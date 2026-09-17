import { useEffect, useMemo, useState } from 'react'

type AgentId = 'researcher' | 'editor' | 'manager'
type Agent = {
  id: AgentId
  name: string
  role: string
  model: string
  personality: string
  status: string
  currentTask: string
  lastUpdateAt: string
}
type OfficeMessage = {
  id: string
  timestamp: string
  from: AgentId
  to: string
  kind: string
  summary: string
}
type OfficeState = {
  mode: string
  updatedAt: string
  activeProject: null | { id: string; title: string; startedAt: string }
  usage: { fiveHourUsedPercent: number; weeklyUsedPercent: number; policy: string; note?: string }
  agents: Record<AgentId, Agent>
  messages: OfficeMessage[]
  outputs: Array<{ path?: string; title?: string; status?: string }>
}
type GitSnapshot = {
  repository: string
  status: { ok: boolean; output: string }
  log: { ok: boolean; output: string }
  diff: { ok: boolean; output: string }
  checkedAt: string
}

const BRIDGE = 'http://127.0.0.1:3310'
const AGENT_ORDER: AgentId[] = ['researcher', 'editor', 'manager']
const ICONS: Record<AgentId, string> = { researcher: '⌕', editor: '✂', manager: '$' }

function statusColor(status: string): string {
  if (status === 'waiting') return '#8da0b8'
  if (status === 'blocked') return '#ff786a'
  if (status === 'reviewing' || status === 'uploading') return '#f6c759'
  return '#69d7a0'
}

export function YouTubeOfficePanel({ compact }: { compact: boolean }) {
  const [state, setState] = useState<OfficeState | null>(null)
  const [git, setGit] = useState<GitSnapshot | null>(null)
  const [connected, setConnected] = useState(false)

  useEffect(() => {
    let closed = false
    const load = () => fetch(`${BRIDGE}/state`).then((r) => r.json()).then((data) => { if (!closed) setState(data) }).catch(() => {})
    load()
    const timer = window.setInterval(load, 5000)
    const socket = new WebSocket('ws://127.0.0.1:3310/ws')
    socket.onopen = () => setConnected(true)
    socket.onclose = () => setConnected(false)
    socket.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data)
        if (message.state && !closed) setState(message.state)
      } catch { /* ignore malformed local events */ }
    }
    return () => { closed = true; window.clearInterval(timer); socket.close() }
  }, [])

  useEffect(() => {
    if (compact) return undefined
    let closed = false
    const load = () => fetch(`${BRIDGE}/git`).then((r) => r.json()).then((data) => { if (!closed) setGit(data) }).catch(() => {})
    load()
    const timer = window.setInterval(load, 10000)
    return () => { closed = true; window.clearInterval(timer) }
  }, [compact])

  const agents = useMemo(() => state ? AGENT_ORDER.map((id) => state.agents[id]) : [], [state])
  const waiting = agents.length > 0 && agents.every((agent) => agent.status === 'waiting')

  if (compact) {
    return (
      <div style={{ position: 'absolute', inset: 0, zIndex: 80, pointerEvents: 'none', fontFamily: 'var(--pixel-font)' }}>
        <div style={{ position: 'absolute', top: 8, left: 8, right: 8, padding: '9px 12px', color: '#fff5eb', background: 'rgba(20,16,31,.88)', border: '2px solid rgba(125,104,155,.75)', boxShadow: '0 4px 0 rgba(0,0,0,.35)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
          <div>
            <div style={{ fontSize: 19, fontWeight: 700 }}>YouTube Office</div>
            <div style={{ fontSize: 13, color: waiting ? '#9fd5ba' : '#f6c759' }}>{waiting ? 'All workers waiting for your instruction' : state?.activeProject?.title || 'Working'}</div>
          </div>
          <div style={{ display: 'flex', gap: 6 }} aria-label="Worker states">
            {agents.map((agent) => <span key={agent.id} title={`${agent.name}: ${agent.status}`} style={{ width: 10, height: 10, background: statusColor(agent.status), display: 'block', boxShadow: '0 0 0 2px rgba(0,0,0,.3)' }} />)}
          </div>
        </div>
        <div style={{ position: 'absolute', left: 10, bottom: 8, color: 'rgba(255,245,235,.78)', background: 'rgba(20,16,31,.78)', padding: '5px 8px', fontSize: 11 }}>
          Click to expand · {connected ? 'local bridge connected' : 'reconnecting'}
        </div>
      </div>
    )
  }

  return (
    <aside style={{ position: 'absolute', top: 0, right: 0, bottom: 0, width: 410, zIndex: 90, color: '#fff5eb', background: 'rgba(18,15,28,.96)', borderLeft: '3px solid #5f526f', boxShadow: '-8px 0 20px rgba(0,0,0,.35)', overflowY: 'auto', fontFamily: 'var(--pixel-font)' }}>
      <header style={{ position: 'sticky', top: 0, zIndex: 2, padding: 16, background: '#171321', borderBottom: '2px solid #4a4058', WebkitAppRegion: 'drag' } as React.CSSProperties}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div><div style={{ fontSize: 24, fontWeight: 700 }}>YouTube Office</div><div style={{ fontSize: 13, color: connected ? '#69d7a0' : '#ff786a' }}>{connected ? 'Local bridge connected' : 'Bridge reconnecting'}</div></div>
          <button type="button" onClick={() => (window as unknown as { youtubeOffice?: { collapse(): void } }).youtubeOffice?.collapse()} style={{ WebkitAppRegion: 'no-drag', border: '2px solid #756589', background: '#2b2437', color: '#fff5eb', padding: '7px 10px', fontFamily: 'inherit', cursor: 'pointer' } as React.CSSProperties}>Compact</button>
        </div>
      </header>

      <section style={{ padding: 14, borderBottom: '2px solid #40374c' }}>
        <div style={{ fontSize: 12, color: '#a99db9', marginBottom: 5 }}>CURRENT PROJECT</div>
        <div style={{ fontSize: 18, color: state?.activeProject ? '#fff5eb' : '#9fd5ba' }}>{state?.activeProject?.title || 'Waiting for your instruction'}</div>
        <div style={{ marginTop: 7, fontSize: 12, color: '#a99db9' }}>Workers never start jobs on their own.</div>
      </section>

      <section style={{ padding: 14, display: 'grid', gap: 9, borderBottom: '2px solid #40374c' }}>
        <div style={{ fontSize: 12, color: '#a99db9' }}>THE TEAM</div>
        {agents.map((agent) => (
          <article key={agent.id} style={{ padding: 10, background: '#241e2e', borderLeft: `4px solid ${statusColor(agent.status)}` }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}><strong style={{ fontSize: 16 }}>{ICONS[agent.id]} {agent.name}</strong><span style={{ color: statusColor(agent.status), fontSize: 12, textTransform: 'uppercase' }}>{agent.status}</span></div>
            <div style={{ color: '#d5ccdf', fontSize: 13, marginTop: 4 }}>{agent.currentTask}</div>
            <div style={{ color: '#8f829e', fontSize: 11, marginTop: 5 }}>{agent.role} · {agent.model}</div>
          </article>
        ))}
      </section>

      <section style={{ padding: 14, borderBottom: '2px solid #40374c' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 7 }}><span style={{ fontSize: 12, color: '#a99db9' }}>USAGE MANAGER</span><strong style={{ color: state?.usage.policy === 'lockdown' ? '#ff786a' : '#69d7a0', textTransform: 'uppercase', fontSize: 12 }}>{state?.usage.policy || 'unknown'}</strong></div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <div style={{ background: '#241e2e', padding: 9 }}><div style={{ fontSize: 11, color: '#a99db9' }}>5-hour used</div><div style={{ fontSize: 20 }}>{state?.usage.fiveHourUsedPercent ?? '—'}%</div></div>
          <div style={{ background: '#241e2e', padding: 9 }}><div style={{ fontSize: 11, color: '#a99db9' }}>Weekly used</div><div style={{ fontSize: 20 }}>{state?.usage.weeklyUsedPercent ?? '—'}%</div></div>
        </div>
      </section>

      <section style={{ padding: 14, borderBottom: '2px solid #40374c' }}>
        <div style={{ fontSize: 12, color: '#a99db9', marginBottom: 7 }}>MESSAGES & HANDOFFS</div>
        {(state?.messages || []).slice(-8).reverse().map((message) => (
          <div key={message.id} style={{ padding: '8px 0', borderTop: '1px solid #40374c' }}>
            <div style={{ fontSize: 12, color: '#f6c759' }}>{state?.agents[message.from]?.name || message.from} → {message.to}</div>
            <div style={{ fontSize: 13, color: '#ded6e7', marginTop: 3 }}>{message.summary}</div>
          </div>
        ))}
        {(state?.messages || []).length === 0 && <div style={{ color: '#8f829e', fontSize: 13 }}>No messages yet. The office is waiting.</div>}
      </section>

      <section style={{ padding: 14 }}>
        <div style={{ fontSize: 12, color: '#a99db9', marginBottom: 7 }}>CONTENT-OPS GIT</div>
        <pre style={{ margin: 0, padding: 10, maxHeight: 180, overflow: 'auto', whiteSpace: 'pre-wrap', color: '#d8cfdf', background: '#100d16', fontFamily: 'Consolas, monospace', fontSize: 11 }}>{git?.status.output || 'Checking repository…'}</pre>
        {git?.log.output && <pre style={{ margin: '8px 0 0', padding: 10, maxHeight: 170, overflow: 'auto', whiteSpace: 'pre-wrap', color: '#b8acc6', background: '#100d16', fontFamily: 'Consolas, monospace', fontSize: 10 }}>{git.log.output}</pre>}
      </section>
    </aside>
  )
}

