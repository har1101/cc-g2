/**
 * reply-recording screen handler (Phase 1.5c, extended in Phase 5).
 *
 * - double tap → 録音停止 → STT → reply-confirm 遷移
 *   STT 失敗時は permission timeout 残り時間で分岐:
 *     >5s 残あり → permission-actions に戻して retry 余地を残す
 *     ≤5s 残あり → plain deny にフォールバック
 * - swipe (scroll) → キャンセル → 前画面
 *
 * Phase 5 §5.5 で追加された watchdog:
 *   - 30s 録音上限 → 強制 finalize (forceFinalizeReplyAsMaxTimeout)
 *   - permission timeout 残り 3s → 強制 deny (forceFinalizeReplyAsDeny)
 *
 * STT 呼び出しは 1.5c から SttEngine 経由 (`ctx.sttEngine.start → push → finalize`)。
 */

import type { ScreenContext } from './types'
import type { NormalizedG2Event } from '../even-events'
import { G2_EVENT, isDoubleTapEventType } from '../even-events'
import { isAskUserQuestionNotification, permissionTimeoutRemainingMs } from './_helpers'
import { REPLY_STT_RETRY_THRESHOLD_MS } from './_constants'
import { clearReplyRecordingTimers } from '../state/store'

async function returnToPrePreviousScreen(ctx: ScreenContext): Promise<void> {
  const { store, conn, glassesUI } = ctx
  if (
    store.notif.detailItem &&
    isAskUserQuestionNotification(store.notif.detailItem) &&
    store.notif.askQuestions.length > 0
  ) {
    store.notif.screen = 'ask-question'
    const q = store.notif.askQuestions[store.notif.askQuestionIndex]
    await glassesUI.showAskUserQuestion(conn, q, store.notif.askQuestionIndex, store.notif.askQuestions.length)
  } else {
    store.notif.screen = 'detail-actions'
    if (store.notif.detailItem) {
      await glassesUI.showNotificationActions(conn, store.notif.detailItem)
    }
  }
}

/**
 * Phase 5 §5.5: force-finalize the recording into a plain deny reply.
 * Used by:
 *   - permission-timeout coordination watchdog (3s before timeout)
 *   - STT error path when remaining time ≤ 5s (no point in retry)
 *
 * The audio buffer is discarded; we send `action='deny'` directly. Returns
 * to the notification list once the reply lands.
 */
export async function forceFinalizeReplyAsDeny(
  ctx: ScreenContext,
  reason: string,
): Promise<void> {
  const { store, glassesUI, notifClient, log } = ctx
  if (store.reply.stopInFlight) return
  store.reply.stopInFlight = true
  clearReplyRecordingTimers()
  await ctx.stopReplyAudioRecording()
  const liveConn = ctx.getConnection()
  const item = store.notif.detailItem
  log(`返信録音 → 強制 deny: reason=${reason} notificationId=${item?.id ?? 'none'}`)
  if (!item) {
    store.reply.stopInFlight = false
    return
  }
  store.notif.screen = 'reply-sending'
  ctx.updateNotifInfo()
  try {
    await notifClient.reply(item.id, { action: 'deny', source: 'g2' })
    if (liveConn) await glassesUI.showReplyResult(liveConn, true, `Deny (${reason})`)
  } catch (err) {
    if (liveConn) {
      await glassesUI.showReplyResult(liveConn, false, err instanceof Error ? err.message : String(err))
    }
  }
  setTimeout(() => ctx.returnToListFromResult(), 3000)
  store.reply.stopInFlight = false
}

/**
 * Phase 5 §5.5: 30s recording-max watchdog. If the user is still recording
 * we attempt a normal finalize (so a long but coherent comment still gets
 * STT'd). If audio is empty we fall back to plain deny.
 */
export async function forceFinalizeReplyAsMaxTimeout(
  ctx: ScreenContext,
): Promise<void> {
  const { store, log } = ctx
  log('返信録音: 30s 上限 → 強制 finalize')
  // Cleanest: emulate a double-tap finalize by calling the same pipeline.
  await runStopAndFinalize(ctx, 'recording-max-timeout')
}

async function runStopAndFinalize(
  ctx: ScreenContext,
  reason: string,
): Promise<void> {
  const { store, conn, glassesUI, sttEngineForReply, log } = ctx
  if (store.reply.stopInFlight) {
    log(`返信録音: stop 重複 reason=${reason}`)
    return
  }
  store.reply.stopInFlight = true
  clearReplyRecordingTimers()
  await ctx.stopReplyAudioRecording()
  await glassesUI.showReplySttProcessing(conn)

  if (store.reply.audioTotalBytes === 0) {
    log(`返信録音: 音声データなし reason=${reason}`)
    if (permissionTimeoutRemainingMs() <= REPLY_STT_RETRY_THRESHOLD_MS) {
      // Not enough time for retry → plain deny.
      store.reply.stopInFlight = false
      await forceFinalizeReplyAsDeny(ctx, 'empty-audio-low-budget')
      return
    }
    await returnToPrePreviousScreen(ctx)
    ctx.updateNotifInfo()
    store.reply.stopInFlight = false
    return
  }

  try {
    const session = await sttEngineForReply.start({
      voiceSessionId: `reply-${store.notif.detailItem?.id ?? 'unknown'}-${Date.now()}`,
      lang: 'ja',
    })
    for (const chunk of store.reply.audioChunks) {
      await session.pushPcm(chunk)
    }
    const stt = await session.finalize()
    const text = stt.text || ''
    log(`返信STT完了: provider=${stt.provider} text="${text}" reason=${reason}`)

    if (!text) {
      log('返信STT: テキスト空 → 前画面に戻る')
      if (permissionTimeoutRemainingMs() <= REPLY_STT_RETRY_THRESHOLD_MS) {
        store.reply.stopInFlight = false
        await forceFinalizeReplyAsDeny(ctx, 'empty-stt-low-budget')
        return
      }
      await returnToPrePreviousScreen(ctx)
      ctx.updateNotifInfo()
      store.reply.stopInFlight = false
      return
    }

    store.notif.replyText = text
    store.notif.screen = 'reply-confirm'
    await glassesUI.showReplyConfirm(conn, text)
    ctx.updateNotifInfo()
    store.reply.stopInFlight = false
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log(`返信STT失敗 reason=${reason}: ${msg}`)
    // Phase 5 §5.5: branch on permission timeout budget.
    const remaining = permissionTimeoutRemainingMs()
    if (remaining <= REPLY_STT_RETRY_THRESHOLD_MS) {
      log(`返信STT失敗: 残り ${remaining}ms — 強制 deny にフォールバック`)
      store.reply.stopInFlight = false
      await forceFinalizeReplyAsDeny(ctx, 'stt-error-low-budget')
      return
    }
    log(`返信STT失敗: 残り ${remaining}ms — permission-actions に戻して retry 可能に`)
    await glassesUI.showReplyResult(conn, false, msg)
    setTimeout(async () => {
      const liveConn = ctx.getConnection()
      if (store.notif.detailItem && liveConn) {
        await returnToPrePreviousScreen({ ...ctx, conn: liveConn })
      }
      ctx.updateNotifInfo()
      store.reply.stopInFlight = false
    }, 3000)
  }
}

export async function handle(event: NormalizedG2Event, ctx: ScreenContext): Promise<void> {
  // Phase 2: permission コメント (返信) パスは常に groq-batch を使う。
  // streaming engine は voice-command 専用 (短文には latency 旨味が薄いため)。
  const { store, log } = ctx
  const eventType = event.eventType

  // 録音中画面:
  // - 単タップ相当は sysEvent {} とノイズが区別できないため使わない
  // - DOUBLE_CLICK を確実な停止入力として扱う
  if (isDoubleTapEventType(eventType)) {
    if (!store.reply.isRecording || store.reply.stopInFlight) {
      log('返信録音: 重複停止イベントを無視')
      return
    }
    log('返信録音: 停止 → STT処理開始')
    await runStopAndFinalize(ctx, 'user-doubletap')
    return
  }

  // スクロール入力はキャンセル → 前画面に戻る
  if (eventType === G2_EVENT.SCROLL_TOP || eventType === G2_EVENT.SCROLL_BOTTOM) {
    log('返信録音: キャンセル → 前画面に戻る')
    clearReplyRecordingTimers()
    await ctx.stopReplyAudioRecording()
    await returnToPrePreviousScreen(ctx)
    ctx.updateNotifInfo()
    store.reply.stopInFlight = false
    return
  }
}
