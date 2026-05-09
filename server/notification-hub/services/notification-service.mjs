// Notification service: owns the lifecycle of NotificationItems and replies.
// May call: state/store, state/persistence, core/log, notification-utils.
// Must NOT call: approval-service, command-service, routes/*.
//
// processReply() orchestrates approval matching/resolution but receives the
// approval-side helpers (matchPendingApprovalForReply, resolveApproval) via
// the cfg parameter so this module stays free of upward imports.
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
 * End-to-end reply processing for POST /api/notifications/:id/reply.
 * Owns: validation of action/answerData, approval matching + resolution,
 * forward + relay invocation, status reduction, persistence, and logging.
 *
 * Routes pass through HTTP plumbing only; all business logic lives here.
 *
 * @param {{
 *   notificationId: string,
 *   body: any,            // already JSON.parse'd request body
 * }} input
 * @param {{
 *   matchPendingApprovalForReply: (params: { replyText: string, notification: import('../state/store.mjs').NotificationItem }) => import('../state/store.mjs').ApprovalRecord | null,
 *   resolveApproval: (id: string, decision: 'approve'|'deny', comment: string|undefined, decidedBy: string|undefined) => unknown,
 *   forwardReplyIfConfigured: (params: { reply: import('../state/store.mjs').ReplyRecord, notification: any }) => Promise<{ status: string, error?: string }>,
 *   relayReplyIfConfigured: (params: { reply: import('../state/store.mjs').ReplyRecord, notification: any }) => Promise<{ status: string, error?: string }>,
 *   repliesFile: string,
 * }} cfg
 * @returns {Promise<{ status: number, body: any }>}
 */
export async function processReply(input, cfg) {
  const { notificationId, body } = input
  const item = store.notificationsById.get(notificationId)
  if (!item) {
    return { status: 404, body: { ok: false, error: 'Notification not found' } }
  }
  if (!body || typeof body !== 'object') {
    return { status: 400, body: { ok: false, error: 'Invalid JSON body' } }
  }
  const replyTextRaw = typeof body.replyText === 'string' ? body.replyText : ''
  const action = typeof body.action === 'string' ? body.action : ''
  const comment = typeof body.comment === 'string' ? body.comment : ''
  const source = typeof body.source === 'string' ? body.source : ''

  // answerData バリデーション: plain object, キー/値とも string, 上限付き
  let answerData = undefined
  if (body.answerData && typeof body.answerData === 'object' && !Array.isArray(body.answerData)) {
    const entries = Object.entries(body.answerData)
    if (entries.length <= 10 && entries.every(([k, v]) => typeof k === 'string' && typeof v === 'string' && k.length <= 2000 && v.length <= 2000)) {
      answerData = body.answerData
    }
  }

  const validActions = new Set(['approve', 'deny', 'comment', 'answer'])
  if (action && !validActions.has(action)) {
    return { status: 400, body: { ok: false, error: 'Invalid `action`' } }
  }
  if (action === 'answer') {
    if (!answerData) {
      return { status: 400, body: { ok: false, error: '`answerData` is required for action=answer' } }
    }
    const isAskQ = item.metadata && item.metadata.hookType === 'ask-user-question'
    if (!isAskQ) {
      return { status: 400, body: { ok: false, error: 'action=answer is only valid for ask-user-question notifications' } }
    }
  }

  const replyText =
    replyTextRaw ||
    (action === 'approve' ? '[ACTION] approve' : '') ||
    (action === 'deny' ? '[ACTION] deny' : '') ||
    (action === 'answer' ? '[ACTION] answer' : '') ||
    (action === 'comment' ? comment : '') ||
    ''
  if (!replyText) {
    return {
      status: 400,
      body: {
        ok: false,
        error: '`replyText` or (`action` + optional `comment`) is required',
      },
    }
  }

  /** @type {import('../state/store.mjs').ReplyRecord} */
  const record = {
    id: randomUUID(),
    notificationId,
    replyText,
    createdAt: new Date().toISOString(),
    status: 'stubbed',
    action: action ? /** @type {'approve'|'deny'|'comment'} */ (action) : undefined,
    resolvedAction: undefined,
    result: undefined,
    ignoredReason: undefined,
    comment: comment || undefined,
    source: source || undefined,
  }
  let linkedApproval = store.approvalsByNotificationId.get(notificationId)
  const isAskUserQuestion = item.metadata && item.metadata.hookType === 'ask-user-question'
  const isApprovalNotification =
    isAskUserQuestion ||
    (item.metadata && item.metadata.hookType === 'permission-request') ||
    (item.metadata && item.metadata.approvalId)
  let shouldRelay = true
  // Fallback: if no direct link but notification looks like an approval,
  // find a matching pending approval by content similarity.
  // MOSHI notifications don't carry approvalId, so we match by toolName
  // and file path / command to avoid resolving the wrong approval.
  if (!linkedApproval && isApprovalNotification) {
    linkedApproval = cfg.matchPendingApprovalForReply({ replyText, notification: item })
    if (linkedApproval) {
      const replyToolName = (item.metadata && item.metadata.toolName) || ''
      const matchType = replyToolName ? 'content' : 'most-recent'
      log(`approval-broker fallback: matched reply to approval id=${linkedApproval.id} (${matchType} match, no direct link)`)
    }
  }
  if (linkedApproval && linkedApproval.status === 'pending') {
    // AskUserQuestion の回答: deny+コメントとして返す（PermissionRequest経由でClaude Codeに届く）
    if (action === 'answer' && answerData && isAskUserQuestion) {
      linkedApproval.answerData = answerData
      const answerPairs = Object.entries(answerData).map(([q, a]) => `${q} → ${a}`)
      const answerComment = `選択回答: ${answerPairs.join(' / ')}`
      record.resolvedAction = 'deny'
      record.result = 'resolved'
      cfg.resolveApproval(linkedApproval.id, 'deny', answerComment, source || 'g2')
      log(`ask-user-question answered id=${linkedApproval.id} answers=${JSON.stringify(answerData)}`)
      shouldRelay = false
    }
    // Resolve approval: explicit approve/deny actions, or parse comment text
    let resolvedAction = null
    if (action === 'answer') {
      // already handled above
    } else if (action === 'approve' || action === 'deny') {
      resolvedAction = action
    } else if (action === 'comment' || !action) {
      // G2 sends comments (not explicit approve/deny buttons).
      // Parse comment text for intent keywords. If no keyword matches,
      // do NOT resolve the approval — let the comment be relayed as plain text
      // to the Claude Code input. Explicit approve/deny buttons should be used
      // for approval decisions.
      const text = (comment || replyText || '').toLowerCase().trim()
      const denyPatterns = ['拒否', 'deny', 'no', 'reject', 'だめ', 'ダメ', 'いいえ']
      const approvePatterns = ['承認', 'approve', 'yes', 'ok', 'おk', 'いいよ', 'はい', '許可']
      if (denyPatterns.some((p) => text.includes(p))) {
        resolvedAction = 'deny'
      } else if (approvePatterns.some((p) => text.includes(p))) {
        resolvedAction = 'approve'
      }
      // else: no keyword match → resolvedAction stays null → approval not resolved
      // comment is still relayed to tmux as plain text input
    }
    if (resolvedAction) {
      record.resolvedAction = resolvedAction
      record.result = 'resolved'
      cfg.resolveApproval(linkedApproval.id, resolvedAction, comment, source || 'g2')
      log(
        `approval-broker resolved id=${linkedApproval.id} action=${resolvedAction} (original=${action || 'none'} text=${(comment || replyText || '').slice(0, 50)})`,
      )
      // HTTP hook が承認を解決済みなので tmux relay は不要。
      // relay すると承認ダイアログ消失後に y/n キーが入力欄に漏れる。
      shouldRelay = false
    } else if (action === 'comment') {
      // Comment without keyword match on an approval notification:
      // HTTP hook 経由の場合は deny + comment として approval を解決し、
      // HTTP レスポンスで Claude Code に返す。tmux relay は不要。
      const commentText = comment || replyText || ''
      record.resolvedAction = 'deny'
      record.result = 'resolved'
      cfg.resolveApproval(linkedApproval.id, 'deny', commentText, source || 'g2')
      log(
        `approval-broker resolved as deny+comment id=${linkedApproval.id} text=${commentText.slice(0, 50)}`,
      )
      shouldRelay = false
    }
  } else if (isApprovalNotification) {
    // Stale/ambiguous approval replies must not be relayed to tmux.
    // Otherwise an old "approve" tap can affect a newer pending prompt.
    shouldRelay = false
    record.result = 'ignored'
    if (linkedApproval) {
      record.ignoredReason = 'approval-not-pending'
      record.error = 'Approval is no longer pending'
      log(
        `reply relay skipped: approval already decided id=${linkedApproval.id} action=${action || 'none'}`,
      )
    } else {
      record.ignoredReason = 'approval-link-not-found'
      record.error = 'Approval link not found'
      log(`reply relay skipped: approval link not found notificationId=${notificationId} action=${action || 'none'}`)
    }
  }

  if (!record.result) {
    record.result = 'relayed'
  }

  const fwd = await cfg.forwardReplyIfConfigured({
    reply: record,
    notification: {
      id: item.id,
      title: item.title,
      summary: item.summary,
      metadata: item.metadata,
    },
  })
  const relay = shouldRelay
    ? await cfg.relayReplyIfConfigured({
        reply: record,
        notification: {
          id: item.id,
          title: item.title,
          summary: item.summary,
          metadata: item.metadata,
        },
      })
    : { status: 'stubbed' }
  const statuses = [fwd.status, relay.status]
  if (statuses.includes('failed')) record.status = 'failed'
  else if (statuses.includes('forwarded')) record.status = 'forwarded'
  else record.status = 'stubbed'
  const errors = [fwd.error, relay.error].filter(Boolean)
  if (errors.length > 0) record.error = [record.error, ...errors].filter(Boolean).join(' | ')
  await persistReply(record, { repliesFile: cfg.repliesFile })

  log(
    `reply accepted id=${record.id} notificationId=${record.notificationId} status=${record.status}${record.action ? ` action=${record.action}` : ''}${record.error ? ` error=${record.error}` : ''}`,
  )
  return { status: 200, body: { ok: true, reply: record } }
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
