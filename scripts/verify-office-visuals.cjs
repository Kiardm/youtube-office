const { chromium } = require('playwright')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const outDir = path.join(root, 'youtube-office', 'data')
fs.mkdirSync(outDir, { recursive: true })

async function main() {
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  try {
    const compact = await browser.newPage({ viewport: { width: 470, height: 330 }, deviceScaleFactor: 1 })
    await compact.goto('http://127.0.0.1:3300/?kiosk&youtubeOffice=1&compact=1', { waitUntil: 'networkidle' })
    await compact.waitForSelector('.yt-office-compact-title', { timeout: 25000 })
    await compact.screenshot({ path: path.join(outDir, 'qa-compact-3.0.png') })
    const compactCheck = await compact.evaluate(() => ({
      title: document.querySelector('.yt-office-compact-title')?.textContent,
      minimize: Boolean(document.querySelector('[data-office-window-control]')),
      canvas: Boolean(document.querySelector('canvas')),
    }))

    const expanded = await browser.newPage({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 1 })
    await expanded.goto('http://127.0.0.1:3300/?kiosk&youtubeOffice=1&expanded=1', { waitUntil: 'networkidle' })
    await expanded.waitForSelector('.yt-office-panel', { timeout: 25000 })
    const expandedCheck = await expanded.evaluate(() => {
      const panel = document.querySelector('.yt-office-panel')
      const sectionText = document.querySelector('.yt-office-panel section div')
      const office = window.__officeState
      const characters = office ? [...office.characters.values()].map((character) => ({
        role: character.folderName,
        col: character.tileCol,
        row: character.tileRow,
        seatId: character.seatId,
      })) : []
      return {
        title: document.querySelector('.yt-office-title')?.textContent,
        panelWidth: panel ? Math.round(panel.getBoundingClientRect().width) : 0,
        bodyFont: sectionText ? Number.parseFloat(getComputedStyle(sectionText).fontSize) : 0,
        characters,
      }
    })
    await expanded.screenshot({ path: path.join(outDir, 'qa-expanded-3.0.png') })

    const idleHourCheck = await expanded.evaluate(() => {
      const office = window.__officeState
      const manager = office ? [...office.characters.values()].find((character) => character.folderName === 'Manager') : null
      if (!office || !manager) return { ok: false, minCol: null, maxCol: null }
      manager.isActive = false
      let minCol = manager.tileCol
      let maxCol = manager.tileCol
      for (let second = 0; second < 3600; second += 1) {
        office.update(1)
        minCol = Math.min(minCol, manager.tileCol)
        maxCol = Math.max(maxCol, manager.tileCol)
      }
      return { ok: minCol >= 12 && maxCol <= 14, minCol, maxCol }
    })

    await expanded.evaluate(() => window.dispatchEvent(new CustomEvent('youtube-office-agent-speech', {
      detail: { role: 'researcher', text: 'Hot trail: this bubble follows me while I move.', durationSec: 12 },
    })))
    await expanded.evaluate(() => window.__officeState?.update(0.3))
    await expanded.waitForTimeout(100)
    const speechCheck = await expanded.evaluate(() => {
      const office = window.__officeState
      const researcher = office ? [...office.characters.values()].find((character) => character.folderName === 'Researcher') : null
      return { text: researcher?.speechText || null, x: researcher?.x || null, y: researcher?.y || null }
    })
    await expanded.screenshot({ path: path.join(outDir, 'qa-speech-follow-3.0.png') })

    const manager = expandedCheck.characters.find((character) => character.role === 'Manager')
    const result = {
      ok: compactCheck.title === 'YouTube Office 3.0'
        && compactCheck.minimize
        && compactCheck.canvas
        && expandedCheck.title === 'YouTube Office 3.0'
        && expandedCheck.panelWidth >= 418
        && expandedCheck.bodyFont >= 18
        && manager?.seatId === 'yt-chair-manager'
        && manager.col >= 12
        && idleHourCheck.ok
        && speechCheck.text?.startsWith('Hot trail:'),
      compactCheck,
      expandedCheck,
      idleHourCheck,
      speechCheck,
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    if (!result.ok) process.exitCode = 1
  } finally {
    await browser.close()
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
