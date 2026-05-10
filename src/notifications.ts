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
    async list(limit = 20): Promise<NotificationItem[]> {
      const res = await fetchJson<NotificationListResponse>(
        `/api/notifications?limit=${limit}`,
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
  }
}
