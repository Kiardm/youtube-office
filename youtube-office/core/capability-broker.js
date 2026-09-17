'use strict'

const SCOPES = new Set(['chat', 'files:read', 'files:write', 'applications', 'browser', 'network', 'render', 'publish', 'destructive'])
const DURATIONS = new Set(['action', 'project', 'remembered'])

class CapabilityBroker {
  constructor(initial = []) { this.grants = Array.isArray(initial) ? initial.filter((g) => g && SCOPES.has(g.scope)) : [] }
  request({ worker, scope, resource = '*', duration = 'action', projectId = null, reason = '' }) {
    if (!SCOPES.has(scope)) throw new Error('Unknown capability scope')
    if (!DURATIONS.has(duration)) throw new Error('Unknown grant duration')
    return { id: `grant-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, worker, scope, resource, duration, projectId, reason, status: scope === 'chat' ? 'approved' : 'pending', createdAt: new Date().toISOString(), decidedAt: scope === 'chat' ? new Date().toISOString() : null }
  }
  decide(request, approved, decidedBy = 'local-user') {
    const grant = { ...request, status: approved ? 'approved' : 'denied', decidedBy, decidedAt: new Date().toISOString() }
    this.grants = [...this.grants.filter((g) => g.id !== grant.id), grant].slice(-500)
    return grant
  }
  allows(worker, scope, resource = '*', projectId = null) {
    if (scope === 'chat') return true
    return this.grants.some((g) => g.status === 'approved' && g.worker === worker && g.scope === scope && (g.resource === '*' || g.resource === resource) && (g.duration === 'remembered' || !g.projectId || g.projectId === projectId))
  }
  snapshot() { return this.grants.map((g) => ({ ...g })) }
}

module.exports = { CapabilityBroker, SCOPES, DURATIONS }
