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
