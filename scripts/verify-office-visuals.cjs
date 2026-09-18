const { chromium } = require('playwright')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const outDir = path.join(root, 'youtube-office', 'data')
fs.mkdirSync(outDir, { recursive: true })

async function main() {
  const session = await fetch('http://127.0.0.1:3300/api/youtube-office-session').then((response) => response.json())
  const officeToken = encodeURIComponent(session.token || 'browser-preview')
  const browser = await chromium.launch({ channel: 'chrome', headless: true })
  try {
    const compact = await browser.newPage({ viewport: { width: 470, height: 330 }, deviceScaleFactor: 1 })
    await compact.goto(`http://127.0.0.1:3300/?kiosk&youtubeOffice=1&compact=1&officeToken=${officeToken}`, { waitUntil: 'domcontentloaded' })
    await compact.waitForSelector('.yt-office-compact-title', { timeout: 25000 })
    await compact.screenshot({ path: path.join(outDir, 'qa-compact-3.2.png') })
    const compactCheck = await compact.evaluate(() => ({
      title: document.querySelector('.yt-office-compact-title')?.textContent,
      minimize: Boolean(document.querySelector('[data-office-window-control]')),
      canvas: Boolean(document.querySelector('canvas')),
    }))

    const expanded = await browser.newPage({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 1 })
    await expanded.goto(`http://127.0.0.1:3300/?kiosk&youtubeOffice=1&expanded=1&officeToken=${officeToken}`, { waitUntil: 'domcontentloaded' })
    await expanded.waitForSelector('.yt-office-panel', { timeout: 25000 })
    await expanded.waitForFunction(() => window.__officeState?.characters?.size >= 3, null, { timeout: 25000 })
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
        waitingOverlayPresent: document.body.innerText.includes('Waiting for agents') || document.body.innerText.includes('Start a Claude Code session'),
        panelWidth: panel ? Math.round(panel.getBoundingClientRect().width) : 0,
        bodyFont: sectionText ? Number.parseFloat(getComputedStyle(sectionText).fontSize) : 0,
        characters,
      }
    })
    await expanded.screenshot({ path: path.join(outDir, 'qa-expanded-3.2.png') })

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
    await expanded.screenshot({ path: path.join(outDir, 'qa-speech-follow-3.2.png') })

    await expanded.locator('.yt-office-agent-card').first().click()
    await expanded.waitForSelector('.yt-office-chat-dock')
    const dockCheck = await expanded.evaluate(() => {
      const dock = document.querySelector('.yt-office-chat-dock')
      const canvas = document.querySelector('canvas')
      const speech = document.querySelector('.yt-office-speech')
      const composer = document.querySelector('.yt-office-chat-compose')
      const textarea = composer?.querySelector('textarea')
      const send = composer?.querySelector('button')
      if (!dock || !canvas || !speech || !composer || !textarea || !send) return { visible: false }
      const d = dock.getBoundingClientRect()
      const s = speech.getBoundingClientRect()
      const c = composer.getBoundingClientRect()
      const t = textarea.getBoundingClientRect()
      const b = send.getBoundingClientRect()
      return { visible: true, width: Math.round(d.width), height: Math.round(d.height), speechContained: s.left >= 0 && s.right <= window.innerWidth && s.top >= 0 && s.bottom <= window.innerHeight, composerContained: c.left >= 0 && c.right <= window.innerWidth && c.top >= 0 && c.bottom <= window.innerHeight, textareaVisible: t.height >= 44, sendVisible: b.width >= 80 && b.bottom <= window.innerHeight, narrowTranscriptRemoved: !document.querySelector('.yt-office-chat-transcript') }
    })
    await expanded.screenshot({ path: path.join(outDir, 'qa-chat-dock-3.2.png') })

    const scaleChecks = []
    for (const scale of [1, 1.25, 1.5, 2]) {
      const page = await browser.newPage({ viewport: { width: 1024, height: 720 }, deviceScaleFactor: scale })
      await page.goto(`http://127.0.0.1:3300/?kiosk&youtubeOffice=1&expanded=1&officeToken=${officeToken}`, { waitUntil: 'domcontentloaded' })
      await page.waitForSelector('.yt-office-chat-compose', { timeout: 25000 })
      scaleChecks.push(await page.evaluate((deviceScaleFactor) => {
        const dock = document.querySelector('.yt-office-chat-dock')
        const composer = document.querySelector('.yt-office-chat-compose')
        const textarea = composer?.querySelector('textarea')
        const send = composer?.querySelector('button')
        if (!dock || !composer || !textarea || !send) return { deviceScaleFactor, ok: false }
        const d = dock.getBoundingClientRect(); const c = composer.getBoundingClientRect(); const t = textarea.getBoundingClientRect(); const b = send.getBoundingClientRect()
        return { deviceScaleFactor, ok: d.bottom <= window.innerHeight && c.bottom <= window.innerHeight && c.left >= 0 && t.height >= 44 && b.width >= 80 && !document.querySelector('.yt-office-chat-transcript') }
      }, scale))
      await page.close()
    }

    await expanded.evaluate(() => {
      const lines = {
        researcher: 'Averylongunbrokenresearchtokenmustwrapsafelyinsidethebubble with centered evidence.',
        editor: 'This simultaneous editing note must stay readable and never cover another employee message.',
        manager: 'Budget review: clear facts, no overflow, and every pixel earns its keep.',
      }
      for (const [role, text] of Object.entries(lines)) window.dispatchEvent(new CustomEvent('youtube-office-agent-speech', { detail: { role, text, durationSec: 12 } }))
      window.dispatchEvent(new CustomEvent('youtube-office-agent-thinking', { detail: { role: 'manager', thinking: true } }))
    })
    await expanded.waitForTimeout(150)
    await expanded.screenshot({ path: path.join(outDir, 'qa-bubbles-thinking-3.2.png') })
    const thinkingCheck = await expanded.evaluate(() => {
      const office = window.__officeState
      const manager = office ? [...office.characters.values()].find((character) => character.folderName === 'Manager') : null
      return { active: manager?.thinking === true }
    })
    await expanded.evaluate(() => {
      const office = window.__officeState
      if (!office) return
      for (const character of office.characters.values()) {
        character.speechText = null
        character.thinking = character.folderName === 'Manager'
      }
    })
    await expanded.waitForTimeout(100)
    await expanded.screenshot({ path: path.join(outDir, 'qa-thinking-only-3.2.png') })
    await expanded.route(`http://127.0.0.1:3310/session/${officeToken}/chat/editor`, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          agent: { id: 'editor', name: 'Editor', role: 'Creative Director / Editor', status: 'waiting', currentTask: 'Waiting for work' },
          messages: [{ id: 'visual-blocked', author: 'user', text: 'Visual failure-state check', createdAt: new Date().toISOString(), status: 'failed' }],
          queue: [], runtime: { messageId: null, processId: null, startedAt: null }, guidance: [],
          timing: { reliable: false, message: 'No reliable ETA exists yet.' },
          blocker: { messageId: 'visual-blocked', reason: 'Simulated visual-test failure.', kind: 'process', retryable: true },
        }),
      })
    })
    await expanded.locator('.yt-office-agent-card').nth(1).click()
    await expanded.waitForSelector('.yt-office-chat-blocker')
    const blockerCheck = await expanded.evaluate(() => ({
      visible: Boolean(document.querySelector('.yt-office-chat-blocker')),
      thinking: Boolean(document.querySelector('.yt-office-chat-thinking')),
      text: document.querySelector('.yt-office-chat-blocker')?.textContent || '',
    }))
    await expanded.screenshot({ path: path.join(outDir, 'qa-chat-blocker-3.2.png') })

    await expanded.locator('.yt-office-controls-button').click()
    await expanded.waitForSelector('.yt-office-control-center')
    const controlCenterCheck = await expanded.evaluate(() => ({
      visible: Boolean(document.querySelector('.yt-office-control-center')),
      title: document.querySelector('.yt-office-control-center header strong')?.textContent,
      sections: [...document.querySelectorAll('.yt-office-control-center nav button')].map((button) => button.textContent),
      contained: (() => { const box = document.querySelector('.yt-office-control-center')?.getBoundingClientRect(); return Boolean(box && box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight) })(),
    }))
    await expanded.screenshot({ path: path.join(outDir, 'qa-control-center-4.0.png') })

    const manager = expandedCheck.characters.find((character) => character.role === 'Manager')
    const result = {
      ok: compactCheck.title === 'YouTube Office 4.2'
        && compactCheck.minimize
        && compactCheck.canvas
        && expandedCheck.title === 'YouTube Office 4.2'
        && !expandedCheck.waitingOverlayPresent
        && expandedCheck.characters.length === 3
        && new Set(expandedCheck.characters.map((character) => character.role)).size === 3
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
      dockCheck,
      scaleChecks,
      thinkingCheck,
      blockerCheck,
      controlCenterCheck,
    }
    result.ok = result.ok && dockCheck.visible && dockCheck.width > 500 && dockCheck.height >= 150 && dockCheck.speechContained && dockCheck.composerContained && dockCheck.textareaVisible && dockCheck.sendVisible && dockCheck.narrowTranscriptRemoved && scaleChecks.every((check) => check.ok) && thinkingCheck.active && blockerCheck.visible && !blockerCheck.thinking && controlCenterCheck.visible && controlCenterCheck.title === 'YouTube Office 4.2' && controlCenterCheck.contained && controlCenterCheck.sections.length === 10
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
