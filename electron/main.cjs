const { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage } = require('electron')
const { fork, execFile } = require('child_process')
const path = require('path')
const http = require('http')
const fs = require('fs')
const crypto = require('crypto')
const { contentRoot, dataDir } = require('../youtube-office/paths')

const ROOT = path.resolve(__dirname, '..')
const OFFICE_URL = 'http://127.0.0.1:3300/'
const COMPACT = { width: 470, height: 330 }
const EXPANDED = { width: 1280, height: 820 }
const CHATGPT_APP_ID = 'OpenAI.Codex_2p2nqsd0c76g0!App'
let win
let tray
let quitting = false
let compact = true
let serverProcess
let bridgeProcess
let gatewayProcess
const sessionToken = crypto.randomBytes(32).toString('base64url')

const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) app.quit()

app.setName('YouTube Office 4.2.2')
app.setAppUserModelId('com.openai.youtube-agent-office')

function runHidden(file, args) {
  return new Promise((resolve) => execFile(file, args, { windowsHide: true, timeout: 10000 }, () => resolve()))
}

function isChatGptRunning() {
  return new Promise((resolve) => {
    execFile('tasklist.exe', ['/FI', 'IMAGENAME eq ChatGPT.exe', '/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 5000 }, (error, stdout) => {
      resolve(!error && /ChatGPT\.exe/i.test(stdout || ''))
    })
  })
}

async function ensureChatGptOpen() {
  if (process.platform !== 'win32' || await isChatGptRunning()) return
  await runHidden('explorer.exe', [`shell:AppsFolder\\${CHATGPT_APP_ID}`])
}

async function ensureDesktopShortcut() {
  if (process.platform !== 'win32') return
  await runHidden('powershell.exe', [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(ROOT, 'scripts', 'install-office-shortcut.ps1'),
    '-ElectronPath', process.execPath, '-EntryPoint', path.join(ROOT, 'electron', 'main.cjs'), '-IconPath', path.join(ROOT, 'icon.png'),
  ])
}

function startServices() {
  const logDir = dataDir
  fs.mkdirSync(logDir, { recursive: true })
  const common = { cwd: ROOT, windowsHide: true, silent: true }
  serverProcess = fork(path.join(ROOT, 'standalone-server.js'), [], {
    ...common,
    env: { ...process.env, NO_SCAN: '1', PORT: '3300', YOUTUBE_OFFICE_SESSION_TOKEN: sessionToken },
  })
  bridgeProcess = fork(path.join(ROOT, 'youtube-office', 'bridge-service.js'), [], {
    ...common,
    env: {
      ...process.env,
      YOUTUBE_OFFICE_PORT: '3310',
      PIXEL_OFFICE_SERVER: 'ws://127.0.0.1:3300/ws/report',
      YOUTUBE_OFFICE_CONTENT_ROOT: contentRoot,
      YOUTUBE_OFFICE_DATA_DIR: dataDir,
      YOUTUBE_OFFICE_SESSION_TOKEN: sessionToken,
    },
  })
  gatewayProcess = fork(path.join(ROOT, 'youtube-office', 'codex-gateway-service.js'), [], {
    ...common,
    env: {
      ...process.env,
      YOUTUBE_OFFICE_DATA_DIR: dataDir,
      YOUTUBE_OFFICE_SESSION_TOKEN: sessionToken,
    },
  })
  for (const [name, proc] of [['pixel-office', serverProcess], ['youtube-bridge', bridgeProcess], ['codex-gateway', gatewayProcess]]) {
    proc.stdout?.pipe(fs.createWriteStream(path.join(logDir, `${name}.log`), { flags: 'a' }))
    proc.stderr?.pipe(fs.createWriteStream(path.join(logDir, `${name}.error.log`), { flags: 'a' }))
  }
}

function waitForServer(url, attempts = 80) {
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const req = http.get(url, (res) => {
        res.resume()
        if (res.statusCode && res.statusCode < 500) resolve()
        else retry()
      })
      req.on('error', retry)
      req.setTimeout(800, () => { req.destroy(); retry() })
    }
    const retry = () => {
      if (--attempts <= 0) reject(new Error(`Timed out waiting for ${url}`))
      else setTimeout(tryOnce, 250)
    }
    tryOnce()
  })
}

function bottomRight(bounds) {
  const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
  return { x: area.x + area.width - bounds.width - 18, y: area.y + area.height - bounds.height - 18 }
}

async function loadMode() {
  const suffix = compact ? `?kiosk&youtubeOffice=1&compact=1&officeToken=${encodeURIComponent(sessionToken)}&loaderText=Starting%20office` : `?kiosk&youtubeOffice=1&expanded=1&officeToken=${encodeURIComponent(sessionToken)}&loaderText=Opening%20workspace`
  await win.loadURL(OFFICE_URL + suffix)
}

function setCompact(nextCompact) {
  compact = nextCompact
  const bounds = compact ? COMPACT : EXPANDED
  win.setBounds({ ...bottomRight(bounds), ...bounds }, true)
  win.setResizable(!compact)
  loadMode().catch(() => {})
  updateTrayMenu()
}

function toggleWindow() { setCompact(!compact) }

function updateTrayMenu() {
  if (!tray) return
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: compact ? 'Expand office' : 'Compact office', click: toggleWindow },
    { label: win?.isVisible() ? 'Hide office' : 'Show office', click: () => win.isVisible() ? win.hide() : win.show() },
    { type: 'separator' },
    { label: 'Restart office', click: () => { win.reload() } },
    { label: 'Exit', click: () => { quitting = true; app.quit() } },
  ]))
}

async function createWindow() {
  await Promise.all([waitForServer('http://127.0.0.1:3300/api/status'), waitForServer('http://127.0.0.1:3310/health')])
  const pos = bottomRight(COMPACT)
  win = new BrowserWindow({
    ...COMPACT,
    ...pos,
    frame: false,
    transparent: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: false,
    show: false,
    title: 'YouTube Office 4.2.2',
    icon: path.join(ROOT, 'icon.png'),
    backgroundColor: '#171321',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  win.setAlwaysOnTop(true, 'floating')
  win.once('ready-to-show', () => win.show())
  win.on('close', (event) => {
    if (quitting) return
    event.preventDefault()
    if (!compact) setCompact(true)
    else win.hide()
  })
  await loadMode()

  const icon = nativeImage.createFromPath(path.join(ROOT, 'icon.png'))
  tray = new Tray(icon.resize({ width: 16, height: 16 }))
  tray.setToolTip('YouTube Office 4.2.2 — waiting for work')
  tray.on('click', () => {
    if (win.isMinimized()) { win.restore(); win.show(); win.focus(); return }
    if (win.isVisible()) toggleWindow()
    else { win.show(); win.focus() }
  })
  updateTrayMenu()
}

ipcMain.on('toggle-window', toggleWindow)
ipcMain.on('set-compact', () => setCompact(true))
ipcMain.on('minimize-window', () => win?.minimize())
ipcMain.on('hide-window', () => win?.hide())

app.whenReady().then(async () => {
  await Promise.all([ensureChatGptOpen(), ensureDesktopShortcut()])
  startServices()
  await createWindow()
})

app.on('second-instance', () => {
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
})

app.on('before-quit', () => {
  quitting = true
  for (const proc of [gatewayProcess, bridgeProcess, serverProcess]) {
    if (proc && !proc.killed) proc.kill()
  }
})

app.on('window-all-closed', (event) => event.preventDefault())
