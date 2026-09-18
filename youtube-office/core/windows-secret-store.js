'use strict'

const fs = require('fs')
const path = require('path')
const { execFile } = require('child_process')

function powershell(script, env = {}) {
  return new Promise((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15000, env: { ...process.env, ...env }, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => error ? reject(new Error(String(stderr || error.message).trim())) : resolve(String(stdout || '').trim())))
}

class WindowsSecretStore {
  constructor(directory) { this.directory = directory; fs.mkdirSync(directory, { recursive: true }) }
  file(name) { return path.join(this.directory, `${String(name).replace(/[^a-z0-9_-]/gi, '_')}.dpapi`) }
  async set(name, value) {
    if (process.platform !== 'win32') throw new Error('Secure YouTube credential storage currently requires Windows DPAPI.')
    const script = "Add-Type -AssemblyName System.Security; $b=[Text.Encoding]::UTF8.GetBytes($env:YTO_SECRET); $p=[Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Convert]::ToBase64String($p)"
    const protectedValue = await powershell(script, { YTO_SECRET: JSON.stringify(value) })
    fs.writeFileSync(this.file(name), protectedValue, { encoding: 'utf8', mode: 0o600 })
  }
  async get(name) {
    const file = this.file(name)
    if (!fs.existsSync(file)) return null
    if (process.platform !== 'win32') throw new Error('Secure YouTube credential storage currently requires Windows DPAPI.')
    const script = "$p=[Convert]::FromBase64String($env:YTO_PROTECTED); $b=[Security.Cryptography.ProtectedData]::Unprotect($p,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser); [Text.Encoding]::UTF8.GetString($b)"
    return JSON.parse(await powershell(script, { YTO_PROTECTED: fs.readFileSync(file, 'utf8').trim() }))
  }
  delete(name) { fs.rmSync(this.file(name), { force: true }) }
  has(name) { return fs.existsSync(this.file(name)) }
}

module.exports = { WindowsSecretStore }
