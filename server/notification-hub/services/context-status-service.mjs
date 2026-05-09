// Context-status service: per-session context-window snapshot
// (cwd / usedPercentage / model) coming from the StatusLine hook.
// May call: state/store, notification-utils.
import { getString } from '../notification-utils.mjs'
import { contextStatusBySession } from '../state/store.mjs'

/**
 * Record the latest context-status snapshot for a session.
 * @param {any} payload - already-parsed JSON body
 * @returns {{ ok: true, sessionId: string }}
 */
export function recordContextStatus(payload) {
  const p = (payload && typeof payload === 'object') ? payload : {}
  const sessionId = getString(p.sessionId, 'default')
  contextStatusBySession.set(sessionId, {
    sessionId,
    cwd: getString(p.cwd),
    usedPercentage: typeof p.usedPercentage === 'number' ? p.usedPercentage : 0,
    model: getString(p.model),
    updatedAt: new Date().toISOString(),
  })
  return { ok: true, sessionId }
}

export function listContextStatuses() {
  return [...contextStatusBySession.values()]
}
