// /api/hooks/permission-request (long-poll HTTP hook for Claude Code / Codex)
// /api/notify/moshi (MOSHI inbound notifications)
import { randomUUID } from 'node:crypto'
import {
  getString,
  normalizeMoshiPayload,
  readRequestBody,
  safeJsonParse,
} from '../notification-utils.mjs'
import { isBodyTooLargeError, sendJson, sendRequestBodyTooLarge } from '../core/http.mjs'
import { log } from '../core/log.mjs'
import { writeAuditEntry } from '../core/audit-log.mjs'
import { normalizePermissionRequestPayload } from '../services/approval-service.mjs'
import { classify, inputPreviewFor } from '../services/policy-service.mjs'
import { resolveSessionId } from '../services/session-router.mjs'

// Phase 5 §5.5: destructive approvals carry a metadata.timeout_at so the G2
// reply-recording substate can budget for STT vs. server-side timeout.
// Default 60s lines up with approval long-poll responsiveness.
const PERMISSION_TIMEOUT_DEFAULT_MS = 60_000

async function handlePermissionRequestHook(req, res, deps) {
  let body
  try {
    body = await readRequestBody(req, { maxBytes: deps.hubMaxBodyBytes })
  } catch (err) {
    if (isBodyTooLargeError(err)) {
      sendRequestBodyTooLarge(res, err)
      return
    }
    throw err
  }
  const parsed = safeJsonParse(body || '{}')
  if (!parsed.ok || !parsed.value || typeof parsed.value !== 'object') {
    sendJson(res, 400, { error: 'Invalid JSON body' })
    return
  }

  // Phase 4: session-router resolves the agent_session_id from the
  // X-Agent-Session-Id header (with X-Tmux-Target reverse-lookup fallback).
  // The result threads through approval metadata so per-session views and
  // tmux-relay reply routing stay consistent.
  const agentSessionId = resolveSessionId(req)

  const shaped = normalizePermissionRequestPayload(parsed.value, {
    tmuxTarget: getString(req.headers['x-tmux-target']),
    agentSource: getString(req.headers['x-agent-source']),
    agentSessionId,
  })

  // Phase 5 §5.1–5.2: classify upfront. Hard-deny short-circuits — no approval
  // is created, no long-poll, agent gets immediate deny + G2 sees a separate
  // permission.blocked notification (metadata.hookType='permission-blocked').
  // Destructive stamps risk_tier on the approval so the G2 UI knows to
  // require a 2-step swipe-up confirmation.
  const requestId = randomUUID()
  const verdict = classify({
    tool_name: shaped.toolName,
    tool_input: shaped.toolInput,
    agent_session_id: agentSessionId,
    request_id: requestId,
  })
  const inputPreview = inputPreviewFor(shaped.toolName, shaped.toolInput)

  if (verdict.tier === 'hard_deny') {
    // Synthesize a permission.blocked notification (no approval lifecycle).
    // The G2 frontend sees `metadata.hookType === 'permission-blocked'` and
    // routes to the action-blocked screen.
    const blockedPayload = {
      title: shaped.toolName || 'Permission',
      body: `🛑 Blocked: ${verdict.reason}\n\n$ ${inputPreview}`,
      hookType: 'permission-blocked',
      metadata: {
        ...(shaped.metadata || {}),
        hookType: 'permission-blocked',
        request_id: requestId,
        toolName: shaped.toolName,
        cwd: shaped.cwd || undefined,
        agentName: shaped.agentName,
        risk_tier: 'hard_deny',
        reason: verdict.reason,
        input_preview: inputPreview,
        ack_window_ms: 60_000,
      },
    }
    try {
      await deps.addNotification(blockedPayload, 'permission-blocked')
    } catch (err) {
      log(`permission.blocked notification persist failed: ${err instanceof Error ? err.message : String(err)}`)
    }

    writeAuditEntry({
      event: 'permission.blocked',
      request_id: requestId,
      agent_session_id: agentSessionId,
      tool_name: shaped.toolName,
      input_preview: inputPreview,
      reason: verdict.reason,
    })

    // Reply with the same shape as a denied approval so claude/codex bridges
    // don't need branching logic. comment field surfaces the reason.
    const denyMessage = `G2 blocked (${verdict.reason})`
    sendJson(res, 200, {
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'deny', message: denyMessage },
      },
    })
    return
  }

  // Stamp risk_tier and timeout_at onto destructive approvals so the G2
  // frontend can branch (2-step confirm) and the reply-recording substate
  // can coordinate timeouts (Phase 5 §5.5). Normal approvals also receive
  // timeout_at — it's purely informational for the client.
  const timeoutMs = PERMISSION_TIMEOUT_DEFAULT_MS
  const timeoutAt = new Date(Date.now() + timeoutMs).toISOString()
  shaped.metadata = {
    ...(shaped.metadata || {}),
    request_id: requestId,
    risk_tier: verdict.tier,
    timeout_at: timeoutAt,
    timeout_ms: timeoutMs,
    input_preview: inputPreview,
  }

  const { approval } = await deps.createApproval(shaped)

  deps.spawnLocalNotification(shaped.toolName)

  // PC側で承認/拒否された場合、Claude Codeが接続を切る → 検知してマーク
  let clientDisconnected = false
  const onClose = () => { clientDisconnected = true }
  req.on('close', onClose)
  res.on('close', onClose)

  const result = await deps.waitForApprovalDecision({
    approvalId: approval.id,
    isDisconnected: () => clientDisconnected,
  })
  req.off('close', onClose)
  res.off('close', onClose)

  if (result.outcome === 'disconnected') {
    const cleaned = deps.cleanupApprovalOnDisconnect(approval.id)
    if (cleaned) {
      log(`approval cleaned up by terminal disconnect id=${cleaned.id}`)
    }
    return
  }
  if (result.outcome === 'decided') {
    if (result.record.status === 'decided' && !result.record.decision) {
      log(
        `approval cleanup observed while waiting id=${result.record.id} resolution=${result.record.resolution || 'unknown'}`,
      )
    }
    const response = deps.buildHookResponseFromApproval(result.record)
    sendJson(res, response.status, response.body)
    return
  }
  // Timeout: return empty response → Claude Code shows normal dialog
  sendJson(res, 200, {})
}

export async function handle(req, res, ctx) {
  const { method, pathname, deps } = ctx

  if (method === 'POST' && pathname === '/api/hooks/permission-request') {
    await handlePermissionRequestHook(req, res, deps)
    return true
  }

  if (method === 'POST' && pathname === '/api/notify/moshi') {
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
    const ctype = req.headers['content-type'] || ''
    let payload = null

    if (ctype.includes('application/json')) {
      const parsed = safeJsonParse(rawBody || '{}')
      if (!parsed.ok) {
        sendJson(res, 400, { ok: false, error: `Invalid JSON: ${parsed.error}` })
        return true
      }
      payload = parsed.value
    } else if (ctype.includes('application/x-www-form-urlencoded')) {
      const form = new URLSearchParams(rawBody)
      payload = Object.fromEntries(form.entries())
    } else {
      const parsed = safeJsonParse(rawBody)
      payload = parsed.ok ? parsed.value : { rawBody }
    }

    // Phase 4: stamp the resolved agent_session_id onto incoming notifications
    // so stop-hook / generic moshi events participate in per-session views.
    // The header takes priority; if absent we fall back to the value already
    // present in the payload metadata (e.g. tests or legacy callers).
    const agentSessionId = resolveSessionId(req)
    if (payload && typeof payload === 'object' && agentSessionId) {
      const meta = payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {}
      payload.metadata = { ...meta, agentSessionId: meta.agentSessionId || agentSessionId }
    }

    // MOSHI の permission-request 通知は HTTP hook が既に notification + approval を
    // 作成済みのため、notifications 配列には保存しない（G2 重複防止）。
    const preItem = normalizeMoshiPayload(payload, {
      persistRaw: deps.hubPersistRaw,
      createId: () => randomUUID(),
    })
    if (preItem.metadata && preItem.metadata.hookType === 'permission-request') {
      log(`moshi permission-request notification: skipped (not stored) title=${JSON.stringify(preItem.title)}`)
      sendJson(res, 201, { ok: true, item: preItem, stored: false })
      return true
    }

    const { item } = await deps.addNotification(payload, 'moshi notification')
    sendJson(res, 201, { ok: true, item })
    return true
  }

  return false
}
