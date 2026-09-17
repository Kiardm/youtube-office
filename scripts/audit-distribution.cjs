'use strict'

const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root })
  .toString('utf8').split('\0').filter(Boolean)
const textExtensions = new Set(['.cjs', '.js', '.json', '.md', '.ps1', '.ts', '.tsx', '.yml', '.yaml', '.gitignore'])
const findings = []
const forbiddenPaths = [/(^|\/)office-memory\.sqlite/i, /(^|\/)office-state\.json/i, /(^|\/)activity\.jsonl/i, /(^|\/)coop-private\.json/i, /(^|\/)agent-chats?\//i, /(^|\/)room-logs?\//i, /\.yobak$/i, /\.(mp4|mov|mkv|wav|mp3)$/i]
const rules = [
  { name: 'owner-specific Windows path', pattern: /[A-Za-z]:\\Users\\Owner\\/i },
  { name: 'GitHub personal token', pattern: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/ },
  { name: 'OpenAI-style secret key', pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/ },
  { name: 'PEM private key', pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/ },
]

for (const relative of files) {
  if (forbiddenPaths.some((pattern) => pattern.test(relative))) findings.push(`${relative}: private or generated data must not be distributed`)
  const extension = path.extname(relative).toLowerCase()
  if (!textExtensions.has(extension) && path.basename(relative) !== '.gitignore') continue
  let content
  try { content = fs.readFileSync(path.join(root, relative), 'utf8') } catch { continue }
  for (const rule of rules) {
    if (rule.pattern.test(content)) findings.push(`${relative}: ${rule.name}`)
  }
}

if (findings.length) {
  console.error(`Distribution audit failed:\n${findings.map((item) => `- ${item}`).join('\n')}`)
  process.exit(1)
}
console.log(`Distribution audit passed (${files.length} tracked/unignored files checked).`)
