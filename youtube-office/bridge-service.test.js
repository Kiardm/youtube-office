const test = require('node:test')
const assert = require('node:assert/strict')

test('worker roles remain human and prompt-activated', () => {
  const source = require('fs').readFileSync(require('path').join(__dirname, 'bridge-service.js'), 'utf8')
  assert.match(source, /Researcher \/ Planner/)
  assert.match(source, /Creative Director \/ Editor/)
  assert.match(source, /Manager \/ Publisher/)
  assert.match(source, /status: 'waiting'/)
  assert.doesNotMatch(source, /setInterval\([^)]*research/i)
})

