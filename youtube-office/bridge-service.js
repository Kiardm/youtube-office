const fs = require('fs')
const http = require('http')
const path = require('path')
const { execFile } = require('child_process')
const WS = require('ws')
const { WebSocketServer } = WS
// Pixel Office's reporter expects the EventEmitter-style `ws` API. Node 24
// also exposes a browser-style global WebSocket, so pin the reporter to `ws`.
globalThis.WebSocket = WS
const { createPixelReporter } = require('../reporter-sdk')

const HOST = '127.0.0.1'
const PORT = Number(process.env.YOUTUBE_OFFICE_PORT || 3310)
const CONTENT_ROOT = process.env.CONTENT_OPS_ROOT || 'C:\\Users\\Owner\\Documents\\Codex\\2026-09-13\\id'
const DATA_DIR = path.join(__dirname, 'data')
const STATE_FILE = path.join(DATA_DIR, 'office-state.json')
const EVENT_FILE = path.join(DATA_DIR, 'activity.jsonl')
const MAX_BODY = 256 * 1024
const USAGE_STALE_MS = Number(process.env.YOUTUBE_OFFICE_USAGE_STALE_MS || 15 * 60 * 1000)

const AGENT_DEFS = {
  researcher: {
    name: 'Researcher',
    role: 'Researcher / Planner',
    model: 'gpt-5.6-luna · medium',
    personality: 'Curious, trend-aware, and skeptical of weak sources.',
  },
  editor: {
    name: 'Editor',
    role: 'Creative Director / Editor',
    model: 'gpt-5.6-terra · medium',
    personality: 'Blunt, evidence-led, and protective of pacing and payoff.',
  },
  manager: {
    name: 'Manager',
    role: 'Manager / Publisher',
    model: 'gpt-6-astra · medium',
    personality: 'Cost-conscious, profit-focused, and strict about final quality.',
  },
}

function cleanText(value, max = 500) {
  return String(value ?? '')
    .replace(/(bearer\s+|api[_-]?key[=:]\s*|token[=:]\s*|cookie[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
}

function nowIso() { return new Date().toISOString() }

function emptyCost() {
  return { status: 'unknown', inputTokens: null, outputTokens: null, estimatedUsd: null }
}

function defaultState() {
  return {
    version: 2,
    updatedAt: nowIso(),
    mode: 'idle',
    activeProject: null,
    usage: {
      fiveHourUsedPercent: null,
      weeklyUsedPercent: null,
      ordinaryUsageAllowed: null,
      policy: 'unknown',
      source: null,
      checkedAt: null,
      resetsAt: { primary: null, secondary: null },
      creditsAvailable: null,
      note: 'Usage is unknown until a fresh external snapshot is provided. Credits are never consumed automatically.',
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
    const restored = {
      ...base,
      ...parsed,
      version: 2,
      usage: { ...base.usage, ...(parsed.usage || {}) },
      timeline: Array.isArray(parsed.timeline) ? parsed.timeline.slice(-300) : [],
      agents: Object.fromEntries(Object.entries(base.agents).map(([id, agent]) => [id, {
        ...agent,
        ...(parsed.agents?.[id] || {}),
        status: 'waiting',
        currentTask: 'Waiting for work', processId: null,
      }])),
    }
    if (parsed.activeProject && ['working', 'cancelling', 'recovery', 'blocked'].includes(parsed.mode)) {
      restored.mode = 'recovery'
      restored.recovery = { required: true, detectedAt: nowIso(), reason: 'Bridge restarted during an active pipeline.' }
      for (const id of Object.keys(restored.agents)) {
        restored.agents[id].status = 'blocked'
        restored.agents[id].currentTask = 'Interrupted by bridge restart; waiting for an explicit restart or cancellation'
      }
    }
    return restored
  } catch {
    return defaultState()
  }
}

fs.mkdirSync(DATA_DIR, { recursive: true })
let state = loadState()
let clients = new Set()
let pipelineRunning = false
let activeCodexProcess = null
let activeWorker = null
let cancelRequested = false

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
  }
  fs.appendFileSync(EVENT_FILE, JSON.stringify(event) + '\n')
  state.timeline = [...(state.timeline || []).slice(-299), event]
  return event
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

function visibleState() {
  if (usageIsFresh()) return state
  return {
    ...state,
    usage: {
      ...state.usage,
      fiveHourUsedPercent: null,
      weeklyUsedPercent: null,
      ordinaryUsageAllowed: null,
      policy: 'unknown',
      source: null,
      checkedAt: null,
      note: 'Usage snapshot is absent or stale.',
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
    machineId: 'youtube-office',
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
    lastUpdateAt: nowIso(),
  }
  reporterStatus(id, status, state.agents[id].currentTask)
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

function json(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
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

function safeProjectName(value) {
  return cleanText(value, 80).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || `project-${Date.now()}`
}

function runCodexWorker(agentId, model, prompt, outputFile) {
  return new Promise((resolve, reject) => {
    const gate = usageGate()
    if (!gate.allowed) return reject(new Error(`Worker start blocked: ${gate.reason}`))
    if (cancelRequested) return reject(new Error('Pipeline cancelled before worker start.'))
    const args = [
      'exec', '-m', model,
      '-c', 'model_reasoning_effort="medium"',
      '-C', CONTENT_ROOT,
      '-s', 'danger-full-access',
      '-a', 'never',
      '--search',
      '--color', 'never',
      '-o', outputFile,
      prompt,
    ]
    const startedAt = nowIso()
    const child = execFile('codex', args, { windowsHide: true, timeout: 2 * 60 * 60 * 1000, maxBuffer: 4 * 1024 * 1024 }, async (error, stdout, stderr) => {
      activeCodexProcess = null
      activeWorker = null
      const logFile = outputFile.replace(/\.md$/, '.log')
      fs.writeFileSync(logFile, `${stdout || ''}\n${stderr || ''}`.trim().slice(-100000) + '\n')
      const endedAt = nowIso()
      const exitCode = Number.isInteger(error?.code) ? error.code : (error ? 1 : 0)
      updateAgent(agentId, error ? 'blocked' : 'working', error ? 'Worker stopped before completing its handoff' : 'Worker completed; preparing handoff', {
        processId: null, startedAt, endedAt, exitCode,
      })
      const gitSnapshot = await getGitSnapshot()
      appendEvent(error ? (cancelRequested ? 'worker_cancelled' : 'worker_failed') : 'worker_completed', {
        agent: agentId,
        projectId: state.activeProject?.id,
        status: error ? (cancelRequested ? 'cancelled' : 'failed') : 'completed',
        reason: error ? cleanText(stderr || error.message, 500) : 'Codex worker exited successfully.',
        evidence: [logFile], output: outputFile, git: gitSnapshot, cost: emptyCost(), processId: child.pid,
      })
      persistState(); broadcast('worker')
      if (error) reject(new Error(cancelRequested ? 'Pipeline cancelled by request.' : `${AGENT_DEFS[agentId].name} failed: ${cleanText(stderr || error.message, 500)}`))
      else resolve({ processId: child.pid, startedAt, endedAt, exitCode, outputFile, logFile })
    })
    activeCodexProcess = child
    activeWorker = { agentId, processId: child.pid, startedAt, outputFile }
    updateAgent(agentId, state.agents[agentId].status, state.agents[agentId].currentTask, {
      processId: child.pid, startedAt, endedAt: null, exitCode: null,
    })
    appendEvent('worker_started', {
      agent: agentId, projectId: state.activeProject?.id, status: 'running', processId: child.pid,
      reason: 'Started sequential Codex worker process.', output: outputFile, cost: emptyCost(),
    })
    persistState(); broadcast('worker')
  })
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
  const postmortemFile = path.join(runDir, 'postmortem.md')
  const memoryFile = path.join(runDir, 'run-memory.json')
  project.completedStages = Array.isArray(project.completedStages) ? project.completedStages : []

  const beginStage = (stage) => {
    project.currentStage = stage
    project.lastStageStartedAt = nowIso()
    persistState()
  }
  const finishStage = (stage, output) => {
    if (!project.completedStages.includes(stage)) project.completedStages.push(stage)
    project.currentStage = null
    project.lastStageEndedAt = nowIso()
    appendEvent('stage_completed', { agent: stage, projectId: project.id, status: 'completed', reason: `${stage} handoff completed.`, output })
    persistState()
  }

  try {
    if (!project.completedStages.includes('researcher')) {
      beginStage('researcher')
      updateAgent('researcher', 'researching', 'Researching references, footage, audience demand, and the strongest execution plan')
      persistState(); broadcast()
      await runCodexWorker('researcher', 'gpt-5.6-luna', [
      `You are the human Researcher/Planner in a three-person YouTube production office. Project: ${project.title}.`,
      'Work independently and stay tightly scoped. Read the project master prompt and existing rules in this repository before acting.',
      'Use current primary sources when needed. Inventory usable footage and assets, preserve chronology and complete payoffs, and identify licensing or factual risks.',
      `Write a concise evidence-backed brief to ${researchFile}. Do not edit or publish the final video. Commit only your text/manifests with a Researcher-prefixed commit.`,
      'The account is in conservative usage mode: avoid optional revisions and stop if essential user information is missing.',
      ].join('\n'), researchFile)
      finishStage('researcher', researchFile)
      addMessage('researcher', 'editor', 'Research brief complete. Evidence, footage priorities, risks, and recommended structure are ready.', 'handoff', [researchFile])
    }

    if (!project.completedStages.includes('editor')) {
      beginStage('editor')
      updateAgent('researcher', 'waiting', 'Research handoff complete')
      updateAgent('editor', 'editing', 'Reviewing the evidence and assembling the strongest accurate production')
      persistState(); broadcast()
      await runCodexWorker('editor', 'gpt-5.6-terra', [
      `You are the human Creative Director/Editor. Project: ${project.title}.`,
      `Review the Researcher brief at ${researchFile} and challenge weak recommendations with evidence and a better alternative.`,
      'Then produce the requested content independently using local footage and tools. Entertainment and retention come first without misleading titles or thumbnails.',
      'For gaming: maintain chronology, keep complete jokes/clutches/kills/deaths/round outcomes, use the Yeti track once, censor profanity, avoid overlapping media and over-editing, use the approved intro, and export 1080p60 MP4 where sources allow.',
      `Record the exact outputs, checks, and remaining blockers in ${editFile}. Commit text/manifests/scripts with an Editor-prefixed commit; never commit large media or secrets.`,
      ].join('\n'), editFile)
      finishStage('editor', editFile)
      addMessage('editor', 'manager', 'Production candidate assembled. Technical checks and exact output paths are ready for final inspection.', 'handoff', [editFile])
    }

    if (!project.completedStages.includes('manager')) {
      beginStage('manager')
      updateAgent('editor', 'waiting', 'Candidate handed to Manager')
      updateAgent('manager', 'reviewing', 'Performing final quality, accuracy, licensing, retention, and cost inspection')
      persistState(); broadcast()
      await runCodexWorker('manager', 'gpt-6-astra', [
      `You are the human cost-focused Manager/Publisher. Project: ${project.title}.`,
      `Inspect ${researchFile} and ${editFile}, plus every stated output. Reject unsupported claims, broken chronology, cropped gameplay, weak pacing, misleading packaging, audio problems, overlaps, licensing risk, or missing payoffs.`,
      'Use local deterministic QA before any additional model work. Do not request optional revisions while usage is constrained.',
      'If and only if the candidate passes, create accurate high-retention title/thumbnail metadata and publish through the already-authorized channel tools when available. The newest approved revision should be public; superseded/rejected versions private, never deleted.',
      `Write the final decision, QA evidence, publication status, and any blocker to ${managerFile}. Commit release records with a Manager-prefixed commit.`,
      ].join('\n'), managerFile)
      finishStage('manager', managerFile)
    }
    addMessage('manager', 'user', 'Autonomous pipeline finished. Final QA and release status are ready in the manager report.', 'completion', [managerFile])
    state.outputs = [...state.outputs, { title: project.title, path: managerFile, status: 'reviewed' }].slice(-50)
    const completedAt = nowIso()
    const runSummary = {
      projectId: project.id, title: project.title, startedAt: project.startedAt, completedAt,
      completedStages: project.completedStages, outputs: [researchFile, editFile, managerFile],
      usageSnapshot: state.usage, cost: emptyCost(),
    }
    fs.writeFileSync(postmortemFile, `# Run postmortem\n\n- Project: ${cleanText(project.title, 180)}\n- Started: ${project.startedAt}\n- Completed: ${completedAt}\n- Stages: ${project.completedStages.join(', ')}\n- Cost: unknown (provider usage was not reported)\n\n## Durable lesson\n\nResume only from completed stage checkpoints, require fresh usage authorization before every worker, and never consume credits automatically.\n`)
    fs.writeFileSync(memoryFile, JSON.stringify(runSummary, null, 2) + '\n')
    state.mode = 'idle'
    state.activeProject = null
    state.intake = null
    for (const id of Object.keys(AGENT_DEFS)) updateAgent(id, 'waiting', 'Waiting for work')
    state.recovery = null
    appendEvent('pipeline_completed', { projectId: project.id, status: 'completed', reason: 'All sequential stages completed.', evidence: [postmortemFile, memoryFile], output: managerFile, cost: emptyCost() })
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
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`)
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS' })
    return res.end()
  }
  try {
    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true, mode: state.mode })
    if (req.method === 'GET' && url.pathname === '/state') return json(res, 200, visibleState())
    if (req.method === 'GET' && url.pathname === '/git') return json(res, 200, await getGitSnapshot())
    if (req.method === 'GET' && url.pathname === '/unread') return json(res, 200, { messages: state.messages.filter((m) => !m.readInChat) })

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
      const gate = usageGate()
      if (!gate.allowed) return json(res, 409, { error: gate.reason, usage: visibleState().usage })
      const projectId = cleanText(body.projectId || `video-${Date.now()}`, 80)
      const title = cleanText(body.title, 180)
      if (!title) return json(res, 400, { error: 'A non-empty project title is required.' })
      state.mode = 'working'
      state.intake.confirmed = true
      state.intake.confirmedAt = nowIso()
      state.activeProject = { id: projectId, title, startedAt: nowIso(), source: 'explicit-intake', completedStages: [], attempt: 1 }
      updateAgent('researcher', 'researching', 'Building the evidence and source brief')
      updateAgent('editor', 'waiting', 'Waiting for the Researcher handoff')
      updateAgent('manager', 'waiting', 'Waiting for a researched proposal and usage estimate')
      addMessage('researcher', 'team', `Research started: ${title}`, 'assignment')
      appendEvent('task_started', { projectId, status: 'working', reason: `Confirmed intake started: ${title}`, evidence: [state.intake.id], cost: emptyCost() })
      persistState(); broadcast()
      void runAutonomousPipeline(state.activeProject)
      return json(res, 200, visibleState())
    }

    if (req.method === 'POST' && url.pathname === '/task/restart') {
      if (!state.activeProject || !['recovery', 'blocked'].includes(state.mode) || pipelineRunning) {
        return json(res, 409, { error: 'No recoverable pipeline is waiting to restart.' })
      }
      const gate = usageGate()
      if (!gate.allowed) return json(res, 409, { error: gate.reason, usage: visibleState().usage })
      state.mode = 'working'
      state.recovery = null
      state.activeProject.attempt = Number(state.activeProject.attempt || 1) + 1
      appendEvent('pipeline_restarted', { projectId: state.activeProject.id, status: 'working', reason: 'Explicit restart accepted; completed stage checkpoints will be preserved.', evidence: state.activeProject.completedStages || [] })
      persistState(); broadcast('pipeline')
      void runAutonomousPipeline(state.activeProject)
      return json(res, 200, visibleState())
    }

    if (req.method === 'POST' && url.pathname === '/task/cancel') {
      if (!state.activeProject && state.mode === 'intake') {
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

const wss = new WebSocketServer({ server, path: '/ws' })
wss.on('connection', (socket) => {
  clients.add(socket)
  socket.send(JSON.stringify({ type: 'state', state: visibleState() }))
  socket.on('close', () => clients.delete(socket))
  socket.on('error', () => clients.delete(socket))
})

persistState()
server.listen(PORT, HOST, () => {
  console.log(`YouTube Office bridge: http://${HOST}:${PORT}`)
})

function shutdown() {
  if (activeCodexProcess && !activeCodexProcess.killed) activeCodexProcess.kill()
  for (const reporter of Object.values(reporters)) reporter.disconnect()
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 1500).unref()
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
