// /api/v1/command — free-text command from G2 (voice or text). Phase 1.
import { readRequestBody, safeJsonParse } from '../notification-utils.mjs'
import { isBodyTooLargeError, sendJson, sendRequestBodyTooLarge } from '../core/http.mjs'
import { processCommand } from '../services/command-service.mjs'

export async function handle(req, res, ctx) {
  if (ctx.method !== 'POST' || ctx.pathname !== '/api/v1/command') return false
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
    sendJson(res, 400, { ok: false, error: 'invalid JSON body' })
    return true
  }
  const p = parsed.value
  const result = await processCommand(
    {
      source: p.source,
      text: p.text,
      transcriptConfidence: p.transcript_confidence,
      tmuxTarget: p.tmux_target,
    },
    {
      relay: deps.relayReplyIfConfigured,
      notificationsFile: deps.notificationsFile,
      repliesFile: deps.repliesFile,
      persistRaw: deps.hubPersistRaw,
    },
  )
  sendJson(res, result.status, result.body)
  return true
}
