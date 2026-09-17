'use strict'

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const { spawnSync } = require('child_process')

class BackupManager {
  constructor(dataDir, appRoot) { this.dataDir = dataDir; this.appRoot = appRoot; this.backupDir = path.join(dataDir, 'backups'); fs.mkdirSync(this.backupDir, { recursive: true }) }
  snapshot(label, files = []) {
    const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${String(label).replace(/[^a-z0-9_-]+/gi, '-').slice(0, 50)}`
    const dir = path.join(this.backupDir, id); fs.mkdirSync(dir, { recursive: true })
    const records = []
    for (const file of files) {
      const resolved = path.resolve(file)
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) continue
      const target = path.join(dir, path.basename(resolved)); fs.copyFileSync(resolved, target)
      records.push({ name: path.basename(resolved), sha256: crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex'), bytes: fs.statSync(target).size })
    }
    const manifest = { schemaVersion: 1, id, label, appRoot: this.appRoot, createdAt: new Date().toISOString(), pinned: false, files: records }
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
    if (process.platform === 'win32' && records.length) {
      const encryptedFile = path.join(this.backupDir, `${id}.yobak`)
      const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(this.appRoot, 'scripts', 'protect-backup.ps1'), '-SourceDir', dir, '-Destination', encryptedFile], { windowsHide: true, encoding: 'utf8' })
      if (result.status !== 0) throw new Error(`Windows profile encryption failed: ${String(result.stderr || result.stdout).slice(0, 400)}`)
      manifest.encryption = 'Windows DPAPI CurrentUser'; manifest.archive = path.basename(encryptedFile)
      fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
      for (const record of records) { try { fs.unlinkSync(path.join(dir, record.name)) } catch {} }
    }
    return manifest
  }
  list() { return fs.readdirSync(this.backupDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => { try { return JSON.parse(fs.readFileSync(path.join(this.backupDir, e.name, 'manifest.json'), 'utf8')) } catch { return null } }).filter(Boolean).sort((a,b) => b.createdAt.localeCompare(a.createdAt)) }
}

module.exports = { BackupManager }
