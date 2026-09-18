const fs = require('fs')
const http = require('http')
const path = require('path')
const { execFile } = require('child_process')
const WS = require('ws')
const { WebSocketServer } = WS
const { versions: PROMPT_VERSIONS, buildWorkerPrompt, buildChatPrompt, APPROVED_RULES_FILE } = require('./prompts')
const { contentRoot: CONTENT_ROOT, dataDir: DATA_DIR, configFile: CONFIG_FILE, config: LOCAL_CONFIG } = require('./paths')
const { ProviderRegistry } = require('./core/provider-registry')
const { MemoryStore } = require('./core/memory-store')
const { CapabilityBroker } = require('./core/capability-broker')
const { BackupManager } = require('./core/backup-manager')
const { RoomService } = require('./coop/room-service')
const { CoopTransport } = require('./coop/transport')
const { ArtifactStore } = require('./coop/artifact-store')
const { MANAGER_ESCALATION_TRIGGERS, managerModels, parseManagerEscalation, premiumUsageGate, modelLabel } = require('./core/manager-routing')
// Pixel Office's reporter expects the EventEmitter-style `ws` API. Node 24
// also exposes a browser-style global WebSocket, so pin the reporter to `ws`.
globalThis.WebSocket = WS
const { createPixelReporter } = require('../reporter-sdk')

const HOST = '127.0.0.1'
const PORT = Number(process.env.YOUTUBE_OFFICE_PORT || 3310)
const STATE_FILE = path.join(DATA_DIR, 'office-state.json')
const EVENT_FILE = path.join(DATA_DIR, 'activity.jsonl')
const ROOM_DATA_DIR = path.join(DATA_DIR, 'rooms')
const MAX_BODY = 1024 * 1024
const USAGE_STALE_MS = Number(process.env.YOUTUBE_OFFICE_USAGE_STALE_MS || 15 * 60 * 1000)
const DESKTOP_CONNECTION_STALE_MS = Number(process.env.YOUTUBE_OFFICE_DESKTOP_STALE_MS || 12 * 1000)
const APP_VERSION = '4.1.2'
const SESSION_TOKEN = process.env.YOUTUBE_OFFICE_SESSION_TOKEN || 'browser-preview'
const CODEX_BIN = process.env.YOUTUBE_OFFICE_CODEX_BIN || 'codex'
const CODEX_PREFIX_ARGS = (() => {
  try { return JSON.parse(process.env.YOUTUBE_OFFICE_CODEX_PREFIX_ARGS || '[]') } catch { return [] }
})()
const CHAT_MODELS = { researcher: 'gpt-5.6-luna', editor: 'gpt-5.6-terra', manager: 'gpt-5.6-terra' }
const CLAUDE_MODELS = { researcher: 'haiku', editor: 'sonnet', manager: 'sonnet' }
const AGENT_IDS = Object.freeze(Object.keys(CHAT_MODELS))
const CHAT_TIMEOUT_MS = 90 * 1000
const APP_ROOT = path.resolve(__dirname, '..')
const providerRegistry = new ProviderRegistry({ assignments: LOCAL_CONFIG.providerAssignments })
const memoryStore = new MemoryStore(DATA_DIR)
const backupManager = new BackupManager(DATA_DIR, APP_ROOT)
const roomService = new RoomService(DATA_DIR)
const artifactStore = new ArtifactStore(DATA_DIR)
const coopTransport = new CoopTransport((raw, channel) => {
  try {
    const envelope = JSON.parse(raw)
    const payload = roomService.openEnvelope(state.coop.activeRoomId, envelope)
    if (envelope.senderId === roomService.identity.id) return
    const logEntry = { id: envelope.nonce, senderId: envelope.senderId, senderLabel: envelope.senderLabel, type: envelope.type, channel, receivedAt: nowIso(), status: 'verified', summary: envelope.type === 'message' ? cleanText(payload.text, 500) : envelope.type }
    state.coop.sharedLog = [...state.coop.sharedLog, logEntry].slice(-500); appendRoomLog(logEntry)
    const participant = { id: cleanText(envelope.senderId, 160), label: cleanText(envelope.senderLabel || 'Participant', 80), publicKey: cleanText(envelope.senderPublicKey, 1000) }
    state.coop.participants = [...(state.coop.participants || []).filter((item) => item.id !== participant.id), participant].slice(-8)
    appendEvent('coop_envelope_received', { status: 'verified', reason: `Signed encrypted ${envelope.type || 'room'} envelope from ${cleanText(envelope.senderLabel || envelope.senderId, 80)} was verified over ${channel}.` })
    if (envelope.type === 'join' || envelope.type === 'join-ack' || envelope.type === 'crew-status') {
      const workers = sanitizeRemoteWorkers(payload.workers)
      state.coop.remoteCrews = [...(state.coop.remoteCrews || []).filter((crew) => crew.participantId !== participant.id), { participantId: participant.id, participantLabel: participant.label, workers, lastUpdateAt: nowIso() }].slice(-2)
      if (envelope.type === 'join') sendCoopEnvelope('join-ack', { participantId: roomService.identity.id, participantLabel: localParticipantLabel(), workers: localCrewSnapshot(), joinedAt: nowIso() })
    }
    if (envelope.type === 'project-started') {
      const project = { id: cleanText(payload.projectId, 80), title: cleanText(payload.title, 180), participantId: participant.id, participantLabel: participant.label, status: 'available', startedAt: cleanText(payload.startedAt || nowIso(), 50) }
      if (project.id && project.title) state.coop.pendingProjects = [...(state.coop.pendingProjects || []).filter((item) => item.id !== project.id), project].slice(-25)
    }
    if (envelope.type === 'project-joined') {
      state.coop.pendingProjects = (state.coop.pendingProjects || []).map((item) => item.id === cleanText(payload.projectId, 80) ? { ...item, status: 'joined', joinedBy: participant.label } : item)
    }
    if (envelope.type === 'role-handoff') {
      const handoff = { projectId: cleanText(payload.projectId, 80), role: cleanText(payload.role, 30), participantId: participant.id, participantLabel: participant.label, summary: cleanText(payload.summary, 1200), completedAt: cleanText(payload.completedAt || nowIso(), 50) }
      state.coop.roleHandoffs = [...(state.coop.roleHandoffs || []).filter((item) => !(item.projectId === handoff.projectId && item.role === handoff.role && item.participantId === handoff.participantId)), handoff].slice(-100)
    }
    if (envelope.type === 'project-completed') {
      state.coop.pendingProjects = (state.coop.pendingProjects || []).map((item) => item.id === cleanText(payload.projectId, 80) ? { ...item, status: 'completed', completedBy: participant.label } : item)
    }
    if (envelope.type === 'manager-review') {
      const outcome = recordCoopManagerReview({ ...payload, participantId: envelope.senderId, participantLabel: envelope.senderLabel })
      appendEvent('coop_manager_review', { agent: 'manager', status: outcome.status, reason: `${envelope.senderLabel || envelope.senderId}: ${outcome.review.decision} — ${outcome.review.reason}` })
      if (outcome.status === 'human-escalation-required') void runCoopDisagreementEscalation(outcome)
    }
    if (envelope.type === 'artifact') {
      const encoded = String(payload.bytesBase64 || '')
      const bytes = Buffer.from(encoded, 'base64')
      if (!encoded || bytes.length > 512 * 1024) throw new Error('Incoming attachment exceeds the quarantine limit')
      const artifact = artifactStore.receive({ ownerParticipantId: envelope.senderId, taskId: cleanText(payload.taskId, 160), name: cleanText(payload.name, 240), mimeType: cleanText(payload.mimeType, 120), bytes })
      state.coop.artifacts = [...(state.coop.artifacts || []), artifact].slice(-100)
      logEntry.summary = `${artifact.name} · ${artifact.bytes} bytes · quarantined`
      appendEvent('coop_artifact_quarantined', { status: 'quarantined', reason: `${artifact.name} was received, verified, and quarantined. It will not be opened or executed until locally approved.`, output: artifact.path })
    }
    persistState(); broadcast('coop')
  } catch {}
})

const AGENT_DEFS = {
  researcher: {
    name: 'Researcher',
    role: 'Researcher / Planner',
    model: 'gpt-5.6-luna · medium',
    personality: 'Curious, trend-aware, and skeptical of weak sources.',
    quirks: ['Calls strong leads a hot trail', 'Collects sticky notes and celebrates sources that have receipts'],
  },
  editor: {
    name: 'Editor',
    role: 'Creative Director / Editor',
    model: 'gpt-5.6-terra · medium',
    personality: 'Blunt, evidence-led, and protective of pacing and payoff.',
    quirks: ['Counts dead-air seconds', 'Rechecks transitions until the coffee goes cold'],
  },
  manager: {
    name: 'Manager',
    role: 'Manager / Publisher',
    model: 'Codex · gpt-5.6-terra · low chat / medium production',
    personality: 'Cost-conscious, profit-focused, and strict about final quality.',
    quirks: ['Keeps a framed first dollar and guards the snack budget', 'Uses an approval stamp or desk bell'],
  },
}

function cleanText(value, max = 500) {
  return String(value ?? '')
    .replace(/(bearer\s+|api[_-]?key[=:]\s*|token[=:]\s*|cookie[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
}

function nowIso() { return new Date().toISOString() }

function sanitizeRemoteWorkers(workers) {
  const allowed = new Set(AGENT_IDS)
  return (Array.isArray(workers) ? workers : []).filter((worker) => allowed.has(worker?.role)).map((worker) => ({
    role: worker.role,
    name: cleanText(worker.name || AGENT_DEFS[worker.role].name, 80),
    status: cleanText(worker.status || 'waiting', 30),
    currentTask: cleanText(worker.currentTask || 'Waiting for shared work', 180),
    model: cleanText(worker.model || '', 80),
  })).slice(0, 3)
}

function localParticipantLabel() {
  return cleanText(state?.coop?.invite?.participant?.label || roomService.identity.label || 'Local participant', 80)
}

function localCrewSnapshot() {
  return AGENT_IDS.map((role) => ({ role, name: state.agents[role].name, status: state.agents[role].status, currentTask: state.agents[role].currentTask, model: state.agents[role].model }))
}

function sendCoopEnvelope(type, payload) {
  if (!state?.coop?.activeRoomId || state.coop.mode === 'solo') return false
  try { coopTransport.send(roomService.makeEnvelope(state.coop.activeRoomId, type, payload)); return true } catch { return false }
}

function coopCounterpartContext(role, projectId) {
  const handoffs = (state.coop?.roleHandoffs || []).filter((item) => item.projectId === projectId && item.role === role)
  if (!handoffs.length) return 'No remote counterpart handoff is available yet; continue independently and publish a concise encrypted handoff when finished.'
  return handoffs.map((item) => `${item.participantLabel}: ${item.summary}`).join('\n')
}

function emptyCost() {
  return { status: 'unknown', inputTokens: null, outputTokens: null, estimatedUsd: null }
}

function defaultState() {
  const emptyRuntime = () => ({ messageId: null, processId: null, startedAt: null })
  const emptyMetrics = (agentId) => ({ model: CHAT_MODELS[agentId], started: 0, completed: 0, blocked: 0, failed: 0, totalDurationMs: 0, billingSource: 'unknown' })
  return {
    version: 10,
    appVersion: APP_VERSION,
    updatedAt: nowIso(),
    mode: 'idle',
    activeProject: null,
    promptVersions: { ...PROMPT_VERSIONS },
    desktopConnection: { connected: false, status: 'required', checkedAt: null, threadId: null, deliveryMode: null },
    roleChallenges: [],
    meeting: null,
    reviewReminders: [],
    projectLessons: [],
    workday: { openedAt: nowIso(), reflections: [], endedAt: null, meetingProposals: [] },
    providerAssignments: { ...providerRegistry.assignments },
    capabilityGrants: [],
    capabilityRequests: [],
    coop: { activeRoomId: null, mode: 'solo', participants: [], remoteCrews: [], pendingProjects: [], roleHandoffs: [], sharedLog: [], finalReviews: [], managerEscalations: [], artifacts: [] },
    agentChats: { researcher: [], editor: [], manager: [] },
    teamConversations: [],
    chatQueues: Object.fromEntries(AGENT_IDS.map((id) => [id, []])),
    chatRuntime: Object.fromEntries(AGENT_IDS.map((id) => [id, emptyRuntime()])),
    chatMetrics: Object.fromEntries(AGENT_IDS.map((id) => [id, emptyMetrics(id)])),
    guidanceItems: [],
    approvedRules: [],
    stageDurationHistory: { researcher: [], editor: [], manager: [] },
    managerRouting: { policy: 'adaptive', routineModel: 'gpt-5.6-terra', premiumModel: 'gpt-6-astra', premiumLimitPerProject: 1 },
    usage: {
      fiveHourUsedPercent: null,
      weeklyUsedPercent: null,
      ordinaryUsageAllowed: null,
      policy: 'unknown',
      source: null,
      checkedAt: null,
      resetsAt: { primary: null, secondary: null },
      creditsAvailable: null,
      note: 'Exact usage unavailable — your local signed-in provider will enforce its limits.',
    },
    agents: Object.fromEntries(Object.entries(AGENT_DEFS).map(([id, def]) => [id, {
      id,
      ...def,
      status: 'waiting',
      currentTask: 'Waiting for work',
      processId: null,
      startedAt: null,
      endedAt: null,
      exitCode: null,
      lastUpdateAt: nowIso(),
    }])),
    messages: [],
    outputs: [],
    timeline: [],
    recovery: null,
  }
}

function loadState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
    const base = defaultState()
    const legacyQueue = Array.isArray(parsed.chatQueue) ? parsed.chatQueue : []
    const restored = {
      ...base,
      ...parsed,
      version: 10,
      appVersion: APP_VERSION,
      usage: { ...base.usage, ...(parsed.usage || {}) },
      // The current installed prompt bundle is authoritative. Persisted hashes
      // may belong to an older build or a checkout with different newlines.
      promptVersions: { ...base.promptVersions },
      desktopConnection: { ...base.desktopConnection, ...(parsed.desktopConnection || {}), connected: false },
      roleChallenges: Array.isArray(parsed.roleChallenges) ? parsed.roleChallenges.slice(-100) : [],
      meeting: parsed.meeting && typeof parsed.meeting === 'object' ? parsed.meeting : null,
      reviewReminders: Array.isArray(parsed.reviewReminders) ? parsed.reviewReminders.slice(-100) : [],
      projectLessons: Array.isArray(parsed.projectLessons) ? parsed.projectLessons.slice(-100) : [],
      workday: { ...base.workday, ...(parsed.workday || {}), reflections: Array.isArray(parsed.workday?.reflections) ? parsed.workday.reflections.slice(-300) : [], meetingProposals: Array.isArray(parsed.workday?.meetingProposals) ? parsed.workday.meetingProposals.slice(-100) : [] },
      providerAssignments: { ...base.providerAssignments, ...(parsed.providerAssignments || {}) },
      capabilityGrants: Array.isArray(parsed.capabilityGrants) ? parsed.capabilityGrants.slice(-500) : [],
      capabilityRequests: Array.isArray(parsed.capabilityRequests) ? parsed.capabilityRequests.slice(-200) : [],
      coop: { ...base.coop, ...(parsed.coop || {}), participants: Array.isArray(parsed.coop?.participants) ? parsed.coop.participants.slice(-8) : [], remoteCrews: Array.isArray(parsed.coop?.remoteCrews) ? parsed.coop.remoteCrews.slice(-2) : [], pendingProjects: Array.isArray(parsed.coop?.pendingProjects) ? parsed.coop.pendingProjects.slice(-25) : [], roleHandoffs: Array.isArray(parsed.coop?.roleHandoffs) ? parsed.coop.roleHandoffs.slice(-100) : [], sharedLog: Array.isArray(parsed.coop?.sharedLog) ? parsed.coop.sharedLog.slice(-500) : [], finalReviews: Array.isArray(parsed.coop?.finalReviews) ? parsed.coop.finalReviews.slice(-100) : [], managerEscalations: Array.isArray(parsed.coop?.managerEscalations) ? parsed.coop.managerEscalations.slice(-50) : [], artifacts: Array.isArray(parsed.coop?.artifacts) ? parsed.coop.artifacts.slice(-100) : [] },
      agentChats: Object.fromEntries(Object.keys(base.agentChats).map((id) => [id, Array.isArray(parsed.agentChats?.[id]) ? parsed.agentChats[id].slice(-100) : []])),
      teamConversations: Array.isArray(parsed.teamConversations) ? parsed.teamConversations.slice(-100) : [],
      chatQueues: Object.fromEntries(AGENT_IDS.map((id) => [id,
        (Array.isArray(parsed.chatQueues?.[id]) ? parsed.chatQueues[id] : legacyQueue.filter((item) => item.agentId === id)).slice(-100),
      ])),
      chatRuntime: { ...base.chatRuntime },
      chatMetrics: Object.fromEntries(AGENT_IDS.map((id) => [id, { ...base.chatMetrics[id], ...(parsed.chatMetrics?.[id] || {}) }])),
      guidanceItems: Array.isArray(parsed.guidanceItems) ? parsed.guidanceItems.slice(-200) : [],
      approvedRules: Array.isArray(parsed.approvedRules) ? parsed.approvedRules.slice(-200) : [],
      stageDurationHistory: Object.fromEntries(Object.keys(base.stageDurationHistory).map((id) => [id, Array.isArray(parsed.stageDurationHistory?.[id]) ? parsed.stageDurationHistory[id].slice(-30) : []])),
      managerRouting: { ...base.managerRouting, ...(parsed.managerRouting || {}) },
      timeline: Array.isArray(parsed.timeline) ? parsed.timeline.slice(-300) : [],
      agents: Object.fromEntries(Object.entries(base.agents).map(([id, agent]) => [id, {
        ...agent,
        ...(parsed.agents?.[id] || {}),
        model: agent.model,
        status: 'waiting',
        currentTask: 'Waiting for work', processId: null,
      }])),
    }
    if (parsed.activeProject && ['working', 'cancelling', 'recovery', 'blocked', 'office_review'].includes(parsed.mode)) {
      restored.mode = 'recovery'
      restored.recovery = { required: true, detectedAt: nowIso(), reason: 'Bridge restarted during an active pipeline.' }
      for (const id of Object.keys(restored.agents)) {
        restored.agents[id].status = 'blocked'
        restored.agents[id].currentTask = 'Interrupted by bridge restart; waiting for an explicit restart or cancellation'
      }
    }
    delete restored.chatQueue
    delete restored.usage.localProductionAuthorized
    delete restored.usage.localProductionAuthorizedAt
    delete restored.usage.localProductionProviderIds
    return restored
  } catch {
    return defaultState()
  }
}

fs.mkdirSync(DATA_DIR, { recursive: true })
let state = loadState()
for (const [worker, provider] of Object.entries(state.providerAssignments || {})) {
  try { providerRegistry.assign(worker, provider) } catch {}
}
const capabilityBroker = new CapabilityBroker(state.capabilityGrants)
let clients = new Set()
let pipelineRunning = false
let activeCodexProcess = null
let activeWorker = null
let cancelRequested = false
const activeChatProcesses = Object.fromEntries(AGENT_IDS.map((id) => [id, null]))

function persistState() {
  state.updatedAt = new Date().toISOString()
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n')
}

function appendEvent(type, data = {}) {
  const safeGit = data.git && typeof data.git === 'object' ? {
    repository: cleanText(data.git.repository, 500),
    checkedAt: cleanText(data.git.checkedAt, 50),
    status: data.git.status ? { ok: Boolean(data.git.status.ok), output: cleanText(data.git.status.output, 2000) } : null,
    log: data.git.log ? { ok: Boolean(data.git.log.ok), output: cleanText(data.git.log.output, 2000) } : null,
    diff: data.git.diff ? { ok: Boolean(data.git.diff.ok), output: cleanText(data.git.diff.output, 2000) } : null,
  } : null
  const safeCost = data.cost && typeof data.cost === 'object' ? {
    status: cleanText(data.cost.status || 'unknown', 30),
    inputTokens: Number.isFinite(data.cost.inputTokens) ? data.cost.inputTokens : null,
    outputTokens: Number.isFinite(data.cost.outputTokens) ? data.cost.outputTokens : null,
    estimatedUsd: Number.isFinite(data.cost.estimatedUsd) ? data.cost.estimatedUsd : null,
  } : emptyCost()
  const event = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: nowIso(),
    type: cleanText(type, 50),
    agent: data.agent ? cleanText(data.agent, 30) : null,
    reason: cleanText(data.reason || data.summary || data.task || '', 500),
    evidence: Array.isArray(data.evidence) ? data.evidence.map((v) => cleanText(v, 300)).slice(0, 12) : [],
    output: data.output ? cleanText(data.output, 500) : null,
    git: safeGit,
    cost: safeCost,
    projectId: data.projectId ? cleanText(data.projectId, 80) : null,
    status: data.status ? cleanText(data.status, 40) : null,
    processId: Number.isInteger(data.processId) ? data.processId : null,
    model: data.model ? cleanText(data.model, 80) : null,
    reasoning: data.reasoning ? cleanText(data.reasoning, 20) : null,
    escalationTrigger: data.escalationTrigger ? cleanText(data.escalationTrigger, 80) : null,
  }
  fs.appendFileSync(EVENT_FILE, JSON.stringify(event) + '\n')
  state.timeline = [...(state.timeline || []).slice(-299), event]
  return event
}

function appendRoomLog(entry) {
  if (!state.coop?.activeRoomId) return
  const roomDir = path.join(ROOM_DATA_DIR, safeProjectName(state.coop.activeRoomId))
  fs.mkdirSync(roomDir, { recursive: true })
  fs.appendFileSync(path.join(roomDir, 'shared-log.jsonl'), JSON.stringify({ ...entry, summary: cleanText(entry.summary, 500) }) + '\n')
}

function recordCoopManagerReview(review) {
  const clean = { artifactId: cleanText(review.artifactId, 160), participantId: cleanText(review.participantId, 160), participantLabel: cleanText(review.participantLabel, 80), decision: review.decision === 'pass' ? 'pass' : 'reject', reason: cleanText(review.reason, 500), reviewedAt: review.reviewedAt || nowIso() }
  state.coop.finalReviews = [...(state.coop.finalReviews || []).filter((item) => !(item.artifactId === clean.artifactId && item.participantId === clean.participantId)), clean].slice(-100)
  const reviews = state.coop.finalReviews.filter((item) => item.artifactId === clean.artifactId)
  const decisions = new Set(reviews.map((item) => item.decision))
  return { review: clean, status: reviews.length >= 2 && decisions.size === 1 && decisions.has('pass') ? 'approved-by-both-managers' : decisions.size > 1 ? 'human-escalation-required' : 'awaiting-second-manager', reviews }
}

function usageIsFresh(at = Date.now()) {
  const checked = Date.parse(state.usage?.checkedAt || '')
  return Number.isFinite(checked) && checked <= at + 60 * 1000 && at - checked <= USAGE_STALE_MS
}

function usageGate(at = Date.now()) {
  if (!usageIsFresh(at)) return { allowed: false, reason: 'Usage snapshot is absent or stale.' }
  if (state.usage.ordinaryUsageAllowed !== true) return { allowed: false, reason: 'Ordinary usage is not allowed by the latest snapshot.' }
  return { allowed: true, reason: 'Fresh usage snapshot permits ordinary usage.' }
}

function assignedProductionProviderIds() {
  return [...new Set(AGENT_IDS.map((id) => providerRegistry.assignments[id] || providerRegistry.assignments.office || 'codex'))]
}

async function resolveUsageAuthorization() {
  if (usageIsFresh()) {
    if (state.usage.ordinaryUsageAllowed !== true) return { allowed: false, reason: 'Ordinary usage is not allowed by the latest snapshot.', code: 'usage-blocked' }
    return { allowed: true, authorization: { mode: 'usage-snapshot', providerIds: assignedProductionProviderIds(), authorizedAt: nowIso(), source: state.usage.source || 'trusted-snapshot' } }
  }
  const statuses = await providerRegistry.statuses()
  const providerIds = assignedProductionProviderIds()
  const unavailable = providerIds.filter((id) => !statuses[id]?.installed || !statuses[id]?.authenticated)
  if (unavailable.length) {
    return {
      allowed: false,
      code: 'provider-authentication-required',
      reason: `Sign in to the locally assigned provider(s) in Controls → Providers: ${unavailable.join(', ')}.`,
      providers: statuses,
    }
  }
  return { allowed: true, authorization: { mode: 'local-provider', providerIds, authorizedAt: nowIso(), source: 'local-authenticated-provider' } }
}

function projectUsageGate(project) {
  if (project?.usageAuthorization?.mode === 'local-provider' || project?.usageAuthorization?.mode === 'usage-snapshot') {
    return { allowed: true, reason: `Project authorized through ${project.usageAuthorization.mode}.` }
  }
  return usageGate()
}

function visibleState() {
  const desktopCheckedAt = Date.parse(state.desktopConnection?.checkedAt || '')
  const desktopFresh = Boolean(state.desktopConnection?.connected) && Number.isFinite(desktopCheckedAt) && Date.now() - desktopCheckedAt <= DESKTOP_CONNECTION_STALE_MS
  const { agentChats: _privateChats, chatQueues: _privateQueues, teamConversations: _privateTeamConversations, ...publicState } = state
  const visible = {
    ...publicState,
    chatRuntime: Object.fromEntries(AGENT_IDS.map((id) => [id, { ...state.chatRuntime[id], messageId: null }])),
    desktopConnection: { ...state.desktopConnection, connected: desktopFresh, status: desktopFresh ? 'connected' : 'required' },
  }
  if (usageIsFresh()) return visible
  return {
    ...visible,
    usage: {
      ...state.usage,
      fiveHourUsedPercent: null,
      weeklyUsedPercent: null,
      ordinaryUsageAllowed: null,
      policy: 'provider-managed',
      source: null,
      checkedAt: null,
      note: 'Exact usage unavailable — your local signed-in provider will enforce its limits.',
    },
  }
}

if (state.mode === 'recovery') {
  appendEvent('restart_recovery_required', {
    projectId: state.activeProject?.id,
    status: 'recovery',
    reason: state.recovery?.reason || 'Interrupted work requires an explicit restart or cancellation.',
    evidence: state.activeProject?.completedStages || [],
  })
}

function broadcast(type = 'state') {
  const payload = JSON.stringify({ type, state: visibleState() })
  for (const client of clients) {
    if (client.readyState === 1) client.send(payload)
  }
}

const reporters = {}
const reporterTools = {}
const reporterConnected = {}
for (const [id, def] of Object.entries(AGENT_DEFS)) {
  reporters[id] = createPixelReporter({
    serverUrl: process.env.PIXEL_OFFICE_SERVER || 'ws://127.0.0.1:3300/ws/report',
    machineId: `youtube-office-${id}`,
    agentName: def.name,
    persistent: true,
    silent: true,
  })
  reporters[id].connect()
  reporterConnected[id] = true
}

function ensureReporter(id) {
  if (!reporterConnected[id]) {
    reporters[id].connect()
    reporterConnected[id] = true
  }
}

function reporterStatus(id, status, task) {
  const reporter = reporters[id]
  if (!reporter) return
  if (status === 'waiting' && !reporterConnected[id]) return
  ensureReporter(id)
  if (reporterTools[id]) {
    reporter.toolEnd(reporterTools[id])
    delete reporterTools[id]
  }
  if (status === 'waiting') {
    reporter.taskEnd()
    return
  }
  reporter.taskStart(task || `${AGENT_DEFS[id].name} task`)
  const tool = status === 'researching' ? 'WebSearch'
    : status === 'editing' ? 'Edit'
      : status === 'reviewing' ? 'Review'
        : status === 'uploading' ? 'Publish'
          : status === 'blocked' ? 'NeedsApproval'
            : 'Task'
  reporter.toolStart(tool, { summary: cleanText(task, 120) })
  reporterTools[id] = tool
}

function updateAgent(id, status, task, lifecycle = {}) {
  if (!state.agents[id]) throw new Error(`Unknown agent: ${id}`)
  const allowed = new Set(['waiting', 'working', 'researching', 'editing', 'reviewing', 'uploading', 'blocked'])
  if (!allowed.has(status)) throw new Error(`Invalid status: ${status}`)
  state.agents[id] = {
    ...state.agents[id],
    status,
    currentTask: cleanText(task || (status === 'waiting' ? 'Waiting for work' : status), 180),
    processId: lifecycle.processId === undefined ? state.agents[id].processId : lifecycle.processId,
    startedAt: lifecycle.startedAt === undefined ? state.agents[id].startedAt : lifecycle.startedAt,
    endedAt: lifecycle.endedAt === undefined ? state.agents[id].endedAt : lifecycle.endedAt,
    exitCode: lifecycle.exitCode === undefined ? state.agents[id].exitCode : lifecycle.exitCode,
    model: lifecycle.model === undefined ? (status === 'waiting' ? AGENT_DEFS[id].model : state.agents[id].model) : cleanText(lifecycle.model, 100),
    lastUpdateAt: nowIso(),
  }
  reporterStatus(id, status, state.agents[id].currentTask)
  sendCoopEnvelope('crew-status', { participantId: roomService.identity.id, participantLabel: localParticipantLabel(), workers: localCrewSnapshot(), updatedAt: nowIso() })
}

function addMessage(from, to, summary, kind = 'update', evidence = []) {
  if (!state.agents[from]) throw new Error(`Unknown sender: ${from}`)
  const message = {
    id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    timestamp: new Date().toISOString(),
    from,
    to: cleanText(to || 'user', 40),
    kind: cleanText(kind, 30),
    summary: cleanText(summary, 500),
    evidence: Array.isArray(evidence) ? evidence.map((item) => cleanText(item, 300)).slice(0, 8) : [],
    readInChat: false,
  }
  state.messages = [...state.messages.slice(-199), message]
  appendEvent('message', message)
  return message
}

function extractReflection(file, fallback) {
  try {
    const content = fs.readFileSync(file, 'utf8')
    const match = content.match(/(?:^|\n)#{1,3}\s*Reflection\s*\n([\s\S]*?)(?=\n#{1,3}\s|$)/i)
    return cleanText(match?.[1] || fallback, 420)
  } catch {
    return cleanText(fallback, 420)
  }
}

function createReviewReminders(project, managerFile, completedAt) {
  let published = false
  try { published = /(?:published|visibility)[^\n]{0,80}(?:public|success)/i.test(fs.readFileSync(managerFile, 'utf8')) } catch {}
  if (!published) return []
  const base = Date.parse(completedAt)
  return [3, 21].map((days) => ({
    id: `review-${project.id}-${days}d`, projectId: project.id, title: project.title,
    dueAt: new Date(base + days * 86400000).toISOString(), status: 'pending', activatedAt: null,
    note: `Local ${days}-day performance reminder. No model work starts without explicit approval.`,
  }))
}

function json(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': 'http://127.0.0.1:3300',
    'Vary': 'Origin',
    'Cache-Control': 'no-store',
  })
  res.end(JSON.stringify(body))
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > MAX_BODY) reject(new Error('Request too large'))
    })
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}) } catch { reject(new Error('Invalid JSON')) }
    })
    req.on('error', reject)
  })
}

function git(args) {
  return new Promise((resolve) => {
    execFile('git', ['-C', CONTENT_ROOT, ...args], { windowsHide: true, timeout: 5000 }, (error, stdout, stderr) => {
      resolve({ ok: !error, output: cleanText(stdout || stderr || '', 12000) })
    })
  })
}

async function getGitSnapshot() {
  const [status, log, diff] = await Promise.all([
    git(['status', '--short', '--branch']),
    git(['log', '-8', '--pretty=format:%h|%an|%s|%ar']),
    git(['diff', '--stat']),
  ])
  return { repository: CONTENT_ROOT, status, log, diff, checkedAt: new Date().toISOString() }
}

function runStatus(file, args, options = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: 8000, ...options }, (error, stdout, stderr) => {
      resolve({ ok: !error, output: cleanText(stdout || stderr || '', 1000) })
    })
  })
}

async function getInstallationStatus() {
  const [codexVersion, codexLogin, updateCount, providers] = await Promise.all([
    runStatus(CODEX_BIN, [...CODEX_PREFIX_ARGS, '--version']),
    runStatus(CODEX_BIN, [...CODEX_PREFIX_ARGS, 'login', 'status']),
    runStatus('git', ['-C', APP_ROOT, 'rev-list', '--count', 'HEAD..@{upstream}']),
    providerRegistry.statuses(),
  ])
  const behind = updateCount.ok && /^\d+$/.test(updateCount.output) ? Number(updateCount.output) : null
  return {
    appVersion: APP_VERSION,
    contentRoot: CONTENT_ROOT,
    dataDir: DATA_DIR,
    configFile: CONFIG_FILE,
    codex: {
      installed: codexVersion.ok,
      version: codexVersion.ok ? codexVersion.output : null,
      authenticated: codexLogin.ok && /logged in/i.test(codexLogin.output),
      status: codexLogin.ok ? codexLogin.output : 'Codex sign-in is required or unavailable.',
    },
    providers,
    providerAssignments: { ...providerRegistry.assignments },
    prompts: {
      localMasterPrompt: fs.existsSync(path.join(CONTENT_ROOT, 'MASTER_PROMPT.md')),
      approvedRules: fs.existsSync(APPROVED_RULES_FILE),
      versions: state.promptVersions,
    },
    updates: {
      status: behind == null ? 'unknown' : behind > 0 ? 'available' : 'current',
      commitsBehind: behind,
      note: behind == null ? 'Run git fetch to refresh repository update information.' : behind > 0 ? `${behind} approved update(s) are available.` : 'This installation matches its last fetched upstream state.',
    },
  }
}

function chatMessage(agentId, author, text, status = 'queued', extra = {}) {
  const message = {
    id: `chat-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    agentId, author, text: cleanText(text, 4000), createdAt: nowIso(), status,
    ...extra,
  }
  state.agentChats[agentId] = [...state.agentChats[agentId].slice(-99), message]
  return message
}

function timingSummary(agentId) {
  const samples = (state.stageDurationHistory?.[agentId] || []).filter(Number.isFinite).sort((a, b) => a - b)
  if (samples.length < 3) return { reliable: false, message: 'No reliable ETA exists yet; fewer than three completed stages are recorded.' }
  const median = samples[Math.floor(samples.length / 2)]
  return { reliable: true, samples: samples.length, medianSeconds: Math.round(median), rangeSeconds: [Math.round(samples[0]), Math.round(samples[samples.length - 1])] }
}

function localMemoryContext(agentId) {
  const records = [...memoryStore.list({ role: agentId, status: 'approved', limit: 20 }), ...memoryStore.list({ role: 'shared', status: 'approved', limit: 20 })].slice(0, 30)
  return records.length ? `Approved local memory (facts and user-approved lessons only):\n${records.map((record) => `- [${record.kind}; confidence ${record.confidence}] ${record.content} (source: ${record.provenance})`).join('\n')}` : 'Approved local memory: none yet.'
}

function chatSnapshot(agentId) {
  const queueIndex = state.chatQueues[agentId].findIndex((item) => item.agentId === agentId)
  return {
    appVersion: APP_VERSION,
    officeMode: state.mode,
    employee: { id: agentId, status: state.agents[agentId].status, currentTask: state.agents[agentId].currentTask },
    activeProject: state.activeProject ? { id: state.activeProject.id, title: state.activeProject.title, currentStage: state.activeProject.currentStage, completedStages: state.activeProject.completedStages || [] } : null,
    usage: visibleState().usage,
    timing: timingSummary(agentId),
    approvedLocalMemory: localMemoryContext(agentId),
    queuePosition: queueIndex < 0 ? 0 : queueIndex + 1,
  }
}

function parseChatOutput(raw) {
  const cleaned = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  try {
    const parsed = JSON.parse(cleaned)
    return {
      reply: cleanText(parsed.reply, 4000) || 'I could not produce a usable response.',
      bubbleSummary: cleanText(parsed.bubbleSummary || parsed.reply, 120),
      guidanceCandidate: parsed.guidanceCandidate && typeof parsed.guidanceCandidate === 'object' ? parsed.guidanceCandidate : null,
    }
  } catch {
    return { reply: cleanText(cleaned, 4000) || 'I could not produce a usable response.', bubbleSummary: cleanText(cleaned, 120), guidanceCandidate: null }
  }
}

function finishQueuedChat(message, status, text, extra = {}) {
  const list = state.agentChats[message.agentId]
  const target = list.find((item) => item.id === message.messageId)
  const conversation = message.conversationScope === 'team'
    ? { conversationScope: 'team', teamMessageId: message.teamMessageId }
    : {}
  if (target) Object.assign(target, { status, ...conversation, ...extra })
  if (text) chatMessage(message.agentId, 'assistant', text, status, { ...conversation, ...extra })
}

function teamChatView() {
  const batches = state.teamConversations.slice(-100)
  const batchIds = new Set(batches.map((batch) => batch.id))
  const messages = batches.map((batch) => ({
    id: batch.id,
    teamMessageId: batch.id,
    conversationScope: 'team',
    agentId: null,
    author: 'user',
    text: batch.text,
    createdAt: batch.createdAt,
    status: 'sent',
  }))
  for (const agentId of AGENT_IDS) {
    for (const message of state.agentChats[agentId]) {
      if (message.author !== 'assistant' || message.conversationScope !== 'team' || !batchIds.has(message.teamMessageId)) continue
      messages.push({ ...message, agentId, agentName: AGENT_DEFS[agentId].name })
    }
  }
  messages.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || (a.author === 'user' ? -1 : 1))
  const latestTeamId = batches.at(-1)?.id || null
  const workers = Object.fromEntries(AGENT_IDS.map((agentId) => {
    const userMessage = [...state.agentChats[agentId]].reverse().find((message) => message.author === 'user' && message.teamMessageId === latestTeamId)
    const queued = state.chatQueues[agentId].find((item) => item.teamMessageId === latestTeamId)
    const running = Boolean(userMessage && state.chatRuntime[agentId]?.messageId === userMessage.id)
    const blocker = userMessage && ['blocked', 'failed'].includes(userMessage.status) ? {
      messageId: userMessage.id,
      reason: userMessage.blockerReason || 'The employee reply did not complete.',
      kind: userMessage.errorKind || 'process',
      retryable: userMessage.retryable === true,
    } : null
    return [agentId, {
      agent: state.agents[agentId],
      status: running ? 'thinking' : queued ? 'queued' : userMessage?.status || 'idle',
      queuePosition: queued ? state.chatQueues[agentId].indexOf(queued) + 1 : 0,
      runtime: state.chatRuntime[agentId],
      blocker,
      timing: timingSummary(agentId),
    }]
  }))
  return {
    target: 'team',
    messages,
    workers,
    guidance: state.guidanceItems.filter((item) => item.status === 'pending'),
    latestTeamMessageId: latestTeamId,
  }
}

function latestChatBlocker(agentId) {
  const latest = [...state.agentChats[agentId]].reverse().find((message) => message.author === 'user')
  if (!latest || !['blocked', 'failed'].includes(latest.status)) return null
  return {
    messageId: latest.id,
    reason: latest.blockerReason || 'The employee reply did not complete.',
    kind: latest.errorKind || 'process',
    retryable: latest.retryable === true,
  }
}

function chatBillingSource() {
  if (usageIsFresh() && state.usage.ordinaryUsageAllowed === true) return 'included'
  if (state.usage.creditsAvailable === true) return 'existing-credits-authorized'
  return 'provider-determined'
}

function modelFor(agentId, providerId) { return providerId === 'claude' ? CLAUDE_MODELS[agentId] : CHAT_MODELS[agentId] }

function classifyChatFailure(error, stderr) {
  const detail = cleanText(stderr || error?.message || 'Unknown chat process failure.', 500)
  const lower = detail.toLowerCase()
  if (error?.killed || /timed?\s*out|timeout/.test(lower)) return { status: 'failed', kind: 'timeout', detail: 'The employee reply exceeded the 90-second limit.' }
  if (/usage limit|insufficient (?:usage )?credits?|credit balance|out of credits|quota exceeded/.test(lower)) return { status: 'blocked', kind: 'usage', detail }
  if (/unauthorized|authentication|not logged in|sign[ -]?in|\b401\b/.test(lower)) return { status: 'failed', kind: 'authentication', detail }
  if (/model.{0,40}(?:not found|unavailable|unsupported)|invalid model/.test(lower)) return { status: 'failed', kind: 'model_unavailable', detail }
  return { status: 'failed', kind: 'process', detail }
}

function processChatQueue(agentId = null) {
  const targets = agentId ? [agentId] : AGENT_IDS
  for (const id of targets) processAgentChatQueue(id)
}

async function processAgentChatQueue(agentId) {
  const queue = state.chatQueues[agentId]
  if (!queue || queue.length === 0 || activeChatProcesses[agentId] || state.chatRuntime[agentId]?.processId) return
  const item = queue[0]
  const recent = state.agentChats[agentId].slice(-24).map(({ author, text }) => ({ author, text }))
  const prompt = buildChatPrompt(agentId, chatSnapshot(agentId), recent)
  const startedAt = nowIso()
  const billingSource = chatBillingSource()
  const provider = providerRegistry.forWorker(agentId)
  const chatModel = modelFor(agentId, provider.id)
  const chatReasoning = 'low'
  let processHandle = null
  state.chatRuntime[agentId] = { messageId: item.messageId, processId: null, startedAt, provider: provider.id }
  state.chatMetrics[agentId].started += 1
  state.chatMetrics[agentId].billingSource = billingSource
  const target = state.agentChats[agentId].find((message) => message.id === item.messageId)
  if (target) target.status = 'thinking'
  if (state.agents[agentId].status === 'waiting') state.agents[agentId].model = modelLabel(provider.id, chatModel, chatReasoning)
  appendEvent('chat_started', { agent: agentId, status: 'thinking', reason: `Independent read-only employee response started through ${provider.displayName}.`, model: chatModel, reasoning: chatReasoning, cost: { ...emptyCost(), status: billingSource } })
  persistState(); broadcast('chat_thinking')
  try {
    const result = await provider.chat({ model: chatModel, reasoning: chatReasoning, cwd: CONTENT_ROOT, dataDir: DATA_DIR, prompt, timeoutMs: CHAT_TIMEOUT_MS, onStart: (child) => {
      processHandle = child; activeChatProcesses[agentId] = child
      state.chatRuntime[agentId] = { messageId: item.messageId, processId: child.pid, startedAt, provider: provider.id }
      persistState(); broadcast('chat_thinking')
    } })
    const durationMs = Math.max(0, Date.now() - Date.parse(startedAt))
    state.chatMetrics[agentId].totalDurationMs += durationMs
      const parsed = parseChatOutput(result.output)
      let guidanceCandidateId = null
      if (parsed.guidanceCandidate) {
        const owner = Object.hasOwn(AGENT_DEFS, parsed.guidanceCandidate.owner) ? parsed.guidanceCandidate.owner : agentId
        const guidance = { id: `guide-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, sourceAgent: agentId, owner, text: cleanText(parsed.guidanceCandidate.text, 500), reason: cleanText(parsed.guidanceCandidate.reason, 300), priority: 'high', status: 'pending', createdAt: nowIso() }
        state.guidanceItems = [...state.guidanceItems, guidance].slice(-200)
        guidanceCandidateId = guidance.id
      }
      state.chatMetrics[agentId].completed += 1
      finishQueuedChat(item, 'complete', parsed.reply, { bubbleSummary: parsed.bubbleSummary, guidanceCandidateId, durationMs, provider: provider.id })
      appendEvent('chat_reply', { agent: agentId, status: 'complete', reason: `Read-only employee reply completed through ${provider.displayName}.`, model: chatModel, reasoning: chatReasoning, processId: result.processId, cost: { ...emptyCost(), status: billingSource } })
  } catch (error) {
    const durationMs = Math.max(0, Date.now() - Date.parse(startedAt))
    const failure = error?.kind ? { status: error.kind === 'usage' ? 'blocked' : 'failed', kind: error.kind, detail: cleanText(error.message, 500) } : classifyChatFailure(error, error?.stderr)
    state.chatMetrics[agentId][failure.status === 'blocked' ? 'blocked' : 'failed'] += 1
    finishQueuedChat(item, failure.status, `I could not answer: ${failure.detail}`, { blockerReason: failure.detail, errorKind: failure.kind, retryable: error?.retryable !== false, durationMs, provider: provider.id })
    appendEvent(`chat_${failure.status}`, { agent: agentId, status: failure.status, reason: failure.detail, model: chatModel, reasoning: chatReasoning, processId: processHandle?.pid, cost: { ...emptyCost(), status: billingSource } })
  } finally {
    activeChatProcesses[agentId] = null
    state.chatQueues[agentId] = state.chatQueues[agentId].filter((queued) => queued.id !== item.id)
    state.chatRuntime[agentId] = { messageId: null, processId: null, startedAt: null, provider: provider.id }
    if (state.agents[agentId].status === 'waiting') state.agents[agentId].model = AGENT_DEFS[agentId].model
    persistState(); broadcast('chat_reply')
    setImmediate(() => processChatQueue(agentId))
  }
}

function saveApprovedRules() {
  fs.mkdirSync(path.dirname(APPROVED_RULES_FILE), { recursive: true })
  fs.writeFileSync(APPROVED_RULES_FILE, JSON.stringify({ version: 1, rules: state.approvedRules }, null, 2) + '\n')
}

function safeProjectName(value) {
  return cleanText(value, 80).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || `project-${Date.now()}`
}

const PRODUCTION_CAPABILITIES = {
  researcher: ['files:read', 'files:write', 'network'],
  editor: ['files:read', 'files:write', 'applications', 'render'],
  manager: ['files:read', 'files:write', 'browser'],
}

function ensureProductionCapabilityRequests(projectId) {
  const pending = []
  for (const [worker, scopes] of Object.entries(PRODUCTION_CAPABILITIES)) for (const scope of scopes) {
    if (capabilityBroker.allows(worker, scope, '*', projectId)) continue
    let request = state.capabilityRequests.find((item) => item.worker === worker && item.scope === scope && item.projectId === projectId && item.status === 'pending')
    if (!request) {
      request = capabilityBroker.request({ worker, scope, resource: '*', duration: 'project', projectId, reason: `Required for the confirmed ${projectId} production workflow.` })
      state.capabilityRequests = [...state.capabilityRequests, request].slice(-200)
      appendEvent('capability_requested', { agent: worker, projectId, status: 'pending', reason: `${scope} is required before production can start.` })
    }
    pending.push(request)
  }
  return pending
}

function capabilityApprovalBundle(projectId, requests, action = 'start') {
  return {
    projectId,
    action,
    requestIds: requests.map((request) => request.id),
    workers: AGENT_IDS.map((worker) => ({
      worker,
      scopes: requests.filter((request) => request.worker === worker).map((request) => request.scope),
    })).filter((entry) => entry.scopes.length),
    excludes: ['destructive', 'publish'],
  }
}

function approveProjectCapabilityBundle(projectId, pending, requestIds) {
  const expected = pending.map((request) => request.id).sort()
  const supplied = [...new Set(Array.isArray(requestIds) ? requestIds.map((id) => cleanText(id, 160)) : [])].sort()
  if (expected.length !== supplied.length || expected.some((id, index) => id !== supplied[index])) {
    throw new Error('The project permission bundle changed. Review the current permissions before approving.')
  }
  for (const request of pending) {
    if (request.projectId !== projectId || request.duration !== 'project' || request.scope === 'destructive' || request.scope === 'publish') throw new Error('Invalid project permission request.')
    const grant = capabilityBroker.decide(request, true)
    request.status = grant.status
    request.decidedAt = grant.decidedAt
    appendEvent('capability_decided', { agent: grant.worker, projectId, status: grant.status, reason: `${grant.scope} approved in the confirmed project bundle.` })
  }
  state.capabilityGrants = capabilityBroker.snapshot()
}

function denyPendingProjectCapabilities(projectId, reason = 'Project permission bundle was cancelled locally.') {
  for (const request of state.capabilityRequests.filter((item) => item.projectId === projectId && item.status === 'pending')) {
    const grant = capabilityBroker.decide(request, false)
    request.status = grant.status
    request.decidedAt = grant.decidedAt
    appendEvent('capability_decided', { agent: grant.worker, projectId, status: 'denied', reason })
  }
  state.capabilityGrants = capabilityBroker.snapshot()
}

async function runCodexWorker(agentId, model, prompt, outputFile, options = {}) {
  const gate = projectUsageGate(state.activeProject)
  if (!gate.allowed) throw new Error(`Worker start blocked: ${gate.reason}`)
  if (cancelRequested) throw new Error('Pipeline cancelled before worker start.')
  const requiredScopes = PRODUCTION_CAPABILITIES[agentId]
  const missing = requiredScopes.filter((scope) => !capabilityBroker.allows(agentId, scope, '*', state.activeProject?.id))
  if (missing.length) throw new Error(`Capability approval required for ${AGENT_DEFS[agentId].name}: ${missing.join(', ')}`)
  const provider = providerRegistry.forWorker(agentId)
  const selectedModel = options.model || modelFor(agentId, provider.id) || model
  const reasoning = options.reasoning || 'medium'
  const escalationTrigger = options.escalationTrigger || null
  const startedAt = nowIso()
  const logFile = outputFile.replace(/\.md$/, '.log')
  let processId = null
  try {
    const result = await provider.executeWorker({ model: selectedModel, reasoning, cwd: CONTENT_ROOT, prompt, outputFile, network: requiredScopes.includes('network'), sandbox: 'danger-full-access', timeoutMs: 2 * 60 * 60 * 1000, onStart: (child) => {
      activeCodexProcess = child; processId = child.pid
      activeWorker = { agentId, processId: child.pid, startedAt, outputFile, provider: provider.id }
      updateAgent(agentId, state.agents[agentId].status, state.agents[agentId].currentTask, { processId: child.pid, startedAt, endedAt: null, exitCode: null, model: modelLabel(provider.id, selectedModel, reasoning) })
      appendEvent('worker_started', { agent: agentId, projectId: state.activeProject?.id, status: 'running', processId: child.pid, reason: `Started sequential ${provider.displayName} worker process.`, model: selectedModel, reasoning, escalationTrigger, output: outputFile, cost: emptyCost() })
      persistState(); broadcast('worker')
    } })
    fs.writeFileSync(logFile, `${result.stdout || ''}\n${result.stderr || ''}`.trim().slice(-100000) + '\n')
    const endedAt = nowIso(); updateAgent(agentId, 'working', 'Worker completed; preparing handoff', { processId: null, startedAt, endedAt, exitCode: 0 })
    const gitSnapshot = await getGitSnapshot()
    appendEvent('worker_completed', { agent: agentId, projectId: state.activeProject?.id, status: 'completed', reason: `${provider.displayName} worker exited successfully.`, model: selectedModel, reasoning, escalationTrigger, evidence: [logFile], output: outputFile, git: gitSnapshot, cost: emptyCost(), processId })
    persistState(); broadcast('worker')
    return { processId, startedAt, endedAt, exitCode: 0, outputFile, logFile, provider: provider.id }
  } catch (error) {
    const endedAt = nowIso(); fs.writeFileSync(logFile, cleanText(error.message, 100000) + '\n')
    updateAgent(agentId, 'blocked', 'Worker stopped before completing its handoff', { processId: null, startedAt, endedAt, exitCode: 1 })
    appendEvent(cancelRequested ? 'worker_cancelled' : 'worker_failed', { agent: agentId, projectId: state.activeProject?.id, status: cancelRequested ? 'cancelled' : 'failed', reason: cleanText(error.message, 500), model: selectedModel, reasoning, escalationTrigger, evidence: [logFile], output: outputFile, cost: emptyCost(), processId })
    persistState(); broadcast('worker')
    throw new Error(cancelRequested ? 'Pipeline cancelled by request.' : `${AGENT_DEFS[agentId].name} failed: ${cleanText(error.message, 500)}`)
  } finally { activeCodexProcess = null; activeWorker = null }
}

function hasCoopManagerDisagreement() {
  const byArtifact = new Map()
  for (const review of state.coop?.finalReviews || []) {
    if (!byArtifact.has(review.artifactId)) byArtifact.set(review.artifactId, new Set())
    byArtifact.get(review.artifactId).add(review.decision)
  }
  return [...byArtifact.values()].some((decisions) => decisions.size > 1)
}

function readManagerEscalation(reportFile) {
  let report = ''
  try { report = fs.readFileSync(reportFile, 'utf8') } catch {}
  return parseManagerEscalation(report, { coopDisagreement: hasCoopManagerDisagreement() })
}

async function runPremiumManagerReview(project, trigger, routineReport, premiumReport) {
  const attempts = project.managerModelUsage?.premiumEscalations || []
  if (attempts.length >= 1) throw new Error('Premium Manager review already ran once for this project. A retry requires a new documented reason and must not start automatically.')
  const gate = premiumUsageGate(state.usage, usageIsFresh())
  if (!gate.allowed) {
    appendEvent('manager_escalation_blocked', { agent: 'manager', projectId: project.id, status: 'blocked', reason: `${MANAGER_ESCALATION_TRIGGERS[trigger]} ${gate.reason}`, model: managerModels('codex').premium, reasoning: 'medium', escalationTrigger: trigger })
    throw new Error(`Premium Manager review required for ${trigger}, but it was not started: ${gate.reason}`)
  }
  const provider = providerRegistry.forWorker('manager')
  const models = managerModels(provider.id)
  const attempt = { trigger, reason: MANAGER_ESCALATION_TRIGGERS[trigger], provider: provider.id, model: models.premium, reasoning: 'medium', startedAt: nowIso(), status: 'running' }
  project.managerModelUsage = { ...(project.managerModelUsage || {}), policy: 'adaptive', routineModel: models.routine, premiumEscalations: [...attempts, attempt] }
  appendEvent('manager_escalation_started', { agent: 'manager', projectId: project.id, status: 'running', reason: attempt.reason, model: models.premium, reasoning: 'medium', escalationTrigger: trigger, evidence: [routineReport] })
  persistState(); broadcast('manager_escalation')
  try {
    await runCodexWorker('manager', models.premium, buildWorkerPrompt('manager', [
      `Premium final-gate review for project: ${project.title}.`,
      `Escalation trigger: ${trigger} — ${attempt.reason}`,
      `Inspect the routine Manager report at ${routineReport} and its referenced evidence. Do not repeat ordinary QA.` ,
      'Resolve only the escalated risk. If evidence remains insufficient, block release explicitly instead of guessing.',
      state.coop.mode === 'solo' ? 'Return a final release decision. Publishing still requires its separate action-scoped permission.' : 'Provide evidence for the two human collaborators. Do not overrule either participant or publish from the wrong computer.',
      `Write the premium decision and supporting evidence to ${premiumReport}.`,
      localMemoryContext('manager'),
    ].join('\n')), premiumReport, { model: models.premium, reasoning: 'medium', escalationTrigger: trigger })
    attempt.status = 'completed'
    attempt.completedAt = nowIso()
    appendEvent('manager_escalation_completed', { agent: 'manager', projectId: project.id, status: 'completed', reason: `Premium Manager review resolved ${trigger}.`, model: models.premium, reasoning: 'medium', escalationTrigger: trigger, output: premiumReport })
    return premiumReport
  } catch (error) {
    attempt.status = 'failed'
    attempt.completedAt = nowIso()
    attempt.failure = cleanText(error.message, 500)
    throw error
  }
}

async function runCoopDisagreementEscalation(outcome) {
  const artifactId = cleanText(outcome?.review?.artifactId, 160)
  if (!artifactId || outcome?.status !== 'human-escalation-required') return
  const existing = (state.coop.managerEscalations || []).find((item) => item.artifactId === artifactId)
  if (existing) return
  const gate = premiumUsageGate(state.usage, usageIsFresh())
  const provider = providerRegistry.forWorker('manager')
  const models = managerModels(provider.id)
  const record = { artifactId, trigger: 'coop-manager-disagreement', provider: provider.id, model: models.premium, reasoning: 'medium', startedAt: nowIso(), status: gate.allowed ? 'running' : 'blocked', reason: gate.allowed ? MANAGER_ESCALATION_TRIGGERS['coop-manager-disagreement'] : gate.reason }
  state.coop.managerEscalations = [...(state.coop.managerEscalations || []), record].slice(-50)
  if (!gate.allowed || activeCodexProcess || activeChatProcesses.manager) {
    if (gate.allowed) { record.status = 'blocked'; record.reason = 'The local Manager is already busy; premium co-op review did not start automatically.' }
    appendEvent('manager_escalation_blocked', { agent: 'manager', status: 'blocked', reason: record.reason, model: models.premium, reasoning: 'medium', escalationTrigger: record.trigger, evidence: [artifactId] })
    persistState(); broadcast('manager_escalation')
    return
  }
  const outputDir = path.join(CONTENT_ROOT, 'agent-runs', 'coop-manager-escalations')
  const outputFile = path.join(outputDir, `${safeProjectName(artifactId)}.md`)
  fs.mkdirSync(outputDir, { recursive: true })
  updateAgent('manager', 'reviewing', 'Reviewing a co-op Manager disagreement at the premium final gate', { model: modelLabel(provider.id, models.premium, 'medium') })
  appendEvent('manager_escalation_started', { agent: 'manager', status: 'running', reason: record.reason, model: models.premium, reasoning: 'medium', escalationTrigger: record.trigger, evidence: [artifactId] })
  persistState(); broadcast('manager_escalation')
  try {
    const reviews = outcome.reviews.map((review) => `${review.participantLabel || review.participantId}: ${review.decision} — ${review.reason}`).join('\n')
    const result = await provider.chat({ model: models.premium, reasoning: 'medium', cwd: CONTENT_ROOT, dataDir: DATA_DIR, prompt: buildWorkerPrompt('manager', [
      `Co-op final-candidate disagreement for artifact ${artifactId}.`,
      `Independent Manager reviews:\n${reviews}`,
      'Analyze only the documented disagreement. Identify the evidence the humans need to resolve it. Do not publish, alter files, or overrule either participant.',
      'Return a concise evidence-backed advisory decision with unresolved uncertainty clearly labeled.',
    ].join('\n\n')), timeoutMs: 10 * 60 * 1000 })
    fs.writeFileSync(outputFile, String(result.output || '').trim() + '\n')
    record.status = 'completed'; record.completedAt = nowIso(); record.output = outputFile
    appendEvent('manager_escalation_completed', { agent: 'manager', status: 'completed', reason: 'Premium co-op disagreement analysis is ready for both humans.', model: models.premium, reasoning: 'medium', escalationTrigger: record.trigger, output: outputFile, evidence: [artifactId] })
  } catch (error) {
    record.status = 'failed'; record.completedAt = nowIso(); record.reason = cleanText(error.message, 500)
    appendEvent('manager_escalation_failed', { agent: 'manager', status: 'failed', reason: record.reason, model: models.premium, reasoning: 'medium', escalationTrigger: record.trigger, evidence: [artifactId] })
  } finally {
    updateAgent('manager', 'waiting', 'Waiting for work', { model: AGENT_DEFS.manager.model, processId: null })
    persistState(); broadcast('manager_escalation')
  }
}

async function runAutonomousPipeline(project) {
  if (pipelineRunning) return
  pipelineRunning = true
  cancelRequested = false
  const runDir = path.join(CONTENT_ROOT, 'agent-runs', safeProjectName(project.id))
  fs.mkdirSync(runDir, { recursive: true })
  const researchFile = path.join(runDir, 'research-brief.md')
  const editFile = path.join(runDir, 'production-report.md')
  const managerFile = path.join(runDir, 'manager-release-report.md')
  const premiumManagerFile = path.join(runDir, 'manager-premium-review.md')
  const postmortemFile = path.join(runDir, 'postmortem.md')
  const memoryFile = path.join(runDir, 'run-memory.json')
  project.completedStages = Array.isArray(project.completedStages) ? project.completedStages : []
  const guidanceFor = (role) => (project.userGuidance || []).filter((item) => item.owner === role).map((item) => `- ${item.text}`).join('\n') || '- None'

  const beginStage = (stage) => {
    project.currentStage = stage
    project.lastStageStartedAt = nowIso()
    persistState()
  }
  const finishStage = (stage, output) => {
    if (!project.completedStages.includes(stage)) project.completedStages.push(stage)
    project.currentStage = null
    project.lastStageEndedAt = nowIso()
    const elapsedSeconds = Math.max(0, (Date.parse(project.lastStageEndedAt) - Date.parse(project.lastStageStartedAt)) / 1000)
    if (Number.isFinite(elapsedSeconds)) state.stageDurationHistory[stage] = [...state.stageDurationHistory[stage], elapsedSeconds].slice(-30)
    appendEvent('stage_completed', { agent: stage, projectId: project.id, status: 'completed', reason: `${stage} handoff completed.`, output })
    sendCoopEnvelope('role-handoff', { projectId: project.id, role: stage, summary: extractReflection(output, `${AGENT_DEFS[stage].name} completed the local ${stage} stage and handed it to the next role.`), completedAt: project.lastStageEndedAt })
    persistState()
  }

  try {
    if (!project.completedStages.includes('researcher')) {
      beginStage('researcher')
      updateAgent('researcher', 'researching', 'Researching references, footage, audience demand, and the strongest execution plan')
      persistState(); broadcast()
      await runCodexWorker('researcher', 'gpt-5.6-luna', buildWorkerPrompt('researcher', [
        `Project: ${project.title}.`,
        `High-priority user guidance for Researcher:\n${guidanceFor('researcher')}`,
        'Use current primary sources when needed. Inventory usable footage and assets, preserve chronology and complete payoffs, and identify licensing or factual risks.',
        `Write an evidence-backed brief and Reflection section to ${researchFile}. Do not edit or publish the final video. Commit only text/manifests with a Researcher-prefixed commit.`,
        'The account is in conservative usage mode: avoid optional revisions and stop if essential user information is missing.',
        `Encrypted counterpart context:\n${coopCounterpartContext('researcher', project.id)}`,
        localMemoryContext('researcher'),
      ].join('\n')), researchFile)
      finishStage('researcher', researchFile)
      addMessage('researcher', 'editor', 'Research brief complete. Evidence, footage priorities, risks, and recommended structure are ready.', 'handoff', [researchFile])
    }

    if (!project.completedStages.includes('editor')) {
      beginStage('editor')
      updateAgent('researcher', 'waiting', 'Research handoff complete')
      updateAgent('editor', 'editing', 'Reviewing the evidence and assembling the strongest accurate production')
      persistState(); broadcast()
      await runCodexWorker('editor', 'gpt-5.6-terra', buildWorkerPrompt('editor', [
        `Project: ${project.title}. Review the Researcher brief at ${researchFile}.`,
        `High-priority user guidance for Editor:\n${guidanceFor('editor')}`,
        'Challenge a weak recommendation once with evidence and a better alternative, then produce the requested content using local footage and tools.',
        'Entertainment and retention come first without misleading packaging. Maintain chronology and complete payoffs; apply every gaming rule from the shared protocol.',
        `Record outputs, checks, blockers, and a Reflection section in ${editFile}. Commit text/manifests/scripts with an Editor-prefixed commit; never commit media or secrets.`,
        `Encrypted counterpart context:\n${coopCounterpartContext('editor', project.id)}\nAlso consult any received Researcher handoff in the co-op activity log.`,
        localMemoryContext('editor'),
      ].join('\n')), editFile)
      finishStage('editor', editFile)
      addMessage('editor', 'manager', 'Production candidate assembled. Technical checks and exact output paths are ready for final inspection.', 'handoff', [editFile])
    }

    let finalManagerFile = managerFile
    if (!project.completedStages.includes('manager')) {
      beginStage('manager')
      updateAgent('editor', 'waiting', 'Candidate handed to Manager')
      updateAgent('manager', 'reviewing', 'Performing final quality, accuracy, licensing, retention, and cost inspection')
      persistState(); broadcast()
      const managerProvider = providerRegistry.forWorker('manager')
      const managerRoute = managerModels(managerProvider.id)
      project.managerModelUsage = { ...(project.managerModelUsage || {}), policy: 'adaptive', routineModel: managerRoute.routine, routineReasoning: 'medium', premiumEscalations: project.managerModelUsage?.premiumEscalations || [] }
      await runCodexWorker('manager', managerRoute.routine, buildWorkerPrompt('manager', [
        `Project: ${project.title}. Inspect ${researchFile}, ${editFile}, and every stated output.`,
        `High-priority user guidance for Manager:\n${guidanceFor('manager')}`,
        'Reject unsupported claims, broken chronology, cropped gameplay, weak pacing, misleading packaging, audio problems, overlaps, licensing risk, or missing payoffs.',
        'Use deterministic QA first. Do not request optional revisions while usage is constrained.',
        state.coop.mode === 'solo' ? 'Prepare a passing candidate and exact publication package, but do not publish without a separate action-scoped publish grant. The newest approved revision should become public; superseded or rejected versions stay private and are never deleted.' : 'Co-op safety: do not publish yet. Record the verified final candidate and wait until both local Manager agents approve the same artifact; publishing remains on the destination-account owner’s PC.',
        `Write the final decision, QA evidence, publication status, office-meeting synthesis, and Reflection section to ${managerFile}. Commit release records with a Manager-prefixed commit.`,
        `End the report with exactly one routing line. Use "ASTRA_ESCALATION: none" when routine QA is sufficient. Otherwise use exactly one of: ${Object.keys(MANAGER_ESCALATION_TRIGGERS).join(', ')}. Harmless warnings and optional polish must use none.`,
        `Encrypted counterpart context:\n${coopCounterpartContext('manager', project.id)}\nBoth local Managers must approve a shared final candidate before co-op publication.`,
        localMemoryContext('manager'),
      ].join('\n')), managerFile, { model: managerRoute.routine, reasoning: 'medium' })
      const escalationTrigger = readManagerEscalation(managerFile)
      if (escalationTrigger) {
        updateAgent('manager', 'reviewing', `Escalating only the unresolved ${escalationTrigger} risk to the premium final gate`)
        finalManagerFile = await runPremiumManagerReview(project, escalationTrigger, managerFile, premiumManagerFile)
      }
      project.managerModelUsage.routineCompletedAt = nowIso()
      project.managerModelUsage.finalModel = escalationTrigger ? managerRoute.premium : managerRoute.routine
      project.managerModelUsage.finalReasoning = 'medium'
      finishStage('manager', finalManagerFile)
    }
    const contributions = [
      { agent: 'researcher', summary: extractReflection(researchFile, 'Research evidence, risks, and source lessons are recorded in the research brief.') },
      { agent: 'editor', summary: extractReflection(editFile, 'Creative, pacing, and production lessons are recorded in the production report.') },
      { agent: 'manager', summary: extractReflection(finalManagerFile, 'Final QA, budget, packaging, and publishing lessons are recorded in the release report.') },
    ]
    state.workday.reflections = [...state.workday.reflections, { projectId: project.id, title: project.title, completedAt: nowIso(), contributions, evidence: [researchFile, editFile, finalManagerFile] }].slice(-300)
    appendEvent('workday_reflection_saved', { projectId: project.id, status: 'pending_end_workday', reason: 'Stage reflections were saved locally. The office meeting will run only when End Workday is selected.', evidence: [researchFile, editFile, finalManagerFile] })
    addMessage('manager', 'user', 'Autonomous pipeline finished. Final QA and release status are ready in the manager report.', 'completion', [finalManagerFile])
    state.outputs = [...state.outputs, { title: project.title, path: finalManagerFile, status: 'reviewed' }].slice(-50)
    const completedAt = nowIso()
    const runSummary = {
      projectId: project.id, title: project.title, startedAt: project.startedAt, completedAt,
      completedStages: project.completedStages, outputs: [researchFile, editFile, finalManagerFile],
      promptVersions: project.promptVersions || state.promptVersions,
      meeting: null, workdayReflectionSaved: true, usageSnapshot: state.usage, managerModelUsage: project.managerModelUsage, cost: emptyCost(),
    }
    const lesson = `Preserve completed checkpoints, use the project-recorded local usage authorization, and apply the saved Researcher, Editor, and Manager reflections before the next related project.`
    fs.writeFileSync(postmortemFile, `# Run postmortem\n\n- Project: ${cleanText(project.title, 180)}\n- Started: ${project.startedAt}\n- Completed: ${completedAt}\n- Stages: ${project.completedStages.join(', ')}\n- Prompt versions: ${Object.entries(project.promptVersions || state.promptVersions).map(([key, value]) => `${key}=${value}`).join(', ')}\n- Cost: unknown (provider usage was not reported)\n\n## Pending End Workday reflections\n\n${contributions.map((item) => `- ${AGENT_DEFS[item.agent].name}: ${item.summary}`).join('\n')}\n\n## Durable lesson\n\n${lesson}\n`)
    fs.writeFileSync(memoryFile, JSON.stringify(runSummary, null, 2) + '\n')
    state.projectLessons = [...state.projectLessons, { projectId: project.id, title: project.title, completedAt, lesson, promptVersions: project.promptVersions || state.promptVersions }].slice(-100)
    memoryStore.add({ role: 'shared', kind: 'fact', content: `Project ${project.title} completed all stages at ${completedAt}.`, provenance: finalManagerFile, confidence: 1, status: 'approved', projectId: project.id })
    state.reviewReminders = [...state.reviewReminders, ...createReviewReminders(project, finalManagerFile, completedAt)].slice(-100)
    state.mode = 'idle'
    state.activeProject = null
    state.intake = null
    for (const id of Object.keys(AGENT_DEFS)) updateAgent(id, 'waiting', 'Waiting for work')
    state.recovery = null
    appendEvent('pipeline_completed', { projectId: project.id, status: 'completed', reason: 'All sequential stages completed.', evidence: [postmortemFile, memoryFile], output: finalManagerFile, cost: emptyCost() })
    sendCoopEnvelope('project-completed', { projectId: project.id, title: project.title, completedAt, participantId: roomService.identity.id })
  } catch (error) {
    const failedAgent = state.agents.manager.status !== 'waiting' ? 'manager' : state.agents.editor.status !== 'waiting' ? 'editor' : 'researcher'
    const stoppedAt = nowIso()
    const outcome = cancelRequested ? 'cancelled' : 'failed'
    const safeError = cleanText(error.message, 500)
    fs.writeFileSync(postmortemFile, `# Run postmortem\n\n- Project: ${cleanText(project.title, 180)}\n- Outcome: ${outcome}\n- Stopped: ${stoppedAt}\n- Completed stages: ${project.completedStages.join(', ') || 'none'}\n- Reason: ${safeError}\n- Cost: unknown (provider usage was not reported)\n\n## Recovery\n\n${cancelRequested ? 'No automatic restart is permitted after cancellation.' : `Resume explicitly from ${project.currentStage || 'the first incomplete stage'} after a fresh usage snapshot allows ordinary usage.`}\n`)
    fs.writeFileSync(memoryFile, JSON.stringify({
      projectId: project.id, title: project.title, startedAt: project.startedAt, stoppedAt,
      outcome, reason: safeError, completedStages: project.completedStages,
      resumeFrom: cancelRequested ? null : project.currentStage, outputs: [postmortemFile], cost: emptyCost(),
    }, null, 2) + '\n')
    updateAgent(failedAgent, 'blocked', error.message)
    addMessage(failedAgent, 'user', error.message, 'blocker')
    state.mode = cancelRequested ? 'cancelled' : 'blocked'
    state.recovery = cancelRequested ? null : { required: true, detectedAt: nowIso(), reason: cleanText(error.message, 500), resumeFrom: project.currentStage }
    if (cancelRequested) {
      state.activeProject = null
      state.intake = null
      for (const id of Object.keys(state.agents)) updateAgent(id, 'waiting', 'Waiting for work', { processId: null })
    }
    appendEvent(cancelRequested ? 'pipeline_cancelled' : 'pipeline_blocked', { agent: failedAgent, projectId: project.id, status: state.mode, reason: safeError, evidence: [...project.completedStages, postmortemFile, memoryFile], output: postmortemFile, cost: emptyCost() })
  } finally {
    pipelineRunning = false
    persistState(); broadcast('pipeline')
    setImmediate(processChatQueue)
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`)
  const origin = req.headers.origin
  if (origin && origin !== 'http://127.0.0.1:3300' && origin !== 'http://localhost:3300') return json(res, 403, { error: 'Origin is not permitted.' })
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': origin || 'http://127.0.0.1:3300', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS', Vary: 'Origin' })
    return res.end()
  }
  if (url.pathname === '/health') return json(res, 200, { ok: true, mode: state.mode })
  const sessionPrefix = `/session/${SESSION_TOKEN}`
  if (!url.pathname.startsWith(`${sessionPrefix}/`)) return json(res, 401, { error: 'A valid local session token is required.' })
  url.pathname = url.pathname.slice(sessionPrefix.length) || '/'
  try {
    if (req.method === 'GET' && url.pathname === '/state') return json(res, 200, visibleState())
    if (req.method === 'GET' && url.pathname === '/git') return json(res, 200, await getGitSnapshot())
    if (req.method === 'GET' && url.pathname === '/installation') return json(res, 200, await getInstallationStatus())
    if (req.method === 'GET' && url.pathname === '/unread') return json(res, 200, { messages: state.messages.filter((m) => !m.readInChat) })

    if (req.method === 'GET' && url.pathname === '/providers') return json(res, 200, { ...providerRegistry.snapshot(), status: await providerRegistry.statuses() })
    if (req.method === 'POST' && url.pathname === '/providers/assign') {
      const body = await readBody(req)
      if (!['office', ...AGENT_IDS].includes(body.worker)) return json(res, 400, { error: 'Unknown worker assignment.' })
      providerRegistry.assign(body.worker, body.provider)
      state.providerAssignments = { ...providerRegistry.assignments }
      appendEvent('provider_assignment_changed', { agent: body.worker === 'office' ? null : body.worker, status: 'saved', reason: `${body.worker} now uses ${body.provider}.` })
      persistState(); broadcast('providers'); return json(res, 200, providerRegistry.snapshot())
    }

    if (req.method === 'GET' && url.pathname === '/memory') return json(res, 200, { records: memoryStore.list({ role: url.searchParams.get('role') || undefined, status: url.searchParams.get('status') || undefined, query: url.searchParams.get('q') || undefined }), database: memoryStore.file })
    if (req.method === 'POST' && url.pathname === '/memory') {
      const body = await readBody(req); const record = memoryStore.add({ ...body, status: body.kind === 'fact' && body.confirmed === true ? 'approved' : 'proposed' })
      appendEvent('memory_created', { agent: record.role === 'shared' ? null : record.role, status: record.status, reason: record.content, evidence: [record.provenance] })
      broadcast('memory'); return json(res, 201, record)
    }
    const memoryAction = url.pathname.match(/^\/memory\/([^/]+)\/(approve|reject|forget|correct)$/)
    if (req.method === 'POST' && memoryAction) {
      const body = await readBody(req); const id = cleanText(memoryAction[1], 160); const action = memoryAction[2]
      const record = action === 'correct' ? memoryStore.correct(id, cleanText(body.content, 10000), cleanText(body.provenance || 'user correction', 1000)) : action === 'forget' ? memoryStore.forget(id) : memoryStore.setStatus(id, action === 'approve' ? 'approved' : 'rejected', cleanText(body.reason, 1000))
      if (!record) return json(res, 404, { error: 'Memory record not found.' })
      appendEvent(`memory_${action}`, { agent: record.role === 'shared' ? null : record.role, status: record.status, reason: record.content })
      broadcast('memory'); return json(res, 200, record)
    }

    if (req.method === 'GET' && url.pathname === '/capabilities') return json(res, 200, { grants: capabilityBroker.snapshot(), requests: state.capabilityRequests })
    if (req.method === 'POST' && url.pathname === '/capabilities/request') {
      const body = await readBody(req); const request = capabilityBroker.request(body); state.capabilityRequests = [...state.capabilityRequests, request].slice(-200)
      appendEvent('capability_requested', { agent: request.worker, status: request.status, reason: `${request.scope} for ${request.resource}: ${request.reason}` })
      persistState(); broadcast('capabilities'); return json(res, 201, request)
    }
    const capabilityDecision = url.pathname.match(/^\/capabilities\/([^/]+)\/(approve|deny)$/)
    if (req.method === 'POST' && capabilityDecision) {
      const request = state.capabilityRequests.find((item) => item.id === cleanText(capabilityDecision[1], 160)); if (!request) return json(res, 404, { error: 'Capability request not found.' })
      const grant = capabilityBroker.decide(request, capabilityDecision[2] === 'approve'); state.capabilityGrants = capabilityBroker.snapshot(); request.status = grant.status; request.decidedAt = grant.decidedAt
      appendEvent('capability_decided', { agent: grant.worker, status: grant.status, reason: `${grant.scope} for ${grant.resource}` })
      persistState(); broadcast('capabilities'); return json(res, 200, grant)
    }
    const capabilityProjectDeny = url.pathname.match(/^\/capabilities\/projects\/([^/]+)\/deny$/)
    if (req.method === 'POST' && capabilityProjectDeny) {
      const projectId = cleanText(capabilityProjectDeny[1], 80)
      denyPendingProjectCapabilities(projectId)
      persistState(); broadcast('capabilities')
      return json(res, 200, { projectId, status: 'denied' })
    }

    if (req.method === 'POST' && url.pathname === '/workday/end') {
      if (state.coop.mode !== 'solo') return json(res, 409, { error: 'End Workday meetings are disabled in co-op mode.' })
      const pending = state.workday.reflections || []; if (!pending.length) return json(res, 409, { error: 'No completed-project reflections are waiting.' })
      state.mode = 'office_review'; const contributions = pending.flatMap((item) => item.contributions.map((entry) => ({ ...entry, projectId: item.projectId })))
      const roles = new Set(contributions.map((entry) => entry.agent)); const agreed = AGENT_IDS.every((id) => roles.has(id))
      const proposal = agreed ? memoryStore.add({ role: 'shared', kind: 'lesson', content: `Workday review covering ${pending.length} completed project(s): preserve verified successes, correct repeated failures, and require user approval before changing permanent rules.`, provenance: pending.map((item) => item.projectId).join(','), confidence: 0.75 }) : null
      state.meeting = { id: `meeting-${Date.now()}`, status: 'completed', startedAt: nowIso(), completedAt: nowIso(), contributions, unanimous: agreed, proposalId: proposal?.id || null }
      state.workday = { openedAt: nowIso(), reflections: [], endedAt: nowIso(), meetingProposals: [...(state.workday.meetingProposals || []), ...(proposal ? [proposal.id] : [])].slice(-100) }
      state.mode = 'idle'; appendEvent('workday_ended', { status: 'completed', reason: agreed ? 'All three roles contributed; a reusable lesson was proposed for user approval.' : 'Meeting recorded without a permanent lesson because all three roles did not contribute.', evidence: proposal ? [proposal.id] : [] })
      persistState(); broadcast('meeting'); return json(res, 200, state.meeting)
    }

    if (req.method === 'GET' && url.pathname === '/backups') return json(res, 200, { backups: backupManager.list() })
    if (req.method === 'POST' && url.pathname === '/backups') {
      const body = await readBody(req); memoryStore.checkpoint(); const manifest = backupManager.snapshot(cleanText(body.label || APP_VERSION, 80), [STATE_FILE, memoryStore.file, CONFIG_FILE, APPROVED_RULES_FILE])
      appendEvent('backup_created', { status: 'complete', reason: manifest.label, output: path.join(backupManager.backupDir, manifest.id) })
      return json(res, 201, manifest)
    }

    if (req.method === 'POST' && url.pathname === '/coop/rooms') {
      const body = await readBody(req); const room = roomService.createRoom({ label: cleanText(body.label || 'Host', 80), appVersion: APP_VERSION, promptBundle: state.promptVersions }); const transport = await coopTransport.startLanHost(Number(body.port) || 0)
      state.coop = { activeRoomId: room.id, mode: 'coop-host', participants: room.participants || [], remoteCrews: [], pendingProjects: [], roleHandoffs: [], sharedLog: [], finalReviews: [], managerEscalations: [], artifacts: [], invite: room, transport }; appendEvent('coop_room_created', { status: 'waiting', reason: `Encrypted co-op room created with verification phrase ${room.phrase}.` })
      persistState(); broadcast('coop'); return json(res, 201, { ...room, transport })
    }
    if (req.method === 'POST' && url.pathname === '/coop/join') {
      const body = await readBody(req)
      if (!body.invite || body.invite.appVersion !== APP_VERSION || JSON.stringify(body.invite.promptBundle) !== JSON.stringify(state.promptVersions)) return json(res, 409, { error: 'Application or prompt-bundle versions do not match the host.' })
      if (!/^wss?:\/\//.test(body.url || '')) return json(res, 400, { error: 'A ws:// LAN or wss:// relay URL is required.' })
      const room = roomService.joinRoom(body.invite, { label: cleanText(body.label || 'Guest', 80) })
      coopTransport.connect(body.url, body.kind === 'relay' ? 'relay' : 'lan')
      state.coop = { activeRoomId: room.id, mode: 'coop-guest', participants: room.participants || [], remoteCrews: [], pendingProjects: [], roleHandoffs: [], sharedLog: [], finalReviews: [], managerEscalations: [], artifacts: [], invite: null }; appendEvent('coop_room_joined', { status: 'connected', reason: 'Joined an encrypted six-worker room after version and verification checks.' })
      setTimeout(() => sendCoopEnvelope('join', { participantId: roomService.identity.id, participantLabel: cleanText(body.label || 'Guest', 80), workers: localCrewSnapshot(), joinedAt: nowIso() }), 500)
      persistState(); broadcast('coop'); return json(res, 200, room)
    }
    if (req.method === 'POST' && url.pathname === '/coop/connect') { const body = await readBody(req); if (!/^wss?:\/\//.test(body.url || '')) return json(res, 400, { error: 'A ws:// LAN or wss:// relay URL is required.' }); coopTransport.connect(body.url, body.kind === 'relay' ? 'relay' : 'lan'); return json(res, 202, coopTransport.status()) }
    if (req.method === 'POST' && url.pathname === '/coop/messages') { const body = await readBody(req); if (!state.coop.activeRoomId) return json(res, 409, { error: 'No co-op room is active.' }); const text = cleanText(body.text, 4000); if (!text) return json(res, 400, { error: 'Message is required.' }); const envelope = roomService.makeEnvelope(state.coop.activeRoomId, 'message', { text, target: cleanText(body.target || 'all-six', 80), sentAt: nowIso() }); coopTransport.send(envelope); const logEntry = { id: envelope.nonce, senderId: envelope.senderId, type: 'message', sentAt: nowIso(), status: 'encrypted-sent', summary: text }; state.coop.sharedLog = [...state.coop.sharedLog, logEntry].slice(-500); appendRoomLog(logEntry); persistState(); broadcast('coop'); return json(res, 202, { envelopeId: envelope.nonce }) }
    if (req.method === 'POST' && url.pathname === '/coop/artifacts') {
      const body = await readBody(req); if (!state.coop.activeRoomId) return json(res, 409, { error: 'No co-op room is active.' })
      const encoded = String(body.bytesBase64 || ''); const bytes = Buffer.from(encoded, 'base64'); if (!encoded || bytes.length > 512 * 1024) return json(res, 413, { error: 'Attachments are limited to 512 KiB in this transport. Large media should remain local and be exchanged through an explicitly approved project transfer.' })
      const name = path.basename(cleanText(body.name || 'attachment.bin', 240)); const mimeType = cleanText(body.mimeType || 'application/octet-stream', 120)
      const envelope = roomService.makeEnvelope(state.coop.activeRoomId, 'artifact', { taskId: cleanText(body.taskId, 160), name, mimeType, bytesBase64: encoded })
      coopTransport.send(envelope); const logEntry = { id: envelope.nonce, senderId: envelope.senderId, type: 'artifact', sentAt: nowIso(), status: 'encrypted-sent', summary: `${name} · ${bytes.length} bytes` }
      state.coop.sharedLog = [...state.coop.sharedLog, logEntry].slice(-500); appendRoomLog(logEntry); persistState(); broadcast('coop'); return json(res, 202, { envelopeId: envelope.nonce, name, bytes: bytes.length })
    }
    const artifactDecision = url.pathname.match(/^\/coop\/artifacts\/([^/]+)\/approve$/)
    if (req.method === 'POST' && artifactDecision) {
      const artifact = (state.coop.artifacts || []).find((item) => item.id === cleanText(artifactDecision[1], 160)); if (!artifact) return json(res, 404, { error: 'Quarantined artifact not found.' })
      const approved = artifactStore.approve(artifact); state.coop.artifacts = state.coop.artifacts.map((item) => item.id === approved.id ? approved : item)
      appendEvent('coop_artifact_approved', { status: 'approved', reason: `${approved.name} was explicitly approved for local access.`, output: approved.path }); persistState(); broadcast('coop'); return json(res, 200, approved)
    }
    if (req.method === 'POST' && url.pathname === '/coop/final-candidate') { const body = await readBody(req); if (!state.coop.activeRoomId) return json(res, 409, { error: 'No co-op room is active.' }); if (!body.artifactId || !['pass','reject'].includes(body.decision)) return json(res, 400, { error: 'artifactId and a pass/reject decision are required.' }); const outcome = recordCoopManagerReview({ artifactId: body.artifactId, participantId: roomService.identity.id, participantLabel: roomService.identity.label, decision: body.decision, reason: body.reason }); const envelope = roomService.makeEnvelope(state.coop.activeRoomId, 'manager-review', outcome.review); coopTransport.send(envelope); appendEvent('coop_manager_review', { agent: 'manager', status: outcome.status, reason: `${outcome.review.decision} — ${outcome.review.reason}` }); if (outcome.status === 'human-escalation-required') void runCoopDisagreementEscalation(outcome); persistState(); broadcast('coop'); return json(res, 200, outcome) }
    if (req.method === 'POST' && url.pathname === '/coop/remove-participant') { const body = await readBody(req); if (state.coop.mode !== 'coop-host') return json(res, 403, { error: 'Only the local room host can remove a participant.' }); const invite = roomService.removeParticipant(state.coop.activeRoomId, cleanText(body.participantId, 160)); state.coop.invite = invite; appendEvent('coop_participant_removed', { status: 'rotated', reason: 'Participant removed; room code and encryption key were rotated.' }); persistState(); broadcast('coop'); return json(res, 200, invite) }
    const coopJoinProject = url.pathname.match(/^\/coop\/projects\/([^/]+)\/join$/)
    if (req.method === 'POST' && coopJoinProject) {
      const body = await readBody(req)
      const pending = (state.coop.pendingProjects || []).find((item) => item.id === cleanText(coopJoinProject[1], 80))
      if (!pending) return json(res, 404, { error: 'Shared project is no longer available.' })
      if (body.confirmed !== true) return json(res, 400, { error: 'Explicit local confirmation is required to use this device and its provider usage.' })
      if (state.activeProject || pipelineRunning) return json(res, 409, { error: 'A local project is already active.' })
      const gate = await resolveUsageAuthorization(); if (!gate.allowed) return json(res, 409, { error: gate.reason, code: gate.code, usage: visibleState().usage, providers: gate.providers })
      const pendingCapabilities = ensureProductionCapabilityRequests(pending.id)
      if (pendingCapabilities.length) {
        if (body.approveProjectCapabilities === true) {
          try { approveProjectCapabilityBundle(pending.id, pendingCapabilities, body.capabilityRequestIds) } catch (error) { return json(res, 409, { error: cleanText(error.message, 500), approvalBundle: capabilityApprovalBundle(pending.id, pendingCapabilities, 'coop-join') }) }
        } else {
          state.intake.pendingProjectId = projectId
          persistState(); broadcast('capabilities')
          return json(res, 428, { error: 'Review and approve this project permission bundle before the local crew joins.', approvalBundle: capabilityApprovalBundle(pending.id, pendingCapabilities, 'coop-join') })
        }
      }
      state.mode = 'working'; state.meeting = null; state.intake = null
      state.activeProject = { id: pending.id, title: pending.title, startedAt: nowIso(), source: 'coop-shared', remoteOwner: pending.participantId, completedStages: [], attempt: 1, promptVersions: { ...state.promptVersions }, userGuidance: [], usageAuthorization: gate.authorization }
      state.coop.pendingProjects = state.coop.pendingProjects.map((item) => item.id === pending.id ? { ...item, status: 'joined-locally' } : item)
      updateAgent('researcher', 'researching', `Collaborating with ${pending.participantLabel}'s Researcher`); updateAgent('editor', 'waiting', 'Waiting for both Researcher handoffs'); updateAgent('manager', 'waiting', 'Waiting for both local production candidates')
      sendCoopEnvelope('project-joined', { projectId: pending.id, participantId: roomService.identity.id, joinedAt: nowIso(), workers: localCrewSnapshot() })
      appendEvent('coop_project_joined', { projectId: pending.id, status: 'working', reason: `This device joined ${pending.participantLabel}'s shared project using only its own providers.` })
      persistState(); broadcast('coop-project'); void runAutonomousPipeline(state.activeProject)
      return json(res, 200, visibleState())
    }
    if (req.method === 'GET' && url.pathname === '/coop/status') return json(res, 200, { ...state.coop, identity: { id: roomService.identity.id, label: roomService.identity.label, publicKey: roomService.identity.publicKey }, protocolVersion: '4.0.0', sixWorkers: state.coop.mode !== 'solo', transport: coopTransport.status() })
    if (req.method === 'POST' && url.pathname === '/coop/leave') { coopTransport.close(); state.coop = { activeRoomId: null, mode: 'solo', participants: [], remoteCrews: [], pendingProjects: [], roleHandoffs: [], sharedLog: [], finalReviews: [], managerEscalations: [], artifacts: [] }; appendEvent('coop_room_left', { status: 'idle', reason: 'Local participant left co-op; no private memory or credentials were shared.' }); persistState(); broadcast('coop'); return json(res, 200, state.coop) }

    if (req.method === 'GET' && url.pathname === '/chat/team') return json(res, 200, teamChatView())

    if (req.method === 'POST' && url.pathname === '/chat/team/messages') {
      const body = await readBody(req)
      const text = cleanText(body.text, 4000)
      if (!text) return json(res, 400, { error: 'A non-empty team chat message is required.' })
      const teamMessageId = `team-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
      const createdAt = nowIso()
      state.teamConversations = [...state.teamConversations.slice(-99), { id: teamMessageId, text, createdAt }]
      const queued = {}
      for (const agentId of AGENT_IDS) {
        const conversation = { conversationScope: 'team', teamMessageId }
        const message = chatMessage(agentId, 'user', text, 'queued', conversation)
        const queueItem = { id: `queue-${Date.now()}-${agentId}-${Math.random().toString(36).slice(2, 6)}`, agentId, messageId: message.id, createdAt, ...conversation }
        state.chatQueues[agentId] = [...state.chatQueues[agentId], queueItem].slice(-100)
        queued[agentId] = { messageId: message.id, queuePosition: state.chatQueues[agentId].length }
      }
      appendEvent('team_chat_queued', { status: 'queued', reason: 'One read-only message was queued independently for all three employees. Production usage gates do not apply.' })
      persistState(); broadcast('chat_queued')
      setImmediate(processChatQueue)
      return json(res, 202, { teamMessageId, queued })
    }

    const chatMatch = url.pathname.match(/^\/chat\/(researcher|editor|manager)$/)
    if (req.method === 'GET' && chatMatch) {
      const agentId = chatMatch[1]
      return json(res, 200, {
        agent: state.agents[agentId],
        messages: state.agentChats[agentId],
        queue: state.chatQueues[agentId],
        runtime: state.chatRuntime[agentId],
        metrics: state.chatMetrics[agentId],
        guidance: state.guidanceItems.filter((item) => item.sourceAgent === agentId || item.owner === agentId),
        timing: timingSummary(agentId),
        blocker: latestChatBlocker(agentId),
      })
    }

    const chatMessageMatch = url.pathname.match(/^\/chat\/(researcher|editor|manager)\/messages$/)
    if (req.method === 'POST' && chatMessageMatch) {
      const agentId = chatMessageMatch[1]
      const body = await readBody(req)
      const text = cleanText(body.text, 4000)
      if (!text) return json(res, 400, { error: 'A non-empty chat message is required.' })
      const message = chatMessage(agentId, 'user', text)
      const queued = { id: `queue-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, agentId, messageId: message.id, createdAt: nowIso() }
      state.chatQueues[agentId] = [...state.chatQueues[agentId], queued].slice(-100)
      appendEvent('chat_queued', { agent: agentId, status: 'queued', reason: 'Independent employee chat queued. Production usage gates do not apply.' })
      persistState(); broadcast('chat_queued')
      setImmediate(() => processChatQueue(agentId))
      return json(res, 202, { message, queuePosition: state.chatQueues[agentId].length })
    }

    const chatRetryMatch = url.pathname.match(/^\/chat\/(researcher|editor|manager)\/messages\/([^/]+)\/retry$/)
    if (req.method === 'POST' && chatRetryMatch) {
      const agentId = chatRetryMatch[1]
      const original = state.agentChats[agentId].find((message) => message.id === cleanText(chatRetryMatch[2], 160) && message.author === 'user')
      if (!original) return json(res, 404, { error: 'Chat message not found.' })
      if (!['blocked', 'failed'].includes(original.status)) return json(res, 409, { error: 'Only blocked or failed messages can be retried.' })
      original.retryable = false
      const conversation = original.conversationScope === 'team' ? { conversationScope: 'team', teamMessageId: original.teamMessageId } : {}
      const message = chatMessage(agentId, 'user', original.text, 'queued', { retryOf: original.id, ...conversation })
      const queued = { id: `queue-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, agentId, messageId: message.id, createdAt: nowIso(), retryOf: original.id, ...conversation }
      state.chatQueues[agentId] = [...state.chatQueues[agentId], queued].slice(-100)
      appendEvent('chat_retried', { agent: agentId, status: 'queued', reason: 'User manually retried a terminal employee-chat message.' })
      persistState(); broadcast('chat_queued')
      setImmediate(() => processChatQueue(agentId))
      return json(res, 202, { message, queuePosition: state.chatQueues[agentId].length })
    }

    const guidanceMatch = url.pathname.match(/^\/chat\/guidance\/([^/]+)\/(approve|dismiss|pin|remove)$/)
    if (req.method === 'POST' && guidanceMatch) {
      const body = await readBody(req)
      const guidance = state.guidanceItems.find((item) => item.id === cleanText(guidanceMatch[1], 120))
      if (!guidance) return json(res, 404, { error: 'Guidance item not found.' })
      const action = guidanceMatch[2]
      if (action === 'approve') {
        const text = cleanText(body.text || guidance.text, 500)
        if (!text) return json(res, 400, { error: 'Approved rule text cannot be empty.' })
        guidance.status = 'approved-permanent'
        guidance.text = text
        const rule = { id: guidance.id, text, owner: guidance.owner, approvedAt: nowIso(), source: `employee-chat:${guidance.sourceAgent}` }
        state.approvedRules = [...state.approvedRules.filter((item) => item.id !== rule.id), rule].slice(-200)
        saveApprovedRules()
        appendEvent('permanent_rule_approved', { agent: guidance.sourceAgent, status: 'approved', reason: text, output: APPROVED_RULES_FILE })
      } else if (action === 'dismiss' || action === 'remove') {
        guidance.status = action === 'dismiss' ? 'dismissed' : 'removed'
        appendEvent('guidance_dismissed', { agent: guidance.sourceAgent, status: guidance.status, reason: guidance.text })
      } else {
        guidance.status = 'pending'
        guidance.priority = 'high'
        appendEvent('guidance_pinned', { agent: guidance.sourceAgent, status: 'pending', reason: guidance.text })
      }
      persistState(); broadcast('guidance')
      return json(res, 200, guidance)
    }

    if (req.method === 'POST' && url.pathname === '/task/intake') {
      if (state.activeProject) return json(res, 409, { error: 'A project is already active.' })
      state.mode = 'intake'
      state.intake = { id: `intake-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, createdAt: nowIso(), confirmed: false }
      updateAgent('researcher', 'blocked', 'Waiting for your idea or permission to research one')
      updateAgent('editor', 'waiting', 'Waiting for a researched brief')
      updateAgent('manager', 'waiting', 'Waiting for a project proposal')
      addMessage('researcher', 'user', 'Do you already have a video or channel idea, or should I research the strongest option and get started?', 'question')
      appendEvent('intake_started', { status: 'awaiting_confirmation', reason: 'User opened an explicit intake session.' })
      persistState(); broadcast('intake')
      return json(res, 200, visibleState())
    }

    if (req.method === 'POST' && url.pathname === '/task/start') {
      const body = await readBody(req)
      if (state.activeProject || pipelineRunning) return json(res, 409, { error: 'A project is already active.' })
      if (state.mode !== 'intake' || !state.intake || body.intakeId !== state.intake.id || body.confirmed !== true) {
        return json(res, 409, { error: 'Start requires an explicit, matching intake confirmation.' })
      }
      const gate = await resolveUsageAuthorization()
      if (!gate.allowed) return json(res, 409, { error: gate.reason, code: gate.code, usage: visibleState().usage, providers: gate.providers })
      const title = cleanText(body.title, 180)
      if (!title) return json(res, 400, { error: 'A non-empty project title is required.' })
      const projectId = cleanText(body.projectId || `video-${safeProjectName(title)}`, 80)
      const pendingCapabilities = ensureProductionCapabilityRequests(projectId)
      if (pendingCapabilities.length) {
        if (body.approveProjectCapabilities === true) {
          try { approveProjectCapabilityBundle(projectId, pendingCapabilities, body.capabilityRequestIds) } catch (error) { return json(res, 409, { error: cleanText(error.message, 500), approvalBundle: capabilityApprovalBundle(projectId, pendingCapabilities) }) }
        } else {
          persistState(); broadcast('capabilities')
          return json(res, 428, { error: 'Review and approve this project permission bundle before production starts.', approvalBundle: capabilityApprovalBundle(projectId, pendingCapabilities) })
        }
      }
      state.mode = 'working'
      state.meeting = null
      state.intake.confirmed = true
      state.intake.confirmedAt = nowIso()
      state.intake.pendingProjectId = null
      const pendingGuidance = state.guidanceItems.filter((item) => item.status === 'pending').map((item) => ({ id: item.id, owner: item.owner, text: item.text, priority: item.priority }))
      state.activeProject = { id: projectId, title, startedAt: nowIso(), source: 'explicit-intake', completedStages: [], attempt: 1, promptVersions: { ...state.promptVersions }, userGuidance: pendingGuidance, usageAuthorization: gate.authorization }
      for (const item of state.guidanceItems) if (pendingGuidance.some((guide) => guide.id === item.id)) item.status = 'incorporated'
      updateAgent('researcher', 'researching', 'Building the evidence and source brief')
      updateAgent('editor', 'waiting', 'Waiting for the Researcher handoff')
      updateAgent('manager', 'waiting', 'Waiting for a researched proposal and usage estimate')
      addMessage('researcher', 'team', `Research started: ${title}`, 'assignment')
      sendCoopEnvelope('project-started', { projectId, title, startedAt: state.activeProject.startedAt, participantId: roomService.identity.id, participantLabel: localParticipantLabel(), workers: localCrewSnapshot() })
      appendEvent('task_started', { projectId, status: 'working', reason: `Confirmed intake started: ${title}`, evidence: [state.intake.id], cost: emptyCost() })
      persistState(); broadcast()
      void runAutonomousPipeline(state.activeProject)
      return json(res, 200, visibleState())
    }

    if (req.method === 'POST' && url.pathname === '/task/restart') {
      if (!state.activeProject || !['recovery', 'blocked'].includes(state.mode) || pipelineRunning) {
        return json(res, 409, { error: 'No recoverable pipeline is waiting to restart.' })
      }
      const gate = await resolveUsageAuthorization()
      if (!gate.allowed) return json(res, 409, { error: gate.reason, code: gate.code, usage: visibleState().usage, providers: gate.providers })
      state.mode = 'working'
      state.recovery = null
      state.activeProject.usageAuthorization = gate.authorization
      state.activeProject.attempt = Number(state.activeProject.attempt || 1) + 1
      appendEvent('pipeline_restarted', { projectId: state.activeProject.id, status: 'working', reason: 'Explicit restart accepted; completed stage checkpoints will be preserved.', evidence: state.activeProject.completedStages || [] })
      persistState(); broadcast('pipeline')
      void runAutonomousPipeline(state.activeProject)
      return json(res, 200, visibleState())
    }

    if (req.method === 'POST' && url.pathname === '/task/cancel') {
      if (!state.activeProject && state.mode === 'intake') {
        if (state.intake?.pendingProjectId) denyPendingProjectCapabilities(state.intake.pendingProjectId, 'The user cancelled project intake before any worker launched.')
        for (const id of Object.keys(state.agents)) updateAgent(id, 'waiting', 'Waiting for work', { processId: null })
        state.mode = 'idle'
        state.intake = null
        state.recovery = null
        appendEvent('intake_cancelled', { status: 'cancelled', reason: 'User closed intake without starting work.' })
        persistState(); broadcast('intake')
        return json(res, 202, visibleState())
      }
      if (!state.activeProject) return json(res, 409, { error: 'No active, intake, or recoverable project to cancel.' })
      cancelRequested = true
      state.mode = 'cancelling'
      appendEvent('cancellation_requested', { projectId: state.activeProject.id, agent: activeWorker?.agentId, processId: activeWorker?.processId, status: 'cancelling', reason: 'User requested cancellation.' })
      if (activeCodexProcess && !activeCodexProcess.killed) activeCodexProcess.kill()
      if (!pipelineRunning) {
        for (const id of Object.keys(state.agents)) updateAgent(id, 'waiting', 'Waiting for work', { processId: null })
        state.mode = 'cancelled'
        state.activeProject = null
        state.intake = null
        state.recovery = null
      }
      persistState(); broadcast('pipeline')
      return json(res, 202, visibleState())
    }

    const agentMatch = url.pathname.match(/^\/agent\/(researcher|editor|manager)$/)
    if (req.method === 'POST' && agentMatch) {
      const body = await readBody(req)
      if (!state.activeProject && body.status !== 'waiting') return json(res, 409, { error: 'Agents cannot work without an active project.' })
      updateAgent(agentMatch[1], cleanText(body.status, 30), body.task)
      appendEvent('agent_status', { agent: agentMatch[1], status: body.status, task: cleanText(body.task, 180) })
      persistState(); broadcast()
      return json(res, 200, state.agents[agentMatch[1]])
    }

    if (req.method === 'POST' && url.pathname === '/role/assign') {
      const body = await readBody(req)
      const assignedTo = cleanText(body.assignedTo, 30)
      const taskOwner = cleanText(body.taskOwner, 30)
      const task = cleanText(body.task, 240)
      if (!state.agents[assignedTo] || !state.agents[taskOwner] || !task) return json(res, 400, { error: 'assignedTo, taskOwner, and task must identify a valid role assignment.' })
      if (assignedTo === taskOwner) {
        addMessage(assignedTo, 'team', `Accepted role-owned assignment: ${task}`, 'assignment')
        appendEvent('role_assignment_accepted', { agent: assignedTo, status: 'accepted', reason: task, projectId: state.activeProject?.id })
      } else {
        const challenge = {
          id: `challenge-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          projectId: state.activeProject?.id || null, assignedTo, taskOwner, task,
          status: 'resolved', createdAt: nowIso(), resolution: `${taskOwner} retained ownership; ${assignedTo} may provide role-appropriate support.`,
        }
        state.roleChallenges = [...state.roleChallenges, challenge].slice(-100)
        addMessage(assignedTo, taskOwner, `That belongs with ${AGENT_DEFS[taskOwner].role}. I can support it from ${AGENT_DEFS[assignedTo].role}, but I will not take over their responsibility.`, 'role-challenge')
        addMessage(taskOwner, 'team', `I am stepping in as the designated owner for: ${task}`, 'role-owner')
        addMessage('manager', 'team', `Decision: ${taskOwner} owns the task; ${assignedTo} may provide scoped support.`, 'role-decision')
        appendEvent('role_redirect_resolved', { agent: assignedTo, projectId: state.activeProject?.id, status: 'resolved', reason: challenge.resolution, evidence: [challenge.id] })
      }
      persistState(); broadcast('roles')
      return json(res, 200, { ok: true, roleChallenges: state.roleChallenges.slice(-1), messages: state.messages.slice(-3) })
    }

    if (req.method === 'POST' && url.pathname === '/desktop/connection') {
      const body = await readBody(req)
      const previousConnected = Boolean(state.desktopConnection?.connected)
      state.desktopConnection = {
        connected: body.connected === true,
        status: body.connected === true ? 'connected' : 'required',
        checkedAt: nowIso(),
        threadId: body.connected === true ? cleanText(body.threadId, 180) || null : null,
        deliveryMode: body.connected === true ? cleanText(body.deliveryMode, 50) || null : null,
      }
      if (previousConnected !== state.desktopConnection.connected) appendEvent('desktop_connection_changed', { status: state.desktopConnection.status, reason: state.desktopConnection.connected ? 'Codex desktop task gateway is connected.' : 'Codex desktop task connection is unavailable.' })
      persistState(); broadcast('connection')
      setImmediate(processChatQueue)
      return json(res, 200, state.desktopConnection)
    }

    const reviewMatch = url.pathname.match(/^\/review-reminder\/([^/]+)\/activate$/)
    if (req.method === 'POST' && reviewMatch) {
      const reminder = state.reviewReminders.find((item) => item.id === cleanText(reviewMatch[1], 120))
      if (!reminder) return json(res, 404, { error: 'Review reminder not found.' })
      reminder.status = 'approved'
      reminder.activatedAt = nowIso()
      appendEvent('historical_review_approved', { projectId: reminder.projectId, status: 'approved', reason: `User approved historical review reminder ${reminder.id}. No worker launches until a normal confirmed intake passes usage gates.` })
      persistState(); broadcast('review')
      return json(res, 200, reminder)
    }

    if (req.method === 'POST' && url.pathname === '/message') {
      const body = await readBody(req)
      const message = addMessage(cleanText(body.from, 30), body.to, body.summary, body.kind, body.evidence)
      persistState(); broadcast('message')
      return json(res, 200, message)
    }

    if (req.method === 'POST' && url.pathname === '/usage') {
      const body = await readBody(req)
      if (typeof body.ordinaryUsageAllowed !== 'boolean') return json(res, 400, { error: 'ordinaryUsageAllowed must be a boolean from a trusted usage snapshot.' })
      const finiteNumber = (value) => value === null || value === undefined || value === '' ? null : (Number.isFinite(Number(value)) ? Number(value) : null)
      const percent = (value) => {
        const number = finiteNumber(value)
        return number === null ? null : Math.max(0, Math.min(100, number))
      }
      state.usage = {
        fiveHourUsedPercent: percent(body.fiveHourUsedPercent),
        weeklyUsedPercent: percent(body.weeklyUsedPercent),
        ordinaryUsageAllowed: body.ordinaryUsageAllowed,
        policy: body.ordinaryUsageAllowed ? 'allowed' : 'blocked',
        source: cleanText(body.source || 'external-snapshot', 80),
        checkedAt: nowIso(),
        resetsAt: {
          primary: finiteNumber(body.resetsAt?.primary),
          secondary: finiteNumber(body.resetsAt?.secondary),
        },
        creditsAvailable: typeof body.creditsAvailable === 'boolean' ? body.creditsAvailable : null,
        note: body.ordinaryUsageAllowed ? 'Fresh snapshot permits ordinary usage.' : 'Pipeline blocked. Credits will not be consumed automatically.',
      }
      appendEvent('usage_snapshot', { status: state.usage.policy, reason: state.usage.note, evidence: [state.usage.source], cost: emptyCost() })
      persistState(); broadcast('usage')
      setImmediate(processChatQueue)
      return json(res, 200, state.usage)
    }

    if (req.method === 'POST' && url.pathname === '/task/complete') {
      const body = await readBody(req)
      if (pipelineRunning) return json(res, 409, { error: 'Use /task/cancel before completing a running pipeline.' })
      if (body.summary) addMessage('manager', 'user', body.summary, 'completion', body.evidence)
      const completedProject = state.activeProject
      for (const id of Object.keys(state.agents)) updateAgent(id, 'waiting', 'Waiting for work')
      state.mode = 'idle'
      state.activeProject = null
      state.intake = null
      appendEvent('task_completed', { projectId: completedProject?.id || null, summary: cleanText(body.summary, 500) })
      persistState(); broadcast()
      return json(res, 200, visibleState())
    }

    if (req.method === 'POST' && url.pathname === '/messages/mark-read') {
      state.messages = state.messages.map((m) => ({ ...m, readInChat: true }))
      persistState(); broadcast()
      return json(res, 200, { ok: true })
    }

    return json(res, 404, { error: 'Not found' })
  } catch (error) {
    return json(res, 400, { error: cleanText(error.message, 300) })
  }
})

const wss = new WebSocketServer({ server, path: `/session/${SESSION_TOKEN}/ws`, verifyClient: ({ origin }) => !origin || origin === 'http://127.0.0.1:3300' || origin === 'http://localhost:3300' })
wss.on('connection', (socket) => {
  clients.add(socket)
  socket.send(JSON.stringify({ type: 'state', state: visibleState() }))
  socket.on('close', () => clients.delete(socket))
  socket.on('error', () => clients.delete(socket))
})

persistState()
server.listen(PORT, HOST, () => {
  console.log(`YouTube Office bridge: http://${HOST}:${PORT}`)
  const configuredRelayUrl = String(LOCAL_CONFIG.coopRelayUrl || '')
  if (state.coop.activeRoomId && /^wss:\/\//.test(configuredRelayUrl)) {
    coopTransport.connect(configuredRelayUrl, 'relay')
    appendEvent('coop_relay_connecting', { status: 'connecting', reason: 'Connecting this office to its configured encrypted Internet relay.' })
    persistState()
  }
  setImmediate(processChatQueue)
})

function shutdown() {
  if (activeCodexProcess && !activeCodexProcess.killed) activeCodexProcess.kill()
  for (const child of Object.values(activeChatProcesses)) if (child && !child.killed) child.kill()
  for (const reporter of Object.values(reporters)) reporter.disconnect()
  coopTransport.close()
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 1500).unref()
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
