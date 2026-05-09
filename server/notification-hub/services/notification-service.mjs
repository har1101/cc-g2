// Notification service: owns the lifecycle of NotificationItems and replies.
// May call: state/store, state/persistence, core/log, notification-utils.
// Must NOT call: approval-service, command-service, routes/*.
import { randomUUID } from 'node:crypto'
import { log } from '../core/log.mjs'
import { normalizeMoshiPayload, persistedNotification } from '../notification-utils.mjs'
import * as store from '../state/store.mjs'
import { appendJsonl } from '../state/persistence.mjs'

/**
 * Add a notification with dedup (externalId + permission-thread TTL).
 * Persists the notification to JSONL.
 *
 * @param {unknown} payload                                       raw moshi-shaped payload
 * @param {string} [logPrefix]                                    log line prefix
 * @param {{
 *   persistRaw: boolean,
 *   permissionThreadDedupMs: number,
 *   notificationsFile: string,
 * }} cfg
 * @returns {Promise<{ ok: true, duplicate: boolean, item: import('../state/store.mjs').NotificationItem }>}
 */
export async function addNotification(payload, logPrefix = 'notification', cfg) {
  const item = normalizeMoshiPayload(payload, {
    persistRaw: cfg.persistRaw,
    createId: () => randomUUID(),
  })
  const extId =
    item && item.metadata && typeof item.metadata.externalId === 'string'
      ? item.metadata.externalId
      : ''
  const hookType =
    item && item.metadata && typeof item.metadata.hookType === 'string'
      ? item.metadata.hookType
      : ''
  const threadId =
    item && item.metadata && typeof item.metadata.threadId === 'string'
      ? item.metadata.threadId
      : ''
  const hasApprovalId =
    item &&
    item.metadata &&
    (typeof item.metadata.approvalId === 'string' ||
      typeof item.metadata.approvalId === 'number')

  // Some hook-originated notifications can arrive almost simultaneously from
  // multiple hook sources. Dedup by threadId only in a short TTL window to avoid
  // dropping legitimate later events.
  if (
    cfg.permissionThreadDedupMs > 0 &&
    (hookType === 'permission-request' || hookType === 'stop') &&
    !hasApprovalId &&
    threadId
  ) {
    const nowMs = Date.now()
    const lastMs = store.permissionThreadSeenAt.get(threadId) || 0
    if (nowMs - lastMs < cfg.permissionThreadDedupMs) {
      return { ok: true, duplicate: true, item }
    }
    store.permissionThreadSeenAt.set(threadId, nowMs)
  }

  if (extId && store.notificationExternalIds.has(extId)) {
    return { ok: true, duplicate: true, item }
  }

  store.notifications.push(item)
  store.notificationsById.set(item.id, item)
  if (extId) store.notificationExternalIds.add(extId)
  await appendJsonl(cfg.notificationsFile, persistedNotification(item, { persistRaw: cfg.persistRaw }))

  log(
    `${logPrefix} received id=${item.id} title=${JSON.stringify(item.title)} summary=${JSON.stringify(item.summary)}`,
  )
  return { ok: true, duplicate: false, item }
}

/**
 * Compute the surfaced reply status for a notification: 'delivered',
 * 'decided', 'pending', 'replied' or undefined.
 */
export function getReplyStatus(item) {
  const approval = store.approvalsByNotificationId.get(item.id)
  if (approval) {
    if (approval.deliveredAt) return 'delivered'
    if (approval.status === 'decided') return 'decided'
    return 'pending'
  }
  const hasReply = store.replies.some((r) => r.notificationId === item.id)
  if (hasReply) return 'replied'
  // 非approval通知（stop hookなど）: 同セッションの新しい通知があれば暗黙的に対応済み
  // PC側のコメントはHubを経由しないため、後続通知の存在で判定する
  // sessionIdがない通知（stop hookなど）はtmuxTargetとcwdで同一セッション判定
  if (item.replyCapable && item.metadata) {
    const sid = item.metadata.sessionId
    const tmux = item.metadata.tmuxTarget
    const cwd = item.metadata.cwd
    const t = new Date(item.createdAt).getTime()
    const isSameSession = (n) => {
      if (!n.metadata) return false
      if (sid && n.metadata.sessionId === sid) return true
      if (tmux && n.metadata.tmuxTarget === tmux) return true
      if (!sid && !tmux && cwd && n.metadata.cwd === cwd) return true
      return false
    }
    const hasNewer = store.notifications.some((n) =>
      n.id !== item.id && isSameSession(n) && new Date(n.createdAt).getTime() > t,
    )
    if (hasNewer) return 'delivered'
  }
  return undefined
}

export function getNotification(id) {
  return store.notificationsById.get(id) || null
}

export function listNotifications(limit) {
  const sorted = [...store.notifications].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  return sorted.slice(0, limit).map((item) => ({
    id: item.id,
    source: item.source,
    title: item.title,
    summary: item.summary,
    createdAt: item.createdAt,
    replyCapable: item.replyCapable,
    metadata: item.metadata,
    replyStatus: getReplyStatus(item),
  }))
}

/**
 * Persist a reply record to the in-memory store and JSONL.
 * @param {import('../state/store.mjs').ReplyRecord} record
 * @param {{ repliesFile: string }} cfg
 */
export async function persistReply(record, cfg) {
  store.replies.push(record)
  await appendJsonl(cfg.repliesFile, record)
}

/**
 * Forward a reply to an external HTTP webhook (MOSHI_REPLY_WEBHOOK_URL).
 * Pure transport with no state dependency, but lives in the notification
 * service since it is logically tied to reply lifecycle.
 */
export async function forwardReplyIfConfigured(record) {
  const url = process.env.MOSHI_REPLY_WEBHOOK_URL
  if (!url) {
    return { status: 'stubbed' }
  }
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(record),
    })
    if (!resp.ok) {
      return { status: 'failed', error: `HTTP ${resp.status}` }
    }
    return { status: 'forwarded' }
  } catch (err) {
    return { status: 'failed', error: err instanceof Error ? err.message : String(err) }
  }
}
