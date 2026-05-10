// /api/approvals (POST/GET), /api/approvals/:id (GET), /api/approvals/:id/decide (POST)
import { getString, readRequestBody, safeJsonParse } from '../notification-utils.mjs'
import { isBodyTooLargeError, sendJson, sendRequestBodyTooLarge } from '../core/http.mjs'
import { log } from '../core/log.mjs'
import { writeAuditEntry } from '../core/audit-log.mjs'
import { getApproval, listPendingApprovals } from '../services/approval-service.mjs'
import { applyDestructiveGuard, getNotification } from '../services/notification-service.mjs'

function matchApprovalPath(pathname) {
  const m = pathname.match(/^\/api\/approvals\/([^/]+)$/)
  return m ? decodeURIComponent(m[1]) : null
}
function matchApprovalDecidePath(pathname) {
  const m = pathname.match(/^\/api\/approvals\/([^/]+)\/decide$/)
  return m ? decodeURIComponent(m[1]) : null
}

export async function handle(req, res, ctx) {
  const { method, pathname, deps } = ctx

  if (method === 'POST' && pathname === '/api/approvals') {
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
    const toolName = getString(p.toolName)
    if (!toolName) {
      sendJson(res, 400, { ok: false, error: '`toolName` is required' })
      return true
    }
    const { approval, notification } = await deps.createApproval({
      source: getString(p.source),
      toolName,
      toolInput: p.toolInput ?? null,
      toolId: getString(p.toolId),
      cwd: getString(p.cwd),
      reason: getString(p.reason),
      agentName: getString(p.agentName),
      title: getString(p.title),
      body: getString(p.body),
      metadata: typeof p.metadata === 'object' && p.metadata !== null ? p.metadata : {},
      threadId: getString(p.threadId),
    })
    sendJson(res, 201, {
      ok: true,
      approvalId: approval.id,
      approval,
      notificationId: notification.id,
    })
    return true
  }

  if (method === 'GET' && pathname === '/api/approvals') {
    sendJson(res, 200, { ok: true, items: listPendingApprovals() })
    return true
  }

  if (method === 'GET') {
    const approvalId = matchApprovalPath(pathname)
    if (approvalId) {
      const record = getApproval(approvalId)
      if (!record) {
        sendJson(res, 404, { ok: false, error: 'Approval not found' })
        return true
      }
      sendJson(res, 200, { ok: true, approval: record })
      return true
    }
  }

  if (method === 'POST') {
    const approvalId = matchApprovalDecidePath(pathname)
    if (approvalId) {
      const record = getApproval(approvalId)
      if (!record) {
        sendJson(res, 404, { ok: false, error: 'Approval not found' })
        return true
      }
      if (record.status !== 'pending') {
        sendJson(res, 409, { ok: false, error: 'Approval already decided', approval: record })
        return true
      }
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
      const decision = getString(parsed.value.decision)
      if (decision !== 'approve' && decision !== 'deny') {
        sendJson(res, 400, { ok: false, error: '`decision` must be "approve" or "deny"' })
        return true
      }
      let comment = getString(parsed.value.comment)
      const source = getString(parsed.value.source)
      const twoStepConfirmed = parsed.value.two_step_confirmed === true

      // Phase 5 Codex pass: the web UI / external clients can hit this route
      // directly. Apply the same destructive 2-step guard processReply() uses,
      // so destructive risk_tier approvals always require two_step_confirmed.
      let effectiveDecision = decision
      const linkedNotification = getNotification(record.notificationId)
      const guard = applyDestructiveGuard({
        notification: linkedNotification,
        action: decision,
        twoStepConfirmed,
      })
      if (!guard.ok) {
        log(`approval-broker forced_deny:no_two_step approvalId=${approvalId} decision=${decision}→deny (route=/api/approvals/:id/decide)`)
        writeAuditEntry({
          event: 'permission.forced_deny',
          request_id: guard.requestId,
          agent_session_id: guard.agentSessionId,
          tool_name: guard.toolName,
          reason: guard.reason,
          source: source || undefined,
        })
        effectiveDecision = guard.forcedAction
        const note = '[forced_deny:no_two_step] approve attempt without two_step_confirmed'
        comment = comment ? `${comment} ${note}` : note
      }

      const updated = deps.resolveApproval(approvalId, effectiveDecision, comment, source)
      sendJson(res, 200, { ok: true, approval: updated })
      return true
    }
  }

  return false
}
