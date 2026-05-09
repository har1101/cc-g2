/**
 * Notification list screen handler (Phase 1.5c).
 *
 * - double tap → idle 復帰
 * - listEvent click → detail 取得 → AskUserQuestion なら ask-question、 通常なら detail
 */

import type { ScreenContext } from './types'
import type { NormalizedG2Event } from '../even-events'
import { isDoubleTapEventType } from '../even-events'
import { extractAskQuestions } from './_helpers'

export async function handle(event: NormalizedG2Event, ctx: ScreenContext): Promise<void> {
  const { store, conn, glassesUI, notifClient, log } = ctx
  const eventType = event.eventType

  if (isDoubleTapEventType(eventType)) {
    await ctx.enterIdleScreen('通知一覧を閉じて待機に戻る (double tap)')
    return
  }

  // SDK標準ListContainer: listEventからクリック選択を取得
  // ※実機ではスクロール方向が物理操作と逆（ファームウェア仕様、許容）
  if (event.source === 'list') {
    if (event.containerName !== 'notif-list') return
    const maybeIndex = typeof event.index === 'number'
      ? event.index
      : store.notif.selectedIndex
    if (typeof maybeIndex !== 'number') {
      log('通知一覧: index未同梱イベントのため無視')
      return
    }
    const index = maybeIndex
    store.notif.selectedIndex = index
    const item = store.notif.items[index]
    if (!item) return
    log(`通知選択: "${item.title}" (index=${store.notif.selectedIndex})`)
    try {
      const detail = await notifClient.detail(item.id)
      store.notif.detailItem = detail

      // AskUserQuestion: 詳細画面をスキップして選択肢画面へ直接遷移
      if (ctx.isAskUserQuestionNotification(detail)) {
        const questions = extractAskQuestions(detail)
        if (questions.length > 0) {
          store.notif.askQuestions = questions
          store.notif.askQuestionIndex = 0
          store.notif.askAnswers = {}
          store.notif.screen = 'ask-question'
          await glassesUI.showAskUserQuestion(conn, questions[0], 0, questions.length)
          ctx.clearPendingScrollEvent()
          ctx.updateNotifInfo()
          return
        }
      }

      const pageCount = glassesUI.getDetailPageCount(detail.fullText)
      store.notif.detailPages = Array.from({ length: pageCount }, (_, i) => String(i))
      store.notif.detailPageIndex = 0
      store.notif.screen = 'detail'
      await glassesUI.showNotificationDetail(conn, detail, 0, pageCount, ctx.getContextPctForNotification(detail))
      // 描画中（createStartUpフォールバックで数秒かかる）にキューされたスクロールイベントを破棄
      // tap/doubleTap等の非スクロールイベントは保持する
      ctx.clearPendingScrollEvent()
      store.eventQueue.lastDetailScrollAt = Date.now()
      ctx.updateNotifInfo()
    } catch (err) {
      log(`通知詳細取得失敗: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}
