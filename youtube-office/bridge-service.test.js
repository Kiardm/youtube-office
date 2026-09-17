const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')

const bridgeSource = fs.readFileSync(path.join(__dirname, 'bridge-service.js'), 'utf8')

test('worker roles remain human and prompt-activated', () => {
  const source = bridgeSource
  assert.match(source, /Researcher \/ Planner/)
  assert.match(source, /Creative Director \/ Editor/)
  assert.match(source, /Manager \/ Publisher/)
  assert.match(source, /status: 'waiting'/)
  assert.doesNotMatch(source, /setInterval\([^)]*research/i)
})

test('GUI intake remains explicit and launches the autonomous handoff pipeline only after selection', () => {
  const source = bridgeSource
  assert.match(source, /\/task\/intake/)
  assert.match(source, /Do you already have a video or channel idea/)
  assert.match(source, /void runAutonomousPipeline\(state\.activeProject\)/)
  assert.match(source, /gpt-5\.6-luna/)
  assert.match(source, /gpt-5\.6-terra/)
  assert.match(source, /gpt-6-astra/)
  assert.match(source, /body\.intakeId !== state\.intake\.id/)
  assert.match(source, /body\.confirmed !== true/)
  assert.match(source, /A non-empty project title is required/)
})

test('real Codex workers run sequentially and expose lifecycle metadata', () => {
  const researcher = bridgeSource.indexOf("await runCodexWorker('researcher'")
  const editor = bridgeSource.indexOf("await runCodexWorker('editor'")
  const manager = bridgeSource.indexOf("await runCodexWorker('manager'")
  assert.ok(researcher > 0 && editor > researcher && manager > editor)
  assert.match(bridgeSource, /processId: child\.pid/)
  assert.match(bridgeSource, /startedAt/)
  assert.match(bridgeSource, /endedAt/)
  assert.match(bridgeSource, /exitCode/)
  assert.match(bridgeSource, /worker_started/)
  assert.match(bridgeSource, /worker_completed/)
})

test('timeline is sanitized and records reason, evidence, output, git and cost', () => {
  assert.match(bridgeSource, /\[REDACTED\]/)
  for (const field of ['reason:', 'evidence:', 'output:', 'git:', 'cost:']) assert.match(bridgeSource, new RegExp(field))
  assert.match(bridgeSource, /state\.timeline =/)
  assert.match(bridgeSource, /activity\.jsonl/)
})

test('usage is unknown by default and fresh ordinary-usage permission gates every worker', () => {
  assert.match(bridgeSource, /ordinaryUsageAllowed: null/)
  assert.match(bridgeSource, /policy: 'unknown'/)
  assert.match(bridgeSource, /Usage snapshot is absent or stale/)
  assert.match(bridgeSource, /ordinaryUsageAllowed !== true/)
  assert.match(bridgeSource, /credits will not be consumed automatically/i)
  assert.doesNotMatch(bridgeSource, /fiveHourUsedPercent:\s*29/)
  assert.doesNotMatch(bridgeSource, /weeklyUsedPercent:\s*96/)
  assert.doesNotMatch(bridgeSource, /weekly\s*>=\s*(75|90)/)
})

test('cancel, failure and restart recovery preserve completed checkpoints', () => {
  assert.match(bridgeSource, /\/task\/cancel/)
  assert.match(bridgeSource, /\/task\/restart/)
  assert.match(bridgeSource, /restart_recovery_required/)
  assert.match(bridgeSource, /completedStages/)
  assert.match(bridgeSource, /pipeline_blocked/)
  assert.match(bridgeSource, /pipeline_cancelled/)
})

test('completed runs emit postmortem and durable run memory while idle has no polling loop', () => {
  assert.match(bridgeSource, /postmortem\.md/)
  assert.match(bridgeSource, /run-memory\.json/)
  assert.match(bridgeSource, /Preserve completed checkpoints/)
  assert.doesNotMatch(bridgeSource, /setInterval\(/)
  assert.doesNotMatch(bridgeSource, /setTimeout\([^)]*runAutonomousPipeline/)
})

test('standalone room is compact, furnished, and includes a separate manager office', () => {
  const source = require('fs').readFileSync(require('path').join(__dirname, '..', 'standalone-server.js'), 'utf8')
  assert.match(source, /const cols = 16/)
  assert.match(source, /const rows = 12/)
  assert.match(source, /managerWall/)
  assert.match(source, /type: 'printer'/)
  assert.match(source, /type: 'paper_stack'/)
})

test('permanent versioned prompts include role boundaries, quirks, reflections, and shared rules', () => {
  const promptModule = fs.readFileSync(path.join(__dirname, 'prompts.js'), 'utf8')
  const promptDir = path.join(__dirname, 'prompts')
  const shared = fs.readFileSync(path.join(promptDir, 'shared-protocol.md'), 'utf8')
  const researcher = fs.readFileSync(path.join(promptDir, 'researcher.md'), 'utf8')
  const editor = fs.readFileSync(path.join(promptDir, 'editor.md'), 'utf8')
  const manager = fs.readFileSync(path.join(promptDir, 'manager.md'), 'utf8')
  assert.match(promptModule, /buildWorkerPrompt/)
  assert.match(promptModule, /sha256/)
  assert.match(shared, /challenge → evidence → alternative → decision/)
  assert.match(shared, /Reflection/)
  assert.match(researcher, /hot trail/)
  assert.match(researcher, /receipts/)
  assert.match(editor, /earn its place/)
  assert.match(editor, /coffee has gone cold/)
  assert.match(manager, /first dollar/)
  assert.match(manager, /approval stamp or desk bell/)
})

test('state v3 migrates meetings, reviews, prompt versions, role redirects and desktop connection', () => {
  assert.match(bridgeSource, /version: 3/)
  assert.match(bridgeSource, /promptVersions/)
  assert.match(bridgeSource, /desktopConnection/)
  assert.match(bridgeSource, /roleChallenges/)
  assert.match(bridgeSource, /office_review/)
  assert.match(bridgeSource, /reviewReminders/)
  assert.match(bridgeSource, /projectLessons/)
  assert.match(bridgeSource, /\/role\/assign/)
  assert.match(bridgeSource, /role_redirect_resolved/)
})

test('office meeting reuses stage reflections and historical reminders remain locally gated', () => {
  assert.match(bridgeSource, /extractReflection\(researchFile/)
  assert.match(bridgeSource, /extractReflection\(editFile/)
  assert.match(bridgeSource, /extractReflection\(managerFile/)
  assert.match(bridgeSource, /office_review_started/)
  assert.match(bridgeSource, /office_review_completed/)
  assert.match(bridgeSource, /No model work starts without explicit approval/)
  assert.match(bridgeSource, /historical_review_approved/)
})
