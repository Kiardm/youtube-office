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
type AssignmentMode = 'chat' | 'quick-research' | 'mini-project'
type SideTask = { id: string; agentId: OfficeAgentId; mode: AssignmentMode; title: string; request: string; status: string; summary?: string; blockerReason?: string; retryable?: boolean; citations?: string[]; shareWithRoom?: boolean }
type SideTaskView = { tasks: SideTask[]; runtime: { taskId: string | null; agentId: OfficeAgentId | null; processId: number | null; phase?: string | null }; metrics: Record<string, { started: number; completed: number; failed: number; blocked: number }> }
type MiniConfirmation = { taskId: string; agentId: OfficeAgentId; title: string; scopes: string[]; requestIds: string[]; excludes: string[]; expectedUsage: string }

const OFFICE_TOKEN = new URLSearchParams(window.location.search).get('officeToken') || 'browser-preview'
const BRIDGE = `http://127.0.0.1:3310/session/${encodeURIComponent(OFFICE_TOKEN)}`
const AGENTS: OfficeAgentId[] = ['researcher', 'editor', 'manager']
const LABELS: Record<OfficeChatTarget, string> = { team: 'Whole Team', researcher: 'Researcher', editor: 'Editor', manager: 'Manager' }

export function YouTubeOfficeChatDock({ target, panelWidth, onSelect, onClose, onHeight }: { target: OfficeChatTarget; panelWidth: number; onSelect(target: OfficeChatTarget): void; onClose(): void; onHeight(height: number): void }) {
  const [view, setView] = useState<ChatView | null>(null)
  const [drafts, setDrafts] = useState<Record<OfficeChatTarget, string>>({ team: '', researcher: '', editor: '', manager: '' })
  const [error, setError] = useState('')
  const [sending, setSending] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [assignmentMode, setAssignmentMode] = useState<AssignmentMode>('chat')
  const [sideView, setSideView] = useState<SideTaskView | null>(null)
  const [miniConfirmation, setMiniConfirmation] = useState<MiniConfirmation | null>(null)
  const [shareWithRoom, setShareWithRoom] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const seenAssistant = useRef<Set<string> | null>(null)
  const text = drafts[target]

  const load = useCallback(async () => {
    try {
      const response = await fetch(`${BRIDGE}/chat/${target}`)
      if (!response.ok) throw new Error('Could not load this conversation.')
      const data = await response.json()
      setView(target === 'team' ? data : { ...data, target })
      if (target !== 'team') {
        const sideResponse = await fetch(`${BRIDGE}/side-tasks?agent=${encodeURIComponent(target)}`)
        if (sideResponse.ok) setSideView(await sideResponse.json())
      } else setSideView(null)
      setError('')
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Office bridge unavailable.') }
  }, [target])
  useEffect(() => {
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
  const thinkingByAgent = useMemo(() => Object.fromEntries(AGENTS.map((agentId) => {
    if (view?.target === 'team') return [agentId, ['queued', 'thinking'].includes(view.workers[agentId]?.status)]
    if (view?.target === agentId) return [agentId, Boolean(view.runtime.processId) || sideView?.runtime?.agentId === agentId || view.messages.some((message) => message.author === 'user' && ['queued', 'thinking'].includes(message.status))]
    return [agentId, false]
  })) as Record<OfficeAgentId, boolean>, [view, sideView])

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
      if (assignmentMode === 'chat' || target === 'team') {
        const response = await fetch(`${BRIDGE}/chat/${target}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: message }) })
        if (!response.ok) setError((await response.json()).error || 'Could not queue the message.')
        else { setDrafts((current) => ({ ...current, [target]: '' })); await load() }
      } else {
        const response = await fetch(`${BRIDGE}/side-tasks`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId: target, mode: assignmentMode, request: message, title: message, shareWithRoom }) })
        const data = await response.json()
        if (response.status === 428 && data.confirmation) setMiniConfirmation(data.confirmation)
        else if (!response.ok) setError(data.error || 'Could not queue the side assignment.')
        else { setDrafts((current) => ({ ...current, [target]: '' })); setMiniConfirmation(null); await load() }
      }
    } catch { setError('Office bridge unavailable.') } finally { setSending(false) }
  }
  const confirmMiniProject = async () => {
    if (!miniConfirmation) return
    setSending(true); setError('')
    try {
      const response = await fetch(`${BRIDGE}/side-tasks/${encodeURIComponent(miniConfirmation.taskId)}/confirm`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ confirmed: true, requestIds: miniConfirmation.requestIds }) })
      const data = await response.json()
      if (!response.ok) setError(data.error || 'Could not confirm the mini project.')
      else { setDrafts((current) => ({ ...current, [target]: '' })); setMiniConfirmation(null); await load() }
    } catch { setError('Office bridge unavailable.') } finally { setSending(false) }
  }
  const sideAction = async (task: SideTask, action: 'cancel' | 'retry' | 'share') => {
    setError('')
    try {
      const response = await fetch(`${BRIDGE}/side-tasks/${encodeURIComponent(task.id)}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })
      if (!response.ok) setError((await response.json()).error || `Could not ${action} this side assignment.`)
      await load()
    } catch { setError('Office bridge unavailable.') }
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
        <div className="yt-office-chat-head__actions">
          <button type="button" className="yt-office-chat-history-button" onClick={() => setHistoryOpen((open) => !open)}>{historyOpen ? 'Hide history' : 'History'}</button>
          {target !== 'team' && <button type="button" onClick={onClose} aria-label="Return to whole-team chat">×</button>}
        </div>
      </div>
      <div className="yt-office-chat-targets" aria-label="Choose conversation">
        {(['team', ...AGENTS] as OfficeChatTarget[]).map((item) => <button type="button" key={item} data-selected={target === item} onClick={() => { if (item === 'team') { setAssignmentMode('chat'); setMiniConfirmation(null) }; onSelect(item) }}>{LABELS[item]}{item !== 'team' && thinkingByAgent[item] ? ' …' : ''}</button>)}
      </div>
      {target !== 'team' && <div className="yt-office-assignment-modes" aria-label="Choose employee interaction mode">
        <button type="button" data-selected={assignmentMode === 'chat'} onClick={() => { setAssignmentMode('chat'); setMiniConfirmation(null) }}>Chat</button>
        <button type="button" data-selected={assignmentMode === 'quick-research'} onClick={() => { setAssignmentMode('quick-research'); setMiniConfirmation(null) }}>Research &amp; answer</button>
        <button type="button" data-selected={assignmentMode === 'mini-project'} onClick={() => setAssignmentMode('mini-project')}>Mini project</button>
      </div>}
      {view?.target === 'team' && <div className="yt-office-team-status">{AGENTS.map((agentId) => <span key={agentId} data-status={view.workers[agentId]?.status}>{LABELS[agentId]}: {view.workers[agentId]?.status || 'idle'}</span>)}</div>}
      {historyOpen && <div className="yt-office-chat-history" role="dialog" aria-label={`${LABELS[target]} conversation history`}>
        <div className="yt-office-chat-history__head"><strong>{LABELS[target]} conversation history</strong><button type="button" onClick={() => setHistoryOpen(false)}>Close</button></div>
        <div className="yt-office-chat-history__messages" aria-live="polite">
          {(view?.messages || []).map((message) => <div key={message.id} className={`yt-office-chat-message yt-office-chat-message--${message.author}`}><b>{message.author === 'user' ? (target === 'team' ? 'You → Whole Team' : 'You') : message.agentName || (view?.target !== 'team' ? view?.agent.name : LABELS[message.agentId || 'team'])}</b><span>{message.text}</span><small>{message.status}</small></div>)}
          {(view?.messages || []).length === 0 && <div className="yt-office-chat-empty">No conversation history yet.</div>}
        </div>
      </div>}
      {(blockers.length > 0 || guidance.some((item) => item.status === 'pending') || error) && <div className="yt-office-chat-notices">
        {blockers.map(({ agentId, blocker }) => <div key={`${agentId}-${blocker.messageId}`} className="yt-office-chat-blocker" role="status"><span><b>{LABELS[agentId]} stopped ({blocker.kind}):</b> {blocker.reason}</span>{blocker.retryable && <button type="button" onClick={() => void retry(agentId, blocker.messageId)}>Retry {LABELS[agentId]}</button>}</div>)}
        {guidance.filter((item) => item.status === 'pending').slice(-1).map((item) => <div className="yt-office-guidance" key={item.id}><span><b>Proposed guidance:</b> {item.text}</span><button onClick={() => guidanceAction(item, 'pin')}>Pin</button><button onClick={() => guidanceAction(item, 'approve')}>Save/edit rule</button><button onClick={() => guidanceAction(item, 'dismiss')}>Dismiss</button></div>)}
        {error && <div className="yt-office-chat-error">{error}</div>}
      </div>}
      {target !== 'team' && (sideView?.tasks || []).slice(-2).reverse().map((task) => <div className="yt-office-side-task" data-status={task.status} key={task.id}>
        <span><b>{task.mode === 'quick-research' ? 'Research' : 'Mini project'} · {task.status}</b>{task.title}</span>
        <div>{['queued','running','cancelling'].includes(task.status) && <button type="button" onClick={() => void sideAction(task, 'cancel')}>Cancel</button>}{['failed','blocked','cancelled'].includes(task.status) && <button type="button" onClick={() => void sideAction(task, 'retry')}>Retry</button>}{task.status === 'completed' && !task.shareWithRoom && <button type="button" onClick={() => void sideAction(task, 'share')}>Share with room</button>}</div>
      </div>)}
      {miniConfirmation && <div className="yt-office-mini-confirm" role="alertdialog" aria-label="Confirm mini project">
        <strong>Are you sure?</strong><span>This single-employee mini project may use more time and tools than quick research.</span><small>{miniConfirmation.scopes.join(' · ')} · excludes destructive and publishing access · {miniConfirmation.expectedUsage}</small>
        <div><button type="button" disabled={sending} onClick={() => void confirmMiniProject()}>Confirm mini project</button><button type="button" onClick={() => setMiniConfirmation(null)}>Cancel</button></div>
      </div>}
      {target !== 'team' && assignmentMode !== 'chat' && <label className="yt-office-share-result"><input type="checkbox" checked={shareWithRoom} onChange={(event) => setShareWithRoom(event.target.checked)} /> Share completed result with the active co-op room</label>}
      <div className="yt-office-chat-compose">
        <textarea value={text} onChange={(event) => setDrafts((current) => ({ ...current, [target]: event.target.value }))} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send() } }} rows={2} placeholder={target === 'team' ? 'Talk to Researcher, Editor, and Manager at the same time…' : assignmentMode === 'quick-research' ? `Give ${LABELS[target]} a small cited research question…` : assignmentMode === 'mini-project' ? `Describe a small ${LABELS[target]} mini project…` : `Talk to ${LABELS[target]}…`} />
        <button type="button" disabled={!text.trim() || sending || Boolean(miniConfirmation)} onClick={() => void send()}>{target === 'team' ? 'Send to 3' : assignmentMode === 'quick-research' ? 'Research' : assignmentMode === 'mini-project' ? 'Review' : 'Send'}</button>
      </div>
    </div>
  )
}
