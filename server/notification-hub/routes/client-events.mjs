// /api/client-events — frontend log intake (one JSON line per event).
import { randomUUID } from 'node:crypto'
import { getString, readRequestBody, safeJsonParse } from '../notification-utils.mjs'
import { isBodyTooLargeError, sendJson, sendRequestBodyTooLarge } from '../core/http.mjs'
import { appendJsonl } from '../state/persistence.mjs'

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
  const p = parsed.value
  const line = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    source: getString(p.source, 'web-client'),
    message: getString(p.message),
    level: getString(p.level, 'info'),
    context: typeof p.context === 'object' && p.context !== null ? p.context : undefined,
  }
  await appendJsonl(deps.clientEventsFile, line)
  sendJson(res, 201, { ok: true })
  return true
}
