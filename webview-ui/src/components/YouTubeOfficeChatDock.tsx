import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { playMessageSound, playUiSound, unlockAudio } from '../notificationSound.js'

export type OfficeAgentId = 'researcher' | 'editor' | 'manager'
type ChatMessage = { id: string; author: 'user' | 'assistant'; text: string; createdAt: string; status: string; bubbleSummary?: string; guidanceCandidateId?: string | null }
type Guidance = { id: string; text: string; reason?: string; status: string; owner: OfficeAgentId }
type ChatView = {
  agent: { id: OfficeAgentId; name: string; role: string; status: string; currentTask: string }
  messages: ChatMessage[]
  queue: Array<{ id: string }>
  runtime: { activeAgent: OfficeAgentId | null }
  guidance: Guidance[]
  timing: { reliable: boolean; message?: string; medianSeconds?: number; rangeSeconds?: number[] }
  blocker?: null | { reason: string; note: string }
}

const BRIDGE = 'http://127.0.0.1:3310'

export function YouTubeOfficeChatDock({ agentId, panelWidth, onClose, onHeight }: { agentId: OfficeAgentId; panelWidth: number; onClose(): void; onHeight(height: number): void }) {
  const [view, setView] = useState<ChatView | null>(null)
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const [sending, setSending] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const transcript = useRef<HTMLDivElement>(null)
  const lastAssistant = useRef<string | null>(null)

  const load = useCallback(async () => {
    try {
      const response = await fetch(`${BRIDGE}/chat/${agentId}`)
      if (response.ok) setView(await response.json())
    } catch { setError('Office bridge unavailable.') }
  }, [agentId])

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
  useEffect(() => { transcript.current?.scrollTo({ top: transcript.current.scrollHeight }) }, [view?.messages.length])

  const thinking = view?.runtime.activeAgent === agentId || view?.messages.some((message) => message.author === 'user' && ['queued', 'thinking'].includes(message.status)) === true
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('youtube-office-agent-thinking', { detail: { role: agentId, thinking } }))
    return () => { window.dispatchEvent(new CustomEvent('youtube-office-agent-thinking', { detail: { role: agentId, thinking: false } })) }
  }, [agentId, thinking])
  useEffect(() => {
    const latest = [...(view?.messages || [])].reverse().find((message) => message.author === 'assistant' && message.status === 'complete')
    if (!latest || latest.id === lastAssistant.current) return
    lastAssistant.current = latest.id
    window.dispatchEvent(new CustomEvent('youtube-office-agent-speech', { detail: { role: agentId, text: (latest.bubbleSummary || latest.text).slice(0, 120), durationSec: 10 } }))
    void playMessageSound()
  }, [agentId, view?.messages])

  const eta = useMemo(() => view?.timing.reliable ? `Typical stage: ~${Math.max(1, Math.round((view.timing.medianSeconds || 0) / 60))} min` : 'ETA: not enough completed-stage evidence', [view])
  const send = async () => {
    const message = text.trim(); if (!message || sending) return
    setSending(true); setError(''); unlockAudio(); void playUiSound('start')
    try {
      const response = await fetch(`${BRIDGE}/chat/${agentId}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: message }) })
      if (!response.ok) setError((await response.json()).error || 'Could not queue the message.')
      else { setText(''); await load() }
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

  return (
    <div ref={root} className="yt-office-chat-dock" style={{ right: panelWidth }}>
      <div className="yt-office-chat-head">
        <div><strong>{view?.agent.name || agentId}</strong><span>{view?.agent.role || 'Employee'} · {view?.agent.status || 'loading'} · {eta}</span></div>
        <button type="button" onClick={onClose} aria-label="Close employee chat">×</button>
      </div>
      <div ref={transcript} className="yt-office-chat-transcript" aria-live="polite">
        {(view?.messages || []).map((message) => <div key={message.id} className={`yt-office-chat-message yt-office-chat-message--${message.author}`}><b>{message.author === 'user' ? 'You' : view?.agent.name}</b><span>{message.text}</span><small>{message.status}</small></div>)}
        {thinking && <div className="yt-office-chat-thinking" aria-label="Employee is thinking"><i /><i /><i /></div>}
        {(view?.messages || []).length === 0 && <div className="yt-office-chat-empty">Ask for status, an evidence-based ETA, feedback, or advice. Chat cannot start production.</div>}
      </div>
      {view?.blocker && <div className="yt-office-chat-blocker" role="status"><b>Reply paused:</b> {view.blocker.reason} No model usage was spent; the queued message will resume after a fresh allowed snapshot.</div>}
      {(view?.guidance || []).filter((item) => item.status === 'pending').slice(-1).map((item) => <div className="yt-office-guidance" key={item.id}><span><b>Proposed guidance:</b> {item.text}</span><button onClick={() => guidanceAction(item, 'pin')}>Pin</button><button onClick={() => guidanceAction(item, 'approve')}>Save/edit rule</button><button onClick={() => guidanceAction(item, 'dismiss')}>Dismiss</button></div>)}
      <div className="yt-office-chat-compose">
        <textarea value={text} onChange={(event) => setText(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send() } }} rows={2} placeholder={`Talk to ${view?.agent.name || agentId}…`} />
        <button type="button" disabled={!text.trim() || sending} onClick={() => void send()}>Send</button>
      </div>
      {error && <div className="yt-office-chat-error">{error}</div>}
    </div>
  )
}
