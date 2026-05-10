import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  resolveSessionId,
  resolveTmuxTarget,
  UNKNOWN_SESSION_ID,
  validateSessionId,
} from '../server/notification-hub/services/session-router.mjs'
import * as store from '../server/notification-hub/state/store.mjs'

// Phase 4 — services/session-router resolves the AgentSession id for an
// inbound hook request using the precedence:
//   1. X-Agent-Session-Id header (validated against the strict regex)
//   2. X-Tmux-Target header → reverse lookup against store.sessions
//   3. UNKNOWN_SESSION_ID
//
// These tests pin that precedence and ensure malformed values fall through
// without corrupting routing state.

function makeReq(headers) {
  return { headers: headers || {} }
}

describe('Phase 4 — session-router', () => {
  let originalSessions
  let originalActive

  beforeEach(() => {
    originalSessions = new Map(store.sessions)
    originalActive = store.getActiveSessionId()
    store.sessions.clear()
    store.setActiveSessionId(null)
  })

  afterEach(() => {
    store.sessions.clear()
    for (const [id, s] of originalSessions) store.sessions.set(id, s)
    store.setActiveSessionId(originalActive)
  })

  describe('resolveSessionId', () => {
    it('returns the X-Agent-Session-Id header value when valid', () => {
      const id = 'abc123-valid-session-id'
      const out = resolveSessionId(makeReq({ 'x-agent-session-id': id }))
      expect(out).toBe(id)
    })

    it('falls through to UNKNOWN when X-Agent-Session-Id is malformed', () => {
      // Special characters fail the SESSION_ID_REGEX
      const bad = 'bad chars!'
      const out = resolveSessionId(makeReq({ 'x-agent-session-id': bad }))
      expect(out).toBe(UNKNOWN_SESSION_ID)
    })

    it('falls through to UNKNOWN when X-Agent-Session-Id is too short', () => {
      const tooShort = 'abc' // < 6 chars
      const out = resolveSessionId(makeReq({ 'x-agent-session-id': tooShort }))
      expect(out).toBe(UNKNOWN_SESSION_ID)
    })

    it('uses X-Tmux-Target as fallback when header is absent', () => {
      const target = 'cc-g2-myproject:0.0'
      const sid = 'session-from-tmux'
      store.sessions.set(sid, {
        session_id: sid,
        label: 'tmux-test',
        backend: 'claude-code',
        project_id: '_unmanaged',
        tmux_target: target,
        status: 'idle',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        source: 'manual',
      })
      const out = resolveSessionId(makeReq({ 'x-tmux-target': target }))
      expect(out).toBe(sid)
    })

    it('returns UNKNOWN when header absent and X-Tmux-Target does not match a session', () => {
      const out = resolveSessionId(makeReq({ 'x-tmux-target': 'g2-not-registered:0.0' }))
      expect(out).toBe(UNKNOWN_SESSION_ID)
    })

    it('returns UNKNOWN when both headers are absent', () => {
      const out = resolveSessionId(makeReq({}))
      expect(out).toBe(UNKNOWN_SESSION_ID)
    })

    it('prefers X-Agent-Session-Id over X-Tmux-Target reverse lookup', () => {
      const tmuxTarget = 'g2-real:0.0'
      store.sessions.set('tmux-session-id', {
        session_id: 'tmux-session-id',
        label: 'tmux-side',
        backend: 'claude-code',
        project_id: '_unmanaged',
        tmux_target: tmuxTarget,
        status: 'idle',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        source: 'manual',
      })
      const out = resolveSessionId(
        makeReq({ 'x-agent-session-id': 'header-priority-id', 'x-tmux-target': tmuxTarget }),
      )
      expect(out).toBe('header-priority-id')
    })

    it('falls through to tmux fallback when header is malformed but tmux matches', () => {
      const tmux = 'g2-fallback:0.0'
      const sid = 'session-fallback-id'
      store.sessions.set(sid, {
        session_id: sid,
        label: 'fallback',
        backend: 'claude-code',
        project_id: '_unmanaged',
        tmux_target: tmux,
        status: 'idle',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        source: 'manual',
      })
      const out = resolveSessionId(
        makeReq({ 'x-agent-session-id': 'has spaces!!', 'x-tmux-target': tmux }),
      )
      expect(out).toBe(sid)
    })
  })

  describe('resolveTmuxTarget', () => {
    it('returns the tmux target for a registered session', () => {
      const tmux = 'g2-known:0.0'
      store.sessions.set('known-id', {
        session_id: 'known-id',
        label: 'k',
        backend: 'claude-code',
        project_id: '_unmanaged',
        tmux_target: tmux,
        status: 'idle',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        source: 'manual',
      })
      expect(resolveTmuxTarget('known-id')).toBe(tmux)
    })

    it('returns null for an unregistered session id', () => {
      expect(resolveTmuxTarget('unregistered')).toBeNull()
    })

    it('returns null for the UNKNOWN sentinel', () => {
      expect(resolveTmuxTarget(UNKNOWN_SESSION_ID)).toBeNull()
    })

    it('returns null for empty/null inputs', () => {
      expect(resolveTmuxTarget(null)).toBeNull()
      expect(resolveTmuxTarget('')).toBeNull()
      expect(resolveTmuxTarget(undefined)).toBeNull()
    })
  })

  describe('validateSessionId', () => {
    it('accepts valid session ids', () => {
      expect(validateSessionId('abcdef')).toBe('abcdef') // exactly 6
      expect(validateSessionId('valid-id_with_underscore')).toBe('valid-id_with_underscore')
      // UUID-style
      expect(validateSessionId('11111111-2222-3333-4444-555555555555')).toBe(
        '11111111-2222-3333-4444-555555555555',
      )
    })

    it('rejects non-string / empty / out-of-range / pattern violations', () => {
      expect(validateSessionId(undefined)).toBeNull()
      expect(validateSessionId(null)).toBeNull()
      expect(validateSessionId(123)).toBeNull()
      expect(validateSessionId('')).toBeNull()
      expect(validateSessionId('short')).toBeNull() // < 6
      expect(validateSessionId('has spaces')).toBeNull()
      expect(validateSessionId('日本語session')).toBeNull()
      expect(validateSessionId('a'.repeat(129))).toBeNull() // > 128
    })
  })
})
