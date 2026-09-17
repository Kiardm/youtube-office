const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')

const bridgeFile = path.join(__dirname, 'bridge-service.js')

async function waitFor(check, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const value = await check()
      if (value) return value
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('Timed out waiting for employee-chat integration state.')
}

test('three employee chats run independently without a usage or desktop-connection gate', { timeout: 20000 }, async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'youtube-office-chat-'))
  const fakeCodex = path.join(temp, 'fake-codex.js')
  const lifecycle = path.join(temp, 'lifecycle.jsonl')
  const port = 34000 + Math.floor(Math.random() * 1000)
  fs.writeFileSync(fakeCodex, `
const fs = require('node:fs')
const args = process.argv.slice(2)
const output = args[args.indexOf('-o') + 1]
const model = args[args.indexOf('-m') + 1]
const role = model.includes('luna') ? 'researcher' : model.includes('terra') ? 'editor' : 'manager'
fs.appendFileSync(process.env.FAKE_CHAT_LIFECYCLE, JSON.stringify({ role, event: 'start', at: Date.now() }) + '\\n')
setTimeout(() => {
  fs.writeFileSync(output, JSON.stringify({ reply: role + ' personal reply', bubbleSummary: role + ' replied', guidanceCandidate: null }))
  fs.appendFileSync(process.env.FAKE_CHAT_LIFECYCLE, JSON.stringify({ role, event: 'end', at: Date.now() }) + '\\n')
}, 300)
`, 'utf8')

  const child = spawn(process.execPath, [bridgeFile], {
    cwd: path.join(__dirname, '..'),
    windowsHide: true,
    env: {
      ...process.env,
      YOUTUBE_OFFICE_PORT: String(port),
      YOUTUBE_OFFICE_DATA_DIR: temp,
      YOUTUBE_OFFICE_CODEX_BIN: process.execPath,
      YOUTUBE_OFFICE_CODEX_PREFIX_ARGS: JSON.stringify([fakeCodex]),
      FAKE_CHAT_LIFECYCLE: lifecycle,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const base = `http://127.0.0.1:${port}`
  try {
    await waitFor(async () => (await fetch(`${base}/health`)).ok)
    const agents = ['researcher', 'editor', 'manager']
    await Promise.all(agents.map((agent) => fetch(`${base}/chat/${agent}/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: `Hello ${agent}` }),
    })))

    const chats = await waitFor(async () => {
      const values = await Promise.all(agents.map((agent) => fetch(`${base}/chat/${agent}`).then((response) => response.json())))
      return values.every((value) => value.messages.some((message) => message.author === 'assistant' && message.status === 'complete')) ? values : null
    })
    assert.deepEqual(chats.map((chat) => chat.metrics.completed), [1, 1, 1])
    assert.ok(chats.every((chat) => chat.queue.length === 0 && chat.runtime.processId === null))
    assert.match(chats[0].messages.at(-1).text, /researcher personal reply/)
    assert.match(chats[1].messages.at(-1).text, /editor personal reply/)
    assert.match(chats[2].messages.at(-1).text, /manager personal reply/)

    const events = fs.readFileSync(lifecycle, 'utf8').trim().split(/\r?\n/).map(JSON.parse)
    const starts = events.filter((event) => event.event === 'start')
    const ends = events.filter((event) => event.event === 'end')
    assert.equal(starts.length, 3)
    assert.equal(ends.length, 3)
    assert.ok(Math.max(...starts.map((event) => event.at)) < Math.min(...ends.map((event) => event.at)), 'all three chats should overlap')

    const publicState = await fetch(`${base}/state`).then((response) => response.json())
    assert.equal(publicState.agentChats, undefined)
    assert.equal(publicState.chatQueues, undefined)
  } finally {
    child.kill()
    await new Promise((resolve) => child.once('exit', resolve))
    fs.rmSync(temp, { recursive: true, force: true })
  }
})
