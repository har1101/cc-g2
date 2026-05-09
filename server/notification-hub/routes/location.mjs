// /api/location (POST: receive Overland-style GeoJSON; GET: latest location)
import { readRequestBody, safeJsonParse } from '../notification-utils.mjs'
import { isBodyTooLargeError, sendJson, sendRequestBodyTooLarge } from '../core/http.mjs'
import { getLatestLocation, ingestOverlandPayload } from '../services/location-service.mjs'

export async function handle(req, res, ctx) {
  const { method, pathname, deps } = ctx

  if (method === 'POST' && pathname === '/api/location') {
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
    const result = ingestOverlandPayload(parsed.value)
    if (!result.ok) {
      sendJson(res, 400, { ok: false, error: result.error })
      return true
    }
    sendJson(res, 200, { ok: true })
    return true
  }

  if (method === 'GET' && pathname === '/api/location') {
    const loc = getLatestLocation()
    if (!loc) {
      sendJson(res, 200, { ok: true, location: null, message: 'No location data received yet' })
      return true
    }
    sendJson(res, 200, { ok: true, location: loc })
    return true
  }
  return false
}
