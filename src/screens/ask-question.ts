/**
 * AskUserQuestion screen handler (Phase 1.5c).
 *
 * 質問の選択肢を 1 問ずつ提示。 各画面で:
 * - double tap → list 復帰
 * - listEvent click index < optionCount → 回答記録、 次の質問 or 全回答送信
 * - index === optionCount → "その他（音声）" → reply-recording へ
 * - index === optionCount + 1 → ◀ 戻る (list へ)
 */

import type { ScreenContext } from './types'
import type { NormalizedG2Event } from '../even-events'
import { isDoubleTapEventType } from '../even-events'
import { getReplyResultMessage } from './_helpers'

export async function handle(event: NormalizedG2Event, ctx: ScreenContext): Promise<void> {
  const { store, conn, glassesUI, notifClient, log } = ctx
  if (!store.notif.detailItem) return
  const eventType = event.eventType

  if (isDoubleTapEventType(eventType)) {
    log('AskUserQuestion: double tap → リストに戻る')
    store.notif.screen = 'list'
    store.notif.detailItem = null
    store.notif.askQuestions = []
    store.notif.askQuestionIndex = 0
    store.notif.askAnswers = {}
    await glassesUI.showNotificationList(conn, store.notif.items)
    ctx.updateNotifInfo()
    return
  }

  if (event.source !== 'list') return
  if (event.containerName !== 'ask-q-lst') return
  const index = event.index ?? 0
  const currentQ = store.notif.askQuestions[store.notif.askQuestionIndex]
  if (!currentQ) return
  const optionCount = currentQ.options.length
  // optionCount+0: 「その他（音声）」, optionCount+1: 「◀ 戻る」

  if (index === optionCount + 1) {
    // ◀ 戻る
    log('AskUserQuestion: 戻る → リスト')
    store.notif.screen = 'list'
    store.notif.detailItem = null
    store.notif.askQuestions = []
    store.notif.askQuestionIndex = 0
    store.notif.askAnswers = {}
    await glassesUI.showNotificationList(conn, store.notif.items)
    ctx.updateNotifInfo()
    return
  }

  if (index === optionCount) {
    // その他（音声入力）→ 録音画面へ
    log('AskUserQuestion: その他（音声入力）')
    store.notif.screen = 'reply-recording'
    store.notif.replyText = ''
    await glassesUI.showReplyRecording(conn)
    if (conn.mode === 'bridge' && !glassesUI.hasRenderedPage(conn)) {
      await glassesUI.ensureBasePage(conn, 'マイク録音中...')
    }
    await ctx.startReplyAudioRecording()
    ctx.updateNotifInfo()
    return
  }

  if (index < optionCount) {
    // 選択肢を選んだ
    const selectedLabel = currentQ.options[index].label
    store.notif.askAnswers[currentQ.question] = selectedLabel
    log(`AskUserQuestion: 選択 "${selectedLabel}" for "${currentQ.question}"`)

    // 次の質問があるか？
    if (store.notif.askQuestionIndex < store.notif.askQuestions.length - 1) {
      store.notif.askQuestionIndex++
      const nextQ = store.notif.askQuestions[store.notif.askQuestionIndex]
      await glassesUI.showAskUserQuestion(conn, nextQ, store.notif.askQuestionIndex, store.notif.askQuestions.length)
      ctx.updateNotifInfo()
      return
    }

    // 全質問に回答完了 → Hub に送信
    log(`AskUserQuestion: 全質問回答完了 answers=${JSON.stringify(store.notif.askAnswers)}`)
    store.notif.screen = 'reply-sending'
    ctx.updateNotifInfo()
    try {
      const res = await notifClient.reply(store.notif.detailItem.id, {
        action: 'answer',
        answerData: store.notif.askAnswers,
        source: 'g2',
      })
      const result = getReplyResultMessage(res)
      log(`AskUserQuestion: 送信完了 status=${res.reply?.status || 'ok'}`)
      if (store.notif.screen === 'reply-sending') {
        if (result.ok) {
          await glassesUI.showReplyResult(conn, true, `回答: ${selectedLabel}`)
        } else {
          await glassesUI.showReplyResult(conn, false, result.message || 'error')
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log(`AskUserQuestion: 送信失敗 ${msg}`)
      if (store.notif.screen === 'reply-sending') {
        await glassesUI.showReplyResult(conn, false, msg)
      }
    }
    setTimeout(() => ctx.returnToListFromResult(), 3000)
    return
  }
}
