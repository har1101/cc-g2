/**
 * Cross-screen helpers and shared lifecycle functions (Phase 1.5c).
 *
 * 旧 main.ts では module-level closure として持っていた audio handle 変数や
 * lifecycle 関数 (startVoiceCommandRecording 等) を 1 箇所に集約。 値・タイミング
 * は元実装と完全同等で、 store / audio-session / glasses-ui への副作用も同じ。
 *
 * `installScreenHelpers(deps)` で 1 度だけ inject すれば、 main.ts は
 * `buildScreenContext()` で thin な wrapper を作るだけになる。
 */

import type { BridgeConnection } from '../bridge'
import type { AskQuestionData } from '../glasses-ui'
import type { GlassesUI } from './types'
import type { AudioSession, AudioSessionHandle } from '../audio-session'
import type { RenderQueue } from '../render-queue'
import type { SttEngine, SttSession } from '../stt/engine'
import type { createNotificationClient } from '../notifications'
import type { NotificationDetail } from '../notifications'
import {
  bumpVoiceGeneration,
  cancelIdleSingleTapTimer,
  clearVoiceDoneTimer,
  clearVoiceRecordingMaxTimer,
  resetReplyAudio,
  resetVoiceToIdle,
  store,
} from '../state/store'
import {
  IDLE_REOPEN_COOLDOWN_MS,
  VOICE_COMMAND_DONE_AUTO_RETURN_MS,
  VOICE_COMMAND_RECORDING_MAX_MS,
  TAP_SCROLL_SUPPRESS_MS,
  DETAIL_SCROLL_COOLDOWN_MS,
} from './_constants'
import { G2_EVENT, getNormalizedEventType } from '../even-events'
import type { EvenHubEvent } from '@evenrealities/even_hub_sdk'

// ---------------------------------------------------------------------------
// Helper deps (injected once at startup by main.ts)
// ---------------------------------------------------------------------------

export type HelperDeps = {
  getConnection: () => BridgeConnection | null
  getAudioSession: () => AudioSession | null
  glassesUI: GlassesUI
  notifClient: ReturnType<typeof createNotificationClient>
  renderQueue: RenderQueue
  /**
   * Voice-command 用 STT engine。 `VITE_STT_ENGINE_VOICE_COMMAND` で
   * `groq-batch` (default) か `deepgram-stream` を選ぶ。
   */
  sttEngine: SttEngine
  /**
   * Permission コメント (返信) 用 STT engine。 短文向けで always groq-batch。
   * 1.5c までは voice-command と同じ engine を共有していたが、 Phase 2 で
   * permission パスはストリーミングのオーバーヘッドが見合わないため別 inject。
   */
  sttEngineForReply: SttEngine
  log: (msg: string) => void
  appConfig: {
    notificationIdleDimMode: boolean
  }
  /** 旧 main.ts の updateNotifInfo を委譲する。 helpers 内では UI のみ更新したい時に呼ぶ */
  updateNotifInfo: () => void
  /** 旧 main.ts の flushPendingNotificationUi 相当 (returnToListFromResult から呼ばれる) */
  flushPendingNotificationUi: (reason: string) => Promise<void>
}

let deps: HelperDeps | null = null

export function installScreenHelpers(d: HelperDeps): void {
  deps = d
}

function need(): HelperDeps {
  if (!deps) throw new Error('screen helpers not installed: call installScreenHelpers(deps) at startup')
  return deps
}

// ---------------------------------------------------------------------------
// Audio handle ownership (module-level, like the original closure variables)
// ---------------------------------------------------------------------------

let currentReplyAudioHandle: AudioSessionHandle | null = null
let currentVoiceAudioHandle: AudioSessionHandle | null = null
/**
 * Phase 2: Deepgram streaming session held while the
 * voice-command-recording-streaming screen is active. Owned by
 * `startVoiceCommandRecordingStreaming` and released by finalize/cancel.
 */
let currentVoiceSttSession: SttSession | null = null
let currentVoiceSttRedrawTimer: ReturnType<typeof setTimeout> | null = null
let voiceSttRedrawDirty = false

/** Test helper: clear all module-level state (used by unit tests). */
export function _resetHelpersForTest(): void {
  currentReplyAudioHandle = null
  currentVoiceAudioHandle = null
  currentVoiceSttSession = null
  if (currentVoiceSttRedrawTimer) {
    clearTimeout(currentVoiceSttRedrawTimer)
    currentVoiceSttRedrawTimer = null
  }
  voiceSttRedrawDirty = false
}

/** dev-mic は main.ts (Connect / Mic ボタン) からのみ使うので main.ts 側に置く */

// ---------------------------------------------------------------------------
// Misc small helpers (旧 main.ts 由来)
// ---------------------------------------------------------------------------

/** glasses-ui か render-queue のどちらかが進行中なら true */
export function isAnyRendering(): boolean {
  const d = need()
  return d.glassesUI.isRendering() || d.renderQueue.isRendering()
}

/** AskUserQuestion 通知判定 */
export function isAskUserQuestionNotification(detail: NotificationDetail): boolean {
  const meta = detail.metadata
  return !!(meta && (meta.hookType === 'ask-user-question' || meta.toolName === 'AskUserQuestion'))
}

/** AskUserQuestion: questions[] (必要 shape のみ) を抽出 */
export function extractAskQuestions(detail: NotificationDetail): AskQuestionData[] {
  const meta = detail.metadata
  if (!meta) return []
  const questions = meta.questions
  if (!Array.isArray(questions)) return []
  return questions.filter(
    (q: unknown): q is AskQuestionData =>
      !!q && typeof q === 'object' && 'question' in q && 'options' in q && Array.isArray((q as AskQuestionData).options),
  )
}

/** reply エンドポイント応答から表示 用メッセージを生成 */
export function getReplyResultMessage(
  res: { reply?: { status?: string; result?: string; error?: string; ignoredReason?: string } } | undefined,
): { ok: boolean; message?: string } {
  const reply = res?.reply
  if (!reply) return { ok: true }
  if (reply.status === 'failed') {
    return { ok: false, message: reply.error || 'reply failed' }
  }
  if (reply.result === 'ignored') {
    if (reply.ignoredReason === 'approval-not-pending') {
      return { ok: false, message: 'この承認は既に無効です' }
    }
    if (reply.ignoredReason === 'approval-link-not-found') {
      return { ok: false, message: '承認リンクが見つかりません' }
    }
    return { ok: false, message: reply.error || 'reply ignored' }
  }
  return { ok: true }
}

/** 通知のmetadata.cwdに一致するセッションのコンテキスト占有率を返す */
export function getContextPctForNotification(detail: { metadata?: Record<string, unknown> }): number | undefined {
  const cwd = detail.metadata?.cwd
  if (typeof cwd !== 'string' || store.context.sessions.length === 0) return store.context.latestPct
  const matches = store.context.sessions.filter((s) => s.cwd === cwd)
  if (matches.length === 0) return store.context.latestPct
  return Math.max(...matches.map((s) => s.usedPercentage))
}

/** detail スクロール suppress / cooldown 判定 */
export function shouldIgnoreDetailScroll(eventType: number | undefined): boolean {
  const d = need()
  if (eventType !== G2_EVENT.SCROLL_TOP && eventType !== G2_EVENT.SCROLL_BOTTOM) return false
  const now = Date.now()
  if ((now - store.eventQueue.lastTapEventAt) < TAP_SCROLL_SUPPRESS_MS) {
    d.log('[event] detail scroll suppressed: tap直後')
    return true
  }
  if ((now - store.eventQueue.lastDetailScrollAt) < DETAIL_SCROLL_COOLDOWN_MS) {
    d.log('[event] detail scroll suppressed: cooldown')
    return true
  }
  store.eventQueue.lastDetailScrollAt = now
  return false
}

export function clearPendingNotifEvent(): void {
  store.eventQueue.pendingNotifEvent = null
  if (store.eventQueue.pendingNotifEventFlushTimer) {
    clearTimeout(store.eventQueue.pendingNotifEventFlushTimer)
    store.eventQueue.pendingNotifEventFlushTimer = null
  }
}

/** キュー中のイベントがスクロールの場合のみクリアする（tap/doubleTap等は保持） */
export function clearPendingScrollEvent(): void {
  if (!store.eventQueue.pendingNotifEvent) return
  const eventType = getNormalizedEventType(store.eventQueue.pendingNotifEvent as EvenHubEvent)
  if (eventType === G2_EVENT.SCROLL_TOP || eventType === G2_EVENT.SCROLL_BOTTOM) {
    clearPendingNotifEvent()
  }
}

// ---------------------------------------------------------------------------
// 結果画面 → 通知一覧復帰 / idle 復帰
// ---------------------------------------------------------------------------

export async function returnToListFromResult(): Promise<void> {
  const d = need()
  const conn = d.getConnection()
  if (store.notif.screen === 'list') return // 既に復帰済み
  d.log('結果画面 → 通知一覧に復帰')
  store.notif.screen = 'list'
  store.notif.detailItem = null
  store.notif.replyText = ''
  store.notif.selectedIndex = 0
  store.notif.askQuestions = []
  store.notif.askQuestionIndex = 0
  store.notif.askAnswers = {}
  if (conn) {
    try {
      store.notif.items = await d.notifClient.list(20)
    } catch { /* fallback to cached */ }
    await d.glassesUI.showNotificationList(conn, store.notif.items)
  }
  d.updateNotifInfo()
  await d.flushPendingNotificationUi('result-return')
}

export async function enterIdleScreen(reason: string): Promise<void> {
  const d = need()
  const conn = d.getConnection()
  store.notif.screen = 'idle'
  store.notif.detailItem = null
  store.notif.replyText = ''
  store.idle.idleTapDuringRender = false
  store.idle.lastIdleEventAt = 0
  cancelIdleSingleTapTimer()
  store.idle.idleOpenBlockedUntil = Date.now() + IDLE_REOPEN_COOLDOWN_MS
  clearPendingNotifEvent()
  if (conn) {
    await d.glassesUI.showIdleLauncher(conn, { dimMode: d.appConfig.notificationIdleDimMode })
  }
  d.updateNotifInfo()
  d.log(`${reason} (idle reopen blocked ${IDLE_REOPEN_COOLDOWN_MS}ms)`)
}

/**
 * Phase 3: enter the SessionList screen. Lazily fetches projects/sessions
 * from the Hub. The dashboard controller calls this when the user clicks
 * the "Sessions" button, and screen handlers can call it from G2 too if a
 * later UX iteration adds a sentinel.
 */
export async function enterSessionListScreen(reason: string): Promise<void> {
  const d = need()
  const conn = d.getConnection()
  if (!conn) return
  try {
    if (store.sessionList.projects.length === 0) {
      store.sessionList.projects = await d.notifClient.listProjects()
    }
    store.sessionList.sessions = await d.notifClient.listSessions()
  } catch (err) {
    d.log(`SessionList: 初期取得失敗 ${err instanceof Error ? err.message : String(err)}`)
  }
  // Phase 4: prefetch the active-summary so the first paint already shows
  // (active) + (N pending) badges. This is best-effort — on failure we keep
  // whatever the polling controller last cached in store.sessionUi.
  try {
    const summary = await d.notifClient.fetchActiveSummary()
    store.sessionUi.activeSessionId = summary.activeSessionId
    store.sessionUi.pendingCountsByOtherSession = summary.pendingCountsByOtherSession
  } catch (err) {
    d.log(`SessionList: active-summary取得失敗 ${err instanceof Error ? err.message : String(err)}`)
  }
  store.sessionList.selectedIndex = 0
  store.sessionList.screen = 'session-list'
  store.notif.screen = 'session-list'
  await d.glassesUI.showSessionList(conn, store.sessionList.sessions, 0, {
    activeSessionId: store.sessionUi.activeSessionId,
    pendingCounts: store.sessionUi.pendingCountsByOtherSession,
  })
  d.updateNotifInfo()
  d.log(`SessionList enter (${reason})`)
}

// ---------------------------------------------------------------------------
// reply (permission コメント) 録音
// ---------------------------------------------------------------------------

export async function startReplyAudioRecording(): Promise<boolean> {
  const d = need()
  const conn = d.getConnection()
  const audioSession = d.getAudioSession()
  if (!conn || !audioSession) return false
  resetReplyAudio()
  try {
    currentReplyAudioHandle = await audioSession.acquire('reply-comment')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    d.log(`返信録音 開始失敗: ${msg}`)
    return false
  }
  currentReplyAudioHandle.onPcm((pcm) => {
    if (!store.reply.isRecording) return
    store.reply.audioChunks.push(pcm)
    store.reply.audioTotalBytes += pcm.length
  })
  store.reply.isRecording = true
  return true
}

export async function stopReplyAudioRecording(): Promise<void> {
  const d = need()
  store.reply.isRecording = false
  if (currentReplyAudioHandle) {
    try {
      await currentReplyAudioHandle.release()
    } catch (err) {
      d.log(`返信録音 stopAudio失敗: ${err instanceof Error ? err.message : String(err)}`)
    }
    currentReplyAudioHandle = null
  }
}

// ---------------------------------------------------------------------------
// voice-command 録音
// ---------------------------------------------------------------------------

/**
 * Public entry: start voice-command recording.
 *
 * Phase 2: dispatch on `sttEngine.kind`.
 * - `groq-batch` → existing batch path (record → finalize → confirm)
 * - `deepgram-stream` → streaming path (live partials on G2)
 *
 * permission-comment (返信) パスはこの関数を経由しないため、 engine 切替の影響を受けない。
 */
export async function startVoiceCommandRecording(): Promise<void> {
  const d = need()
  if (d.sttEngine.kind === 'deepgram-stream') {
    await startVoiceCommandRecordingStreaming()
    return
  }
  await startVoiceCommandRecordingBatch()
}

async function startVoiceCommandRecordingBatch(): Promise<void> {
  const d = need()
  const conn = d.getConnection()
  if (!conn) return
  if (store.voice.startInFlight) {
    d.log('voice-command: 重複開始イベントを無視 (start-in-flight)')
    return
  }
  store.voice.startInFlight = true
  // start のたびに世代を 1 つ進める。stop/send 側はこの値をキャプチャしておき、
  // await 後にグローバルが進んでいたら（=cancel または再 start 済み）状態を上書きしない。
  const gen = bumpVoiceGeneration()
  try {
    store.voice.audioChunks = []
    store.voice.audioTotalBytes = 0
    store.voice.finalText = ''
    store.voice.stopInFlight = false
    store.voice.startedAt = Date.now()
    store.voice.isRecording = true
    store.notif.screen = 'voice-command-recording'

    await d.glassesUI.showVoiceCommandRecording(conn, { bytes: 0 })
    // simulator 互換: audioControl 前にベースページが必要
    if (conn.mode === 'bridge' && !d.glassesUI.hasRenderedPage(conn)) {
      await d.glassesUI.ensureBasePage(conn, '音声コマンド録音中...')
    }
    const audioSession = d.getAudioSession()
    if (!audioSession) throw new Error('audio-session not initialized')
    currentVoiceAudioHandle = await audioSession.acquire('voice-command')
    currentVoiceAudioHandle.onPcm((pcm) => {
      if (!store.voice.isRecording) return
      store.voice.audioChunks.push(pcm)
      store.voice.audioTotalBytes += pcm.length
    })

    clearVoiceRecordingMaxTimer()
    store.voice.recordingMaxTimer = setTimeout(() => {
      void stopVoiceCommandRecording('timeout')
    }, VOICE_COMMAND_RECORDING_MAX_MS)

    d.updateNotifInfo()
    d.log(`voice-command: 録音開始 (single tap) gen=${gen}`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    d.log(`voice command: 録音開始失敗 ${msg}`)
    // 録音開始の途中失敗は state を必ず idle に戻す。世代も進めて、もし stopAudio など
    // 既にスケジュール済みのコールバックが返ってきても無視されるようにする。
    resetVoiceToIdle()
    bumpVoiceGeneration()
    if (currentVoiceAudioHandle) {
      try { await currentVoiceAudioHandle.release() } catch { /* ignore */ }
      currentVoiceAudioHandle = null
    }
    try {
      await returnToIdleFromVoiceCommand('start-failed')
    } catch (idleErr) {
      d.log(`voice-command: idle 復帰失敗 ${idleErr instanceof Error ? idleErr.message : String(idleErr)}`)
      store.notif.screen = 'idle'
    }
  } finally {
    store.voice.startInFlight = false
  }
}

// ---------------------------------------------------------------------------
// voice-command 録音 (streaming, Phase 2)
// ---------------------------------------------------------------------------

const STREAM_REDRAW_INTERVAL_MS = 150 // ~6.6Hz

function scheduleStreamRedraw(): void {
  voiceSttRedrawDirty = true
  if (currentVoiceSttRedrawTimer) return
  currentVoiceSttRedrawTimer = setTimeout(() => {
    currentVoiceSttRedrawTimer = null
    if (!voiceSttRedrawDirty) return
    voiceSttRedrawDirty = false
    flushStreamRedraw()
  }, STREAM_REDRAW_INTERVAL_MS)
}

function flushStreamRedraw(): void {
  const d = need()
  const conn = d.getConnection()
  if (!conn) return
  if (store.notif.screen !== 'voice-command-recording-streaming') return
  const elapsedMs = Date.now() - store.voice.startedAt
  // fire-and-forget — caller throttles
  void d.glassesUI.showVoiceCommandRecordingStreaming(conn, {
    stableText: store.voice.stableText,
    partialText: store.voice.partialText,
    elapsedMs,
  }).catch((err) => {
    d.log(`voice-command-streaming redraw失敗: ${err instanceof Error ? err.message : String(err)}`)
  })
}

async function startVoiceCommandRecordingStreaming(): Promise<void> {
  const d = need()
  const conn = d.getConnection()
  if (!conn) return
  if (store.voice.startInFlight) {
    d.log('voice-command-streaming: 重複開始イベントを無視 (start-in-flight)')
    return
  }
  store.voice.startInFlight = true
  const gen = bumpVoiceGeneration()
  try {
    store.voice.audioChunks = []
    store.voice.audioTotalBytes = 0
    store.voice.finalText = ''
    store.voice.stableText = ''
    store.voice.partialText = ''
    store.voice.stableSeq = 0
    store.voice.partialSeq = 0
    store.voice.preFinalText = ''
    store.voice.sendOrCancelInProgress = false
    store.voice.stopInFlight = false
    store.voice.startedAt = Date.now()
    store.voice.isRecording = true
    store.notif.screen = 'voice-command-recording-streaming'

    await d.glassesUI.showVoiceCommandRecordingStreaming(conn, { stableText: '', partialText: '', elapsedMs: 0 })
    if (conn.mode === 'bridge' && !d.glassesUI.hasRenderedPage(conn)) {
      await d.glassesUI.ensureBasePage(conn, '音声コマンド録音中...')
    }

    const audioSession = d.getAudioSession()
    if (!audioSession) throw new Error('audio-session not initialized')
    currentVoiceAudioHandle = await audioSession.acquire('voice-command')

    // Open the streaming engine BEFORE wiring PCM, so early chunks aren't dropped.
    let session: SttSession
    try {
      session = await d.sttEngine.start({ voiceSessionId: `voice-${gen}`, lang: 'ja' })
    } catch (err) {
      // Engine could not connect (no_api_key / network). Reset and bail.
      d.log(`voice-command-streaming: engine start失敗 ${err instanceof Error ? err.message : String(err)}`)
      try { await currentVoiceAudioHandle.release() } catch { /* ignore */ }
      currentVoiceAudioHandle = null
      throw err
    }
    currentVoiceSttSession = session

    if (typeof session.onPartial === 'function') {
      session.onPartial((p) => {
        if (store.voice.generation !== gen) return
        // monotonic seq guard (server already drops stale, but client double-checks)
        if (p.partial_seq < store.voice.partialSeq) return
        if (p.stable_seq < store.voice.stableSeq) return
        store.voice.stableSeq = p.stable_seq
        store.voice.partialSeq = p.partial_seq
        store.voice.stableText = p.stable_text
        store.voice.partialText = p.partial_text
        scheduleStreamRedraw()
      })
    }
    if (typeof session.onError === 'function') {
      session.onError((err) => {
        // Codex 2 #6: previously this was log-only, leaving the audio handle
        // and recording state stuck if the upstream WS dropped. Now we tear
        // down the streaming session: cancel engine, release mic, return idle.
        d.log(`voice-command-streaming: engine error code=${err.code} msg=${err.message} → cancel`)
        if (store.voice.generation !== gen) return // stale callback after cancel
        void cancelVoiceCommandStreaming(`engine-error:${err.code}`).catch(() => { /* swallow */ })
      })
    }
    // Phase 2 Pass 5: late-final handling.
    // - 800ms タイムアウト後に届いた stt.final の本文に差し替える (confirm画面で送信前のみ)。
    // - 送信中 / キャンセル後は破棄する。
    if (typeof session.onLateFinal === 'function') {
      session.onLateFinal((late) => {
        if (store.voice.generation !== gen) return
        if (store.voice.sendOrCancelInProgress) {
          d.log('voice-command-streaming: late-final 破棄 (send/cancel 進行中)')
          return
        }
        if (store.notif.screen !== 'voice-command-confirm') {
          d.log(`voice-command-streaming: late-final 破棄 (screen=${store.notif.screen})`)
          return
        }
        const lateText = (late.text ?? '').trim()
        if (!lateText) return
        if (lateText === store.voice.preFinalText) {
          d.log('voice-command-streaming: late-final は preFinalText と同一 → no-op')
          return
        }
        d.log(`voice-command-streaming: late-final 適用 "${store.voice.preFinalText}" → "${lateText}"`)
        store.voice.finalText = lateText
        const liveConn = d.getConnection()
        if (liveConn) {
          void d.glassesUI.showVoiceCommandConfirm(liveConn, `${lateText}\n(updated)`)
          // 1 秒後に通常表示に戻す。
          if (store.voice.lateFinalUpdatedTimer) clearTimeout(store.voice.lateFinalUpdatedTimer)
          store.voice.lateFinalUpdatedTimer = setTimeout(() => {
            store.voice.lateFinalUpdatedTimer = null
            if (store.voice.generation !== gen) return
            if (store.notif.screen !== 'voice-command-confirm') return
            const conn2 = d.getConnection()
            if (conn2) void d.glassesUI.showVoiceCommandConfirm(conn2, lateText)
          }, 1000)
        }
      })
    }

    currentVoiceAudioHandle.onPcm((pcm) => {
      if (!store.voice.isRecording) return
      void session.pushPcm(pcm).catch(() => { /* swallowed; engine surfaces via onError */ })
    })

    clearVoiceRecordingMaxTimer()
    store.voice.recordingMaxTimer = setTimeout(() => {
      void finalizeVoiceCommandStreaming('timeout')
    }, VOICE_COMMAND_RECORDING_MAX_MS)

    d.updateNotifInfo()
    d.log(`voice-command-streaming: 録音開始 gen=${gen}`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    d.log(`voice-command-streaming: 録音開始失敗 ${msg}`)
    resetVoiceToIdle()
    bumpVoiceGeneration()
    if (currentVoiceSttSession) {
      try { await currentVoiceSttSession.cancel() } catch { /* ignore */ }
      currentVoiceSttSession = null
    }
    if (currentVoiceAudioHandle) {
      try { await currentVoiceAudioHandle.release() } catch { /* ignore */ }
      currentVoiceAudioHandle = null
    }
    try {
      await returnToIdleFromVoiceCommand('start-failed-streaming')
    } catch {
      store.notif.screen = 'idle'
    }
  } finally {
    store.voice.startInFlight = false
  }
}

/**
 * Finalize the streaming session, transition to voice-command-confirm.
 * Public entry from the screen handler (single tap → send).
 */
export async function finalizeVoiceCommandStreaming(reason: string): Promise<void> {
  const d = need()
  const conn = d.getConnection()
  if (!conn) return
  if (store.voice.stopInFlight) {
    d.log(`voice-command-streaming: 重複停止イベントを無視 reason=${reason}`)
    return
  }
  const gen = store.voice.generation
  store.voice.stopInFlight = true
  clearVoiceRecordingMaxTimer()

  // Stop accepting new PCM immediately.
  store.voice.isRecording = false
  if (currentVoiceAudioHandle) {
    try {
      await currentVoiceAudioHandle.release()
    } catch (err) {
      d.log(`voice-command-streaming stopAudio失敗: ${err instanceof Error ? err.message : String(err)}`)
    }
    currentVoiceAudioHandle = null
  }

  if (store.voice.generation !== gen) {
    store.voice.stopInFlight = false
    return
  }

  const session = currentVoiceSttSession
  if (!session) {
    // Nothing to finalize — go back to idle.
    store.voice.stopInFlight = false
    await returnToIdleFromVoiceCommand('streaming-no-session')
    return
  }

  try {
    const elapsedMs = Date.now() - store.voice.startedAt
    d.log(`voice-command-streaming: 停止 reason=${reason} gen=${gen} elapsed=${elapsedMs}ms`)
    const stt = await session.finalize()
    currentVoiceSttSession = null

    if (store.voice.generation !== gen) {
      d.log(`voice-command-streaming: 停止結果を破棄 (gen mismatch) reason=${reason}`)
      return
    }
    const text = (stt.text ?? '').trim()
    if (!text) {
      d.log('voice-command-streaming: STT空 → idle')
      await returnToIdleFromVoiceCommand('empty-streaming')
      return
    }
    store.voice.finalText = text
    // preFinalText: if a late stt.final arrives after the timeout, we'll
    // diff against this and show the (updated) badge.
    store.voice.preFinalText = text
    store.notif.screen = 'voice-command-confirm'
    await d.glassesUI.showVoiceCommandConfirm(conn, text)
    d.updateNotifInfo()
  } catch (err) {
    d.log(`voice-command-streaming finalize失敗: ${err instanceof Error ? err.message : String(err)}`)
    await returnToIdleFromVoiceCommand('streaming-finalize-error')
  } finally {
    store.voice.stopInFlight = false
  }
}

/**
 * Cancel the streaming session and return to idle. Public entry from the
 * voice-command-recording-streaming screen handler (double tap).
 */
export async function cancelVoiceCommandStreaming(reason: string): Promise<void> {
  const d = need()
  const conn = d.getConnection()
  if (!conn) return
  bumpVoiceGeneration()
  clearVoiceRecordingMaxTimer()
  store.voice.isRecording = false
  store.voice.sendOrCancelInProgress = true

  if (currentVoiceSttSession) {
    try { await currentVoiceSttSession.cancel() } catch { /* ignore */ }
    currentVoiceSttSession = null
  }
  if (currentVoiceAudioHandle) {
    try {
      await currentVoiceAudioHandle.release()
    } catch (err) {
      d.log(`voice-command-streaming cancel stopAudio失敗: ${err instanceof Error ? err.message : String(err)}`)
    }
    currentVoiceAudioHandle = null
  }
  store.voice.audioChunks = []
  store.voice.audioTotalBytes = 0
  store.voice.finalText = ''
  store.voice.stableText = ''
  store.voice.partialText = ''
  store.voice.stableSeq = 0
  store.voice.partialSeq = 0
  store.voice.preFinalText = ''
  d.log(`voice-command-streaming: キャンセル reason=${reason}`)
  await returnToIdleFromVoiceCommand(reason)
}

export async function stopVoiceCommandRecording(reason: string): Promise<void> {
  const d = need()
  const conn = d.getConnection()
  if (!conn) return
  if (store.voice.stopInFlight) {
    d.log(`voice-command: 重複停止イベントを無視 reason=${reason}`)
    return
  }
  // entry 時に現世代をキャプチャ。各 await 後にこの値が陳腐化していないか確認することで、
  // ユーザーが double-tap でキャンセルした流れと競合した時の上書きを防ぐ。
  const gen = store.voice.generation
  store.voice.stopInFlight = true
  clearVoiceRecordingMaxTimer()

  const isStillCurrent = () => {
    if (store.voice.generation !== gen) return false
    // start/stop/confirm 以外の画面に遷移していたらキャンセル済み（idle など）。
    if (
      store.notif.screen !== 'voice-command-recording' &&
      store.notif.screen !== 'voice-command-confirm'
    ) {
      return false
    }
    return true
  }

  try {
    if (store.voice.isRecording) {
      store.voice.isRecording = false
      if (currentVoiceAudioHandle) {
        await currentVoiceAudioHandle.release()
        currentVoiceAudioHandle = null
      }
    }
    if (!isStillCurrent()) {
      d.log(`voice-command: stop result discarded (cancelled) reason=${reason} stage=stopAudio`)
      return
    }

    const elapsedMs = Date.now() - store.voice.startedAt
    d.log(`voice-command: 停止 reason=${reason} gen=${gen} elapsed=${elapsedMs}ms bytes=${store.voice.audioTotalBytes}`)

    if (store.voice.audioTotalBytes === 0) {
      d.log('voice-command: 録音内容なし → idle')
      await returnToIdleFromVoiceCommand('empty-audio')
      return
    }

    const chunks = store.voice.audioChunks
    try {
      // SttEngine seam: batch engine では chunks を一括 push して finalize する。
      // Phase 2 の streaming engine と同じ shape にしておく。
      const session = await d.sttEngine.start({ voiceSessionId: `voice-${gen}`, lang: 'ja' })
      for (const chunk of chunks) {
        await session.pushPcm(chunk)
      }
      const stt = await session.finalize()
      if (!isStillCurrent()) {
        d.log(`voice-command: stop result discarded (cancelled) reason=${reason} stage=stt`)
        return
      }
      const text = (stt.text ?? '').trim()
      d.log(`voice-command STT完了: provider=${stt.provider} text="${text}"`)

      if (!text) {
        d.log('voice-command: STT空 → idle (送信せず)')
        await returnToIdleFromVoiceCommand('empty-stt')
        return
      }

      store.voice.finalText = text
      store.notif.screen = 'voice-command-confirm'
      await d.glassesUI.showVoiceCommandConfirm(conn, text)
      if (!isStillCurrent()) {
        d.log(`voice-command: stop result discarded (cancelled) reason=${reason} stage=confirm-render`)
        return
      }
      d.updateNotifInfo()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      d.log(`voice-command STT失敗: ${msg}`)
      if (store.voice.generation !== gen) {
        d.log('voice-command: STT失敗の表示をキャンセル (gen mismatch)')
        return
      }
      store.notif.screen = 'voice-command-done'
      await d.glassesUI.showVoiceCommandDone(conn, false)
      if (store.voice.generation !== gen) {
        d.log('voice-command: STT失敗の表示後 gen mismatch → idle 維持')
        return
      }
      d.updateNotifInfo()
      scheduleVoiceCommandDoneReturn()
    }
  } finally {
    store.voice.stopInFlight = false
  }
}

export async function cancelVoiceCommandRecording(reason: string): Promise<void> {
  const d = need()
  const conn = d.getConnection()
  if (!conn) return
  // 進行中の stop / send が await 後に状態を上書きできないよう世代を進める。
  bumpVoiceGeneration()
  clearVoiceRecordingMaxTimer()
  if (store.voice.isRecording) {
    store.voice.isRecording = false
    if (currentVoiceAudioHandle) {
      try {
        await currentVoiceAudioHandle.release()
      } catch (err) {
        d.log(`voice-command stopAudio失敗: ${err instanceof Error ? err.message : String(err)}`)
      }
      currentVoiceAudioHandle = null
    }
  }
  // Phase 2: streaming session は startVoiceCommandRecording の deepgram-stream
  // ブランチで開かれているので、 念のためここでも release。
  if (currentVoiceSttSession) {
    try { await currentVoiceSttSession.cancel() } catch { /* ignore */ }
    currentVoiceSttSession = null
  }
  store.voice.audioChunks = []
  store.voice.audioTotalBytes = 0
  store.voice.finalText = ''
  store.voice.stableText = ''
  store.voice.partialText = ''
  store.voice.stableSeq = 0
  store.voice.partialSeq = 0
  store.voice.preFinalText = ''
  d.log(`voice-command: キャンセル reason=${reason}`)
  await returnToIdleFromVoiceCommand(reason)
}

export async function returnToIdleFromVoiceCommand(reason: string): Promise<void> {
  const d = need()
  const conn = d.getConnection()
  if (!conn) return
  clearVoiceDoneTimer()
  store.notif.screen = 'idle'
  await d.glassesUI.showIdleLauncher(conn, { dimMode: d.appConfig.notificationIdleDimMode })
  d.updateNotifInfo()
  d.log(`voice-command → idle (${reason})`)
}

export function scheduleVoiceCommandDoneReturn(): void {
  clearVoiceDoneTimer()
  store.voice.doneTimer = setTimeout(() => {
    store.voice.doneTimer = null
    void returnToIdleFromVoiceCommand('done-timeout')
  }, VOICE_COMMAND_DONE_AUTO_RETURN_MS)
}

export async function sendVoiceCommandAndShowResult(): Promise<void> {
  const d = need()
  const conn = d.getConnection()
  if (!conn) return
  const text = store.voice.finalText
  if (!text) {
    await returnToIdleFromVoiceCommand('empty-text-send')
    return
  }
  // entry 時に世代をキャプチャ。store.voice.sendCancelled も併用するが、こちらは
  // 全キャンセル経路（cancel/start 再起動）を網羅する一般化されたガード。
  const gen = store.voice.generation
  // 新規送信開始時にキャンセルフラグをリセット
  store.voice.sendCancelled = false
  // Phase 2: 送信開始 → late-final が届いてもテキストを差し替えない。
  store.voice.sendOrCancelInProgress = true
  // late-final 用の (updated) バッジ復元タイマーをキャンセル
  if (store.voice.lateFinalUpdatedTimer) {
    clearTimeout(store.voice.lateFinalUpdatedTimer)
    store.voice.lateFinalUpdatedTimer = null
  }
  store.notif.screen = 'voice-command-sending'
  await d.glassesUI.showVoiceCommandSending(conn)
  if (store.voice.generation !== gen) {
    d.log('voice-command: send result discarded (cancelled) stage=sending-render')
    return
  }
  d.updateNotifInfo()

  let ok = false
  try {
    const res = await d.notifClient.sendCommand({ source: 'g2_voice', text })
    ok = !!res?.ok
    d.log(`voice-command 送信完了: ok=${ok} delivered_at=${res?.delivered_at ?? '-'} relay=${res?.relay ?? '-'}`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    d.log(`voice-command 送信失敗: ${msg}`)
    ok = false
  }

  // await 中にユーザーが double-tap で強制 idle 復帰していたら結果画面をスキップ
  if (
    store.voice.generation !== gen ||
    store.notif.screen !== 'voice-command-sending' ||
    store.voice.sendCancelled
  ) {
    d.log('voice-command: send result discarded (user cancelled)')
    return
  }

  store.notif.screen = 'voice-command-done'
  await d.glassesUI.showVoiceCommandDone(conn, ok)
  if (store.voice.generation !== gen) {
    d.log('voice-command: done render後 gen mismatch → 自動復帰スキップ')
    return
  }
  d.updateNotifInfo()
  scheduleVoiceCommandDoneReturn()
}
