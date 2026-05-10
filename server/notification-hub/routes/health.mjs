// /api/health, /api/healthz, / (index banner)
import { sendJson, sendText } from '../core/http.mjs'
import { getHealthSummary } from '../services/health-service.mjs'

export async function handle(req, res, ctx) {
  const { method, pathname } = ctx

  if (method === 'GET' && (pathname === '/api/health' || pathname === '/api/healthz')) {
    sendJson(res, 200, getHealthSummary())
    return true
  }

  if (method === 'GET' && pathname === '/') {
    sendText(
      res,
      200,
      [
        'notification-hub (approval-broker)',
        '',
        'GET  /api/health',
        'POST /api/hooks/permission-request  (HTTP hook for Claude Code)',
        'POST /api/notify/moshi',
        'GET  /api/notifications?limit=20',
        'GET  /api/notifications/:id',
        'POST /api/notifications/:id/reply',
        '',
        'POST /api/approvals              (create approval request)',
        'GET  /api/approvals              (list pending approvals)',
        'GET  /api/approvals/:id          (poll approval status)',
        'POST /api/approvals/:id/decide   (submit decision)',
        '',
        'POST /api/v1/command             (free-text command from G2)',
        '',
        'GET  /ui                         (approval dashboard)',
        'POST /api/client-events          (frontend event log intake)',
        'POST /api/location               (receive GPS from Overland/etc)',
        'GET  /api/location               (get latest GPS location)',
      ].join('\n'),
    )
    return true
  }
  return false
}
