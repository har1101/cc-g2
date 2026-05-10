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
import { normalizePermissionRequestPayload } from '../services/approval-service.mjs'
import { resolveSessionId } from '../services/session-router.mjs'

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
