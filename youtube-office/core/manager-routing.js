'use strict'

const MANAGER_ESCALATION_TRIGGERS = Object.freeze({
  'licensing-uncertainty': 'Copyright or licensing remains materially unresolved.',
  'high-impact-factual-claim': 'A high-impact factual claim remains unresolved.',
  'technical-qa-conflict': 'Technical QA failed or produced conflicting evidence.',
  'coop-manager-disagreement': 'The two co-op Managers disagree about the final candidate.',
  'public-release-risk': 'A public release has an unresolved high-risk finding.',
})

const ROUTES = Object.freeze({
  codex: Object.freeze({ routine: 'gpt-5.6-terra', premium: 'gpt-6-astra' }),
  claude: Object.freeze({ routine: 'sonnet', premium: 'opus' }),
})

function managerModels(providerId = 'codex') {
  return ROUTES[providerId] || ROUTES.codex
}

function parseManagerEscalation(report, options = {}) {
  if (options.coopDisagreement === true) return 'coop-manager-disagreement'
  const match = String(report || '').match(/^ASTRA_ESCALATION:\s*([^\r\n]+)\s*$/im)
  if (!match) return null
  const value = match[1].trim().toLowerCase()
  return Object.hasOwn(MANAGER_ESCALATION_TRIGGERS, value) ? value : null
}

function premiumUsageGate(usage, usageIsFresh) {
  if (!usageIsFresh) return { allowed: false, reason: 'Exact usage is unavailable, so premium Manager escalation will not start automatically.' }
  if (usage?.ordinaryUsageAllowed !== true) return { allowed: false, reason: 'Ordinary model usage is restricted, so premium Manager escalation will not start automatically.' }
  if (Number.isFinite(usage?.weeklyUsedPercent) && usage.weeklyUsedPercent >= 90) return { allowed: false, reason: 'Weekly usage has reached the protected 10% reserve.' }
  if (Number.isFinite(usage?.fiveHourUsedPercent) && usage.fiveHourUsedPercent >= 80) return { allowed: false, reason: 'Five-hour usage has reached the protected 20% reserve.' }
  return { allowed: true, reason: 'Fresh usage data leaves both protected reserves available.' }
}

function modelLabel(providerId, model, reasoning) {
  const provider = providerId === 'claude' ? 'Claude' : 'Codex'
  return `${provider} · ${model} · ${reasoning}`
}

module.exports = {
  MANAGER_ESCALATION_TRIGGERS,
  managerModels,
  parseManagerEscalation,
  premiumUsageGate,
  modelLabel,
}
