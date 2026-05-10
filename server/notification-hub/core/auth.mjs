// Auth helpers — token verification, public-route policy, UI cookie sessions.
// UI session map lives here (not in state/store) because it is purely an
// auth concern and never crosses service boundaries.
import { randomUUID } from 'node:crypto'
import { sendJson } from './http.mjs'

const UI_SESSION_COOKIE = 'cc_g2_ui_session'
const UI_SESSION_MAX_AGE_SEC = 60 * 60 * 12

/** @type {Map<string, number>} */
const uiSessions = new Map()

export const UI_SESSION = {
  cookie: UI_SESSION_COOKIE,
  maxAgeSec: UI_SESSION_MAX_AGE_SEC,
}

export function parseCookies(req) {
  const raw = String(req.headers.cookie || '')
  if (!raw) return new Map()
  return new Map(
    raw
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const idx = part.indexOf('=')
        if (idx < 0) return [part, '']
        return [part.slice(0, idx), decodeURIComponent(part.slice(idx + 1))]
      }),
  )
}

export function createUiSession() {
  const token = randomUUID()
  uiSessions.set(token, Date.now() + UI_SESSION_MAX_AGE_SEC * 1000)
  return token
}

export function cleanupExpiredUiSessions() {
  const now = Date.now()
  for (const [token, expiresAt] of uiSessions.entries()) {
    if (expiresAt <= now) uiSessions.delete(token)
  }
}

export function hasValidUiSession(req) {
  cleanupExpiredUiSessions()
  const token = parseCookies(req).get(UI_SESSION_COOKIE)
  if (!token) return false
  const expiresAt = uiSessions.get(token)
  if (!expiresAt || expiresAt <= Date.now()) {
    uiSessions.delete(token)
    return false
  }
  return true
}

function matchNotificationDetail(pathname) {
  const m = pathname.match(/^\/api\/notifications\/([^/]+)$/)
  return m ? decodeURIComponent(m[1]) : null
}

export function isPublicApiRequest(method, pathname) {
  if (method === 'GET' && pathname === '/api/health') return true
  if (method === 'GET' && pathname === '/api/context-status') return true
  if (method === 'GET' && pathname === '/api/notifications') return true
  if (method === 'POST' && pathname === '/api/client-events') return true
  if (method === 'POST' && pathname === '/api/location') return true
  if (method === 'GET' && matchNotificationDetail(pathname)) return true
  return false
}

export function requireApiAuth(req, res, hubAuthToken) {
  if (!hubAuthToken) return true
  const provided = String(req.headers['x-cc-g2-token'] || '').trim()
  if (provided === hubAuthToken) return true
  if (hasValidUiSession(req)) return true
  sendJson(res, 401, { ok: false, error: 'Unauthorized' })
  return false
}
