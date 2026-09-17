'use strict'

const { CodexAdapter } = require('../providers/codex-adapter')
const { ClaudeAdapter } = require('../providers/claude-adapter')

class ProviderRegistry {
  constructor(config = {}) {
    this.adapters = new Map([['codex', new CodexAdapter(config.codex)], ['claude', new ClaudeAdapter(config.claude)]])
    this.assignments = { office: 'codex', researcher: 'codex', editor: 'codex', manager: 'codex', ...(config.assignments || {}) }
  }
  get(id) { const adapter = this.adapters.get(id); if (!adapter) throw new Error(`Unknown provider: ${id}`); return adapter }
  forWorker(workerId) { return this.get(this.assignments[workerId] || this.assignments.office || 'codex') }
  assign(workerId, providerId) { this.get(providerId); this.assignments[workerId] = providerId; return this.snapshot() }
  async statuses() { return Object.fromEntries(await Promise.all([...this.adapters].map(async ([id, adapter]) => [id, await adapter.getStatus()]))) }
  snapshot() { return { assignments: { ...this.assignments }, providers: [...this.adapters.values()].map(({ id, displayName }) => ({ id, displayName })) } }
}

module.exports = { ProviderRegistry }
