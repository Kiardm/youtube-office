const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('youtubeOffice', {
  toggleWindow: () => ipcRenderer.send('toggle-window'),
  collapse: () => ipcRenderer.send('set-compact'),
  minimize: () => ipcRenderer.send('minimize-window'),
  hide: () => ipcRenderer.send('hide-window'),
})

window.addEventListener('DOMContentLoaded', () => {
  const params = new URLSearchParams(location.search)
  if (!params.has('compact')) return
  window.addEventListener('pointerdown', (event) => {
    const path = typeof event.composedPath === 'function' ? event.composedPath() : []
    if (path.some((node) => node instanceof Element && node.hasAttribute('data-office-window-control'))) return
    ipcRenderer.send('toggle-window')
  }, { capture: true })
})
