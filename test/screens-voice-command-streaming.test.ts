/**
 * Phase 2 Pass 4 + 5: voice-command-recording-streaming screen lifecycle.
 *
 * Drives the public _helpers entry points with a fake audio session and
 * a fake streaming SttEngine that we can hand-feed partial / final.
 *
 * Verifies:
 * - tap → finalize → voice-command-confirm screen with stable_text
 * - double tap → cancel → idle, ws cancel called
 * - finalize timeout → uses last stable_text (NOT partial_text)
 * - late stt.final after timeout → updates finalText if still on confirm
 *   and not yet sent (Pass 5 behavior)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  installScreenHelpers,
  startVoiceCommandRecording,
  finalizeVoiceCommandStreaming,
  cancelVoiceCommandStreaming,
  _resetHelpersForTest,
} from '../src/screens/_helpers'
import { store } from '../src/state/store'
import type { SttEngine, SttPartialResult, SttSession } from '../src/stt/engine'

// --- fakes ---

function makeFakeAudioSession() {
  let onPcmHandler: ((pcm: Uint8Array) => void) | null = null
  let released = false
  const handle = {
    onPcm(h: (pcm: Uint8Array) => void) { onPcmHandler = h },
    async release() { released = true; onPcmHandler = null },
  }
  return {
    handle,
    feedPcm(pcm: Uint8Array) {
      if (onPcmHandler && !released) onPcmHandler(pcm)
    },
    isReleased: () => released,
    audioSession: {
      current: () => 'voice-command' as const,
      acquire: vi.fn(async () => handle),
    },
  }
}

type FakeSession = SttSession & {
  emitPartial(p: SttPartialResult): void
  emitFinal(text: string, opts?: { confidence?: number }): void
  emitLateFinal(text: string, opts?: { confidence?: number }): void
  emitError(code: string, message: string): void
  finalizeCalled: () => boolean
  cancelCalled: () => boolean
}

function makeFakeStreamEngine(opts: { finalizeMode?: 'auto-stable' | 'manual' } = {}): SttEngine & { lastSession: () => FakeSession | null } {
  let lastSession: FakeSession | null = null
  return {
    kind: 'deepgram-stream',
    async start({ voiceSessionId }) {
      const partialHandlers: Array<(p: SttPartialResult) => void> = []
      const errorHandlers: Array<(e: { code: string; message: string }) => void> = []
      const lateFinalHandlers: Array<(r: { text: string; confidence?: number; provider: 'deepgram-stream' }) => void> = []
      let stableText = ''
      let finalized = false
      let cancelled = false
      let pendingFinal: { text: string; confidence?: number } | null = null

      const session: FakeSession = {
        voiceSessionId,
        async pushPcm(_chunk) { /* swallow */ },
        async finalize() {
          finalized = true
          if (opts.finalizeMode === 'manual') {
            // wait until emitFinal is called
            await new Promise<void>((resolve) => {
              if (pendingFinal) return resolve()
              const t = setInterval(() => {
                if (pendingFinal) { clearInterval(t); resolve() }
              }, 5)
              setTimeout(() => { clearInterval(t); resolve() }, 200)
            })
          }
          if (pendingFinal) {
            const r = pendingFinal
            pendingFinal = null
            return { text: r.text, provider: 'deepgram-stream', confidence: r.confidence }
          }
          // default: return current stable_text
          return { text: stableText, provider: 'deepgram-stream' }
        },
        async cancel() {
          cancelled = true
          lateFinalHandlers.length = 0
        },
        onPartial(handler) { partialHandlers.push(handler) },
        onError(handler) { errorHandlers.push(handler) },
        onLateFinal(handler) { lateFinalHandlers.push(handler) },
        emitPartial(p) {
          stableText = p.stable_text
          for (const h of partialHandlers) h(p)
        },
        emitFinal(text, o) {
          pendingFinal = { text, confidence: o?.confidence }
          stableText = text
        },
        emitLateFinal(text, o) {
          for (const h of lateFinalHandlers) h({ text, confidence: o?.confidence, provider: 'deepgram-stream' })
        },
        emitError(code, message) {
          for (const h of errorHandlers) h({ code, message })
        },
        finalizeCalled: () => finalized,
        cancelCalled: () => cancelled,
      }
      lastSession = session
      return session
    },
    lastSession: () => lastSession,
  } as unknown as SttEngine & { lastSession: () => FakeSession | null }
}

function makeFakeGlassesUI() {
  return {
    isRendering: () => false,
    hasRenderedPage: () => true,
    ensureBasePage: vi.fn(async () => undefined),
    showText: vi.fn(async () => undefined),
    showIdleLauncher: vi.fn(async () => undefined),
    showNotificationList: vi.fn(async () => undefined),
    showNotificationDetail: vi.fn(async () => undefined),
    getDetailPageCount: () => 1,
    showNotificationActions: vi.fn(async () => undefined),
    showAskUserQuestion: vi.fn(async () => undefined),
    showReplyRecording: vi.fn(async () => undefined),
    showReplySttProcessing: vi.fn(async () => undefined),
    showReplyConfirm: vi.fn(async () => undefined),
    showReplyResult: vi.fn(async () => undefined),
    showVoiceCommandRecording: vi.fn(async () => undefined),
    showVoiceCommandRecordingStreaming: vi.fn(async () => undefined),
    showVoiceCommandConfirm: vi.fn(async () => undefined),
    showVoiceCommandSending: vi.fn(async () => undefined),
    showVoiceCommandDone: vi.fn(async () => undefined),
    requestApproval: vi.fn(async () => 'ok'),
    paginateText: () => [''],
  }
}

function makeFakeNotifClient() {
  return {
    list: vi.fn(async () => []),
    get: vi.fn(async () => ({ id: '', title: '', summary: '', fullText: '', source: 'claude-code', createdAt: '' })),
    sendCommand: vi.fn(async () => ({ ok: true })),
    health: vi.fn(async () => ({ ok: true })),
    permissionAdminClear: vi.fn(async () => ({ ok: true })),
  } as unknown as ReturnType<typeof import('../src/notifications').createNotificationClient>
}

function setupHelpers(opts: { finalizeMode?: 'auto-stable' | 'manual' } = {}) {
  const fakeAudio = makeFakeAudioSession()
  const engine = makeFakeStreamEngine(opts)
  const replyEngine: SttEngine = {
    kind: 'groq-batch',
    async start() {
      throw new Error('reply path should not be exercised in these tests')
    },
  }
  const glassesUI = makeFakeGlassesUI()
  const notifClient = makeFakeNotifClient()
  // a fake bridge connection — we only need `bridge` and `mode`
  const fakeConn = { bridge: {}, mode: 'bridge' as const, startAudio: async () => {}, stopAudio: async () => {}, onAudio: () => {}, onEvent: () => {}, getDeviceInfo: async () => null } as unknown as import('../src/bridge').BridgeConnection

  installScreenHelpers({
    getConnection: () => fakeConn,
    getAudioSession: () => fakeAudio.audioSession as unknown as import('../src/audio-session').AudioSession,
    glassesUI: glassesUI as unknown as import('../src/screens/types').GlassesUI,
    notifClient,
    renderQueue: { isRendering: () => false } as unknown as import('../src/render-queue').RenderQueue,
    sttEngine: engine,
    sttEngineForReply: replyEngine,
    log: () => {},
    appConfig: { notificationIdleDimMode: false },
    updateNotifInfo: () => {},
    flushPendingNotificationUi: async () => {},
  })

  // reset central state to known baseline
  store.notif.screen = 'idle'
  store.voice.audioChunks = []
  store.voice.audioTotalBytes = 0
  store.voice.isRecording = false
  store.voice.startInFlight = false
  store.voice.stopInFlight = false
  store.voice.finalText = ''
  store.voice.stableText = ''
  store.voice.partialText = ''
  store.voice.stableSeq = 0
  store.voice.partialSeq = 0
  store.voice.preFinalText = ''
  store.voice.sendCancelled = false
  store.voice.recordingMaxTimer = null
  store.voice.doneTimer = null
  store.voice.lateFinalUpdatedTimer = null
  store.voice.sendOrCancelInProgress = false
  store.voice.startedAt = 0
  store.voice.generation = 0

  return { engine, glassesUI, notifClient, fakeAudio, fakeConn }
}

describe('voice-command-recording-streaming', () => {
  beforeEach(() => {
    _resetHelpersForTest()
  })
  afterEach(() => {
    _resetHelpersForTest()
  })

  it('start → screen transitions to streaming and ws partials populate stable/partial', async () => {
    const env = setupHelpers()
    await startVoiceCommandRecording()
    expect(store.notif.screen).toBe('voice-command-recording-streaming')
    const session = env.engine.lastSession()
    expect(session).not.toBeNull()
    session!.emitPartial({ stable_text: 'こん', partial_text: 'にちは', stable_seq: 0, partial_seq: 1 })
    expect(store.voice.stableText).toBe('こん')
    expect(store.voice.partialText).toBe('にちは')
    expect(store.voice.partialSeq).toBe(1)
    await cancelVoiceCommandStreaming('cleanup')
  })

  it('drops stale partials (lower seq)', async () => {
    const env = setupHelpers()
    await startVoiceCommandRecording()
    const session = env.engine.lastSession()!
    session.emitPartial({ stable_text: '', partial_text: 'first', stable_seq: 0, partial_seq: 5 })
    session.emitPartial({ stable_text: '', partial_text: 'stale', stable_seq: 0, partial_seq: 3 })
    expect(store.voice.partialText).toBe('first')
    await cancelVoiceCommandStreaming('cleanup')
  })

  it('finalize → voice-command-confirm with text from engine', async () => {
    const env = setupHelpers()
    await startVoiceCommandRecording()
    const session = env.engine.lastSession()!
    session.emitPartial({ stable_text: 'こんにちは。', partial_text: '', stable_seq: 1, partial_seq: 2 })
    await finalizeVoiceCommandStreaming('user-tap')
    expect(session.finalizeCalled()).toBe(true)
    expect(store.voice.finalText).toBe('こんにちは。')
    expect(store.notif.screen).toBe('voice-command-confirm')
    expect(env.glassesUI.showVoiceCommandConfirm).toHaveBeenCalled()
  })

  it('cancel → idle and engine.cancel called', async () => {
    const env = setupHelpers()
    await startVoiceCommandRecording()
    const session = env.engine.lastSession()!
    session.emitPartial({ stable_text: '途中', partial_text: 'まで', stable_seq: 0, partial_seq: 1 })
    await cancelVoiceCommandStreaming('user-cancel')
    expect(session.cancelCalled()).toBe(true)
    expect(store.notif.screen).toBe('idle')
    expect(store.voice.stableText).toBe('')
    expect(store.voice.partialText).toBe('')
  })

  it('finalize timeout falls back to last stable_text without partial_text', async () => {
    // The fake engine returns current stable_text from finalize() if no
    // emitFinal was queued — mimicking the real timeout behavior.
    const env = setupHelpers()
    await startVoiceCommandRecording()
    const session = env.engine.lastSession()!
    session.emitPartial({ stable_text: '今日は', partial_text: '良い天気', stable_seq: 1, partial_seq: 4 })
    await finalizeVoiceCommandStreaming('user-tap')
    // Per spec: 未確定 partial_text は確定として使わない
    expect(store.voice.finalText).toBe('今日は')
    expect(env.glassesUI.showVoiceCommandConfirm).toHaveBeenCalledWith(expect.anything(), '今日は')
  })

  it('late-final updates finalText when still on confirm screen and not sending', async () => {
    const env = setupHelpers()
    await startVoiceCommandRecording()
    const session = env.engine.lastSession()!
    session.emitPartial({ stable_text: '途中の文字', partial_text: '', stable_seq: 1, partial_seq: 1 })
    await finalizeVoiceCommandStreaming('user-tap')
    expect(store.voice.finalText).toBe('途中の文字')
    // simulate late stt.final delivered post-timeout
    session.emitLateFinal('完全な文字列です')
    expect(store.voice.finalText).toBe('完全な文字列です')
    // showVoiceCommandConfirm called with the late text + (updated) badge
    const calls = (env.glassesUI.showVoiceCommandConfirm as any).mock.calls
    const last = calls[calls.length - 1]
    expect(last[1]).toContain('完全な文字列です')
    expect(last[1]).toContain('(updated)')
  })

  it('late-final is dropped after sendOrCancelInProgress is set', async () => {
    const env = setupHelpers()
    await startVoiceCommandRecording()
    const session = env.engine.lastSession()!
    session.emitPartial({ stable_text: 'A', partial_text: '', stable_seq: 1, partial_seq: 1 })
    await finalizeVoiceCommandStreaming('user-tap')
    // simulate user pressing Send
    store.voice.sendOrCancelInProgress = true
    session.emitLateFinal('B-late')
    expect(store.voice.finalText).toBe('A')
  })
})
