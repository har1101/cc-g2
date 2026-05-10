// /api/client-events — frontend log intake (one JSON line per event).
import { readRequestBody, safeJsonParse } from '../notification-utils.mjs'
import { isBodyTooLargeError, sendJson, sendRequestBodyTooLarge } from '../core/http.mjs'
import { appendClientEvent } from '../services/client-events-service.mjs'

export async function handle(req, res, ctx) {
  if (ctx.method !== 'POST' || ctx.pathname !== '/api/client-events') return false
  const { deps } = ctx

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
  await appendClientEvent(parsed.value, { clientEventsFile: deps.clientEventsFile })
  sendJson(res, 201, { ok: true })
  return true
}
