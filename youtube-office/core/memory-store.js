'use strict'

const fs = require('fs')
const path = require('path')
const { DatabaseSync } = require('node:sqlite')

const ROLES = new Set(['researcher', 'editor', 'manager', 'shared'])

class MemoryStore {
  constructor(dataDir) {
    fs.mkdirSync(dataDir, { recursive: true })
    this.file = path.join(dataDir, 'office-memory.sqlite')
    this.db = new DatabaseSync(this.file)
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS memory_records (
        id TEXT PRIMARY KEY, role TEXT NOT NULL, kind TEXT NOT NULL, content TEXT NOT NULL,
        provenance TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 0.5, status TEXT NOT NULL DEFAULT 'proposed',
        correction_of TEXT, project_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        FOREIGN KEY(correction_of) REFERENCES memory_records(id)
      );
      CREATE INDEX IF NOT EXISTS idx_memory_role_status ON memory_records(role,status,updated_at);
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_search USING fts5(id UNINDEXED, role, kind, content, provenance);
      CREATE TABLE IF NOT EXISTS memory_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT, memory_id TEXT NOT NULL, action TEXT NOT NULL,
        detail TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL
      );`)
  }

  add(input) {
    const role = ROLES.has(input.role) ? input.role : 'shared'
    const id = input.id || `mem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const now = new Date().toISOString()
    const status = input.status === 'approved' && input.kind === 'fact' ? 'approved' : 'proposed'
    this.db.prepare('INSERT INTO memory_records(id,role,kind,content,provenance,confidence,status,correction_of,project_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id, role, String(input.kind || 'lesson'), String(input.content || '').slice(0, 10000), String(input.provenance || 'user').slice(0, 1000), Math.max(0, Math.min(1, Number(input.confidence ?? 0.5))), status, input.correctionOf || null, input.projectId || null, now, now)
    this.db.prepare('INSERT INTO memory_search(id,role,kind,content,provenance) VALUES(?,?,?,?,?)').run(id, role, String(input.kind || 'lesson'), String(input.content || '').slice(0, 10000), String(input.provenance || 'user').slice(0, 1000))
    this.audit(id, 'created', status)
    return this.get(id)
  }

  get(id) { return this.db.prepare('SELECT * FROM memory_records WHERE id=?').get(id) || null }
  list({ role, status, query, limit = 100 } = {}) {
    const capped = Math.max(1, Math.min(500, Number(limit) || 100))
    if (query) return this.db.prepare(`SELECT m.* FROM memory_search s JOIN memory_records m ON m.id=s.id WHERE memory_search MATCH ? AND (? IS NULL OR m.role=?) AND (? IS NULL OR m.status=?) ORDER BY m.updated_at DESC LIMIT ?`).all(String(query), role || null, role || null, status || null, status || null, capped)
    return this.db.prepare('SELECT * FROM memory_records WHERE (? IS NULL OR role=?) AND (? IS NULL OR status=?) ORDER BY updated_at DESC LIMIT ?').all(role || null, role || null, status || null, status || null, capped)
  }
  setStatus(id, status, detail = '') {
    if (!['proposed', 'approved', 'rejected', 'forgotten'].includes(status)) throw new Error('Invalid memory status')
    this.db.prepare('UPDATE memory_records SET status=?,updated_at=? WHERE id=?').run(status, new Date().toISOString(), id)
    this.audit(id, status, detail)
    return this.get(id)
  }
  correct(id, content, provenance = 'user correction') { return this.add({ role: this.get(id)?.role || 'shared', kind: 'correction', content, provenance, confidence: 1, correctionOf: id }) }
  forget(id) { return this.setStatus(id, 'forgotten', 'User requested forgetting this record.') }
  audit(memoryId, action, detail = '') { this.db.prepare('INSERT INTO memory_audit(memory_id,action,detail,created_at) VALUES(?,?,?,?)').run(memoryId, action, String(detail).slice(0, 1000), new Date().toISOString()) }
  exportApproved() { return { schemaVersion: 1, exportedAt: new Date().toISOString(), records: this.list({ status: 'approved', limit: 500 }) } }
  checkpoint() { this.db.exec('PRAGMA wal_checkpoint(FULL)') }
}

module.exports = { MemoryStore }
