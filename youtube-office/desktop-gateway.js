'use strict'

const crypto = require('crypto')
const { execFile } = require('child_process')
const fs = require('fs')
const http = require('http')
const https = require('https')
const path = require('path')
const { USAGE_BLOCKED_SUMMARY } = require('./office-verifier')

const MAJOR_GATES = new Set([
  'intake_required', 'approval_required', 'usage_blocked', 'failed',
  'cancelled', 'restarted', 'completed',
])

const SECRET_PATTERNS = [
  /\b(?:sk|sess|pat|ghp|github_pat)-[a-z0-9_-]{8,}\b/gi,
  /\bbearer\s+[a-z0-9._~+\/-]+=*\b/gi,
  /\bauthorization\s*[:=]\s*(?:bearer\s+)?[^\s,;]+/gi,
  /\b(?:api[_ -]?key|password|secret|token)\s*[:=]\s*[^\s,;]+/gi,
]

function sanitizeText(value, max = 500) {
  let text = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ')
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, '[REDACTED]')
  return text.replace(/\s+/g, ' ').trim().slice(0, max)
}

function sanitizeGate(input) {
  const type = sanitizeText(input?.type, 40)
  if (!MAJOR_GATES.has(type)) return null
  return {
    type,
    projectId: sanitizeText(input.projectId || 'office', 100),
    runId: sanitizeText(input.runId || '', 100),
    title: sanitizeText(input.title || type.replaceAll('_', ' '), 160),
    summary: type === 'usage_blocked' ? USAGE_BLOCKED_SUMMARY : sanitizeText(input.summary || '', 600),
    evidence: Array.isArray(input.evidence) ? input.evidence.slice(0, 8).map((item) => sanitizeText(item, 260)) : [],
    occurredAt: sanitizeText(input.occurredAt || new Date().toISOString(), 40),
  }
}

function eventKey(gate) {
  return [gate.projectId, gate.runId || '-', gate.type].join(':')
}

function defaultTransport(endpoint, payload, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const target = new URL(endpoint)
    const body = JSON.stringify(payload)
    const client = target.protocol === 'https:' ? https : http
    const req = client.request(target, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) },
      timeout: timeoutMs,
    }, (res) => {
      res.resume()
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve({ ok: true })
        else reject(new Error(`gateway returned HTTP ${res.statusCode || 0}`))
      })
    })
    req.on('timeout', () => req.destroy(new Error('gateway delivery timed out')))
    req.on('error', reject)
    req.end(body)
  })
}

function formatCodexMessage(payload) {
  const gate = payload.event
  const summary = gate.type === 'usage_blocked' ? USAGE_BLOCKED_SUMMARY : gate.summary
  const evidence = gate.evidence.length ? ` Evidence: ${gate.evidence.join(' | ')}` : ''
  return `[YouTube Office · ${gate.type.replaceAll('_', ' ')}] ${gate.title}: ${summary || 'Open the office log for details.'}${evidence}`.slice(0, 1800)
}

function codexQueueTransport(payload, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    execFile(process.env.CODEX_CLI || 'codex', [
      'queue', '--thread', payload.threadId, '--message', formatCodexMessage(payload),
    ], { windowsHide: true, timeout: timeoutMs, maxBuffer: 256 * 1024 }, (error) => {
      if (error) reject(error)
      else resolve({ ok: true })
    })
  })
}

class DesktopGateway {
  constructor(options = {}) {
    this.queueFile = path.resolve(options.queueFile || path.join(__dirname, 'data', 'codex-gateway-queue.json'))
    this.threadId = sanitizeText(options.threadId || process.env.CODEX_THREAD_ID || '', 160)
    this.endpoint = String(options.endpoint || process.env.CODEX_DESKTOP_GATEWAY_URL || '').trim()
    this.transport = options.transport || ((payload) => this.endpoint
      ? defaultTransport(this.endpoint, payload, options.timeoutMs)
      : codexQueueTransport(payload, options.timeoutMs))
    this.clock = options.clock || (() => new Date())
    this.maxQueue = options.maxQueue || 200
    this.state = this.#load()
  }

  #load() {
    try {
      const value = JSON.parse(fs.readFileSync(this.queueFile, 'utf8'))
      return {
        version: 1,
        items: Array.isArray(value.items) ? value.items.slice(-this.maxQueue) : [],
        deliveredKeys: Array.isArray(value.deliveredKeys) ? value.deliveredKeys.slice(-500) : [],
      }
    } catch {
      return { version: 1, items: [], deliveredKeys: [] }
    }
  }

  #persist() {
    fs.mkdirSync(path.dirname(this.queueFile), { recursive: true })
    const temporary = `${this.queueFile}.${process.pid}.tmp`
    fs.writeFileSync(temporary, `${JSON.stringify(this.state, null, 2)}\n`, { mode: 0o600 })
    fs.renameSync(temporary, this.queueFile)
  }

  bindThread(threadId) {
    this.threadId = sanitizeText(threadId, 160)
    return Boolean(this.threadId)
  }

  enqueue(input) {
    const gate = sanitizeGate(input)
    if (!gate) return { queued: false, reason: 'not-major' }
    const key = eventKey(gate)
    if (this.state.deliveredKeys.includes(key) || this.state.items.some((item) => item.key === key)) {
      return { queued: false, reason: 'duplicate', key }
    }
    const item = {
      id: crypto.createHash('sha256').update(key).digest('hex').slice(0, 20),
      key, gate, attempts: 0, queuedAt: this.clock().toISOString(), lastError: '',
    }
    this.state.items.push(item)
    this.state.items = this.state.items.slice(-this.maxQueue)
    this.#persist()
    return { queued: true, key, item }
  }

  async flush() {
    if (!this.threadId) return { delivered: 0, pending: this.state.items.length, fallback: 'thread-unbound' }
    let delivered = 0
    for (const item of [...this.state.items]) {
      const payload = { version: 1, threadId: this.threadId, eventId: item.id, event: item.gate }
      try {
        await this.transport(payload)
        this.state.items = this.state.items.filter((candidate) => candidate.id !== item.id)
        this.state.deliveredKeys = [...this.state.deliveredKeys, item.key].slice(-500)
        delivered += 1
      } catch (error) {
        const queued = this.state.items.find((candidate) => candidate.id === item.id)
        if (queued) {
          queued.attempts += 1
          queued.lastAttemptAt = this.clock().toISOString()
          queued.lastError = sanitizeText(error?.message || 'delivery failed', 160)
        }
        break
      } finally {
        this.#persist()
      }
    }
    return { delivered, pending: this.state.items.length, fallback: this.state.items.length ? 'durable-queue' : null }
  }

  snapshot() {
    return JSON.parse(JSON.stringify({ threadBound: Boolean(this.threadId), deliveryMode: this.endpoint ? 'http-adapter' : 'codex-queue', endpointConfigured: Boolean(this.endpoint), ...this.state }))
  }
}

module.exports = { DesktopGateway, MAJOR_GATES, sanitizeGate, sanitizeText, formatCodexMessage }
