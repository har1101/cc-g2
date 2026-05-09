/**
 * Notification detail screen handler (Phase 1.5c).
 *
 * - スクロールでページ送り。 page 0 で更に scroll-top → list に戻る、
 *   最終ページで scroll-bottom → detail-actions (replyCapable のみ)
 * - double tap → list に戻る
 *
 * Behavior は旧 main.ts と完全同等。
 */

import type { ScreenContext } from './types'
import type { NormalizedG2Event } from '../even-events'
import { G2_EVENT, isDoubleTapEventType } from '../even-events'

export async function handle(event: NormalizedG2Event, ctx: ScreenContext): Promise<void> {
  const { store, conn, glassesUI, log } = ctx
  if (!store.notif.detailItem) return
  // ghostリストコンテナからのイベントを無視（detail画面ではtextEventとsysEventのみ有効）
  if (event.source === 'list') return

  const eventType = event.eventType
  // detailPages は showNotificationDetail() で都度算出される（ここでは長さのみ参照）
  const pageCount = store.notif.detailPages.length

  if (isDoubleTapEventType(eventType)) {
    log('通知詳細: double tap → リストに戻る')
    store.notif.screen = 'list'
    store.notif.detailItem = null
    store.notif.selectedIndex = 0
    await glassesUI.showNotificationList(conn, store.notif.items)
    ctx.updateNotifInfo()
    return
  }
  if (ctx.shouldIgnoreDetailScroll(eventType)) return

  // 一覧画面と同じく、実機の逆方向スクロール挙動をそのまま許容する。
  // eventType=1 (物理下) → 前ページ / 最初のページで更に戻る → リストに戻る
  // eventType=2 (物理上) → 次ページ / 最終ページで更に進む → アクションメニュー
  if (eventType === G2_EVENT.SCROLL_TOP) {
    if (store.notif.detailPageIndex > 0) {
      store.notif.detailPageIndex--
      await glassesUI.showNotificationDetail(
        conn,
        store.notif.detailItem,
        store.notif.detailPageIndex,
        pageCount,
        ctx.getContextPctForNotification(store.notif.detailItem),
      )
      // 描画完了後にスクロールイベントのみクリア＋クールダウン更新（誤発火を防止）
      ctx.clearPendingScrollEvent()
      store.eventQueue.lastDetailScrollAt = Date.now()
    } else {
      log('通知詳細: 最初のページ → リストに戻る')
      store.notif.screen = 'list'
      store.notif.detailItem = null
      store.notif.selectedIndex = 0
      await glassesUI.showNotificationList(conn, store.notif.items)
    }
    ctx.updateNotifInfo()
    return
  }

  // eventType=2 → 次ページ / 最終ページで更に進む → アクションメニュー
  if (eventType === G2_EVENT.SCROLL_BOTTOM) {
    if (store.notif.detailPageIndex < pageCount - 1) {
      store.notif.detailPageIndex++
      await glassesUI.showNotificationDetail(
        conn,
        store.notif.detailItem,
        store.notif.detailPageIndex,
        pageCount,
        ctx.getContextPctForNotification(store.notif.detailItem),
      )
      // 描画完了後にスクロールイベントのみクリア＋クールダウン更新（誤発火を防止）
      ctx.clearPendingScrollEvent()
      store.eventQueue.lastDetailScrollAt = Date.now()
    } else if (store.notif.detailItem.replyCapable) {
      log('通知詳細: 最終ページ → アクションメニュー')
      store.notif.screen = 'detail-actions'
      await glassesUI.showNotificationActions(conn, store.notif.detailItem)
    }
    ctx.updateNotifInfo()
    return
  }
}
