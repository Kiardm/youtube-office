const { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage } = require('electron')
const { fork } = require('child_process')
const path = require('path')
const http = require('http')
const fs = require('fs')

const ROOT = path.resolve(__dirname, '..')
const OFFICE_URL = 'http://127.0.0.1:3300/'
const COMPACT = { width: 470, height: 330 }
const EXPANDED = { width: 1180, height: 790 }
let win
let tray
let quitting = false
let compact = true
let serverProcess
let bridgeProcess

const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) app.quit()

app.setName('YouTube Agent Office')

function startServices() {
  const logDir = path.join(ROOT, 'youtube-office', 'data')
  fs.mkdirSync(logDir, { recursive: true })
  const common = { cwd: ROOT, windowsHide: true, silent: true }
  serverProcess = fork(path.join(ROOT, 'standalone-server.js'), [], {
    ...common,
    env: { ...process.env, NO_SCAN: '1', PORT: '3300' },
  })
  bridgeProcess = fork(path.join(ROOT, 'youtube-office', 'bridge-service.js'), [], {
    ...common,
    env: {
      ...process.env,
      YOUTUBE_OFFICE_PORT: '3310',
      PIXEL_OFFICE_SERVER: 'ws://127.0.0.1:3300/ws/report',
      CONTENT_OPS_ROOT: 'C:\\Users\\Owner\\Documents\\Codex\\2026-09-13\\id',
    },
  })
  for (const [name, proc] of [['pixel-office', serverProcess], ['youtube-bridge', bridgeProcess]]) {
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
  const suffix = compact ? '?kiosk&youtubeOffice=1&compact=1&loaderText=Starting%20office' : '?kiosk&youtubeOffice=1&expanded=1&loaderText=Opening%20workspace'
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
    title: 'YouTube Agent Office',
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
  tray.setToolTip('YouTube Agent Office — waiting for work')
  tray.on('click', () => { if (win.isVisible()) toggleWindow(); else win.show() })
  updateTrayMenu()
}

ipcMain.on('toggle-window', toggleWindow)
ipcMain.on('set-compact', () => setCompact(true))
ipcMain.on('hide-window', () => win?.hide())

app.whenReady().then(async () => {
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
  for (const proc of [bridgeProcess, serverProcess]) {
    if (proc && !proc.killed) proc.kill()
  }
})

app.on('window-all-closed', (event) => event.preventDefault())
