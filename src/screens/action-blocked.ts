/**
 * Phase 5: Action Blocked screen handler.
 *
 * Shown when the Hub already hard-denied a permission request. The agent
 * has already received a deny response — this screen is purely for the
 * user's awareness. Swipe Down acknowledges via POST
 * /api/v1/permissions/:id/ack-blocked; 60s auto-acks. Any other gesture is
 * a no-op (no approval lifecycle to re-decide).
 *
 * `notification.metadata.request_id` is the canonical id for the ack
 * endpoint; if missing, we fall back to the notification id so older blocked
 * notifications without request_id still ack.
 */

import type { ScreenContext } from './types'
import type { NormalizedG2Event } from '../even-events'
import { G2_EVENT } from '../even-events'

const BLOCKED_AUTO_ACK_MS = 60_000

export function clearBlockedAutoAckTimer(ctx: ScreenContext): void {
  if (ctx.store.notif.blocked.timer) {
    clearTimeout(ctx.store.notif.blocked.timer)
    ctx.store.notif.blocked.timer = null
  }
}

async function ackAndReturnToList(ctx: ScreenContext, reason: string): Promise<void> {
  const { store, glassesUI, log, notifClient } = ctx
  const liveConn = ctx.getConnection()
  clearBlockedAutoAckTimer(ctx)
  const item = store.notif.detailItem
  if (item) {
    const requestId = (item.metadata as { request_id?: string } | undefined)?.request_id || item.id
    try {
      await notifClient.ackBlocked(requestId, { source: 'g2' })
      log(`action-blocked: ack送信 reason=${reason} request_id=${requestId}`)
    } catch (err) {
      log(`action-blocked: ack送信失敗 reason=${reason}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  store.notif.blocked = { targetItemId: null, timer: null }
  store.notif.screen = 'list'
  store.notif.detailItem = null
  store.notif.selectedIndex = 0
  if (liveConn) {
    try {
      store.notif.items = await notifClient.list(20)
    } catch { /* keep cached */ }
    await glassesUI.showNotificationList(liveConn, store.notif.items)
  }
  ctx.updateNotifInfo()
}

export async function handle(event: NormalizedG2Event, ctx: ScreenContext): Promise<void> {
  const { store, log } = ctx
  const item = store.notif.detailItem
  if (!item) return

  const eventType = event.eventType

  // Swipe down (eventType=1, SCROLL_TOP) ack's the blocked notification.
  if (eventType === G2_EVENT.SCROLL_TOP) {
    log('action-blocked: swipe-down で確認')
    await ackAndReturnToList(ctx, 'swipe-down')
    return
  }

  // Any other gesture is intentionally a no-op (this screen is informational;
  // the agent has already received a deny).
}

/**
 * Schedule the 60s auto-ack timer. Called from the controller that opens
 * the action-blocked screen so the timer is set right after the render.
 */
export function scheduleBlockedAutoAck(ctx: ScreenContext): void {
  clearBlockedAutoAckTimer(ctx)
  ctx.store.notif.blocked.timer = setTimeout(() => {
    ctx.store.notif.blocked.timer = null
    void ackAndReturnToList(ctx, 'auto-timeout')
  }, BLOCKED_AUTO_ACK_MS)
}
