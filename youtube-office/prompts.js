'use strict'

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const PROMPT_DIR = path.join(__dirname, 'prompts')
const CONTENT_ROOT = process.env.CONTENT_OPS_ROOT || 'C:\\Users\\Owner\\Documents\\Codex\\2026-09-13\\id'
const MASTER_PROMPT_FILE = path.join(CONTENT_ROOT, 'MASTER_PROMPT.md')
const APPROVED_RULES_FILE = path.join(CONTENT_ROOT, 'content-ops', 'user-approved-rules.json')
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
  return [prompts.shared, readOptional(MASTER_PROMPT_FILE, 'No master prompt file was available.'), approvedRulesText(), prompts[agentId], '## Other worker roles', roleAwareness, '## Current assignment', projectContext].join('\n\n')
}

function readOptional(file, fallback = '') {
  try { return fs.readFileSync(file, 'utf8').trim() } catch { return fallback }
}

function approvedRulesText() {
  try {
    const parsed = JSON.parse(readOptional(APPROVED_RULES_FILE, '[]'))
    const rules = Array.isArray(parsed) ? parsed : parsed.rules
    if (!Array.isArray(rules) || rules.length === 0) return '## User-approved permanent add-ons\n\nNo add-on rules have been approved.'
    return `## User-approved permanent add-ons\n\n${rules.map((rule) => `- ${String(rule.text || '').trim()}`).filter((line) => line !== '-').join('\n')}`
  } catch { return '## User-approved permanent add-ons\n\nThe managed rules file could not be parsed; do not infer rules.' }
}

function buildChatPrompt(agentId, snapshot, recentMessages) {
  if (!prompts[agentId]) throw new Error(`Unknown prompt role: ${agentId}`)
  const conversation = recentMessages.map((message) => `${message.author === 'user' ? 'User' : prompts[agentId].match(/^#\s+(.+)/m)?.[1] || agentId}: ${message.text}`).join('\n')
  return buildWorkerPrompt(agentId, [
    '## Advisory chat contract',
    'This is a read-only employee conversation. Do not browse, edit files, launch work, publish, upload, or claim that any action occurred. Start a project is the only production trigger.',
    'Stay in character. Clearly label facts, estimates, opinions, and unavailable information. Redirect role-inappropriate work to its proper owner.',
    'Be concise by default: normally answer in one to three short paragraphs. Expand only when the user explicitly requests more detail.',
    'Use only the supplied project snapshot and timing evidence. If timing history is insufficient, say no reliable ETA exists.',
    'Return strict JSON only: {"reply":"full response","bubbleSummary":"max 120 characters","guidanceCandidate":null} or guidanceCandidate {"text":"concise proposed guidance","owner":"researcher|editor|manager","reason":"why"}.',
    'Direct criticism may become a proposed permanent rule, but never save it yourself.',
    `Current sanitized snapshot:\n${JSON.stringify(snapshot, null, 2)}`,
    `This employee's recent conversation only:\n${conversation || '(none)'}`,
  ].join('\n\n'))
}

module.exports = { prompts, versions, buildWorkerPrompt, buildChatPrompt, APPROVED_RULES_FILE }
