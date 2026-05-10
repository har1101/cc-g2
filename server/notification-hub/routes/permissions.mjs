// /api/v1/permissions/:id/ack-blocked (POST) — Phase 5 §5.7
//
// Mark a hard-deny notification as acknowledged by the user. The agent has
// already received its deny response at the hook layer; this endpoint is
// purely for the user-facing G2 ack screen so the hub can record that the
// user saw the block (audit + dashboard).
//
// Lookup order for the request id parameter:
//   1. Notification metadata.request_id (canonical, written by Pass 2's hook)
//   2. Notification.id (fallback for legacy clients)
//
// 404 only when neither lookup finds a notification.
import { readRequestBody, safeJsonParse } from '../notification-utils.mjs'
import { isBodyTooLargeError, sendJson, sendRequestBodyTooLarge } from '../core/http.mjs'
import { writeAuditEntry } from '../core/audit-log.mjs'
import * as store from '../state/store.mjs'

function matchAckPath(pathname) {
  const m = pathname.match(/^\/api\/v1\/permissions\/([^/]+)\/ack-blocked$/)
  return m ? decodeURIComponent(m[1]) : null
}

function findBlockedNotification(idOrRequestId) {
  // First try direct id match.
  const direct = store.notificationsById.get(idOrRequestId)
  if (direct && direct.metadata && direct.metadata.hookType === 'permission-blocked') {
    return direct
  }
  // Then scan metadata.request_id.
  for (const item of store.notifications) {
    if (
      item.metadata &&
      item.metadata.hookType === 'permission-blocked' &&
      item.metadata.request_id === idOrRequestId
    ) {
      return item
    }
  }
  return null
}

export async function handle(req, res, ctx) {
  const { method, pathname, deps } = ctx
  if (method !== 'POST') return false
  const id = matchAckPath(pathname)
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
  const parsed = rawBody ? safeJsonParse(rawBody) : { ok: true, value: {} }
  if (!parsed.ok || !parsed.value || typeof parsed.value !== 'object') {
    sendJson(res, 400, { ok: false, error: 'Invalid JSON body' })
    return true
  }

  const item = findBlockedNotification(id)
  if (!item) {
    sendJson(res, 404, { ok: false, error: 'Blocked notification not found' })
    return true
  }

  // Stamp the ack onto the notification metadata so subsequent reads see it.
  // Persistence is deliberately in-memory only — audit log captures the
  // semantic event, the JSONL stores would otherwise need migration.
  const ackAt = new Date().toISOString()
  item.metadata = {
    ...(item.metadata || {}),
    blockedAckAt: ackAt,
    blockedAckSource: typeof parsed.value.source === 'string' ? parsed.value.source : undefined,
    blockedAckDeviceId: typeof parsed.value.device_id === 'string' ? parsed.value.device_id : undefined,
  }

  writeAuditEntry({
    event: 'permission.blocked_ack',
    request_id: item.metadata.request_id || item.id,
    notification_id: item.id,
    agent_session_id: item.metadata && item.metadata.agentSessionId,
    source: item.metadata.blockedAckSource,
    device_id: item.metadata.blockedAckDeviceId,
  })

  sendJson(res, 200, { ok: true, notification_id: item.id, ackAt })
  return true
}
