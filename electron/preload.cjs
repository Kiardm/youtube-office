const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('youtubeOffice', {
  toggleWindow: () => ipcRenderer.send('toggle-window'),
  collapse: () => ipcRenderer.send('set-compact'),
  hide: () => ipcRenderer.send('hide-window'),
})

window.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(location.search)
  if (!params.has('compact')) return
  window.addEventListener('pointerdown', () => ipcRenderer.send('toggle-window'), { capture: true, once: true })
})

