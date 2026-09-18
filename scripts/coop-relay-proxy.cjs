'use strict'

const WebSocket = require('ws')

const localUrl = process.env.YOUTUBE_OFFICE_LOCAL_ROOM
const relayUrl = process.env.YOUTUBE_OFFICE_RELAY_ROOM
if (!/^ws:\/\//.test(localUrl || '') || !/^wss:\/\//.test(relayUrl || '')) {
  throw new Error('YOUTUBE_OFFICE_LOCAL_ROOM and YOUTUBE_OFFICE_RELAY_ROOM are required')
}

let local
let relay
let closing = false

function connect() {
  local = new WebSocket(localUrl, { maxPayload: 1024 * 1024, perMessageDeflate: false })
  relay = new WebSocket(relayUrl, { maxPayload: 1024 * 1024, perMessageDeflate: false })

  local.on('message', (data, binary) => {
    if (!binary && relay.readyState === WebSocket.OPEN) relay.send(data)
  })
  relay.on('message', (data, binary) => {
    if (!binary && local.readyState === WebSocket.OPEN) local.send(data)
  })

  const reconnect = () => {
    if (closing) return
    closing = true
    try { local.close() } catch {}
    try { relay.close() } catch {}
    setTimeout(() => { closing = false; connect() }, 1500)
  }
  local.on('error', reconnect)
  relay.on('error', reconnect)
  local.on('close', reconnect)
  relay.on('close', reconnect)
  relay.on('open', () => console.log(`Encrypted relay proxy connected: ${relayUrl}`))
}

connect()

function shutdown() {
  closing = true
  try { local.close() } catch {}
  try { relay.close() } catch {}
  setTimeout(() => process.exit(0), 100).unref()
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
