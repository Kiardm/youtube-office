'use strict'

const assert = require('node:assert/strict')
const fs = require('fs')
const http = require('http')
const os = require('os')
const path = require('path')
const test = require('node:test')
const { DesktopGateway, formatCodexMessage } = require('./desktop-gateway')
const { translateActivityEvent, verifyOfficeSnapshot } = require('./office-verifier')

function temporaryQueue(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'office-gateway-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  return path.join(directory, 'queue.json')
}

test('idle/no-work state stays idle and emits no gate', () => {
  const result = verifyOfficeSnapshot({ mode: 'idle', activeProject: null, agents: {
    researcher: { status: 'waiting' }, editor: { status: 'waiting' }, manager: { status: 'waiting' },
  } })
  assert.equal(result.ok, true)
  assert.equal(result.gate, null)
})

test('intake is visible but does not imply launched work', () => {
  const result = verifyOfficeSnapshot({ mode: 'intake', activeProject: null, agents: {} })
  assert.equal(result.ok, true)
  assert.equal(result.gate.type, 'intake_required')
})

test('ordinary usage lock rejects active worker state', () => {
  const result = verifyOfficeSnapshot({ mode: 'working', activeProject: { id: 'VID-101' }, agents: {
    researcher: { status: 'researching' },
  } }, { ordinaryUsageAllowed: false })
  assert.equal(result.ok, false)
  assert.match(result.violations.join(' '), /workers must not be active/)
  assert.equal(result.gate.type, 'usage_blocked')
})

test('failure, cancellation, and restart become major gates', () => {
  assert.equal(translateActivityEvent({ type: 'pipeline_blocked' }).type, 'failed')
  assert.equal(translateActivityEvent({ type: 'task_cancelled' }).type, 'cancelled')
  assert.equal(translateActivityEvent({ type: 'pipeline_restarted' }).type, 'restarted')
  assert.equal(translateActivityEvent({ type: 'agent_status' }), null)
})

test('major gate queue deduplicates and survives restart after delivery failure', async (t) => {
  const queueFile = temporaryQueue(t)
  const failing = new DesktopGateway({ queueFile, threadId: 'thread-123', endpoint: 'http://127.0.0.1:1/deliver',
    transport: async () => { throw new Error('offline') } })
  const gate = { type: 'failed', projectId: 'VID-9', summary: 'Needs attention' }
  assert.equal(failing.enqueue(gate).queued, true)
  assert.equal(failing.enqueue(gate).reason, 'duplicate')
  assert.equal((await failing.flush()).fallback, 'durable-queue')
  let received
  const resumed = new DesktopGateway({ queueFile, threadId: 'thread-123', endpoint: 'http://gateway.test/deliver',
    transport: async (payload) => { received = payload } })
  assert.equal((await resumed.flush()).delivered, 1)
  assert.equal(received.threadId, 'thread-123')
  assert.equal(received.event.type, 'failed')
  assert.equal(resumed.snapshot().items.length, 0)
})

test('gateway delivers only sanitized major gates to the configured thread', async (t) => {
  const queueFile = temporaryQueue(t)
  const requests = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => { requests.push(JSON.parse(body)); res.writeHead(204); res.end() })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const { port } = server.address()
  const gateway = new DesktopGateway({ queueFile, threadId: 'thread-configured', endpoint: `http://127.0.0.1:${port}/events` })
  assert.equal(gateway.enqueue({ type: 'agent_status', rawPrompt: 'do not send me' }).reason, 'not-major')
  gateway.enqueue({ type: 'approval_required', projectId: 'VID-22',
    summary: 'authorization: Bearer abcdefghijklmnop api_key=super-secret',
    rawPrompt: 'hidden operator prompt', credentials: { password: 'hidden' } })
  assert.equal((await gateway.flush()).delivered, 1)
  assert.equal(requests.length, 1)
  const serialized = JSON.stringify(requests[0])
  assert.equal(requests[0].threadId, 'thread-configured')
  assert.doesNotMatch(serialized, /hidden operator prompt|super-secret|abcdefghijklmnop/)
  assert.match(serialized, /\[REDACTED\]/)
})

test('Codex queue message is concise and contains only the sanitized gate', () => {
  const message = formatCodexMessage({ event: {
    type: 'completed', title: 'Wingman edit', summary: 'Passed final QA', evidence: ['manager-report.md'],
  } })
  assert.match(message, /^\[YouTube Office · completed\]/)
  assert.match(message, /Passed final QA/)
  assert.match(message, /manager-report\.md/)
})
