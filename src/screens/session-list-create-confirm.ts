/**
 * Phase 3: SessionList create-confirm overlay handler.
 *
 *   - swipe up/down → cycle through creatable projects
 *   - single tap     → POST /api/v1/sessions, refresh list, return to session-list
 *   - double tap     → cancel, return to session-list
 *   - 10s timeout (set by openCreateConfirm) → cancel, return to session-list
 *
 * The pendingCreate flag suppresses re-entry while the POST is in flight; the
 * Hub already enforces a 1-at-a-time mutex but we surface a friendly UI
 * response by ignoring extra taps locally too.
 */

import type { ScreenContext } from './types'
import type { NormalizedG2Event } from '../even-events'
import { isDoubleTapEventType } from '../even-events'
import { clearSessionListCreateConfirmTimer } from '../state/store'

export async function handle(event: NormalizedG2Event, ctx: ScreenContext): Promise<void> {
  const { store, conn, glassesUI, notifClient, log } = ctx
  const eventType = event.eventType

  if (isDoubleTapEventType(eventType)) {
    log('SessionList create-confirm: double tap → back to list')
    await returnToList(ctx, 'cancelled')
    return
  }

  if (event.kind === 'scrollTop' || event.kind === 'scrollBottom') {
    const choices = creatableProjects(store)
    if (choices.length === 0) return
    if (event.kind === 'scrollTop') {
      store.sessionList.selectedProjectIndex = (store.sessionList.selectedProjectIndex - 1 + choices.length) % choices.length
    } else {
      store.sessionList.selectedProjectIndex = (store.sessionList.selectedProjectIndex + 1) % choices.length
    }
    await glassesUI.showSessionListCreateConfirm(conn, choices, store.sessionList.selectedProjectIndex)
    ctx.updateNotifInfo()
    return
  }

  if (event.kind === 'tap') {
    if (store.sessionList.pendingCreate) {
      log('SessionList create-confirm: already in-flight, tap ignored')
      return
    }
    const choices = creatableProjects(store)
    const project = choices[store.sessionList.selectedProjectIndex]
    if (!project) {
      log('SessionList create-confirm: no project selected (empty allowlist?)')
      return
    }
    store.sessionList.pendingCreate = true
    clearSessionListCreateConfirmTimer()
    try {
      log(`SessionList create-confirm: creating session for project=${project.project_id}`)
      const session = await notifClient.createSession(project.project_id)
      log(`SessionList create-confirm: created session id=${session.session_id} tmux=${session.tmux_target}`)
      // refresh local list
      try {
        store.sessionList.sessions = await notifClient.listSessions()
      } catch (err) {
        log(`SessionList create-confirm: post-create list取得失敗 ${err instanceof Error ? err.message : String(err)}`)
      }
      await returnToList(ctx, 'created')
    } catch (err) {
      log(`SessionList create-confirm: create失敗 ${err instanceof Error ? err.message : String(err)}`)
      await returnToList(ctx, 'create-error')
    } finally {
      store.sessionList.pendingCreate = false
    }
  }
}

function creatableProjects(store: ScreenContext['store']) {
  return store.sessionList.projects.filter((p) => p.project_id !== '_unmanaged')
}

async function returnToList(ctx: ScreenContext, reason: string): Promise<void> {
  const { store, conn, glassesUI, log } = ctx
  clearSessionListCreateConfirmTimer()
  store.sessionList.screen = 'session-list'
  store.notif.screen = 'session-list'
  await glassesUI.showSessionList(conn, store.sessionList.sessions, store.sessionList.selectedIndex)
  ctx.updateNotifInfo()
  log(`SessionList create-confirm: back to list (${reason})`)
}
