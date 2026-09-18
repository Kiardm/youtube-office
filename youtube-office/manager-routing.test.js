'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const {
  MANAGER_ESCALATION_TRIGGERS,
  managerModels,
  parseManagerEscalation,
  premiumUsageGate,
} = require('./core/manager-routing')

test('Manager defaults to economical models while preserving one premium route', () => {
  assert.deepEqual(managerModels('codex'), { routine: 'gpt-5.6-terra', premium: 'gpt-6-astra' })
  assert.deepEqual(managerModels('claude'), { routine: 'sonnet', premium: 'opus' })
})

test('only explicit high-risk routing markers trigger premium review', () => {
  assert.equal(parseManagerEscalation('ASTRA_ESCALATION: none'), null)
  assert.equal(parseManagerEscalation('Minor warning: polish the title\nASTRA_ESCALATION: none'), null)
  for (const trigger of Object.keys(MANAGER_ESCALATION_TRIGGERS)) {
    assert.equal(parseManagerEscalation(`Final QA\nASTRA_ESCALATION: ${trigger}\n`), trigger)
  }
  assert.equal(parseManagerEscalation('ASTRA_ESCALATION: make-it-better'), null)
  assert.equal(parseManagerEscalation('ASTRA_ESCALATION: none', { coopDisagreement: true }), 'coop-manager-disagreement')
})

test('premium review requires fresh unrestricted usage and protected reserves', () => {
  const available = { ordinaryUsageAllowed: true, weeklyUsedPercent: 60, fiveHourUsedPercent: 30 }
  assert.equal(premiumUsageGate(available, true).allowed, true)
  assert.equal(premiumUsageGate(available, false).allowed, false)
  assert.equal(premiumUsageGate({ ...available, ordinaryUsageAllowed: false }, true).allowed, false)
  assert.equal(premiumUsageGate({ ...available, weeklyUsedPercent: 90 }, true).allowed, false)
  assert.equal(premiumUsageGate({ ...available, fiveHourUsedPercent: 80 }, true).allowed, false)
})

test('bridge records the real model, reasoning, trigger, and one-call premium limit', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, 'bridge-service.js'), 'utf8')
  assert.match(source, /managerRoute\.routine/)
  assert.match(source, /managerRoute\.premium/)
  assert.match(source, /premiumEscalations/)
  assert.match(source, /attempts\.length >= 1/)
  assert.match(source, /manager_escalation_started/)
  assert.match(source, /manager_escalation_blocked/)
  assert.match(source, /escalationTrigger/)
  assert.match(source, /modelLabel/)
})
