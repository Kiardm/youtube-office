'use strict'

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const PROMPT_DIR = path.join(__dirname, 'prompts')
const FILES = Object.freeze({
  shared: 'shared-protocol.md',
  researcher: 'researcher.md',
  editor: 'editor.md',
  manager: 'manager.md',
})

function readPrompt(name) {
  return fs.readFileSync(path.join(PROMPT_DIR, FILES[name]), 'utf8').trim()
}

const prompts = Object.freeze(Object.fromEntries(Object.keys(FILES).map((name) => [name, readPrompt(name)])))
const versions = Object.freeze(Object.fromEntries(Object.entries(prompts).map(([name, content]) => [
  name,
  `v1.0.0+${crypto.createHash('sha256').update(content).digest('hex').slice(0, 10)}`,
])))

function buildWorkerPrompt(agentId, projectContext) {
  if (!prompts[agentId]) throw new Error(`Unknown prompt role: ${agentId}`)
  const roleAwareness = ['researcher', 'editor', 'manager']
    .filter((id) => id !== agentId)
    .map((id) => prompts[id])
    .join('\n\n--- OTHER ROLE ---\n\n')
  return [prompts.shared, prompts[agentId], '## Other worker roles', roleAwareness, '## Current assignment', projectContext].join('\n\n')
}

module.exports = { prompts, versions, buildWorkerPrompt }
