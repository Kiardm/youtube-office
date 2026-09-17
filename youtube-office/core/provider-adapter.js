'use strict'

const { execFile } = require('child_process')

/** Normalized provider failure that never exposes credentials or raw environment data. */
class ProviderFailure extends Error {
  constructor(kind, message, retryable = false) {
    super(message)
    this.name = 'ProviderFailure'
    this.kind = kind
    this.retryable = retryable
  }
}

function runProcess(file, args, options = {}, input = '') {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, {
      windowsHide: true,
      timeout: options.timeoutMs || 90_000,
      maxBuffer: options.maxBuffer || 4 * 1024 * 1024,
      cwd: options.cwd,
      env: options.env,
    }, (error, stdout, stderr) => {
      if (error) return reject(Object.assign(error, { stdout, stderr }))
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || ''), processId: child.pid })
    })
    options.onStart?.(child)
    child.stdin?.end(input)
  })
}

function normalizeFailure(error) {
  const detail = String(error?.stderr || error?.message || 'Provider request failed.').replace(/(token|api[_-]?key|cookie)\s*[=:]\s*\S+/gi, '$1=[REDACTED]').slice(0, 800)
  const lower = detail.toLowerCase()
  if (error?.killed || /timed?\s*out|timeout/.test(lower)) return new ProviderFailure('timeout', 'The provider exceeded the configured time limit.', true)
  if (/unauthorized|not logged in|authentication|sign[ -]?in|\b401\b/.test(lower)) return new ProviderFailure('authentication', detail, true)
  if (/usage limit|quota|credit|rate limit|\b429\b/.test(lower)) return new ProviderFailure('usage', detail, true)
  if (/model.{0,40}(unavailable|not found|unsupported)|invalid model/.test(lower)) return new ProviderFailure('model_unavailable', detail, true)
  if (/enoent|not recognized|cannot find/.test(lower)) return new ProviderFailure('not_installed', detail, false)
  return new ProviderFailure('process', detail, true)
}

class ProviderAdapter {
  constructor(id, displayName) { this.id = id; this.displayName = displayName }
  async getStatus() { throw new Error('getStatus must be implemented') }
  async listModels() { return [] }
  async chat() { throw new Error('chat must be implemented') }
  async executeWorker() { throw new Error('executeWorker must be implemented') }
  cancel(handle) { handle?.kill?.() }
}

module.exports = { ProviderAdapter, ProviderFailure, normalizeFailure, runProcess }
