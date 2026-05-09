/**
 * reply-confirm screen handler (Phase 1.5c).
 *
 * - index 0: 送信 → reply-sending → 結果 → list (3s 後)
 * - index 1: 再録 → reply-recording (audio 再開)
 * - index 2 / 3: キャンセル / 戻る → ask-question or detail-actions
 *
 * AskUserQuestion 通知の場合は action='answer' で送る (回答 map に
 * 現質問への文字列を埋め込む)。
 */

import type { ScreenContext } from './types'
import type { NormalizedG2Event } from '../even-events'
import { isAskUserQuestionNotification, getReplyResultMessage } from './_helpers'

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
  const { store, conn, glassesUI, notifClient, log } = ctx
  if (event.source !== 'list') return
  const index = event.index ?? 0

  if (index === 0) {
    // 送信
    if (!store.notif.detailItem || !store.notif.replyText) return
    log(`返信送信: notificationId=${store.notif.detailItem.id}`)
    store.notif.screen = 'reply-sending'
    try {
      // AskUserQuestion の「その他（音声）」経由の場合は answer として送信
      const isAskQ = isAskUserQuestionNotification(store.notif.detailItem)
      const replyReq = isAskQ
        ? {
            action: 'answer' as const,
            answerData: {
              ...store.notif.askAnswers,
              [store.notif.askQuestions[store.notif.askQuestionIndex]?.question ?? '']: store.notif.replyText,
            },
            source: 'g2' as const,
          }
        : {
            action: 'comment' as const,
            comment: store.notif.replyText,
            source: 'g2' as const,
          }
      const res = await notifClient.reply(store.notif.detailItem.id, replyReq)
      const status = res.reply?.status || 'ok'
      const result = getReplyResultMessage(res)
      log(`返信送信完了: status=${status}`)
      // await 中にユーザー操作でリストに戻っていたら結果画面をスキップ
      if (store.notif.screen === 'reply-sending') {
        if (result.ok) {
          await glassesUI.showReplyResult(conn, true)
        } else {
          await glassesUI.showReplyResult(conn, false, result.message || status)
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log(`返信送信失敗: ${msg}`)
      if (store.notif.screen === 'reply-sending') {
        await glassesUI.showReplyResult(conn, false, msg)
      }
    }
    // 3秒後に一覧に戻る（ユーザー操作で先に戻った場合はスキップ）
    setTimeout(() => ctx.returnToListFromResult(), 3000)
    return
  }

  if (index === 1) {
    // 再録
    log('返信確認: 再録')
    store.notif.screen = 'reply-recording'
    store.notif.replyText = ''
    await glassesUI.showReplyRecording(conn)
    await ctx.startReplyAudioRecording()
    ctx.updateNotifInfo()
    return
  }

  if (index === 2 || index === 3) {
    // キャンセル / ◀ 戻る → 前画面に戻る
    log(`返信確認: ${index === 2 ? 'キャンセル' : '戻る'} → 前画面に戻る`)
    store.notif.replyText = ''
    await returnToPrePreviousScreen(ctx)
    ctx.updateNotifInfo()
    return
  }
}
