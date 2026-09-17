'use strict'

const { ProviderAdapter, normalizeFailure, runProcess } = require('../core/provider-adapter')

class ClaudeAdapter extends ProviderAdapter {
  constructor(options = {}) {
    super('claude', 'Claude Code')
    this.binary = options.binary || process.env.YOUTUBE_OFFICE_CLAUDE_BIN || 'claude'
  }

  async getStatus() {
    try {
      const version = await runProcess(this.binary, ['--version'], { timeoutMs: 8_000 })
      return { id: this.id, installed: true, authenticated: true, version: version.stdout.trim(), detail: 'Authentication is verified by the next local Claude request.' }
    } catch (error) { const failure = normalizeFailure(error); return { id: this.id, installed: false, authenticated: false, error: failure.kind, detail: failure.message } }
  }

  async listModels() { return ['sonnet', 'opus', 'haiku'] }

  async chat(request) {
    const args = ['-p', '--output-format', 'text', '--model', request.model || 'sonnet', '--permission-mode', 'plan']
    try { const result = await runProcess(this.binary, args, { timeoutMs: request.timeoutMs, cwd: request.cwd, onStart: request.onStart }, request.prompt); return { output: result.stdout, processId: result.processId, usage: null } }
    catch (error) { throw normalizeFailure(error) }
  }

  async executeWorker(request) {
    const permissionMode = request.sandbox === 'read-only' ? 'plan' : 'acceptEdits'
    const args = ['-p', '--output-format', 'text', '--model', request.model || 'sonnet', '--permission-mode', permissionMode]
    try { return await runProcess(this.binary, args, { timeoutMs: request.timeoutMs || 7_200_000, cwd: request.cwd, onStart: request.onStart }, request.prompt) }
    catch (error) { throw normalizeFailure(error) }
  }
}

module.exports = { ClaudeAdapter }
