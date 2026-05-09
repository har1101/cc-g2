// Approval service: owns approval lifecycle (create, resolve, cleanup) and
// the read-side queries used by routes/UI.
//
// Allowed dependencies (DAG):
//   approval-service → notification-service → state/store + state/persistence
// approval-service may also call core/log directly. It must NOT be reached
// upward from notification-service or routes/* (routes call services, not
// vice versa).
import { randomUUID } from 'node:crypto'
import { log } from '../core/log.mjs'
import { persistedApproval } from '../notification-utils.mjs'
import * as store from '../state/store.mjs'
import { appendJsonl } from '../state/persistence.mjs'

/**
 * Build a human-readable preview string for a hook tool_input. Used by the
 * permission-request long-poll route as the notification body.
 */
export function buildToolPreview(toolName, toolInput) {
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

/**
 * Create a new approval record. Side-effect: also creates a linked
 * notification via the supplied addNotification function (injected by
 * the caller to keep the service free of hub-config knowledge).
 *
 * @param {{
 *   source?: string, toolName: string, toolInput?: unknown, toolId?: string,
 *   cwd?: string, reason?: string, agentName?: string,
 *   title?: string, body?: string, metadata?: Record<string, unknown>,
 *   threadId?: string,
 * }} params
 * @param {{
 *   addNotification: (payload: any, prefix?: string) => Promise<{ item: import('../state/store.mjs').NotificationItem }>,
 *   approvalsFile: string,
 *   persistToolInput: boolean,
 * }} cfg
 */
export async function createApproval(params, cfg) {
  const {
    source, toolName, toolInput, toolId, cwd, reason,
    agentName, title: titleOverride, body: bodyOverride, metadata: extraMeta,
    threadId: incomingThreadId,
  } = params

  const approvalId = randomUUID()
  const now = new Date().toISOString()

  const lines = []
  lines.push(`Tool: ${toolName}`)
  if (cwd) lines.push(`CWD: ${cwd}`)
  if (reason) lines.push(`理由: ${reason}`)
  const inputPreview = typeof toolInput === 'object' && toolInput !== null
    ? (toolInput.command || toolInput.file_path || JSON.stringify(toolInput))
    : String(toolInput || '')
  if (inputPreview) lines.push('', `$ ${inputPreview}`)

  const title = titleOverride || toolName
  const fullText = bodyOverride || lines.join('\n')

  const callerHookType = (extraMeta && typeof extraMeta.hookType === 'string')
    ? extraMeta.hookType
    : 'permission-request'
  const notifPayload = {
    title,
    body: fullText,
    hookType: callerHookType,
    threadId: incomingThreadId || undefined,
    metadata: {
      ...extraMeta,
      hookType: callerHookType,
      approvalId,
      externalId: `approval:${approvalId}`,
      source: `${agentName}-approval-broker`,
      toolName,
      toolId,
      cwd: cwd || undefined,
      agentName,
    },
  }
  const { item: notification } = await cfg.addNotification(notifPayload, 'approval-broker')

  /** @type {import('../state/store.mjs').ApprovalRecord} */
  const record = {
    id: approvalId,
    notificationId: notification.id,
    source: source || agentName,
    toolName,
    toolInput,
    toolId: toolId || '',
    cwd: cwd || '',
    reason: reason || '',
    agentName: agentName || '',
    status: 'pending',
    createdAt: now,
  }
  store.approvals.push(record)
  store.approvalsById.set(record.id, record)
  store.approvalsByNotificationId.set(notification.id, record)
  await appendJsonl(cfg.approvalsFile, persistedApproval(record, { persistToolInput: cfg.persistToolInput }))

  log(`approval created id=${record.id} notificationId=${notification.id} tool=${toolName}`)
  return { approval: record, notification }
}

/**
 * Resolve an approval with an explicit decision (approve/deny).
 * @param {string} approvalId
 * @param {'approve'|'deny'} decision
 * @param {string} [comment]
 * @param {string} [decidedBy]
 * @param {{ approvalsFile: string, persistToolInput: boolean }} cfg
 */
export function resolveApproval(approvalId, decision, comment, decidedBy, cfg) {
  const record = store.approvalsById.get(approvalId)
  if (!record) return null
  if (record.status !== 'pending') return record
  record.status = 'decided'
  record.decision = decision
  record.resolution = undefined
  record.comment = comment || undefined
  record.decidedBy = decidedBy || undefined
  record.decidedAt = new Date().toISOString()
  appendJsonl(
    cfg.approvalsFile,
    persistedApproval({ ...record, _event: 'decided' }, { persistToolInput: cfg.persistToolInput }),
  ).catch((err) =>
    log(`approval persist error ${err instanceof Error ? err.message : String(err)}`),
  )
  log(`approval decided id=${record.id} decision=${decision} by=${decidedBy || 'unknown'}`)
  return record
}

/**
 * Mark a pending approval as cleaned up (e.g. terminal-disconnect, session-ended).
 * @param {import('../state/store.mjs').ApprovalRecord} record
 * @param {'superseded'|'session-ended'|'terminal-disconnect'} resolution
 * @param {string} [decidedBy]
 * @param {string} [decidedAt]
 * @param {{ approvalsFile: string, persistToolInput: boolean }} cfg
 */
export function markApprovalCleanup(record, resolution, decidedBy, decidedAt = new Date().toISOString(), cfg) {
  if (!record || record.status !== 'pending') return record
  record.status = 'decided'
  record.decision = undefined
  record.resolution = resolution
  record.comment = undefined
  record.decidedBy = decidedBy || undefined
  record.decidedAt = decidedAt
  record.deliveredAt = decidedAt
  appendJsonl(
    cfg.approvalsFile,
    persistedApproval({ ...record, _event: 'decided' }, { persistToolInput: cfg.persistToolInput }),
  ).catch((err) =>
    log(`approval persist error ${err instanceof Error ? err.message : String(err)}`),
  )
  log(`approval cleaned up id=${record.id} resolution=${resolution} by=${decidedBy || 'unknown'}`)
  return record
}

/**
 * Sweep all pending approvals belonging to the given session and mark them as
 * `session-ended`. Used by the moshi route when a stop notification arrives.
 * @param {{ sessionId: string, decidedAt?: string }} params
 * @param {{ approvalsFile: string, persistToolInput: boolean }} cfg
 * @returns {string[]} ids of approvals that were swept
 */
export function cleanupApprovalsOnStop(params, cfg) {
  const { sessionId } = params
  if (!sessionId) return []
  const decidedAt = params.decidedAt || new Date().toISOString()
  const swept = []
  for (const a of store.approvals) {
    if (a.status !== 'pending') continue
    const n = store.notificationsById.get(a.notificationId)
    if (n?.metadata?.sessionId === sessionId) {
      markApprovalCleanup(a, 'session-ended', 'auto-session-end', decidedAt, cfg)
      log(`approval auto-cleaned on stop id=${a.id} session=${sessionId}`)
      swept.push(a.id)
    }
  }
  return swept
}

export function getApproval(id) {
  return store.approvalsById.get(id) || null
}

export function getApprovalByNotificationId(notificationId) {
  return store.approvalsByNotificationId.get(notificationId) || null
}

export function listPendingApprovals() {
  return store.approvals.filter((a) => a.status === 'pending')
}

/**
 * Find a pending approval whose tool/file/command best matches the reply
 * notification. Used as a fallback when the reply notification does not
 * carry an explicit approvalId link.
 *
 * Behavior preserved from the previous in-route implementation:
 *   - Same toolName is required for a match (when reply has a toolName).
 *   - Prefer the most recent pending approval whose linked notification
 *     mentions the same file_path / command identifier.
 *   - Otherwise fall back to the most recent pending approval with the
 *     same toolName.
 *
 * @param {{ replyText: string, notification: import('../state/store.mjs').NotificationItem }} params
 * @returns {import('../state/store.mjs').ApprovalRecord | null}
 */
export function matchPendingApprovalForReply({ notification }) {
  const replyToolName = (notification?.metadata && notification.metadata.toolName) || ''
  const replyTitle = notification?.title || ''
  const replySummary = notification?.summary || ''
  const replyFullText = notification?.fullText || ''

  let bestMatch = null
  for (let i = store.approvals.length - 1; i >= 0; i--) {
    if (store.approvals[i].status !== 'pending') continue

    // Same toolName is required for a match
    if (replyToolName && store.approvals[i].toolName !== replyToolName) continue

    // Try to match by file path or command content
    const approvalNotif = store.notificationsById.get(store.approvals[i].notificationId)
    if (approvalNotif && replyToolName) {
      const input = store.approvals[i].toolInput || {}
      const filePath = input.file_path || ''
      const command = input.command || ''
      const identifier = filePath || command

      // Check if the reply notification mentions the same file/command
      if (identifier) {
        const shortId = identifier.split('/').pop() || identifier.slice(0, 30)
        if (replyTitle.includes(shortId) || replySummary.includes(shortId) || replyFullText.includes(shortId)) {
          bestMatch = store.approvals[i]
          break
        }
      }
    }

    // If no content match found yet, keep as fallback (most recent pending with same toolName)
    if (!bestMatch) {
      bestMatch = store.approvals[i]
    }
  }
  return bestMatch
}

/**
 * Cleanup hook used by the long-poll route on requester disconnect.
 * Marks the approval as cleaned-up if it is still pending.
 *
 * @param {string} approvalId
 * @param {{ approvalsFile: string, persistToolInput: boolean }} cfg
 */
export function cleanupOnRequesterDisconnect(approvalId, cfg) {
  const record = store.approvalsById.get(approvalId)
  if (!record || record.status !== 'pending') return null
  return markApprovalCleanup(record, 'terminal-disconnect', 'terminal', new Date().toISOString(), cfg)
}

const HOOK_POLL_TIMEOUT_MS = 600_000
const HOOK_POLL_INTERVAL_MS = 2_000

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Wait for a pending approval to be decided (or for the requester to
 * disconnect). Polls the in-memory store at a fixed interval.
 *
 * Outcomes:
 *   - 'decided'        — approval reached `decided` status. record is the
 *                        latest snapshot. Caller should send the response
 *                        via buildHookResponseFromApproval(record).
 *   - 'disconnected'   — isDisconnected() returned true before a decision.
 *                        Caller is responsible for cleanup via
 *                        cleanupOnRequesterDisconnect.
 *   - 'timeout'        — poll deadline reached. Caller returns 200 {} so
 *                        Claude Code falls back to its native dialog.
 *
 * @param {{
 *   approvalId: string,
 *   isDisconnected: () => boolean,
 *   timeoutMs?: number,
 *   pollIntervalMs?: number,
 * }} params
 * @returns {Promise<{ outcome: 'decided'|'disconnected'|'timeout', record: import('../state/store.mjs').ApprovalRecord | null }>}
 */
export async function waitForDecision(params) {
  const {
    approvalId,
    isDisconnected,
    timeoutMs = HOOK_POLL_TIMEOUT_MS,
    pollIntervalMs = HOOK_POLL_INTERVAL_MS,
  } = params
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    await sleep(pollIntervalMs)
    if (isDisconnected()) {
      return { outcome: 'disconnected', record: store.approvalsById.get(approvalId) || null }
    }
    const record = store.approvalsById.get(approvalId)
    if (record && record.status === 'decided') {
      record.deliveredAt = new Date().toISOString()
      return { outcome: 'decided', record }
    }
  }
  return { outcome: 'timeout', record: store.approvalsById.get(approvalId) || null }
}

/**
 * Build the HTTP hook response from a decided approval. Returns a payload
 * suitable for sendJson(res, 200, body).
 *
 * - approve → allow
 * - deny → deny with `G2: <comment>` or default message
 * - other (e.g. cleanup observed mid-wait) → empty body so Claude Code
 *   shows its native dialog.
 *
 * @param {import('../state/store.mjs').ApprovalRecord} record
 */
export function buildHookResponseFromApproval(record) {
  if (!record) return { status: 200, body: {} }
  if (record.decision === 'approve') {
    return {
      status: 200,
      body: {
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: { behavior: 'allow' },
        },
      },
    }
  }
  if (record.decision === 'deny') {
    const message = record.comment ? `G2: ${record.comment}` : 'G2から拒否されました'
    return {
      status: 200,
      body: {
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest',
          decision: { behavior: 'deny', message },
        },
      },
    }
  }
  return { status: 200, body: {} }
}
