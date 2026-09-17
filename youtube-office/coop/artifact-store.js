'use strict'

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

class ArtifactStore {
  constructor(dataDir) { this.root = path.join(dataDir, 'coop-artifacts'); this.quarantine = path.join(this.root, 'quarantine'); this.approved = path.join(this.root, 'approved'); fs.mkdirSync(this.quarantine, { recursive: true }); fs.mkdirSync(this.approved, { recursive: true }) }
  receive({ ownerParticipantId, taskId, name, mimeType, bytes }) {
    const safeName = path.basename(String(name || 'attachment.bin')).replace(/[^a-z0-9._-]/gi, '_')
    const id = `artifact-${crypto.randomUUID()}`; const file = path.join(this.quarantine, `${id}-${safeName}`); const data = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
    fs.writeFileSync(file, data, { mode: 0o600 })
    return { id, ownerParticipantId, taskId, name: safeName, mimeType: String(mimeType || 'application/octet-stream'), bytes: data.length, sha256: crypto.createHash('sha256').update(data).digest('hex'), quarantined: true, path: file, receivedAt: new Date().toISOString() }
  }
  approve(artifact) { const target = path.join(this.approved, path.basename(artifact.path)); fs.renameSync(artifact.path, target); return { ...artifact, quarantined: false, path: target, approvedAt: new Date().toISOString() } }
}

module.exports = { ArtifactStore }
