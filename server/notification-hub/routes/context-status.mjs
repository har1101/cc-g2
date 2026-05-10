// /api/context-status (POST from StatusLine hook; GET to read all sessions)
import { readRequestBody, safeJsonParse } from '../notification-utils.mjs'
import { isBodyTooLargeError, sendJson, sendRequestBodyTooLarge } from '../core/http.mjs'
import { listContextStatuses, recordContextStatus } from '../services/context-status-service.mjs'

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
    recordContextStatus(parsed.value)
    sendJson(res, 200, { ok: true })
    return true
  }

  if (method === 'GET' && pathname === '/api/context-status') {
    sendJson(res, 200, { ok: true, sessions: listContextStatuses() })
    return true
  }
  return false
}
