const fs = require('fs')
const http = require('http')
const path = require('path')
const { execFile } = require('child_process')
const { WebSocketServer } = require('ws')
const { createPixelReporter } = require('../reporter-sdk')

const HOST = '127.0.0.1'
const PORT = Number(process.env.YOUTUBE_OFFICE_PORT || 3310)
const CONTENT_ROOT = process.env.CONTENT_OPS_ROOT || 'C:\\Users\\Owner\\Documents\\Codex\\2026-09-13\\id'
const DATA_DIR = path.join(__dirname, 'data')
const STATE_FILE = path.join(DATA_DIR, 'office-state.json')
const EVENT_FILE = path.join(DATA_DIR, 'activity.jsonl')
const MAX_BODY = 256 * 1024

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
  return String(value ?? '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max)
}

function defaultState() {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    mode: 'idle',
    activeProject: null,
    usage: {
      fiveHourUsedPercent: 29,
      weeklyUsedPercent: 96,
      policy: 'lockdown',
      note: 'Workers remain idle until instructed in the current Codex chat.',
    },
    agents: Object.fromEntries(Object.entries(AGENT_DEFS).map(([id, def]) => [id, {
      id,
      ...def,
      status: 'waiting',
      currentTask: 'Waiting for work',
      lastUpdateAt: new Date().toISOString(),
    }])),
    messages: [],
    outputs: [],
  }
}

function loadState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
    const base = defaultState()
    return {
      ...base,
      ...parsed,
      mode: 'idle',
      activeProject: null,
      agents: Object.fromEntries(Object.entries(base.agents).map(([id, agent]) => [id, {
        ...agent,
        ...(parsed.agents?.[id] || {}),
        status: 'waiting',
        currentTask: 'Waiting for work',
      }])),
    }
  } catch {
    return defaultState()
  }
}

fs.mkdirSync(DATA_DIR, { recursive: true })
let state = loadState()
let clients = new Set()

function persistState() {
  state.updatedAt = new Date().toISOString()
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n')
}

function appendEvent(type, data = {}) {
  const event = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, timestamp: new Date().toISOString(), type, ...data }
  fs.appendFileSync(EVENT_FILE, JSON.stringify(event) + '\n')
  return event
}

function broadcast(type = 'state') {
  const payload = JSON.stringify({ type, state })
  for (const client of clients) {
    if (client.readyState === 1) client.send(payload)
  }
}

const reporters = {}
const reporterTools = {}
for (const [id, def] of Object.entries(AGENT_DEFS)) {
  reporters[id] = createPixelReporter({
    serverUrl: process.env.PIXEL_OFFICE_SERVER || 'ws://127.0.0.1:3300/ws/report',
    machineId: 'youtube-office',
    agentName: def.name,
    persistent: true,
    silent: true,
  })
  reporters[id].connect()
}

function reporterStatus(id, status, task) {
  const reporter = reporters[id]
  if (!reporter) return
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

function updateAgent(id, status, task) {
  if (!state.agents[id]) throw new Error(`Unknown agent: ${id}`)
  const allowed = new Set(['waiting', 'working', 'researching', 'editing', 'reviewing', 'uploading', 'blocked'])
  if (!allowed.has(status)) throw new Error(`Invalid status: ${status}`)
  state.agents[id] = {
    ...state.agents[id],
    status,
    currentTask: cleanText(task || (status === 'waiting' ? 'Waiting for work' : status), 180),
    lastUpdateAt: new Date().toISOString(),
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`)
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,PUT,OPTIONS' })
    return res.end()
  }
  try {
    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true, mode: state.mode })
    if (req.method === 'GET' && url.pathname === '/state') return json(res, 200, state)
    if (req.method === 'GET' && url.pathname === '/git') return json(res, 200, await getGitSnapshot())
    if (req.method === 'GET' && url.pathname === '/unread') return json(res, 200, { messages: state.messages.filter((m) => !m.readInChat) })

    if (req.method === 'POST' && url.pathname === '/task/start') {
      const body = await readBody(req)
      const projectId = cleanText(body.projectId || `video-${Date.now()}`, 80)
      const title = cleanText(body.title || 'New YouTube assignment', 180)
      state.mode = 'working'
      state.activeProject = { id: projectId, title, startedAt: new Date().toISOString(), source: 'current-codex-chat' }
      updateAgent('manager', 'reviewing', 'Checking usage and assigning the project')
      updateAgent('researcher', 'researching', 'Building the evidence and source brief')
      updateAgent('editor', 'editing', 'Preparing the story and production plan')
      addMessage('manager', 'team', `Project accepted: ${title}`, 'assignment')
      appendEvent('task_started', { projectId, title })
      persistState(); broadcast()
      return json(res, 200, state)
    }

    const agentMatch = url.pathname.match(/^\/agent\/(researcher|editor|manager)$/)
    if (req.method === 'POST' && agentMatch) {
      const body = await readBody(req)
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
      const weekly = Math.max(0, Math.min(100, Number(body.weeklyUsedPercent ?? state.usage.weeklyUsedPercent)))
      const fiveHour = Math.max(0, Math.min(100, Number(body.fiveHourUsedPercent ?? state.usage.fiveHourUsedPercent)))
      state.usage = {
        ...state.usage,
        weeklyUsedPercent: weekly,
        fiveHourUsedPercent: fiveHour,
        policy: weekly >= 90 ? 'lockdown' : weekly >= 75 ? 'restricted' : 'normal',
        checkedAt: new Date().toISOString(),
      }
      persistState(); broadcast('usage')
      return json(res, 200, state.usage)
    }

    if (req.method === 'POST' && url.pathname === '/task/complete') {
      const body = await readBody(req)
      if (body.summary) addMessage('manager', 'user', body.summary, 'completion', body.evidence)
      const completedProject = state.activeProject
      for (const id of Object.keys(state.agents)) updateAgent(id, 'waiting', 'Waiting for work')
      state.mode = 'idle'
      state.activeProject = null
      appendEvent('task_completed', { projectId: completedProject?.id || null, summary: cleanText(body.summary, 500) })
      persistState(); broadcast()
      return json(res, 200, state)
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
  socket.send(JSON.stringify({ type: 'state', state }))
  socket.on('close', () => clients.delete(socket))
  socket.on('error', () => clients.delete(socket))
})

persistState()
server.listen(PORT, HOST, () => {
  console.log(`YouTube Office bridge: http://${HOST}:${PORT}`)
})

function shutdown() {
  for (const reporter of Object.values(reporters)) reporter.disconnect()
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 1500).unref()
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

