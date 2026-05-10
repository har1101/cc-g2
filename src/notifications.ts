import { createHubHeaders } from './config'

/**
 * 通知ハブ API クライアント
 *
 * GET /api/notifications でポーリングし、通知一覧/詳細を取得する。
 */

export type NotificationItem = {
  id: string
  source: string
  title: string
  summary: string
  createdAt: string
  replyCapable: boolean
  metadata?: Record<string, unknown>
  /** 返信/承認ステータス: 'delivered'|'decided'|'replied'|'pending' */
  replyStatus?: string
}

export type NotificationDetail = NotificationItem & {
  fullText: string
  raw?: unknown
}

export type NotificationListResponse = {
  ok: boolean
  items: NotificationItem[]
}

export type NotificationDetailResponse = {
  ok: boolean
  item: NotificationDetail
}

export type NotificationReplyResponse = {
  ok: boolean
  reply?: {
    id: string
    status: string
    action?: string
    resolvedAction?: string
    result?: 'resolved' | 'relayed' | 'ignored'
    ignoredReason?: 'approval-not-pending' | 'approval-link-not-found'
    error?: string
  }
}

export type NotificationReplyRequest = {
  action: 'approve' | 'deny' | 'comment' | 'answer'
  comment?: string
  source?: 'g2' | 'web'
  /** AskUserQuestion の回答データ: { "質問テキスト": "選択ラベル" } */
  answerData?: Record<string, string>
  // ----- Phase 5 additions (optional, backward-compatible) -----
  /** Phase 5: required for `action='approve'` on `risk_tier='destructive'`
   *  notifications. Without this flag the Hub force-rewrites approve → deny. */
  two_step_confirmed?: boolean
  /** Phase 5: identifying device id for audit logs. */
  device_id?: string
  /** Phase 5: client-measured latency from request to user decision (ms). */
  latency_ms?: number
}

export type CommandRequest = {
  source: 'g2_voice' | 'g2_text'
  text: string
  transcript_confidence?: number
  tmux_target?: string
}

export type CommandResponse = {
  ok: boolean
  delivered_at?: string
  relay?: 'stubbed'
  error?: string
}

// ---------------------------------------------------------------------------
// Phase 3: SessionList API types
// ---------------------------------------------------------------------------

/**
 * Public projection of a project allowlist entry — `path` is server-side only
 * and never appears here. Returned by GET /api/v1/projects.
 */
export type ProjectMeta = {
  project_id: string
  label: string
  default_backend: 'claude-code' | 'codex-cli'
  start_template: 'claude' | 'codex'
}

export type AgentSession = {
  session_id: string
  label: string
  backend: 'claude-code' | 'codex-cli'
  project_id: string
  tmux_target: string
  status: 'idle' | 'working' | 'permission' | 'done' | 'error'
  created_at: string
  updated_at: string
  source: 'pull-to-new-session' | 'voice-entry' | 'manual'
}

export function createNotificationClient(baseUrl: string) {
  async function fetchJson<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${baseUrl}${path}`, init)
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`)
    return res.json() as Promise<T>
  }

  return {
    /**
     * List recent notifications. Phase 4: accepts an optional
     * `{ sessionId, limit }` object. Pre-Phase-4 callers passing a bare
     * `number` for limit keep working — we detect and translate.
     *
     * - When `sessionId` is omitted → returns all notifications (existing
     *   behaviour, unchanged for backwards compatibility).
     * - When `sessionId` is set → server filters via
     *   listNotificationsForSession() so the response only contains items
     *   bound to that AgentSession.
     */
    async list(opts?: number | { sessionId?: string; limit?: number }): Promise<NotificationItem[]> {
      const limit = typeof opts === 'number'
        ? opts
        : typeof opts?.limit === 'number'
          ? opts.limit
          : 20
      const sessionId = typeof opts === 'object' && opts ? opts.sessionId : undefined
      const params = new URLSearchParams()
      params.set('limit', String(limit))
      if (sessionId) params.set('session_id', sessionId)
      const res = await fetchJson<NotificationListResponse>(
        `/api/notifications?${params.toString()}`,
        { headers: createHubHeaders() },
      )
      return res.items
    },

    async detail(id: string): Promise<NotificationDetail> {
      const res = await fetchJson<NotificationDetailResponse>(
        `/api/notifications/${encodeURIComponent(id)}`,
        { headers: createHubHeaders() },
      )
      return res.item
    },

    async reply(
      id: string,
      reply: string | NotificationReplyRequest,
    ): Promise<NotificationReplyResponse> {
      const body =
        typeof reply === 'string'
          ? { replyText: reply }
          : {
              action: reply.action,
              comment: reply.comment,
              source: reply.source,
              answerData: reply.answerData,
              // Phase 5 optional fields. Only included when set so older
              // tests / payloads stay byte-equal.
              ...(reply.two_step_confirmed !== undefined ? { two_step_confirmed: reply.two_step_confirmed } : {}),
              ...(reply.device_id !== undefined ? { device_id: reply.device_id } : {}),
              ...(reply.latency_ms !== undefined ? { latency_ms: reply.latency_ms } : {}),
            }
      return fetchJson<NotificationReplyResponse>(
        `/api/notifications/${encodeURIComponent(id)}/reply`,
        {
          method: 'POST',
          headers: createHubHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify(body),
        },
      )
    },

    /**
     * Phase 5: acknowledge a hard-deny (permission-blocked) notification.
     * The agent has already received a deny response; this call is purely
     * for the user-facing G2 ack screen.
     */
    async ackBlocked(requestId: string, body: { source?: 'g2' | 'web'; device_id?: string } = {}): Promise<{ ok: boolean }> {
      return fetchJson<{ ok: boolean }>(
        `/api/v1/permissions/${encodeURIComponent(requestId)}/ack-blocked`,
        {
          method: 'POST',
          headers: createHubHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify(body),
        },
      )
    },

    async sendCommand(req: CommandRequest): Promise<CommandResponse> {
      return fetchJson<CommandResponse>(`/api/v1/command`, {
        method: 'POST',
        headers: createHubHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(req),
      })
    },

    // ----- Phase 3: SessionList API -----

    async listProjects(): Promise<ProjectMeta[]> {
      const res = await fetchJson<{ ok: boolean; items: ProjectMeta[] }>(
        '/api/v1/projects',
        { headers: createHubHeaders() },
      )
      return res.items || []
    },

    async listSessions(): Promise<AgentSession[]> {
      const res = await fetchJson<{ ok: boolean; items: AgentSession[] }>(
        '/api/v1/sessions',
        { headers: createHubHeaders() },
      )
      return res.items || []
    },

    async createSession(projectId: string, labelHint?: string): Promise<AgentSession> {
      const res = await fetchJson<{ ok: boolean; session: AgentSession }>(
        '/api/v1/sessions',
        {
          method: 'POST',
          headers: createHubHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({ project_id: projectId, label_hint: labelHint }),
        },
      )
      return res.session
    },

    async activateSession(sessionId: string): Promise<AgentSession> {
      const res = await fetchJson<{ ok: boolean; session: AgentSession }>(
        `/api/v1/sessions/${encodeURIComponent(sessionId)}/activate`,
        {
          method: 'POST',
          headers: createHubHeaders({ 'Content-Type': 'application/json' }),
          body: JSON.stringify({}),
        },
      )
      return res.session
    },

    /**
     * Phase 4: GET /api/v1/sessions/active-summary
     *
     * Returns the Hub's current active_session_id (or null) and a map of
     * pending-approval counts keyed by AgentSession id, excluding the active
     * session. The polling controller hits this each tick so SessionList can
     * render `(active)` + `(N pending)` badges without computing counts
     * client-side from the full notifications list.
     */
    async fetchActiveSummary(): Promise<{
      activeSessionId: string | null
      pendingCountsByOtherSession: Record<string, number>
    }> {
      const res = await fetchJson<{
        ok: boolean
        active_session_id: string | null
        pending_counts_by_other_session: Record<string, number>
      }>('/api/v1/sessions/active-summary', { headers: createHubHeaders() })
      return {
        activeSessionId: res.active_session_id || null,
        pendingCountsByOtherSession: res.pending_counts_by_other_session || {},
      }
    },
  }
}
