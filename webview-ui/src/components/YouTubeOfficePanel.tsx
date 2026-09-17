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
  processId?: number | null
  startedAt?: string | null
  endedAt?: string | null
  exitCode?: number | null
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
  intake?: null | { id: string; createdAt: string; confirmed: boolean }
  usage: { fiveHourUsedPercent: number | null; weeklyUsedPercent: number | null; ordinaryUsageAllowed?: boolean | null; policy: string; source?: string | null; checkedAt?: string | null; note?: string }
  agents: Record<AgentId, Agent>
  messages: OfficeMessage[]
  outputs: Array<{ path?: string; title?: string; status?: string }>
  timeline?: TimelineEvent[]
}
type TimelineEvent = {
  id: string
  timestamp: string
  type: string
  agent?: AgentId | null
  reason?: string
  status?: string | null
  processId?: number | null
  evidence?: string[]
  output?: string | null
  cost?: { status?: string; inputTokens?: number | null; outputTokens?: number | null; estimatedUsd?: number | null }
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

const ROLE_LINES: Record<AgentId, { idle: string; working: string; blocked: string; reviewing: string }> = {
  researcher: {
    idle: 'Ready to scout the next angle.',
    working: 'Following the strongest signals…',
    blocked: 'I need a source or direction.',
    reviewing: 'Checking the evidence twice.',
  },
  editor: {
    idle: 'Timeline clear. Ready to cut.',
    working: 'Shaping the strongest story beats…',
    blocked: 'Waiting on the next handoff.',
    reviewing: 'Watching the final cut through.',
  },
  manager: {
    idle: 'Board is clear. Standing by.',
    working: 'Keeping every handoff moving…',
    blocked: 'One decision will unblock us.',
    reviewing: 'Running the release checklist.',
  },
}

function statusColor(status: string): string {
  if (status === 'waiting') return '#8da0b8'
  if (status === 'blocked') return '#ff786a'
  if (status === 'reviewing' || status === 'uploading') return '#f6c759'
  return '#69d7a0'
}

function agentMotion(status: string): 'idle' | 'working' | 'blocked' | 'reviewing' {
  const normalized = status.toLowerCase()
  if (normalized === 'waiting' || normalized === 'idle' || normalized === 'paused') return 'idle'
  if (normalized === 'blocked' || normalized === 'failed') return 'blocked'
  if (normalized === 'reviewing' || normalized === 'uploading') return 'reviewing'
  return 'working'
}

function speechFor(agent: Agent): string {
  const motion = agentMotion(agent.status)
  if (motion === 'working' && agent.currentTask && agent.currentTask.length <= 52) return agent.currentTask
  return ROLE_LINES[agent.id][motion]
}

function AgentStation({ agent, compact = false }: { agent: Agent; compact?: boolean }) {
  const motion = agentMotion(agent.status)
  return (
    <div className={`yt-office-station yt-office-station--${agent.id} yt-office-station--${motion}${compact ? ' yt-office-station--compact' : ''}`} style={{ '--agent-status': statusColor(agent.status) } as React.CSSProperties}>
      <div className="yt-office-speech" role="status">{speechFor(agent)}</div>
      <div className="yt-office-worker" aria-hidden="true">
        <span className="yt-office-worker__head">{ICONS[agent.id]}</span>
        <span className="yt-office-worker__body" />
        {agent.id === 'manager' && motion === 'idle' && <span className="yt-office-smoke-break"><i /><i /><i /></span>}
      </div>
      <div className="yt-office-desk" aria-hidden="true">
        <span className="yt-office-monitor"><i /></span>
        <span className="yt-office-mug" />
        {agent.id === 'editor' && <span className="yt-office-printer"><i className="yt-office-printer__sheet" /><i className="yt-office-printer__tray" /></span>}
      </div>
      <div className="yt-office-station__label">
        <strong>{agent.name}</strong>
        <span>{agent.status}</span>
      </div>
    </div>
  )
}

export function YouTubeOfficePanel({ compact }: { compact: boolean }) {
  const [state, setState] = useState<OfficeState | null>(null)
  const [git, setGit] = useState<GitSnapshot | null>(null)
  const [connected, setConnected] = useState(false)
  const [showIntake, setShowIntake] = useState(false)
  const [idea, setIdea] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [requestError, setRequestError] = useState('')

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

  const beginIntake = async () => {
    setRequestError('')
    setSubmitting(true)
    try {
      const response = await fetch(`${BRIDGE}/task/intake`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      if (response.ok) {
        setState(await response.json())
        setShowIntake(true)
      } else setRequestError((await response.json()).error || 'Could not begin intake.')
    } catch { setRequestError('The local office bridge is unavailable.')
    } finally { setSubmitting(false) }
  }

  const startResearch = async (useIdea: boolean) => {
    const title = useIdea && idea.trim() ? idea.trim() : 'Research the strongest profitable YouTube video idea'
    setRequestError('')
    setSubmitting(true)
    try {
      const response = await fetch(`${BRIDGE}/task/start`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, intakeId: state?.intake?.id, confirmed: true }),
      })
      if (response.ok) {
        setState(await response.json())
        setShowIntake(false)
        setIdea('')
      } else setRequestError((await response.json()).error || 'The project could not start.')
    } catch { setRequestError('The local office bridge is unavailable.')
    } finally { setSubmitting(false) }
  }

  const projectAction = async (action: 'cancel' | 'restart') => {
    setRequestError('')
    setSubmitting(true)
    try {
      const response = await fetch(`${BRIDGE}/task/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      const data = await response.json()
      if (response.ok) setState(data)
      else setRequestError(data.error || `Could not ${action} the project.`)
    } catch { setRequestError('The local office bridge is unavailable.')
    } finally { setSubmitting(false) }
  }

  if (compact) {
    return (
      <div className="yt-office-shell yt-office-shell--compact">
        <div className="yt-office-compact-bar">
          <div>
            <div className="yt-office-compact-title"><span className="yt-office-live-light" data-connected={connected} />YouTube Office</div>
            <div className="yt-office-compact-project" data-waiting={waiting}>{waiting ? 'All workers waiting for your instruction' : state?.activeProject?.title || 'Working'}</div>
          </div>
          <div className="yt-office-compact-team" aria-label="Worker states">
            {agents.map((agent) => <AgentStation key={agent.id} agent={agent} compact />)}
          </div>
        </div>
        <div className="yt-office-compact-hint">
          Click to expand · {connected ? 'local bridge connected' : 'reconnecting'}
        </div>
      </div>
    )
  }

  return (
    <aside className="yt-office-panel">
      <header style={{ position: 'sticky', top: 0, zIndex: 2, padding: 16, background: '#171321', borderBottom: '2px solid #4a4058', WebkitAppRegion: 'drag' } as React.CSSProperties}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div><div style={{ fontSize: 24, fontWeight: 700 }}>YouTube Office</div><div className="yt-office-connection" data-connected={connected}><span className="yt-office-live-light" data-connected={connected} />{connected ? 'Local bridge connected' : 'Bridge reconnecting'}</div></div>
          <button type="button" onClick={() => (window as unknown as { youtubeOffice?: { collapse(): void } }).youtubeOffice?.collapse()} style={{ WebkitAppRegion: 'no-drag', border: '2px solid #756589', background: '#2b2437', color: '#fff5eb', padding: '7px 10px', fontFamily: 'inherit', cursor: 'pointer' } as React.CSSProperties}>Compact</button>
        </div>
      </header>

      <section style={{ padding: 14, borderBottom: '2px solid #40374c' }}>
        <div style={{ fontSize: 12, color: '#a99db9', marginBottom: 5 }}>CURRENT PROJECT</div>
        <div style={{ fontSize: 18, color: state?.activeProject ? '#fff5eb' : '#9fd5ba' }}>{state?.activeProject?.title || 'Waiting for your instruction'}</div>
        <div style={{ marginTop: 7, fontSize: 12, color: '#a99db9' }}>Workers never start jobs on their own.</div>
        {!state?.activeProject && !showIntake && state?.mode !== 'intake' && (
          <button type="button" disabled={!connected || submitting} onClick={beginIntake} style={{ marginTop: 12, width: '100%', border: '2px solid #9b7fc0', background: '#5d3f82', color: '#fff5eb', padding: '10px 12px', fontFamily: 'inherit', fontWeight: 700, cursor: 'pointer' }}>Start a project</button>
        )}
        {(showIntake || state?.mode === 'intake') && !state?.activeProject && (
          <div style={{ marginTop: 12, padding: 10, background: '#241e2e', border: '2px solid #5f526f' }}>
            <div style={{ color: '#f6c759', fontSize: 13, marginBottom: 8 }}>Researcher: Do you have an idea, or should I find the strongest option?</div>
            <textarea value={idea} onChange={(event) => setIdea(event.target.value)} placeholder="Optional video or channel idea…" rows={3} style={{ width: '100%', boxSizing: 'border-box', resize: 'vertical', padding: 8, color: '#fff5eb', background: '#100d16', border: '1px solid #756589', fontFamily: 'inherit', fontSize: 12 }} />
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 7, marginTop: 8 }}>
              <button type="button" disabled={!idea.trim() || submitting} onClick={() => startResearch(true)} style={{ border: '2px solid #756589', background: '#3b3049', color: '#fff5eb', padding: 8, fontFamily: 'inherit', cursor: idea.trim() ? 'pointer' : 'not-allowed' }}>Use my idea</button>
              <button type="button" disabled={submitting} onClick={() => startResearch(false)} style={{ border: '2px solid #6fb890', background: '#255b43', color: '#fff5eb', padding: 8, fontFamily: 'inherit', cursor: 'pointer' }}>Research & start</button>
            </div>
            <button type="button" disabled={submitting} onClick={() => { void projectAction('cancel'); setShowIntake(false) }} style={{ marginTop: 7, width: '100%', border: 0, background: 'transparent', color: '#a99db9', padding: 5, fontFamily: 'inherit', fontSize: 11, cursor: 'pointer' }}>Cancel intake</button>
          </div>
        )}
        {state?.activeProject && (
          <div style={{ display: 'flex', gap: 7, marginTop: 10 }}>
            {(state.mode === 'blocked' || state.mode === 'recovery') && <button type="button" disabled={submitting} onClick={() => projectAction('restart')} style={{ flex: 1, border: '2px solid #6fb890', background: '#255b43', color: '#fff5eb', padding: 8, fontFamily: 'inherit', cursor: 'pointer' }}>Restart safely</button>}
            <button type="button" disabled={submitting} onClick={() => projectAction('cancel')} style={{ flex: 1, border: '2px solid #a95e65', background: '#5a2931', color: '#fff5eb', padding: 8, fontFamily: 'inherit', cursor: 'pointer' }}>Cancel project</button>
          </div>
        )}
        {requestError && <div role="alert" style={{ marginTop: 9, padding: 8, color: '#ffd2ce', background: '#4b2229', borderLeft: '4px solid #ff786a', fontSize: 12 }}>{requestError}</div>}
      </section>

      <section style={{ padding: 14, display: 'grid', gap: 9, borderBottom: '2px solid #40374c' }}>
        <div style={{ fontSize: 12, color: '#a99db9' }}>THE TEAM</div>
        <div className="yt-office-room" aria-label="Live three-agent office">
          <div className="yt-office-room__shelf" aria-hidden="true"><i /><i /><i /></div>
          <div className="yt-office-room__clock" aria-hidden="true" />
          <div className="yt-office-room__plant" aria-hidden="true"><i /><i /><i /></div>
          <div className="yt-office-room__stations">
            {agents.map((agent) => <AgentStation key={agent.id} agent={agent} />)}
          </div>
        </div>
        {agents.map((agent) => (
          <article key={agent.id} className="yt-office-agent-card" data-motion={agentMotion(agent.status)} style={{ '--agent-status': statusColor(agent.status) } as React.CSSProperties}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}><strong style={{ fontSize: 16 }}>{ICONS[agent.id]} {agent.name}</strong><span style={{ color: statusColor(agent.status), fontSize: 12, textTransform: 'uppercase' }}>{agent.status}</span></div>
            <div style={{ color: '#d5ccdf', fontSize: 13, marginTop: 4 }}>{agent.currentTask}</div>
            <div style={{ color: '#8f829e', fontSize: 11, marginTop: 5 }}>{agent.role} · {agent.model}</div>
          </article>
        ))}
      </section>

      <section style={{ padding: 14, borderBottom: '2px solid #40374c' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 7 }}><span style={{ fontSize: 12, color: '#a99db9' }}>USAGE MANAGER</span><strong style={{ color: state?.usage.policy === 'allowed' ? '#69d7a0' : '#ff786a', textTransform: 'uppercase', fontSize: 12 }}>{state?.usage.policy || 'unknown'}</strong></div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <div style={{ background: '#241e2e', padding: 9 }}><div style={{ fontSize: 11, color: '#a99db9' }}>5-hour used</div><div style={{ fontSize: 20 }}>{state?.usage.fiveHourUsedPercent == null ? '—' : `${state.usage.fiveHourUsedPercent}%`}</div></div>
          <div style={{ background: '#241e2e', padding: 9 }}><div style={{ fontSize: 11, color: '#a99db9' }}>Weekly used</div><div style={{ fontSize: 20 }}>{state?.usage.weeklyUsedPercent == null ? '—' : `${state.usage.weeklyUsedPercent}%`}</div></div>
        </div>
        {state?.usage.note && <div style={{ marginTop: 7, color: '#a99db9', fontSize: 11 }}>{state.usage.note}</div>}
      </section>

      <section style={{ padding: 14, borderBottom: '2px solid #40374c' }}>
        <div style={{ fontSize: 12, color: '#a99db9', marginBottom: 7 }}>LIVE ACTIVITY & WHY</div>
        {(state?.timeline || []).slice(-12).reverse().map((event) => (
          <div key={event.id} style={{ padding: '8px 0', borderTop: '1px solid #40374c' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, color: '#f6c759', fontSize: 11 }}>
              <span>{event.agent ? `${state?.agents[event.agent]?.name || event.agent} · ` : ''}{event.type.replaceAll('_', ' ')}</span>
              <span>{new Date(event.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
            </div>
            {event.reason && <div style={{ color: '#ded6e7', fontSize: 12, marginTop: 3 }}>{event.reason}</div>}
            <div style={{ color: '#8f829e', fontSize: 10, marginTop: 3 }}>{event.processId ? `PID ${event.processId} · ` : ''}{event.status || 'recorded'} · cost {event.cost?.status || 'unknown'}</div>
            {(event.output || (event.evidence && event.evidence.length > 0)) && <div style={{ color: '#9db9d5', fontSize: 10, marginTop: 3, wordBreak: 'break-all' }}>{event.output || event.evidence?.join(' · ')}</div>}
          </div>
        ))}
        {(state?.timeline || []).length === 0 && <div style={{ color: '#8f829e', fontSize: 13 }}>No work has run. Idle animation uses no model calls.</div>}
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
