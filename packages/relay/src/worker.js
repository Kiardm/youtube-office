export class RoomRelay {
  constructor(state) { this.state = state; this.sessions = new Set() }
  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('WebSocket required', { status: 426 })
    const pair = new WebSocketPair(); const client = pair[0]; const server = pair[1]; server.accept(); this.sessions.add(server)
    server.addEventListener('message', (event) => { if (typeof event.data !== 'string' || event.data.length > 1_048_576) return server.close(1009, 'Frame too large'); for (const peer of this.sessions) if (peer !== server) peer.send(event.data) })
    server.addEventListener('close', () => this.sessions.delete(server)); return new Response(null, { status: 101, webSocket: client })
  }
}
export default { fetch(request, env) { const url = new URL(request.url); if (!/^\/room\/[A-Za-z0-9_-]{20,}$/.test(url.pathname)) return new Response('Not found', { status: 404 }); return env.ROOMS.get(env.ROOMS.idFromName(url.pathname)).fetch(request) } }
