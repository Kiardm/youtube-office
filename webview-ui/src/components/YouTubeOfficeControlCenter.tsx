import { useCallback, useEffect, useState } from 'react'

type Section = 'Office' | 'Projects' | 'Conversation History' | 'Worker Personalities' | 'Memory Center' | 'Providers' | 'Permissions' | 'Co-op Rooms' | 'Activity Log' | 'Backups and Updates'
type ProviderData = { assignments: Record<string, string>; providers: Array<{ id: string; displayName: string }>; status: Record<string, { installed: boolean; authenticated: boolean; version?: string; detail?: string }> }
type MemoryRecord = { id: string; role: string; kind: string; content: string; provenance: string; confidence: number; status: string; updated_at: string }
type Capability = { id: string; worker: string; scope: string; resource: string; duration: string; projectId?: string; reason: string; status: string }
type Backup = { id: string; label: string; createdAt: string; files: Array<{ name: string; bytes: number }> }
type CoopState = {
  mode?: string
  activeRoomId?: string | null
  invite?: Record<string, unknown> | null
  transport?: { lanPort?: number | null; lanAddresses?: string[]; lanPeers?: number; relayConnected?: boolean }
  sharedLog?: Array<{ id: string; senderLabel?: string; senderId?: string; type: string; summary?: string; status?: string }>
  finalReviews?: Array<{ artifactId: string; participantLabel?: string; participantId: string; decision: string; reason?: string }>
  artifacts?: Array<{ id: string; name: string; bytes: number; quarantined: boolean; sha256: string }>
}

const OFFICE_TOKEN = new URLSearchParams(window.location.search).get('officeToken') || 'browser-preview'
const BRIDGE = `http://127.0.0.1:3310/session/${encodeURIComponent(OFFICE_TOKEN)}`
const SECTIONS: Section[] = ['Office', 'Projects', 'Conversation History', 'Worker Personalities', 'Memory Center', 'Providers', 'Permissions', 'Co-op Rooms', 'Activity Log', 'Backups and Updates']

export function YouTubeOfficeControlCenter({ state, initialSection = 'Office', onClose }: { state: { agents?: Record<string, { name: string; role: string; personality: string; quirks?: string[] | string }>; timeline?: Array<{ id: string; timestamp: string; type: string; reason?: string; status?: string | null }>; activeProject?: { title: string } | null; coop?: { mode: string; activeRoomId?: string | null }; workday?: { reflections?: unknown[] } }; initialSection?: Section; onClose(): void }) {
  const [section, setSection] = useState<Section>(initialSection)
  const [providers, setProviders] = useState<ProviderData | null>(null)
  const [memories, setMemories] = useState<MemoryRecord[]>([])
  const [capabilities, setCapabilities] = useState<{ grants: Capability[]; requests: Capability[] }>({ grants: [], requests: [] })
  const [backups, setBackups] = useState<Backup[]>([])
  const [coop, setCoop] = useState<CoopState | null>(null)
  const [inviteText, setInviteText] = useState('')
  const [participantLabel, setParticipantLabel] = useState('Guest')
  const [connectUrl, setConnectUrl] = useState('')
  const [roomMessage, setRoomMessage] = useState('')
  const [roomAttachment, setRoomAttachment] = useState<File | null>(null)
  const [notice, setNotice] = useState('')

  const get = useCallback(async (url: string) => { const response = await fetch(`${BRIDGE}${url}`); if (!response.ok) throw new Error((await response.json()).error || 'Request failed'); return response.json() }, [])
  const post = useCallback(async (url: string, body: object = {}) => { const response = await fetch(`${BRIDGE}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); if (!response.ok) throw new Error((await response.json()).error || 'Request failed'); return response.json() }, [])
  const refresh = useCallback(async () => {
    try {
      const [p, m, c, b, room] = await Promise.all([get('/providers'), get('/memory'), get('/capabilities'), get('/backups'), get('/coop/status')])
      setProviders(p); setMemories(m.records || []); setCapabilities(c); setBackups(b.backups || []); setCoop(room)
    } catch (error) { setNotice(error instanceof Error ? error.message : 'Could not load local controls.') }
  }, [get])
  useEffect(() => { void refresh() }, [refresh])

  const action = async (operation: () => Promise<unknown>, success: string) => { try { await operation(); setNotice(success); await refresh() } catch (error) { setNotice(error instanceof Error ? error.message : 'Action failed.') } }
  const joinRoom = async () => {
    let invite: Record<string, unknown>
    try { invite = JSON.parse(inviteText) } catch { setNotice('Paste the complete invite JSON from the host.'); return }
    await action(() => post('/coop/join', { invite, label: participantLabel, url: connectUrl || undefined, kind: connectUrl.startsWith('wss://') ? 'relay' : 'lan' }), 'Joined the encrypted six-worker room.')
  }
  const sendRoomMessage = async () => {
    const text = roomMessage.trim(); if (!text) return
    await action(() => post('/coop/messages', { text, target: 'all-six' }), 'Encrypted message sent to both crews.')
    setRoomMessage('')
  }
  const sendRoomAttachment = async () => {
    if (!roomAttachment) return
    if (roomAttachment.size > 512 * 1024) { setNotice('This direct encrypted transport is limited to 512 KiB. Keep large media local until an approved resumable transfer is available.'); return }
    const data = new Uint8Array(await roomAttachment.arrayBuffer()); let binary = ''; for (const byte of data) binary += String.fromCharCode(byte)
    await action(() => post('/coop/artifacts', { name: roomAttachment.name, mimeType: roomAttachment.type, bytesBase64: btoa(binary) }), 'Attachment encrypted and sent to the other participant quarantine.')
    setRoomAttachment(null)
  }

  return <div className="yt-office-control-center" role="dialog" aria-label="YouTube Office 4.1 control center">
    <header><div><strong>YouTube Office 4.1</strong><span>Local control center</span></div><button onClick={onClose}>Close</button></header>
    <nav aria-label="Office sections">{SECTIONS.map((name) => <button key={name} data-active={section === name} onClick={() => setSection(name)}>{name}</button>)}</nav>
    {notice && <div className="yt-office-control-notice" role="status">{notice}</div>}
    <main>
      {section === 'Office' && <section><h2>Office</h2><p>The animated office remains the primary workspace. This control center keeps advanced settings out of the way.</p><button onClick={onClose}>Return to office</button><button onClick={() => action(() => post('/workday/end'), 'The End Workday meeting is complete. Any reusable lesson is waiting in Memory Center.')}>End Workday ({state.workday?.reflections?.length || 0} pending)</button></section>}
      {section === 'Projects' && <section><h2>Projects</h2><p>{state.activeProject ? `Active: ${state.activeProject.title}` : 'No project is active. Workers are idle.'}</p><p>Content repositories remain separate from the application and personal office database.</p></section>}
      {section === 'Conversation History' && <section><h2>Conversation History</h2><p>Open the History button in the permanent bottom chat dock to review the Whole Team or selected employee conversation at full size.</p></section>}
      {section === 'Worker Personalities' && <section><h2>Worker Personalities</h2>{Object.values(state.agents || {}).map((agent) => <article key={agent.name}><h3>{agent.name} · {agent.role}</h3><p>{agent.personality}</p><small>{Array.isArray(agent.quirks) ? agent.quirks.join(' · ') : agent.quirks}</small></article>)}</section>}
      {section === 'Memory Center' && <section><h2>Memory Center</h2><p>Facts may be saved automatically. Lessons and permanent changes wait for your approval.</p>{memories.map((memory) => <article key={memory.id}><h3>{memory.role} · {memory.kind} · {memory.status}</h3><p>{memory.content}</p><small>{memory.provenance} · confidence {Math.round(memory.confidence * 100)}%</small><div>{memory.status === 'proposed' && <><button onClick={() => action(() => post(`/memory/${memory.id}/approve`), 'Memory approved.')}>Approve</button><button onClick={() => action(() => post(`/memory/${memory.id}/reject`), 'Memory rejected.')}>Reject</button></>}<button onClick={() => action(() => post(`/memory/${memory.id}/forget`), 'Memory forgotten.')}>Forget</button></div></article>)}</section>}
      {section === 'Providers' && <section><h2>Providers</h2>{providers?.providers.map((provider) => <article key={provider.id}><h3>{provider.displayName}</h3><p>{providers.status[provider.id]?.installed ? `Installed · ${providers.status[provider.id]?.authenticated ? 'authenticated' : 'authentication needed'}` : 'Not installed'}</p><small>{providers.status[provider.id]?.version || providers.status[provider.id]?.detail}</small></article>)}{['researcher','editor','manager'].map((worker) => <label key={worker}>{worker}<select value={providers?.assignments[worker] || 'codex'} onChange={(event) => action(() => post('/providers/assign', { worker, provider: event.target.value }), `${worker} provider saved.`)}><option value="codex">Codex</option><option value="claude">Claude Code</option></select></label>)}</section>}
      {section === 'Permissions' && <section><h2>Permissions</h2><p>Chat is read-only by default. Production access is local, scoped, and auditable.</p>{capabilities.requests.filter((request) => request.status === 'pending').map((request) => <article key={request.id}><h3>{request.worker} requests {request.scope}</h3><p>{request.reason}</p><small>{request.duration} · {request.resource}</small><div><button onClick={() => action(() => post(`/capabilities/${request.id}/approve`), 'Local capability approved.')}>Approve</button><button onClick={() => action(() => post(`/capabilities/${request.id}/deny`), 'Capability denied.')}>Deny</button></div></article>)}{capabilities.requests.every((request) => request.status !== 'pending') && <p>No pending capability requests.</p>}</section>}
      {section === 'Co-op Rooms' && <section className="yt-office-coop-controls"><h2>Co-op Rooms</h2><p>Co-op shares only deliberate room messages, attachments, handoffs, and approved artifacts. Personal memory and credentials stay local.</p><p>Mode: {String(coop?.mode || state.coop?.mode || 'solo')}</p>{coop?.mode === 'solo' ? <>
        <button onClick={() => action(() => post('/coop/rooms', { label: 'Host' }), 'Encrypted co-op room created. Share the invite privately and verify the phrase out of band.')}>Create six-worker room</button>
        <h3>Join a room</h3>
        <label>Participant name<input value={participantLabel} onChange={(event) => setParticipantLabel(event.target.value)} /></label>
        <label>Host or relay WebSocket URL<input value={connectUrl} onChange={(event) => setConnectUrl(event.target.value)} placeholder="ws://192.168.1.20:12345" /></label>
        <label>Private invite JSON<textarea value={inviteText} onChange={(event) => setInviteText(event.target.value)} placeholder="Paste the host's complete invite JSON" /></label>
        <button onClick={() => void joinRoom()}>Verify and join room</button>
      </> : <>
        <article><h3>Encrypted room ready</h3><p>Room: {coop?.activeRoomId}</p><p>Verification phrase: {String(coop?.invite?.phrase || 'Ask the host and compare it outside the app')}</p>{coop?.transport?.lanAddresses?.map((address) => <code key={address}>ws://{address}:{coop.transport?.lanPort}</code>)}</article>
        <label>Internet relay WebSocket URL<input value={connectUrl} onChange={(event) => setConnectUrl(event.target.value)} placeholder="wss://relay.example.workers.dev/room/room-id" /></label>
        <button disabled={!/^wss:\/\//.test(connectUrl)} onClick={() => action(() => post('/coop/connect', { url: connectUrl, kind: 'relay' }), 'This office is connected to the encrypted Internet relay.')}>Connect this office to relay</button>
        {coop?.invite && <><label>Private invite JSON<textarea readOnly value={JSON.stringify(coop.invite, null, 2)} /></label><button onClick={() => navigator.clipboard.writeText(JSON.stringify(coop.invite))}>Copy private invite</button></>}
        <label>Room message<textarea value={roomMessage} onChange={(event) => setRoomMessage(event.target.value)} placeholder="Send only what you intend to share with both crews" /></label><button onClick={() => void sendRoomMessage()}>Send encrypted message</button>
        <label>Small attachment<input type="file" onChange={(event) => setRoomAttachment(event.target.files?.[0] || null)} /></label><button disabled={!roomAttachment} onClick={() => void sendRoomAttachment()}>Encrypt and send to quarantine</button>
        {(coop?.artifacts || []).length > 0 && <><h3>Incoming quarantine</h3>{(coop?.artifacts || []).map((artifact) => <article key={artifact.id}><h3>{artifact.name}</h3><p>{artifact.bytes} bytes · SHA-256 {artifact.sha256}</p><small>{artifact.quarantined ? 'Quarantined — never opened or executed automatically' : 'Approved for local access'}</small>{artifact.quarantined && <button onClick={() => action(() => post(`/coop/artifacts/${artifact.id}/approve`), `${artifact.name} approved for local access.`)}>Approve locally</button>}</article>)}</>}
        <h3>Shared room log</h3>{(coop?.sharedLog || []).slice(-20).reverse().map((entry) => <article key={entry.id}><h3>{entry.senderLabel || entry.senderId || 'Local participant'} · {entry.type}</h3><p>{entry.summary || entry.status}</p></article>)}
        <button onClick={() => action(() => post('/coop/leave'), 'Left co-op and returned to solo mode.')}>Leave room</button>
      </>}</section>}
      {section === 'Activity Log' && <section><h2>Activity Log</h2>{(state.timeline || []).slice(-100).reverse().map((event) => <article key={event.id}><h3>{event.type.replaceAll('_', ' ')} · {event.status || 'recorded'}</h3><p>{event.reason}</p><small>{new Date(event.timestamp).toLocaleString()}</small></article>)}</section>}
      {section === 'Backups and Updates' && <section><h2>Backups and Updates</h2><button onClick={() => action(() => post('/backups', { label: 'manual' }), 'Local application, prompt, state, and memory snapshot created.')}>Create backup now</button>{backups.map((backup) => <article key={backup.id}><h3>{backup.label}</h3><p>{new Date(backup.createdAt).toLocaleString()}</p><small>{backup.files.map((file) => file.name).join(' · ')}</small></article>)}</section>}
    </main>
  </div>
}
