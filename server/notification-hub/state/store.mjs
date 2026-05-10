// Single source of mutable in-memory state for the notification hub.
// Services mutate via this module; routes never touch it directly.
//
// Exported as `const` collections so they can be imported and mutated
// in place; primitive scalars (lastLocation) are exposed via getters/setters.

/** @typedef {{id:string,source:'moshi'|'claude-code',title:string,summary:string,fullText:string,createdAt:string,replyCapable:boolean,raw?:unknown,metadata?:Record<string, unknown>}} NotificationItem */
/** @typedef {{id:string,notificationId:string,replyText:string,createdAt:string,status:'stubbed'|'forwarded'|'failed',action?:'approve'|'deny'|'comment',resolvedAction?:'approve'|'deny'|'comment',result?:'resolved'|'relayed'|'ignored',ignoredReason?:'approval-not-pending'|'approval-link-not-found',comment?:string,source?:string,error?:string}} ReplyRecord */
/** @typedef {{id:string,notificationId:string,source:string,toolName:string,toolInput:unknown,toolId:string,cwd:string,reason:string,agentName:string,status:'pending'|'decided'|'expired',decision?:'approve'|'deny',resolution?:'superseded'|'session-ended'|'terminal-disconnect',comment?:string,decidedBy?:string,createdAt:string,decidedAt?:string,deliveredAt?:string}} ApprovalRecord */
/**
 * Phase 3: AgentSession represents a tmux-backed Claude Code / Codex session
 * registered via /api/v1/sessions. project_path is intentionally absent here:
 * it is server-side only and lives in the projects.json allowlist.
 *
 * @typedef {{
 *   session_id: string,
 *   label: string,
 *   backend: 'claude-code' | 'codex-cli',
 *   project_id: string,
 *   tmux_target: string,
 *   status: 'idle' | 'working' | 'permission' | 'done' | 'error',
 *   created_at: string,
 *   updated_at: string,
 *   source: 'pull-to-new-session' | 'voice-entry' | 'manual'
 * }} AgentSession
 */

/** @type {NotificationItem[]} */
export const notifications = []
/** @type {Map<string, NotificationItem>} */
export const notificationsById = new Map()
/** @type {ReplyRecord[]} */
export const replies = []
/** @type {Set<string>} */
export const notificationExternalIds = new Set()
/** @type {Map<string, number>} */
export const permissionThreadSeenAt = new Map()
/** @type {Map<string, {sessionId:string,cwd:string,usedPercentage:number,model:string,updatedAt:string}>} */
export const contextStatusBySession = new Map()
/** @type {ApprovalRecord[]} */
export const approvals = []
/** @type {Map<string, ApprovalRecord>} */
export const approvalsById = new Map()
/** @type {Map<string, ApprovalRecord>} */
export const approvalsByNotificationId = new Map()

/** @type {{lat:number,lng:number,altitude:number|null,timestamp:string,speed:number|null,battery:number|null,receivedAt:string}|null} */
let _lastLocation = null

export function getLastLocation() {
  return _lastLocation
}

export function setLastLocation(loc) {
  _lastLocation = loc
}

// ---------------------------------------------------------------------------
// Phase 3: AgentSession registry
// ---------------------------------------------------------------------------
/** @type {Map<string, AgentSession>} */
export const sessions = new Map()
/** @type {string | null} */
let _activeSessionId = null

export function getActiveSessionId() {
  return _activeSessionId
}

export function setActiveSessionId(id) {
  _activeSessionId = id
}

// ---------------------------------------------------------------------------
// Phase 4: per-session indexing helpers.
//
// We keep the existing flat arrays (`notifications`, `approvals`, ...) as the
// canonical source of truth — splitting storage in-place would force every
// existing route + persistence path to migrate. Instead Phase 4 stamps each
// approval-linked notification with `metadata.agentSessionId` and the helpers
// below do the per-session filtering on read.
//
// Helpers live in store.mjs (not session-service) so the DAG remains
// notification/approval/session-router → store with no upward edges.
// ---------------------------------------------------------------------------

/**
 * Pull `metadata.agentSessionId` off a notification when present. Returns the
 * trimmed string or null. Centralised so the comparison logic stays consistent
 * across routes/services.
 * @param {NotificationItem | null | undefined} item
 * @returns {string | null}
 */
function notificationSessionId(item) {
  const v = item && item.metadata ? item.metadata.agentSessionId : null
  if (typeof v !== 'string') return null
  const trimmed = v.trim()
  return trimmed ? trimmed : null
}

/**
 * List notifications belonging to a specific AgentSession id. Order matches
 * `services/notification-service.listNotifications` (newest first, by
 * createdAt). When sessionId is `null`, all notifications are returned.
 *
 * @param {string | null} sessionId
 * @returns {NotificationItem[]}
 */
export function listNotificationsForSession(sessionId) {
  const sorted = [...notifications].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
  if (!sessionId) return sorted
  return sorted.filter((item) => notificationSessionId(item) === sessionId)
}

/**
 * List pending approvals scoped to a single AgentSession id. When sessionId
 * is `null`, all pending approvals are returned (legacy behaviour).
 *
 * @param {string | null} sessionId
 * @returns {ApprovalRecord[]}
 */
export function listPendingApprovalsForSession(sessionId) {
  const out = []
  for (const a of approvals) {
    if (a.status !== 'pending') continue
    if (!sessionId) {
      out.push(a)
      continue
    }
    const n = notificationsById.get(a.notificationId)
    if (n && notificationSessionId(n) === sessionId) out.push(a)
  }
  return out
}

/**
 * Build a map of session_id → pending-approval count, excluding the supplied
 * activeSessionId (used by SessionList to render `(N pending)` badges on
 * non-active rows). Notifications without an agentSessionId are bucketed
 * under the literal id 'unknown' and surfaced like any other session.
 *
 * Codex 4 #4: when `activeSessionId` is null/undefined (no session pinned
 * as active), the truthy guard short-circuits and ALL pending approvals
 * are counted, including ones that would belong to an active session if
 * one were selected. This is intentional — the SessionList shows badges
 * for every session with pending work when no row is active — but it is
 * a subtle behavior worth pinning in tests if it ever changes.
 *
 * @param {string | null} activeSessionId
 * @returns {Map<string, number>}
 */
export function pendingApprovalCountByOtherSessions(activeSessionId) {
  /** @type {Map<string, number>} */
  const counts = new Map()
  for (const a of approvals) {
    if (a.status !== 'pending') continue
    const n = notificationsById.get(a.notificationId)
    const sid = notificationSessionId(n) || 'unknown'
    if (activeSessionId && sid === activeSessionId) continue
    counts.set(sid, (counts.get(sid) || 0) + 1)
  }
  return counts
}
