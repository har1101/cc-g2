/**
 * Detail-actions (approve / deny / comment / back) screen handler (Phase 1.5c).
 *
 * 旧 main.ts の `notifState.screen === 'detail-actions'` ブロックを移植。
 * - index 0: コメント (reply-recording へ)
 * - index 1: Approve / index 2: Deny → reply-sending → 結果 → list (3s 後)
 * - index 3: ◀ 戻る (list へ)
 */

import type { ScreenContext } from './types'
import type { NormalizedG2Event } from '../even-events'
import { getReplyResultMessage } from './_helpers'

export async function handle(event: NormalizedG2Event, ctx: ScreenContext): Promise<void> {
  const { store, conn, glassesUI, notifClient, log } = ctx
  if (!store.notif.detailItem) return

  // SDK標準ListContainer: listEventからクリック選択を取得
  if (event.source !== 'list') return

  const index = event.index ?? 0

  // ◀ 戻る (index=3)
  if (index === 3) {
    log('通知アクション: 一覧に戻る')
    store.notif.screen = 'list'
    store.notif.detailItem = null
    store.notif.selectedIndex = 0
    await glassesUI.showNotificationList(conn, store.notif.items)
    ctx.updateNotifInfo()
    return
  }

  if (index === 1 || index === 2) {
    // Approve(1) or Deny(2)
    const action = index === 1 ? 'approve' : 'deny'
    log(`通知アクション送信: ${action} notificationId=${store.notif.detailItem.id}`)
    store.notif.screen = 'reply-sending'
    ctx.updateNotifInfo()
    try {
      const res = await notifClient.reply(store.notif.detailItem.id, {
        action,
        source: 'g2',
      })
      const status = res.reply?.status || 'ok'
      const result = getReplyResultMessage(res)
      log(`通知アクション送信完了: action=${action} status=${status}`)
      // await 中にユーザー操作でリストに戻っていたら結果画面をスキップ
      if (store.notif.screen === 'reply-sending') {
        if (result.ok) {
          await glassesUI.showReplyResult(conn, true, action === 'approve' ? 'Approve' : 'Deny')
        } else {
          await glassesUI.showReplyResult(conn, false, result.message || status)
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log(`通知アクション送信失敗: action=${action} ${msg}`)
      if (store.notif.screen === 'reply-sending') {
        await glassesUI.showReplyResult(conn, false, msg)
      }
    }
    setTimeout(() => ctx.returnToListFromResult(), 3000)
    return
  }

  if (index === 0) {
    // コメント
    log('通知アクション: コメント（録音開始）')
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
}
