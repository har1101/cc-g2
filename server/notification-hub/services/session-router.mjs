// Phase 4: session-router. Resolves the originating AgentSession for an
// inbound hook event (header-priority lookup) and provides reverse lookup
// from a session_id to the tmux pane target used by tmux-relay.
//
// Allowed dependencies (DAG):
//   session-router → state/store + core/log
// session-router must NOT import services/* upward — routes/* and
// services/notification-service consume it via the deps closure in index.mjs.

import { log } from '../core/log.mjs'
import * as store from '../state/store.mjs'

/**
 * Strict shape for a header-supplied session id. Same regex used by
 * session-service.registerSession so a hook header cannot smuggle a value
 * that wouldn't survive registration.
 *
 * Length is bounded [6, 128] — anything shorter is almost certainly garbage
 * (UUID is 36, voice-entry ids are >= 12) and should fall through to the
 * tmux-target reverse lookup rather than overwrite a real bucket.
 */
const SESSION_ID_REGEX = /^[A-Za-z0-9_-]{6,128}$/

/**
 * Hook routing fallback id when no header matches a real session and the
 * tmux-target reverse lookup also fails. Kept stable so existing tests +
 * audit logs see a single deterministic value.
 */
export const UNKNOWN_SESSION_ID = 'unknown'

/**
 * Validate a candidate session id string. Returns the trimmed value if it
 * passes, or null otherwise.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
export function validateSessionId(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed) return null
  if (!SESSION_ID_REGEX.test(trimmed)) return null
  return trimmed
}

/**
 * Reverse lookup: find the AgentSession whose tmux_target matches the
 * supplied target string. Used as a fallback when the X-Agent-Session-Id
 * header is missing but X-Tmux-Target is present.
 *
 * @param {string} tmuxTarget
 * @returns {string | null}
 */
function findSessionIdByTmuxTarget(tmuxTarget) {
  if (!tmuxTarget) return null
  for (const [id, session] of store.sessions) {
    if (session && session.tmux_target === tmuxTarget) return id
  }
  return null
}

/**
 * Resolve the AgentSession id for an inbound hook request.
 *
 * Priority order:
 *   1. X-Agent-Session-Id header (validated against SESSION_ID_REGEX). If the
 *      header is present but malformed, log a warning and continue to the
 *      next step rather than echoing the bad value into routing state.
 *   2. X-Tmux-Target header → reverse lookup against store.sessions.
 *   3. UNKNOWN_SESSION_ID (preserves existing behaviour for hooks that pre-
 *      date Phase 4).
 *
 * @param {{ headers: Record<string, string | string[] | undefined> }} req
 * @returns {string}
 */
export function resolveSessionId(req) {
  const headers = req && req.headers ? req.headers : {}

  const rawHeader = pickHeader(headers, 'x-agent-session-id')
  if (rawHeader) {
    const validated = validateSessionId(rawHeader)
    if (validated) {
      // Even if the id isn't (yet) registered we honour the header — the
      // session might register itself shortly, and per-session indexing
      // tolerates unknown ids.
      return validated
    }
    // Bad header values are noisy in logs (codex hook may forward whatever
    // the parent shell sets), so cap the value we echo.
    log(
      `[session-router] rejecting malformed X-Agent-Session-Id header: ${
        String(rawHeader).slice(0, 64)
      }`,
    )
  }

  const tmuxTarget = pickHeader(headers, 'x-tmux-target')
  if (tmuxTarget) {
    const fallback = findSessionIdByTmuxTarget(tmuxTarget)
    if (fallback) return fallback
  }

  return UNKNOWN_SESSION_ID
}

/**
 * Reverse lookup used by notification-service.processReply to obtain a
 * tmux_target for relay. Returns null when no session is registered (caller
 * falls back to the legacy notification.metadata.tmuxTarget path).
 *
 * @param {string | null | undefined} sessionId
 * @returns {string | null}
 */
export function resolveTmuxTarget(sessionId) {
  if (!sessionId || sessionId === UNKNOWN_SESSION_ID) return null
  const session = store.sessions.get(sessionId)
  if (!session) return null
  const tmuxTarget = session.tmux_target
  return typeof tmuxTarget === 'string' && tmuxTarget ? tmuxTarget : null
}

/**
 * Helper: read a single header value regardless of whether Node parsed it
 * as a string or an array (rare for these headers, but defensive).
 */
function pickHeader(headers, name) {
  const v = headers[name]
  if (Array.isArray(v)) return v[0] || ''
  if (typeof v === 'string') return v
  return ''
}
