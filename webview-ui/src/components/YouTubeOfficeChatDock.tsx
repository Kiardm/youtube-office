import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { playMessageSound, playUiSound, unlockAudio } from '../notificationSound.js'

export type OfficeAgentId = 'researcher' | 'editor' | 'manager'
export type OfficeChatTarget = 'team' | OfficeAgentId
type ChatMessage = { id: string; agentId?: OfficeAgentId | null; agentName?: string; author: 'user' | 'assistant'; text: string; createdAt: string; status: string; bubbleSummary?: string; blockerReason?: string; errorKind?: string; retryable?: boolean; teamMessageId?: string }
type Guidance = { id: string; text: string; reason?: string; status: string; owner: OfficeAgentId }
type Blocker = { messageId: string; reason: string; kind: string; retryable: boolean }
type AgentSummary = { id: OfficeAgentId; name: string; role: string; status: string; currentTask: string }
type AgentChatView = {
  target: OfficeAgentId; agent: AgentSummary; messages: ChatMessage[]; queue: Array<{ id: string }>
  runtime: { messageId: string | null; processId: number | null; startedAt: string | null }
  guidance: Guidance[]; timing: { reliable: boolean; message?: string; medianSeconds?: number }; blocker?: Blocker | null
}
type TeamWorker = { agent: AgentSummary; status: string; queuePosition: number; runtime: { messageId: string | null; processId: number | null; startedAt: string | null }; blocker?: Blocker | null }
type TeamChatView = { target: 'team'; messages: ChatMessage[]; workers: Record<OfficeAgentId, TeamWorker>; guidance: Guidance[]; latestTeamMessageId: string | null }
type ChatView = AgentChatView | TeamChatView

const BRIDGE = 'http://127.0.0.1:3310'
const AGENTS: OfficeAgentId[] = ['researcher', 'editor', 'manager']
const LABELS: Record<OfficeChatTarget, string> = { team: 'Whole Team', researcher: 'Researcher', editor: 'Editor', manager: 'Manager' }

export function YouTubeOfficeChatDock({ target, panelWidth, onSelect, onClose, onHeight }: { target: OfficeChatTarget; panelWidth: number; onSelect(target: OfficeChatTarget): void; onClose(): void; onHeight(height: number): void }) {
  const [view, setView] = useState<ChatView | null>(null)
  const [drafts, setDrafts] = useState<Record<OfficeChatTarget, string>>({ team: '', researcher: '', editor: '', manager: '' })
  const [error, setError] = useState('')
  const [sending, setSending] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const transcript = useRef<HTMLDivElement>(null)
  const seenAssistant = useRef<Set<string> | null>(null)
  const text = drafts[target]

  const load = useCallback(async () => {
    try {
      const response = await fetch(`${BRIDGE}/chat/${target}`)
      if (!response.ok) throw new Error('Could not load this conversation.')
      const data = await response.json()
      setView(target === 'team' ? data : { ...data, target })
      setError('')
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Office bridge unavailable.') }
  }, [target])

  useEffect(() => {
    setView(null)
    const first = window.setTimeout(() => void load(), 0)
    const timer = window.setInterval(() => void load(), 1800)
    return () => { window.clearTimeout(first); window.clearInterval(timer) }
  }, [load])
  useEffect(() => {
    const node = root.current
    if (!node) return
    const report = () => onHeight(Math.round(node.getBoundingClientRect().height))
    report(); const observer = new ResizeObserver(report); observer.observe(node)
    return () => { observer.disconnect(); onHeight(0) }
  }, [onHeight])
  useEffect(() => { transcript.current?.scrollTo({ top: transcript.current.scrollHeight }) }, [view?.messages.length])

  const thinkingByAgent = useMemo(() => Object.fromEntries(AGENTS.map((agentId) => {
    if (view?.target === 'team') return [agentId, ['queued', 'thinking'].includes(view.workers[agentId]?.status)]
    if (view?.target === agentId) return [agentId, Boolean(view.runtime.processId) || view.messages.some((message) => message.author === 'user' && ['queued', 'thinking'].includes(message.status))]
    return [agentId, false]
  })) as Record<OfficeAgentId, boolean>, [view])

  useEffect(() => {
    for (const agentId of AGENTS) window.dispatchEvent(new CustomEvent('youtube-office-agent-thinking', { detail: { role: agentId, thinking: thinkingByAgent[agentId] } }))
    return () => { for (const agentId of AGENTS) window.dispatchEvent(new CustomEvent('youtube-office-agent-thinking', { detail: { role: agentId, thinking: false } })) }
  }, [thinkingByAgent])

  useEffect(() => {
    const complete = (view?.messages || []).filter((message) => message.author === 'assistant' && message.status === 'complete')
    if (seenAssistant.current === null) { seenAssistant.current = new Set(complete.map((message) => message.id)); return }
    for (const message of complete) {
      if (seenAssistant.current.has(message.id)) continue
      seenAssistant.current.add(message.id)
      const role = message.agentId || (view?.target !== 'team' ? view?.target : null)
      if (!role) continue
      window.dispatchEvent(new CustomEvent('youtube-office-agent-speech', { detail: { role, text: (message.bubbleSummary || message.text).slice(0, 120), durationSec: 10 } }))
      void playMessageSound()
    }
  }, [view])

  const send = async () => {
    const message = text.trim(); if (!message || sending) return
    setSending(true); setError(''); unlockAudio(); void playUiSound('start')
    try {
      const response = await fetch(`${BRIDGE}/chat/${target}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: message }) })
      if (!response.ok) setError((await response.json()).error || 'Could not queue the message.')
      else { setDrafts((current) => ({ ...current, [target]: '' })); await load() }
    } catch { setError('Office bridge unavailable.') } finally { setSending(false) }
  }
  const guidanceAction = async (guidance: Guidance, action: 'approve' | 'dismiss' | 'pin') => {
    let ruleText = guidance.text
    if (action === 'approve') {
      const edited = window.prompt('Review or edit the permanent rule before saving:', guidance.text)
      if (edited === null) return
      ruleText = edited.trim(); if (!ruleText) return
    }
    await fetch(`${BRIDGE}/chat/guidance/${encodeURIComponent(guidance.id)}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: ruleText }) })
    await load()
  }
  const retry = async (agentId: OfficeAgentId, messageId: string) => {
    setError(''); unlockAudio(); void playUiSound('start')
    try {
      const response = await fetch(`${BRIDGE}/chat/${agentId}/messages/${encodeURIComponent(messageId)}/retry`, { method: 'POST' })
      if (!response.ok) setError((await response.json()).error || 'Could not retry the message.')
      await load()
    } catch { setError('Office bridge unavailable.') }
  }

  const blockers = view?.target === 'team'
    ? AGENTS.flatMap((agentId) => view.workers[agentId]?.blocker ? [{ agentId, blocker: view.workers[agentId].blocker! }] : [])
    : view?.blocker ? [{ agentId: view.target, blocker: view.blocker }] : []
  const guidance = view?.guidance || []

  return (
    <div ref={root} className="yt-office-chat-dock" style={{ right: panelWidth }}>
      <div className="yt-office-chat-head">
        <div><strong>{LABELS[target]}</strong><span>{target === 'team' ? 'One message · three independent personality-driven replies' : `${view?.target !== 'team' ? view?.agent.role || 'Employee' : 'Employee'} · ${view?.target !== 'team' ? view?.agent.status || 'loading' : 'loading'}`}</span></div>
        {target !== 'team' && <button type="button" onClick={onClose} aria-label="Return to whole-team chat">×</button>}
      </div>
      <div className="yt-office-chat-targets" aria-label="Choose conversation">
        {(['team', ...AGENTS] as OfficeChatTarget[]).map((item) => <button type="button" key={item} data-selected={target === item} onClick={() => onSelect(item)}>{LABELS[item]}{item !== 'team' && thinkingByAgent[item] ? ' …' : ''}</button>)}
      </div>
      {view?.target === 'team' && <div className="yt-office-team-status">{AGENTS.map((agentId) => <span key={agentId} data-status={view.workers[agentId]?.status}>{LABELS[agentId]}: {view.workers[agentId]?.status || 'idle'}</span>)}</div>}
      <div ref={transcript} className="yt-office-chat-transcript" aria-live="polite">
        {(view?.messages || []).map((message) => <div key={message.id} className={`yt-office-chat-message yt-office-chat-message--${message.author}`}><b>{message.author === 'user' ? (target === 'team' ? 'You → Whole Team' : 'You') : message.agentName || (view?.target !== 'team' ? view?.agent.name : LABELS[message.agentId || 'team'])}</b><span>{message.text}</span><small>{message.status}</small></div>)}
        {AGENTS.some((agentId) => thinkingByAgent[agentId]) && <div className="yt-office-chat-thinking" aria-label="Employees are thinking"><i /><i /><i /></div>}
        {(view?.messages || []).length === 0 && <div className="yt-office-chat-empty">{target === 'team' ? 'Message the whole team. Each employee answers independently in character.' : 'Ask for status, an evidence-based ETA, feedback, or advice.'} Chat cannot start production.</div>}
      </div>
      {blockers.map(({ agentId, blocker }) => <div key={`${agentId}-${blocker.messageId}`} className="yt-office-chat-blocker" role="status"><span><b>{LABELS[agentId]} stopped ({blocker.kind}):</b> {blocker.reason}</span>{blocker.retryable && <button type="button" onClick={() => void retry(agentId, blocker.messageId)}>Retry {LABELS[agentId]}</button>}</div>)}
      {guidance.filter((item) => item.status === 'pending').slice(-1).map((item) => <div className="yt-office-guidance" key={item.id}><span><b>Proposed guidance:</b> {item.text}</span><button onClick={() => guidanceAction(item, 'pin')}>Pin</button><button onClick={() => guidanceAction(item, 'approve')}>Save/edit rule</button><button onClick={() => guidanceAction(item, 'dismiss')}>Dismiss</button></div>)}
      <div className="yt-office-chat-compose">
        <textarea value={text} onChange={(event) => setDrafts((current) => ({ ...current, [target]: event.target.value }))} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send() } }} rows={2} placeholder={target === 'team' ? 'Talk to Researcher, Editor, and Manager at the same time…' : `Talk to ${LABELS[target]}…`} />
        <button type="button" disabled={!text.trim() || sending} onClick={() => void send()}>{target === 'team' ? 'Send to 3' : 'Send'}</button>
      </div>
      {error && <div className="yt-office-chat-error">{error}</div>}
    </div>
  )
}
