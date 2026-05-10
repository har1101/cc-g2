// Phase 3: SessionList API routes.
//   GET  /api/v1/projects                 — list public projects (no path)
//   GET  /api/v1/sessions                 — list AgentSessions
//   POST /api/v1/sessions                 — create session via cc-g2.sh
//   POST /api/v1/sessions/register        — idempotent registration (Voice Entry)
//   POST /api/v1/sessions/:id/activate    — mark active session
//
// project_path is server-side only and never appears in any response body.
import { readRequestBody, safeJsonParse } from '../notification-utils.mjs'
import { isBodyTooLargeError, sendJson, sendRequestBodyTooLarge } from '../core/http.mjs'

function matchActivatePath(pathname) {
  const m = pathname.match(/^\/api\/v1\/sessions\/([^/]+)\/activate$/)
  return m ? decodeURIComponent(m[1]) : null
}

async function readJson(req, deps, res) {
  let rawBody
  try {
    rawBody = await readRequestBody(req, { maxBytes: deps.hubMaxBodyBytes })
  } catch (err) {
    if (isBodyTooLargeError(err)) {
      sendRequestBodyTooLarge(res, err)
      return { responded: true }
    }
    throw err
  }
  const parsed = safeJsonParse(rawBody || '{}')
  if (!parsed.ok || !parsed.value || typeof parsed.value !== 'object') {
    sendJson(res, 400, { ok: false, error: 'Invalid JSON body' })
    return { responded: true }
  }
  return { responded: false, body: parsed.value }
}

function statusForError(err) {
  return typeof err?.status === 'number' ? err.status : 500
}

export async function handle(req, res, ctx) {
  const { method, pathname, deps } = ctx
  const sessionService = deps.sessionService
  if (!sessionService) return false

  if (method === 'GET' && pathname === '/api/v1/projects') {
    sendJson(res, 200, { ok: true, items: sessionService.listProjects() })
    return true
  }

  if (method === 'GET' && pathname === '/api/v1/sessions') {
    sendJson(res, 200, { ok: true, items: sessionService.listSessions() })
    return true
  }

  if (method === 'POST' && pathname === '/api/v1/sessions') {
    const parsed = await readJson(req, deps, res)
    if (parsed.responded) return true
    try {
      const { session } = await sessionService.createSession({
        projectId: parsed.body.project_id,
        labelHint: parsed.body.label_hint,
      })
      sendJson(res, 200, { ok: true, session })
    } catch (err) {
      const status = statusForError(err)
      sendJson(res, status, { ok: false, error: err instanceof Error ? err.message : String(err) })
    }
    return true
  }

  if (method === 'POST' && pathname === '/api/v1/sessions/register') {
    const parsed = await readJson(req, deps, res)
    if (parsed.responded) return true
    try {
      const { session } = await sessionService.registerSession(parsed.body)
      sendJson(res, 200, { ok: true, session })
    } catch (err) {
      const status = statusForError(err)
      sendJson(res, status, { ok: false, error: err instanceof Error ? err.message : String(err) })
    }
    return true
  }

  if (method === 'POST') {
    const sessionId = matchActivatePath(pathname)
    if (sessionId) {
      try {
        const session = await sessionService.activateSession(sessionId)
        if (!session) {
          sendJson(res, 404, { ok: false, error: 'session not found' })
          return true
        }
        sendJson(res, 200, { ok: true, session })
      } catch (err) {
        const status = statusForError(err)
        sendJson(res, status, { ok: false, error: err instanceof Error ? err.message : String(err) })
      }
      return true
    }
  }

  return false
}
