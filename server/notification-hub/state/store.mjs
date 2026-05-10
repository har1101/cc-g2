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
