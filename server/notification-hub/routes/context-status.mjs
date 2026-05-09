// /api/context-status (POST from StatusLine hook; GET to read all sessions)
import { getString, readRequestBody, safeJsonParse } from '../notification-utils.mjs'
import { isBodyTooLargeError, sendJson, sendRequestBodyTooLarge } from '../core/http.mjs'
import { contextStatusBySession } from '../state/store.mjs'

export async function handle(req, res, ctx) {
  const { method, pathname, deps } = ctx

  if (method === 'POST' && pathname === '/api/context-status') {
    let rawBody
    try {
      rawBody = await readRequestBody(req, { maxBytes: deps.hubMaxBodyBytes })
    } catch (err) {
      if (isBodyTooLargeError(err)) {
        sendRequestBodyTooLarge(res, err)
        return true
      }
      throw err
    }
    const parsed = safeJsonParse(rawBody || '{}')
    if (!parsed.ok || !parsed.value || typeof parsed.value !== 'object') {
      sendJson(res, 400, { ok: false, error: 'Invalid JSON body' })
      return true
    }
    const p = parsed.value
    const sessionId = getString(p.sessionId, 'default')
    contextStatusBySession.set(sessionId, {
      sessionId,
      cwd: getString(p.cwd),
      usedPercentage: typeof p.usedPercentage === 'number' ? p.usedPercentage : 0,
      model: getString(p.model),
      updatedAt: new Date().toISOString(),
    })
    sendJson(res, 200, { ok: true })
    return true
  }

  if (method === 'GET' && pathname === '/api/context-status') {
    sendJson(res, 200, { ok: true, sessions: [...contextStatusBySession.values()] })
    return true
  }
  return false
}
