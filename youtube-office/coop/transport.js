'use strict'

const os = require('os')
const WS = require('ws')
const { WebSocketServer } = WS

function lanAddresses() { return Object.values(os.networkInterfaces()).flat().filter((item) => item && item.family === 'IPv4' && !item.internal).map((item) => item.address) }

class CoopTransport {
  constructor(onEnvelope = () => {}) { this.onEnvelope = onEnvelope; this.server = null; this.clients = new Set(); this.relay = null; this.port = null }
  async startLanHost(port = 0) {
    if (this.server) return this.status()
    this.server = new WebSocketServer({ host: '0.0.0.0', port, maxPayload: 1024 * 1024, perMessageDeflate: false })
    this.server.on('connection', (socket) => {
      this.clients.add(socket)
      socket.on('message', (data, binary) => { if (binary || data.length > 1024 * 1024) return socket.close(1009, 'Invalid frame'); this.onEnvelope(String(data), 'lan') })
      socket.on('close', () => this.clients.delete(socket)); socket.on('error', () => this.clients.delete(socket))
    })
    await new Promise((resolve, reject) => { this.server.once('listening', resolve); this.server.once('error', reject) })
    this.port = this.server.address().port; return this.status()
  }
  connect(url, kind = 'lan') {
    const socket = new WS(url, { perMessageDeflate: false, maxPayload: 1024 * 1024 })
    socket.on('message', (data, binary) => { if (!binary) this.onEnvelope(String(data), kind) })
    socket.on('error', () => {})
    if (kind === 'relay') this.relay = socket; else { this.clients.add(socket); socket.on('close', () => this.clients.delete(socket)) }
    return socket
  }
  send(envelope) { const data = typeof envelope === 'string' ? envelope : JSON.stringify(envelope); for (const peer of this.clients) if (peer.readyState === WS.OPEN) peer.send(data); if (this.relay?.readyState === WS.OPEN) this.relay.send(data) }
  status() { return { lanPort: this.port, lanAddresses: lanAddresses(), lanPeers: [...this.clients].filter((peer) => peer.readyState === WS.OPEN).length, relayConnected: this.relay?.readyState === WS.OPEN } }
  close() { for (const peer of this.clients) peer.close(); this.clients.clear(); this.relay?.close(); this.relay = null; this.server?.close(); this.server = null; this.port = null }
}

module.exports = { CoopTransport, lanAddresses }
