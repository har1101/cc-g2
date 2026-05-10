/**
 * reply-recording screen handler (Phase 1.5c).
 *
 * - double tap → 録音停止 → STT → reply-confirm 遷移
 *   STT 失敗時は 3 秒後に前画面 (ask-question / detail-actions) に復帰
 * - swipe (scroll) → キャンセル → 前画面
 *
 * STT 呼び出しは 1.5c から SttEngine 経由 (`ctx.sttEngine.start → push → finalize`)。
 * 旧 `transcribePcmChunks` を直接呼んでいた箇所はこの seam に集約された。
 */

import type { ScreenContext } from './types'
import type { NormalizedG2Event } from '../even-events'
import { G2_EVENT, isDoubleTapEventType } from '../even-events'
import { isAskUserQuestionNotification } from './_helpers'

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

export async function handle(event: NormalizedG2Event, ctx: ScreenContext): Promise<void> {
  const { store, conn, glassesUI, sttEngine, log } = ctx
  const eventType = event.eventType

  // 録音中画面:
  // - 単タップ相当は sysEvent {} とノイズが区別できないため使わない
  // - DOUBLE_CLICK を確実な停止入力として扱う
  if (isDoubleTapEventType(eventType)) {
    if (!store.reply.isRecording || store.reply.stopInFlight) {
      log('返信録音: 重複停止イベントを無視')
      return
    }
    store.reply.stopInFlight = true
    log('返信録音: 停止 → STT処理開始')
    await ctx.stopReplyAudioRecording()

    await glassesUI.showReplySttProcessing(conn)

    if (store.reply.audioTotalBytes === 0) {
      log('返信録音: 音声データなし → 前画面に戻る')
      await returnToPrePreviousScreen(ctx)
      ctx.updateNotifInfo()
      store.reply.stopInFlight = false
      return
    }

    try {
      // Phase 1.5c: SttEngine 経由。 batch engine では pushPcm はメモリ蓄積のみで、
      // 旧 transcribePcmChunks(chunks) と同じ処理が finalize() で走る。
      const session = await sttEngine.start({ voiceSessionId: `reply-${store.notif.detailItem?.id ?? 'unknown'}-${Date.now()}`, lang: 'ja' })
      for (const chunk of store.reply.audioChunks) {
        await session.pushPcm(chunk)
      }
      const stt = await session.finalize()
      const text = stt.text || ''
      log(`返信STT完了: provider=${stt.provider} text="${text}"`)

      if (!text) {
        log('返信STT: テキスト空 → 前画面に戻る')
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
      log(`返信STT失敗: ${msg}`)
      await glassesUI.showReplyResult(conn, false, msg)
      // 3秒後に前画面に戻る。 タイマー発火時点で再接続でハンドルが差し替わって
      // いる可能性があるので、 captured `ctx.conn` ではなく live accessor を使う。
      setTimeout(async () => {
        const liveConn = ctx.getConnection()
        if (store.notif.detailItem && liveConn) {
          // ctx を作り直す代わりに、 helper を使って prev-screen 復帰だけを再構成。
          await returnToPrePreviousScreen({ ...ctx, conn: liveConn })
        }
        ctx.updateNotifInfo()
        store.reply.stopInFlight = false
      }, 3000)
    }
    return
  }

  // スクロール入力はキャンセル → 前画面に戻る
  if (eventType === G2_EVENT.SCROLL_TOP || eventType === G2_EVENT.SCROLL_BOTTOM) {
    log('返信録音: キャンセル → 前画面に戻る')
    await ctx.stopReplyAudioRecording()
    await returnToPrePreviousScreen(ctx)
    ctx.updateNotifInfo()
    store.reply.stopInFlight = false
    return
  }
}
