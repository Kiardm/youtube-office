'use strict'

const USAGE_BLOCKED_SUMMARY = 'Production paused: ordinary model usage is unavailable. Employees remain available for conversation.'

const EVENT_TO_GATE = Object.freeze({
  intake_started: 'intake_required', approval_required: 'approval_required', usage_blocked: 'usage_blocked',
  pipeline_blocked: 'failed', pipeline_failed: 'failed', task_cancelled: 'cancelled',
  pipeline_restarted: 'restarted', pipeline_completed: 'completed',
})

function translateActivityEvent(event = {}) {
  const type = EVENT_TO_GATE[event.type]
  if (!type) return null
  const safeDefaults = {
    intake_required: 'The office needs a project brief or permission to research one.',
    approval_required: 'The office is waiting for a major approval.',
    usage_blocked: USAGE_BLOCKED_SUMMARY,
    failed: 'The production run stopped and needs attention.',
    cancelled: 'The production run was cancelled.',
    restarted: 'The production run restarted from persisted state.',
    completed: 'The production run reached its final verification gate.',
  }
  return {
    type,
    projectId: event.projectId || 'office',
    runId: event.runId || '',
    title: event.title || type.replaceAll('_', ' '),
    summary: event.publicSummary || safeDefaults[type],
    evidence: Array.isArray(event.evidence) ? event.evidence : [],
    occurredAt: event.timestamp,
  }
}

function verifyOfficeSnapshot(state, options = {}) {
  const violations = []
  const agents = Object.values(state?.agents || {})
  const mode = state?.mode || 'idle'
  const ordinaryUsageAllowed = options.ordinaryUsageAllowed !== false
  if (mode === 'idle') {
    if (state?.activeProject) violations.push('idle state must not retain an active project')
    if (agents.some((agent) => agent.status !== 'waiting')) violations.push('idle agents must all be waiting')
  }
  if (mode === 'intake' && state?.activeProject) violations.push('intake must not launch a project')
  if (!ordinaryUsageAllowed && (mode === 'working' || agents.some((agent) => !['waiting', 'blocked'].includes(agent.status)))) {
    violations.push('ordinary usage is blocked; production workers must not be active')
  }
  let gate = null
  if (!ordinaryUsageAllowed) gate = translateActivityEvent({ type: 'usage_blocked', projectId: state?.activeProject?.id })
  else if (mode === 'intake') gate = translateActivityEvent({ type: 'intake_started' })
  else if (mode === 'blocked') gate = translateActivityEvent({ type: 'pipeline_blocked', projectId: state?.activeProject?.id })
  return { ok: violations.length === 0, mode, violations, gate }
}

module.exports = { EVENT_TO_GATE, USAGE_BLOCKED_SUMMARY, translateActivityEvent, verifyOfficeSnapshot }
