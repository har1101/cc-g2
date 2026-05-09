// /api/hooks/permission-request (long-poll HTTP hook for Claude Code / Codex)
// /api/notify/moshi (MOSHI inbound notifications)
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import {
  deriveSessionLabel,
  getString,
  normalizeMoshiPayload,
  readRequestBody,
  safeJsonParse,
} from '../notification-utils.mjs'
import { isBodyTooLargeError, sendJson, sendRequestBodyTooLarge } from '../core/http.mjs'
import { log } from '../core/log.mjs'
import * as store from '../state/store.mjs'

const HOOK_POLL_TIMEOUT_MS = 600_000
const HOOK_POLL_INTERVAL_MS = 2_000

function buildToolPreview(toolName, toolInput) {
  if (toolName === 'Bash') {
    return toolInput?.command || ''
  } else if (toolName === 'apply_patch') {
    return buildApplyPatchPreview(toolInput)
  } else if (toolName === 'Edit') {
    const file = toolInput?.file_path || ''
    const old = (toolInput?.old_string || '').slice(0, 2000)
    const new_ = (toolInput?.new_string || '').slice(0, 2000)
    return `${file}\n--- old ---\n${old}\n+++ new +++\n${new_}`
  } else if (toolName === 'Write') {
    const file = toolInput?.file_path || ''
    const content = (toolInput?.content || '').slice(0, 2000)
    return `${file}\n${content}`
  } else {
    return JSON.stringify(toolInput || {}).slice(0, 2000)
  }
}

function buildApplyPatchPreview(toolInput) {
  const patch = getApplyPatchRawString(toolInput)
  if (patch === null) return JSON.stringify(toolInput || {}).slice(0, 2000)

  const fileLines = []
  const seen = new Set()
  for (const line of patch.split(/\r?\n/)) {
    const match = line.match(/^\*\*\* (Add|Update|Delete) File: (.+)$/)
    if (match) {
      const label = match[1] === 'Add' ? 'add' : match[1] === 'Update' ? 'edit' : 'delete'
      const key = `${label}:${match[2]}`
      if (!seen.has(key)) {
        seen.add(key)
        fileLines.push(`- ${label} ${match[2]}`)
      }
    }
  }

  const patchLines = patch
    .replace(/\r\n/g, '\n')
    .split('\n')
    .slice(0, 80)
    .map((line) => (line.length > 160 ? `${line.slice(0, 159)}…` : line))
    .join('\n')

  const summary = fileLines.length > 0
    ? ['Files:', ...fileLines.slice(0, 12), ''].join('\n')
    : ''
  const truncated = patch.split(/\r?\n/).length > 80 ? '\n…' : ''
  return `${summary}${patchLines}${truncated}`.slice(0, 4000)
}

function getApplyPatchRawString(toolInput) {
  for (const key of ['command', 'input', 'patch']) {
    const value = toolInput?.[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return null
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

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
  const p = parsed.value
  const tmuxTarget = req.headers['x-tmux-target'] || ''
  const toolName = getString(p.tool_name)
  const toolInput = p.tool_input || {}
  const cwd = getString(p.cwd)
  const sessionId = getString(p.session_id)
  const agentSource = getString(req.headers['x-agent-source']) === 'codex' ? 'codex' : 'claude-code'
  const approvalSource = agentSource === 'codex' ? 'codex-hook' : 'claude-code-hook'

  const title = toolName
  let preview = buildToolPreview(toolName, toolInput)

  // AskUserQuestion: questions metadata を追加し、プレビューを整形
  const isAskQ = toolName === 'AskUserQuestion' && Array.isArray(toolInput.questions)
  const extraMeta = {}
  if (isAskQ) {
    const previewLines = []
    for (const q of toolInput.questions) {
      previewLines.push(q.question || '')
      if (Array.isArray(q.options)) {
        for (const opt of q.options) {
          previewLines.push(`  • ${opt.label}: ${opt.description || ''}`)
        }
      }
    }
    preview = previewLines.join('\n')
    extraMeta.hookType = 'ask-user-question'
    extraMeta.questions = toolInput.questions
  }

  const projectSlug = path.basename(cwd || '').replace(/[^a-zA-Z0-9_-]/g, '_')
  const sessionSlug = (sessionId || '').replace(/[^a-zA-Z0-9_-]/g, '_')
  const threadId = `permission_${projectSlug}_${sessionSlug}_${Date.now()}`

  const { approval } = await deps.createApproval({
    source: approvalSource,
    toolName,
    toolInput,
    toolId: '',
    cwd,
    agentName: agentSource,
    title,
    body: preview,
    threadId,
    metadata: {
      ...extraMeta,
      tmuxTarget,
      sessionLabel: deriveSessionLabel(tmuxTarget),
      sessionId,
      agentName: agentSource,
    },
  })

  deps.spawnLocalNotification(toolName)

  // PC側で承認/拒否された場合、Claude Codeが接続を切る → 検知してマーク
  let clientDisconnected = false
  const onClose = () => { clientDisconnected = true }
  req.on('close', onClose)
  res.on('close', onClose)

  const deadline = Date.now() + HOOK_POLL_TIMEOUT_MS
  while (Date.now() < deadline) {
    await sleep(HOOK_POLL_INTERVAL_MS)
    if (clientDisconnected) {
      const record = store.approvalsById.get(approval.id)
      if (record && record.status === 'pending') {
        deps.markApprovalCleanup(record, 'terminal-disconnect', 'terminal')
        log(`approval cleaned up by terminal disconnect id=${record.id}`)
      }
      req.off('close', onClose)
      res.off('close', onClose)
      return
    }
    const record = store.approvalsById.get(approval.id)
    if (record && record.status === 'decided') {
      record.deliveredAt = new Date().toISOString()
      req.off('close', onClose)
      res.off('close', onClose)
      if (record.decision === 'approve') {
        sendJson(res, 200, {
          hookSpecificOutput: {
            hookEventName: 'PermissionRequest',
            decision: { behavior: 'allow' },
          },
        })
        return
      }
      if (record.decision === 'deny') {
        const message = record.comment
          ? `G2: ${record.comment}`
          : 'G2から拒否されました'
        sendJson(res, 200, {
          hookSpecificOutput: {
            hookEventName: 'PermissionRequest',
            decision: { behavior: 'deny', message },
          },
        })
        return
      }
      log(
        `approval cleanup observed while waiting id=${record.id} resolution=${record.resolution || 'unknown'}`,
      )
      sendJson(res, 200, {})
      return
    }
  }

  // Timeout: return empty response → Claude Code shows normal dialog
  req.off('close', onClose)
  res.off('close', onClose)
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
