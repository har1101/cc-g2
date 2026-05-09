// /api/notifications, /api/notifications/:id, /api/notifications/:id/reply
import { randomUUID } from 'node:crypto'
import { getString, readRequestBody, safeJsonParse } from '../notification-utils.mjs'
import { isBodyTooLargeError, sendJson, sendRequestBodyTooLarge } from '../core/http.mjs'
import { log } from '../core/log.mjs'
import * as store from '../state/store.mjs'
import { appendJsonl } from '../state/persistence.mjs'
import { listNotifications } from '../services/notification-service.mjs'

function matchNotificationDetail(pathname) {
  const m = pathname.match(/^\/api\/notifications\/([^/]+)$/)
  return m ? decodeURIComponent(m[1]) : null
}

function matchNotificationReply(pathname) {
  const m = pathname.match(/^\/api\/notifications\/([^/]+)\/reply$/)
  return m ? decodeURIComponent(m[1]) : null
}

export async function handle(req, res, ctx) {
  const { method, pathname, url, deps } = ctx

  if (method === 'GET' && pathname === '/api/notifications') {
    const limitRaw = Number(url.searchParams.get('limit') || '20')
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.floor(limitRaw), 1), 100) : 20
    sendJson(res, 200, { ok: true, items: listNotifications(limit) })
    return true
  }

  if (method === 'GET') {
    const id = matchNotificationDetail(pathname)
    if (id) {
      const item = store.notificationsById.get(id)
      if (!item) {
        sendJson(res, 404, { ok: false, error: 'Notification not found' })
        return true
      }
      sendJson(res, 200, { ok: true, item })
      return true
    }
  }

  if (method === 'POST') {
    const id = matchNotificationReply(pathname)
    if (!id) return false
    const item = store.notificationsById.get(id)
    if (!item) {
      sendJson(res, 404, { ok: false, error: 'Notification not found' })
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
    const replyTextRaw = getString(parsed.value.replyText)
    const action = getString(parsed.value.action)
    const comment = getString(parsed.value.comment)
    const source = getString(parsed.value.source)

    // answerData バリデーション: plain object, キー/値とも string, 上限付き
    let answerData = undefined
    if (parsed.value.answerData && typeof parsed.value.answerData === 'object' && !Array.isArray(parsed.value.answerData)) {
      const entries = Object.entries(parsed.value.answerData)
      if (entries.length <= 10 && entries.every(([k, v]) => typeof k === 'string' && typeof v === 'string' && k.length <= 2000 && v.length <= 2000)) {
        answerData = parsed.value.answerData
      }
    }

    const validActions = new Set(['approve', 'deny', 'comment', 'answer'])
    if (action && !validActions.has(action)) {
      sendJson(res, 400, { ok: false, error: 'Invalid `action`' })
      return true
    }
    if (action === 'answer') {
      if (!answerData) {
        sendJson(res, 400, { ok: false, error: '`answerData` is required for action=answer' })
        return true
      }
      const isAskQ = item.metadata && item.metadata.hookType === 'ask-user-question'
      if (!isAskQ) {
        sendJson(res, 400, { ok: false, error: 'action=answer is only valid for ask-user-question notifications' })
        return true
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
      sendJson(res, 400, {
        ok: false,
        error: '`replyText` or (`action` + optional `comment`) is required',
      })
      return true
    }

    /** @type {import('../state/store.mjs').ReplyRecord} */
    const record = {
      id: randomUUID(),
      notificationId: id,
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
    let linkedApproval = store.approvalsByNotificationId.get(id)
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
      const replyToolName = (item.metadata && item.metadata.toolName) || ''
      const replyTitle = item.title || ''
      const replySummary = item.summary || ''
      const replyFullText = item.fullText || ''

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

      linkedApproval = bestMatch
      if (linkedApproval) {
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
        deps.resolveApproval(linkedApproval.id, 'deny', answerComment, source || 'g2')
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
        deps.resolveApproval(linkedApproval.id, resolvedAction, comment, source || 'g2')
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
        deps.resolveApproval(linkedApproval.id, 'deny', commentText, source || 'g2')
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
        log(`reply relay skipped: approval link not found notificationId=${id} action=${action || 'none'}`)
      }
    }

    if (!record.result) {
      record.result = 'relayed'
    }

    const fwd = await deps.forwardReplyIfConfigured({
      reply: record,
      notification: {
        id: item.id,
        title: item.title,
        summary: item.summary,
        metadata: item.metadata,
      },
    })
    const relay = shouldRelay
      ? await deps.relayReplyIfConfigured({
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
    store.replies.push(record)
    await appendJsonl(deps.repliesFile, record)

    log(
      `reply accepted id=${record.id} notificationId=${record.notificationId} status=${record.status}${record.action ? ` action=${record.action}` : ''}${record.error ? ` error=${record.error}` : ''}`,
    )
    sendJson(res, 200, { ok: true, reply: record })
    return true
  }

  return false
}
