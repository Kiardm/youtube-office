const SESSION_TOKEN = process.env.YOUTUBE_OFFICE_SESSION_TOKEN || 'browser-preview'
const BASE = process.env.YOUTUBE_OFFICE_URL || `http://127.0.0.1:3310/session/${encodeURIComponent(SESSION_TOKEN)}`

function parseArgs(items) {
  const out = { _: [] }
  for (let i = 0; i < items.length; i++) {
    const value = items[i]
    if (value.startsWith('--')) out[value.slice(2)] = items[++i] ?? true
    else out._.push(value)
  }
  return out
}

async function request(path, method = 'GET', body) {
  const response = await fetch(BASE + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await response.json()
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`)
  return data
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const command = args._[0] || 'status'
  let result
  if (command === 'status') result = await request('/state')
  else if (command === 'unread') result = await request('/unread')
  else if (command === 'mark-read') result = await request('/messages/mark-read', 'POST', {})
  else if (command === 'start') result = await request('/task/start', 'POST', { projectId: args.project, title: args.title })
  else if (command === 'agent') result = await request(`/agent/${args._[1]}`, 'POST', { status: args.status, task: args.task })
  else if (command === 'message') result = await request('/message', 'POST', { from: args.from, to: args.to, summary: args.summary, kind: args.kind, evidence: args.evidence ? [args.evidence] : [] })
  else if (command === 'usage') result = await request('/usage', 'POST', { fiveHourUsedPercent: Number(args.five), weeklyUsedPercent: Number(args.weekly) })
  else if (command === 'complete') result = await request('/task/complete', 'POST', { summary: args.summary })
  else throw new Error(`Unknown command: ${command}`)
  console.log(JSON.stringify(result, null, 2))
}

main().catch((error) => { console.error(error.message); process.exitCode = 1 })
