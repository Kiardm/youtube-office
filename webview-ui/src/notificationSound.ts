import {
  NOTIFICATION_NOTE_1_HZ,
  NOTIFICATION_NOTE_2_HZ,
  NOTIFICATION_NOTE_1_START_SEC,
  NOTIFICATION_NOTE_2_START_SEC,
  NOTIFICATION_NOTE_DURATION_SEC,
  NOTIFICATION_VOLUME,
} from './constants.js'

let soundEnabled = true
let audioCtx: AudioContext | null = null

export function setSoundEnabled(enabled: boolean): void {
  soundEnabled = enabled
}

export function isSoundEnabled(): boolean {
  return soundEnabled
}

function playNote(ctx: AudioContext, freq: number, startOffset: number, duration = NOTIFICATION_NOTE_DURATION_SEC, volume = NOTIFICATION_VOLUME, wave: OscillatorType = 'sine'): void {
  const t = ctx.currentTime + startOffset
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()

  osc.type = wave
  osc.frequency.setValueAtTime(freq, t)

  gain.gain.setValueAtTime(volume, t)
  gain.gain.exponentialRampToValueAtTime(0.001, t + duration)

  osc.connect(gain)
  gain.connect(ctx.destination)

  osc.start(t)
  osc.stop(t + duration)
}

// Debounce: when several agents flip to "waiting" in the same frame, overlapping
// oscillators clip audibly. 300ms is below the chime duration but well above the
// inter-event window we actually see in practice.
const MIN_PLAY_INTERVAL_MS = 300
let lastPlayedAt = 0

export async function playDoneSound(): Promise<void> {
  if (!soundEnabled) return
  const now = Date.now()
  if (now - lastPlayedAt < MIN_PLAY_INTERVAL_MS) return
  lastPlayedAt = now
  try {
    if (!audioCtx) {
      audioCtx = new AudioContext()
    }
    // Resume suspended context (webviews suspend until user gesture)
    if (audioCtx.state === 'suspended') {
      await audioCtx.resume()
    }
    // Ascending two-note chime: E5 → B5
    playNote(audioCtx, NOTIFICATION_NOTE_1_HZ, NOTIFICATION_NOTE_1_START_SEC)
    playNote(audioCtx, NOTIFICATION_NOTE_2_HZ, NOTIFICATION_NOTE_2_START_SEC)
  } catch {
    // Audio may not be available
  }
}

async function withAudio(play: (ctx: AudioContext) => void, minimumInterval = 110): Promise<void> {
  if (!soundEnabled) return
  const now = Date.now()
  if (now - lastPlayedAt < minimumInterval) return
  lastPlayedAt = now
  try {
    if (!audioCtx) audioCtx = new AudioContext()
    if (audioCtx.state === 'suspended') await audioCtx.resume()
    play(audioCtx)
  } catch { /* Audio may be unavailable or locked until a user gesture. */ }
}

/** A quiet local chirp for a genuine worker message or handoff. */
export function playMessageSound(): Promise<void> {
  return withAudio((ctx) => {
    playNote(ctx, 620, 0, 0.07, 0.025, 'square')
    playNote(ctx, 780, 0.075, 0.08, 0.018, 'sine')
  }, 500)
}

/** Restrained interface feedback. All variants are generated locally. */
export function playUiSound(kind: 'expand' | 'compact' | 'minimize' | 'start'): Promise<void> {
  return withAudio((ctx) => {
    if (kind === 'minimize') playNote(ctx, 360, 0, 0.08, 0.022, 'triangle')
    else if (kind === 'compact') playNote(ctx, 440, 0, 0.07, 0.02, 'triangle')
    else if (kind === 'start') {
      playNote(ctx, 520, 0, 0.07, 0.024, 'square')
      playNote(ctx, 690, 0.07, 0.09, 0.02, 'triangle')
    } else playNote(ctx, 560, 0, 0.07, 0.02, 'triangle')
  })
}

/** Manager stamp/bell used only at a real approval or review gate. */
export function playApprovalSound(): Promise<void> {
  return withAudio((ctx) => {
    playNote(ctx, 880, 0, 0.12, 0.03, 'sine')
    playNote(ctx, 1175, 0.1, 0.2, 0.02, 'sine')
  }, 900)
}

/** Call from any user-gesture handler to ensure AudioContext is unlocked */
export function unlockAudio(): void {
  try {
    if (!audioCtx) {
      audioCtx = new AudioContext()
    }
    if (audioCtx.state === 'suspended') {
      audioCtx.resume()
    }
  } catch {
    // ignore
  }
}
