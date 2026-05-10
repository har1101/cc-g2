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
import type { SttEngine } from '../stt/engine'
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
  sttEngine: SttEngine
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

export async function startVoiceCommandRecording(): Promise<void> {
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
  store.voice.audioChunks = []
  store.voice.audioTotalBytes = 0
  store.voice.finalText = ''
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
