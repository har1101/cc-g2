// /api/notifications, /api/notifications/:id, /api/notifications/:id/reply
import { readRequestBody, safeJsonParse } from '../notification-utils.mjs'
import { isBodyTooLargeError, sendJson, sendRequestBodyTooLarge } from '../core/http.mjs'
import {
  getNotification,
  getReplyStatus,
  listNotifications,
} from '../services/notification-service.mjs'
import { listNotificationsForSession } from '../state/store.mjs'

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
    // Phase 4: optional ?session_id=<id> filter. When omitted, behaviour is
    // unchanged for backwards compatibility. When set, route through
    // listNotificationsForSession() so the response shape matches
    // listNotifications() (replyStatus included) but only the requested
    // session's items are surfaced.
    const sessionIdRaw = url.searchParams.get('session_id')
    const sessionId = typeof sessionIdRaw === 'string' && sessionIdRaw.trim() ? sessionIdRaw.trim() : null
    if (sessionId) {
      const filtered = listNotificationsForSession(sessionId)
        .slice(0, limit)
        .map((item) => ({
          id: item.id,
          source: item.source,
          title: item.title,
          summary: item.summary,
          createdAt: item.createdAt,
          replyCapable: item.replyCapable,
          metadata: item.metadata,
          replyStatus: getReplyStatus(item),
        }))
      sendJson(res, 200, { ok: true, items: filtered })
      return true
    }
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
