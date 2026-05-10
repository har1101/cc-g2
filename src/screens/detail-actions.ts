/**
 * Phase 5: notification-actions screen handler with v3 input model.
 *
 * Input model (per design v4 §5.4 — Phase 5 breaking change):
 *   - swipe up   → allow / approve
 *                  if metadata.risk_tier=='destructive', transition to
 *                  permission-destructive-confirm (2-step gate)
 *                  else immediate approve.
 *   - swipe down → deny
 *   - double tap → back to detail
 *   - single tap → voice comment substate (existing comment recording path)
 *
 * Note on G2 swipe semantics: the firmware inverts physical-vs-event mapping,
 * so SCROLL_BOTTOM (eventType=2) is the *physical up* swipe (= approve), and
 * SCROLL_TOP (eventType=1) is the *physical down* swipe (= deny). This is
 * consistent with the existing `detail.ts` page-navigation logic (see comments
 * in that file).
 *
 * Pre-Phase-5 behavior — the 4-item list (`コメント / Approve / Deny / 戻る`)
 * is fully replaced. Tests that exercised the list-tap path are updated.
 */

import type { ScreenContext } from './types'
import type { NormalizedG2Event } from '../even-events'
import { G2_EVENT, isDoubleTapEventType, isTapEventType } from '../even-events'
import { armReplyRecordingTimers, getReplyResultMessage } from './_helpers'
import { forceFinalizeReplyAsDeny, forceFinalizeReplyAsMaxTimeout } from './reply-recording'

const DESTRUCTIVE_CONFIRM_TIMEOUT_MS = 30_000

function clearPermissionConfirmTimer(ctx: ScreenContext): void {
  if (ctx.store.notif.permissionConfirm.timer) {
    clearTimeout(ctx.store.notif.permissionConfirm.timer)
    ctx.store.notif.permissionConfirm.timer = null
  }
}

async function transitionToDestructiveConfirm(ctx: ScreenContext): Promise<void> {
  const { store, conn, glassesUI, log } = ctx
  const item = store.notif.detailItem
  if (!item) return
  store.notif.screen = 'permission-destructive-confirm'
  store.notif.permissionConfirm.stepCount = 1
  store.notif.permissionConfirm.risk_tier = 'destructive'
  store.notif.permissionConfirm.targetItemId = item.id
  clearPermissionConfirmTimer(ctx)
  store.notif.permissionConfirm.timer = setTimeout(() => {
    void cancelDestructiveConfirm(ctx, 'timeout')
  }, DESTRUCTIVE_CONFIRM_TIMEOUT_MS)
  await glassesUI.showPermissionDestructiveConfirm(conn, item)
  log(`destructive 1段目: confirm画面に遷移 notificationId=${item.id}`)
  ctx.updateNotifInfo()
}

async function cancelDestructiveConfirm(ctx: ScreenContext, reason: string): Promise<void> {
  const { store, glassesUI, log } = ctx
  const liveConn = ctx.getConnection()
  if (!liveConn) return
  clearPermissionConfirmTimer(ctx)
  store.notif.permissionConfirm = { stepCount: 0, risk_tier: null, targetItemId: null, timer: null }
  if (store.notif.detailItem) {
    store.notif.screen = 'detail-actions'
    await glassesUI.showNotificationActions(liveConn, store.notif.detailItem)
  }
  log(`destructive confirm: キャンセル reason=${reason}`)
  ctx.updateNotifInfo()
}

async function sendApprovalReply(
  ctx: ScreenContext,
  action: 'approve' | 'deny',
  options: { twoStepConfirmed?: boolean } = {},
): Promise<void> {
  const { store, conn, glassesUI, notifClient, log } = ctx
  const item = store.notif.detailItem
  if (!item) return
  log(`通知アクション送信: ${action} notificationId=${item.id} two_step_confirmed=${options.twoStepConfirmed === true}`)
  store.notif.screen = 'reply-sending'
  ctx.updateNotifInfo()
  try {
    const replyBody: Parameters<typeof notifClient.reply>[1] = {
      action,
      source: 'g2',
    }
    if (options.twoStepConfirmed === true) {
      // The notifications client only forwards documented fields; we extend
      // by passing through. Cast through `unknown` to keep the type narrow.
      ;(replyBody as { two_step_confirmed?: boolean }).two_step_confirmed = true
    }
    const res = await notifClient.reply(item.id, replyBody)
    const status = res.reply?.status || 'ok'
    const result = getReplyResultMessage(res)
    log(`通知アクション送信完了: action=${action} status=${status}`)
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
}

export async function handle(event: NormalizedG2Event, ctx: ScreenContext): Promise<void> {
  const { store, conn, glassesUI, log } = ctx
  const item = store.notif.detailItem
  if (!item) return

  const eventType = event.eventType

  // Double tap → back to detail (replaces "戻る" list item).
  if (isDoubleTapEventType(eventType)) {
    log('通知アクション: 詳細に戻る')
    store.notif.screen = 'detail'
    store.notif.detailPageIndex = 0
    const pages = glassesUI.getDetailPageCount(item.fullText)
    await glassesUI.showNotificationDetail(
      conn,
      item,
      0,
      pages,
      ctx.getContextPctForNotification(item),
    )
    ctx.updateNotifInfo()
    return
  }

  // Swipe up (= SCROLL_BOTTOM, eventType=2): approve. Destructive → 2-step.
  if (eventType === G2_EVENT.SCROLL_BOTTOM) {
    const riskTier = (item.metadata as { risk_tier?: string } | undefined)?.risk_tier
    if (riskTier === 'destructive') {
      await transitionToDestructiveConfirm(ctx)
      return
    }
    await sendApprovalReply(ctx, 'approve')
    return
  }

  // Swipe down (= SCROLL_TOP, eventType=1): deny.
  if (eventType === G2_EVENT.SCROLL_TOP) {
    await sendApprovalReply(ctx, 'deny')
    return
  }

  // Single tap: voice comment substate (existing reply-recording path).
  if (isTapEventType(eventType) || eventType === undefined) {
    log('通知アクション: コメント（録音開始）')
    store.notif.screen = 'reply-recording'
    store.notif.replyText = ''
    await glassesUI.showReplyRecording(conn)
    if (conn.mode === 'bridge' && !glassesUI.hasRenderedPage(conn)) {
      await glassesUI.ensureBasePage(conn, 'マイク録音中...')
    }
    await ctx.startReplyAudioRecording()
    // Phase 5 §5.5: arm watchdog timers — 30s max, plus permission-timeout
    // coordination if metadata.timeout_at is set on the notification.
    armReplyRecordingTimers(
      () => { void forceFinalizeReplyAsMaxTimeout(ctx) },
      () => { void forceFinalizeReplyAsDeny(ctx, 'permission-timeout-imminent') },
    )
    ctx.updateNotifInfo()
    return
  }
}

/**
 * Phase 5: handler for the destructive 2-step confirm screen.
 *
 * - swipe up (SCROLL_BOTTOM) again → approve with two_step_confirmed=true
 * - any other input (swipe down, tap, double tap) → cancel back to actions
 * - 30s timeout (set in transitionToDestructiveConfirm) → auto-cancel
 */
export async function handleDestructiveConfirm(
  event: NormalizedG2Event,
  ctx: ScreenContext,
): Promise<void> {
  const { store, log } = ctx
  if (!store.notif.detailItem) return
  if (store.notif.detailItem.id !== store.notif.permissionConfirm.targetItemId) {
    // sanity guard — confirm targets a different item than the current detail.
    log('destructive confirm: target mismatch → cancel')
    await cancelDestructiveConfirm(ctx, 'target-mismatch')
    return
  }

  const eventType = event.eventType

  if (eventType === G2_EVENT.SCROLL_BOTTOM) {
    // 2-step satisfied — approve with two_step_confirmed=true.
    log('destructive 2段目: 承認確定')
    clearPermissionConfirmTimer(ctx)
    store.notif.permissionConfirm = { stepCount: 0, risk_tier: null, targetItemId: null, timer: null }
    await sendApprovalReply(ctx, 'approve', { twoStepConfirmed: true })
    return
  }

  // Any other gesture cancels.
  await cancelDestructiveConfirm(ctx, `gesture:${eventType}`)
}
