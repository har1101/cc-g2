// /api/notifications, /api/notifications/:id, /api/notifications/:id/reply
import { readRequestBody, safeJsonParse } from '../notification-utils.mjs'
import { isBodyTooLargeError, sendJson, sendRequestBodyTooLarge } from '../core/http.mjs'
import { getNotification, listNotifications } from '../services/notification-service.mjs'

function matchNotificationDetail(pathname) {
  const m = pathname.match(/^\/api\/notifications\/([^/]+)$/)
  return m ? decodeURIComponent(m[1]) : null
}

function matchNotificationReply(pathname) {
  const m = pathname.match(/^\/api\/notifications\/([^/]+)\/reply$/)
  return m ? decodeURIComponent(m[1]) : null
}

export async function handle(req, res, ctx) {
  const { method, pathname, url, deps } = ctx

  if (method === 'GET' && pathname === '/api/notifications') {
    const limitRaw = Number(url.searchParams.get('limit') || '20')
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.floor(limitRaw), 1), 100) : 20
    sendJson(res, 200, { ok: true, items: listNotifications(limit) })
    return true
  }

  if (method === 'GET') {
    const id = matchNotificationDetail(pathname)
    if (id) {
      const item = getNotification(id)
      if (!item) {
        sendJson(res, 404, { ok: false, error: 'Notification not found' })
        return true
      }
      sendJson(res, 200, { ok: true, item })
      return true
    }
  }

  if (method === 'POST') {
    const id = matchNotificationReply(pathname)
    if (!id) return false
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
    const result = await deps.processReply({ notificationId: id, body: parsed.value })
    sendJson(res, result.status, result.body)
    return true
  }

  return false
}
