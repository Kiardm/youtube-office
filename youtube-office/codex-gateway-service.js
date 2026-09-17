'use strict'

const fs = require('fs')
const path = require('path')
const { DesktopGateway } = require('./desktop-gateway')
const { translateActivityEvent, verifyOfficeSnapshot } = require('./office-verifier')

const dataDir = path.resolve(process.env.YOUTUBE_OFFICE_DATA_DIR || path.join(__dirname, 'data'))
const eventFile = path.join(dataDir, 'activity.jsonl')
const stateFile = path.join(dataDir, 'office-state.json')
const configFile = path.resolve(process.env.CODEX_GATEWAY_CONFIG || path.join(dataDir, 'gateway-config.json'))
let localConfig = {}
try { localConfig = JSON.parse(fs.readFileSync(configFile, 'utf8')) } catch {}
const gateway = new DesktopGateway({
  queueFile: process.env.CODEX_GATEWAY_QUEUE_FILE || path.join(dataDir, 'codex-gateway-queue.json'),
  threadId: process.env.CODEX_THREAD_ID || localConfig.threadId || process.env.CODEX_THREAD_ID_DEFAULT,
  endpoint: process.env.CODEX_DESKTOP_GATEWAY_URL || localConfig.endpoint,
})
let eventOffset = 0
let stopped = false

function readNewEvents() {
  let stat
  try { stat = fs.statSync(eventFile) } catch { return [] }
  if (stat.size < eventOffset) eventOffset = 0
  const length = stat.size - eventOffset
  if (length <= 0) return []
  const fd = fs.openSync(eventFile, 'r')
  const buffer = Buffer.alloc(length)
  fs.readSync(fd, buffer, 0, length, eventOffset)
  fs.closeSync(fd)
  eventOffset = stat.size
  return buffer.toString('utf8').split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)] } catch { return [] }
  })
}

async function poll() {
  for (const event of readNewEvents()) {
    const gate = translateActivityEvent(event)
    if (gate) gateway.enqueue(gate)
  }
  try {
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
    const check = verifyOfficeSnapshot(state, { ordinaryUsageAllowed: state.usage?.ordinaryUsageAllowed === true })
    if (check.gate) gateway.enqueue(check.gate)
  } catch {
    // Missing state is normal during desktop startup. Delivery remains queued.
  }
  await gateway.flush()
}

async function loop() {
  while (!stopped) {
    await poll().catch(() => {})
    await new Promise((resolve) => setTimeout(resolve, 1500))
  }
}

function shutdown() { stopped = true }
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
loop().then(() => process.exit(0))
