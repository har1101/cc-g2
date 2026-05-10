/**
 * Phase 3: SessionList screen handler.
 *
 * Layout (drawn by glasses-ui.showSessionList):
 *   - line 0 sentinel: "↓ Pull to create new"
 *   - line 1..N: existing AgentSessions
 *
 * Interactions:
 *   - Swipe up / down → cycle selectedIndex (0..N)
 *   - Single tap on sentinel (selectedIndex === 0) → open create-confirm
 *   - Single tap on a session (selectedIndex > 0) → activate + return to idle
 *   - Double tap → return to idle
 *
 * The "pull-down" gesture from the design doc is mapped here as: while at
 * the sentinel (selectedIndex === 0), receiving a SCROLL_BOTTOM (= swipe
 * down past the top) opens the create-confirm overlay too. SCROLL_TOP is
 * treated as a normal selection up.
 */

import type { ScreenContext } from './types'
import type { NormalizedG2Event } from '../even-events'
import { G2_EVENT, isDoubleTapEventType } from '../even-events'
import { CREATE_CONFIRM_AUTO_CANCEL_MS } from './_constants'
import { setActiveSessionId, setPendingCountsByOtherSession } from '../state/store'

export async function handle(event: NormalizedG2Event, ctx: ScreenContext): Promise<void> {
  const { store, conn, glassesUI, notifClient, log } = ctx
  const eventType = event.eventType

  if (isDoubleTapEventType(eventType)) {
    log('SessionList: double tap → idle')
    await ctx.enterIdleScreen('SessionList close (double tap)')
    return
  }

  // Scroll handling: treat SCROLL_BOTTOM at sentinel as the "pull down" gesture
  // that opens the create-confirm screen, otherwise just walk the selection.
  if (event.kind === 'scrollTop' || event.kind === 'scrollBottom') {
    const len = store.sessionList.sessions.length + 1 // +1 for sentinel
    if (event.kind === 'scrollTop') {
      store.sessionList.selectedIndex = Math.max(0, store.sessionList.selectedIndex - 1)
    } else {
      // scrollBottom on sentinel → open create-confirm
      if (store.sessionList.selectedIndex === 0) {
        await openCreateConfirm(ctx)
        return
      }
      store.sessionList.selectedIndex = Math.min(len - 1, store.sessionList.selectedIndex + 1)
    }
    await glassesUI.showSessionList(conn, store.sessionList.sessions, store.sessionList.selectedIndex, {
      activeSessionId: store.sessionUi.activeSessionId,
      pendingCounts: store.sessionUi.pendingCountsByOtherSession,
    })
    ctx.updateNotifInfo()
    return
  }

  // List click — listEvent.currentSelectItemIndex points at the item the user
  // tapped. 0 = sentinel, 1..N = sessions[selectedIndex - 1].
  if (event.source === 'list' && event.containerName === 'sl-list') {
    const idx = typeof event.index === 'number' ? event.index : store.sessionList.selectedIndex
    store.sessionList.selectedIndex = idx
    if (idx === 0) {
      await openCreateConfirm(ctx)
      return
    }
    const target = store.sessionList.sessions[idx - 1]
    if (!target) return
    log(`SessionList: activate session id=${target.session_id} label=${target.label}`)
    let activated = false
    try {
      await notifClient.activateSession(target.session_id)
      activated = true
      // Phase 4: optimistically reflect the new active id so the pending-count
      // polling cycle doesn't render the previous active session for one tick.
      setActiveSessionId(target.session_id)
      // Re-poll the active-summary so badges drop the now-active row's pending
      // count and pick up any approvals that arrived during the activate
      // round trip. Best-effort; failures stay in the audit log only.
      try {
        const summary = await notifClient.fetchActiveSummary()
        setActiveSessionId(summary.activeSessionId)
        setPendingCountsByOtherSession(summary.pendingCountsByOtherSession)
      } catch (err) {
        log(`SessionList: active-summary refresh失敗: ${err instanceof Error ? err.message : String(err)}`)
      }
      // Re-poll notifications scoped to the freshly-active session so the
      // user lands on the most relevant view when they exit SessionList.
      try {
        store.notif.items = await notifClient.list({ sessionId: target.session_id, limit: 20 })
      } catch (err) {
        log(`SessionList: per-session notifications refresh失敗: ${err instanceof Error ? err.message : String(err)}`)
      }
    } catch (err) {
      log(`SessionList: activate失敗: ${err instanceof Error ? err.message : String(err)}`)
    }
    // Codex 4 #6/#8: distinguish success vs failure exit reason so upstream
    // tracing isn't misled by a hard-coded "activated session" string.
    await ctx.enterIdleScreen(
      activated ? 'SessionList: activated session' : 'SessionList: activate failed',
    )
    return
  }

  // Plain tap (no list selection, e.g. text-event tap) — promote sentinel if
  // the user has it selected, otherwise no-op.
  if (event.kind === 'tap' && eventType === G2_EVENT.CLICK) {
    if (store.sessionList.selectedIndex === 0) {
      await openCreateConfirm(ctx)
    }
  }
}

async function openCreateConfirm(ctx: ScreenContext): Promise<void> {
  const { store, conn, glassesUI, notifClient, log } = ctx
  // Refresh project list lazily — this is the moment the user actually needs it.
  try {
    if (store.sessionList.projects.length === 0) {
      store.sessionList.projects = await notifClient.listProjects()
    }
  } catch (err) {
    log(`SessionList: projects取得失敗 ${err instanceof Error ? err.message : String(err)}`)
  }
  // Filter out _unmanaged — cannot create new under it.
  const choices = store.sessionList.projects.filter((p) => p.project_id !== '_unmanaged')
  if (choices.length === 0) {
    log('SessionList: no creatable projects in allowlist')
    return
  }
  store.sessionList.selectedProjectIndex = 0
  store.sessionList.screen = 'session-list-create-confirm'
  store.notif.screen = 'session-list-create-confirm'
  await glassesUI.showSessionListCreateConfirm(conn, choices, 0)
  // 10s auto-cancel timer — if the user does nothing, fall back to the list.
  if (store.sessionList.createConfirmTimer) clearTimeout(store.sessionList.createConfirmTimer)
  store.sessionList.createConfirmTimer = setTimeout(() => {
    store.sessionList.createConfirmTimer = null
    if (store.notif.screen !== 'session-list-create-confirm') return
    void ctx.glassesUI.showSessionList(ctx.conn, store.sessionList.sessions, store.sessionList.selectedIndex, {
      activeSessionId: store.sessionUi.activeSessionId,
      pendingCounts: store.sessionUi.pendingCountsByOtherSession,
    }).catch(() => { /* swallow */ })
    store.sessionList.screen = 'session-list'
    store.notif.screen = 'session-list'
    ctx.updateNotifInfo()
    log('SessionList: create-confirm auto-cancelled (10s timeout)')
  }, CREATE_CONFIRM_AUTO_CANCEL_MS)
  ctx.updateNotifInfo()
}
