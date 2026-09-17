'use strict'

const fs = require('fs')
const path = require('path')
const { ProviderAdapter, normalizeFailure, runProcess } = require('../core/provider-adapter')

class CodexAdapter extends ProviderAdapter {
  constructor(options = {}) {
    super('codex', 'OpenAI Codex')
    this.binary = options.binary || process.env.YOUTUBE_OFFICE_CODEX_BIN || 'codex'
    try { this.prefix = options.prefix || JSON.parse(process.env.YOUTUBE_OFFICE_CODEX_PREFIX_ARGS || '[]') } catch { this.prefix = [] }
  }

  async getStatus() {
    try {
      const version = await runProcess(this.binary, [...this.prefix, '--version'], { timeoutMs: 8_000 })
      let authentication = { authenticated: false, detail: 'Sign-in status unavailable.' }
      try {
        const login = await runProcess(this.binary, [...this.prefix, 'login', 'status'], { timeoutMs: 8_000 })
        authentication = { authenticated: /logged in/i.test(login.stdout + login.stderr), detail: (login.stdout || login.stderr).trim().slice(0, 300) }
      } catch (error) { authentication = { authenticated: false, detail: normalizeFailure(error).message } }
      return { id: this.id, installed: true, version: version.stdout.trim(), ...authentication }
    } catch (error) { const failure = normalizeFailure(error); return { id: this.id, installed: false, authenticated: false, error: failure.kind, detail: failure.message } }
  }

  async listModels() { return ['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-6-astra'] }

  async chat(request) {
    const outputFile = request.outputFile || path.join(request.dataDir, `provider-codex-${Date.now()}.json`)
    const args = [...this.prefix, '-a', 'never', 'exec', '--ephemeral', '--ignore-user-config', '--ignore-rules', '-m', request.model, '-c', `model_reasoning_effort="${request.reasoning || 'low'}"`, '-C', request.cwd, '-s', 'read-only', '--color', 'never', '-o', outputFile, '-']
    try {
      const result = await runProcess(this.binary, args, { timeoutMs: request.timeoutMs, cwd: request.cwd, onStart: request.onStart }, request.prompt)
      let output = result.stdout
      try { output = fs.readFileSync(outputFile, 'utf8') } catch {}
      try { fs.unlinkSync(outputFile) } catch {}
      return { output, processId: result.processId, usage: null }
    } catch (error) { try { fs.unlinkSync(outputFile) } catch {}; throw normalizeFailure(error) }
  }

  async executeWorker(request) {
    const args = [...this.prefix, '-a', 'never', ...(request.network ? ['--search'] : []), 'exec', '-m', request.model, '-c', `model_reasoning_effort="${request.reasoning || 'medium'}"`, '-C', request.cwd, '-s', request.sandbox || 'danger-full-access', '--color', 'never', '-o', request.outputFile, '-']
    try { return await runProcess(this.binary, args, { timeoutMs: request.timeoutMs || 7_200_000, cwd: request.cwd, onStart: request.onStart }, request.prompt) }
    catch (error) { throw normalizeFailure(error) }
  }
}

module.exports = { CodexAdapter }
