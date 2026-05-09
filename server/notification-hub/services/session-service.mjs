// Phase 3: Session service. Owns:
//  - project allowlist (server/config/projects.json) loading
//  - AgentSession registry (in-memory + sessions.json snapshot)
//  - createSession() — invokes scripts/cc-g2.sh launch-detached with
//    CC_G2_INTERNAL_JSON=1 (NEVER --dangerously-skip-permissions) and
//    registers the resulting session.
//  - registerSession() — used by Voice Entry / external launches that
//    already created a tmux session and want it visible in SessionList.
//  - activateSession() / listSessions() / getSession() / validateTmuxTargets()
//
// Public projection NEVER exposes `path` — that is server-side only per
// design v4 §Phase 3.
import { execFile, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { log } from '../core/log.mjs'
import * as store from '../state/store.mjs'
import { writeJsonSnapshot } from '../state/persistence.mjs'

const LABEL_REGEX = /^[A-Za-z0-9_-]{1,40}$/
const ALLOWED_BACKENDS = new Set(['claude-code', 'codex-cli'])
const ALLOWED_TEMPLATES = new Set(['claude', 'codex'])
const VALID_STATUSES = new Set(['idle', 'working', 'permission', 'done', 'error'])
const VALID_SOURCES = new Set(['pull-to-new-session', 'voice-entry', 'manual'])

/**
 * @typedef {{ project_id: string, label: string, path: string, default_backend: 'claude-code'|'codex-cli', start_template: 'claude'|'codex' }} ProjectTemplate
 */

/**
 * @typedef {{ project_id: string, label: string, default_backend: string, start_template: string }} ProjectPublic
 */

/**
 * Load the project allowlist from disk. Used at startup; the result is cached
 * by the caller. Never throws — bad files / entries are logged and filtered.
 *
 * @param {{ projectsFile: string }} cfg
 * @returns {Promise<ProjectTemplate[]>}
 */
export async function loadProjectAllowlist(cfg) {
  const filePath = cfg.projectsFile
  let raw
  try {
    raw = await readFile(filePath, 'utf8')
  } catch (err) {
    if (err && err.code === 'ENOENT') {
      log(`[session-service] projects file missing: ${filePath} — empty allowlist`)
      return []
    }
    log(`[session-service] failed to read projects file: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    log(`[session-service] projects file is not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
    return []
  }
  const list = Array.isArray(parsed?.projects) ? parsed.projects : []
  /** @type {ProjectTemplate[]} */
  const out = []
  const seen = new Set()
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue
    const project_id = typeof entry.project_id === 'string' ? entry.project_id.trim() : ''
    const label = typeof entry.label === 'string' ? entry.label.trim() : ''
    const path_ = typeof entry.path === 'string' ? entry.path.trim() : ''
    const default_backend = typeof entry.default_backend === 'string' ? entry.default_backend.trim() : ''
    const start_template = typeof entry.start_template === 'string' ? entry.start_template.trim() : ''
    if (!project_id) {
      log('[session-service] project entry skipped: missing project_id')
      continue
    }
    if (seen.has(project_id)) {
      log(`[session-service] project entry skipped: duplicate project_id="${project_id}"`)
      continue
    }
    if (!label) {
      log(`[session-service] project entry skipped (id=${project_id}): missing label`)
      continue
    }
    if (!ALLOWED_BACKENDS.has(default_backend)) {
      log(`[session-service] project entry skipped (id=${project_id}): bad default_backend="${default_backend}"`)
      continue
    }
    if (!ALLOWED_TEMPLATES.has(start_template)) {
      log(`[session-service] project entry skipped (id=${project_id}): bad start_template="${start_template}"`)
      continue
    }
    // _unmanaged is allowed to have empty path (sentinel for sessions launched
    // outside the SessionList flow). Real projects must have a non-empty path.
    if (project_id !== '_unmanaged' && !path_) {
      log(`[session-service] project entry skipped (id=${project_id}): missing path`)
      continue
    }
    seen.add(project_id)
    out.push({
      project_id,
      label,
      path: path_,
      default_backend: /** @type {'claude-code'|'codex-cli'} */ (default_backend),
      start_template: /** @type {'claude'|'codex'} */ (start_template),
    })
  }
  log(`[session-service] loaded ${out.length} project(s) from ${filePath}`)
  return out
}

/**
 * Build the public projection of a project (no `path`).
 * @param {ProjectTemplate} t
 * @returns {ProjectPublic}
 */
function publicProject(t) {
  return {
    project_id: t.project_id,
    label: t.label,
    default_backend: t.default_backend,
    start_template: t.start_template,
  }
}

/**
 * Create a SessionService bound to its allowlist + dependencies.
 *
 * `runLaunchDetached` and `tmuxHasSession` are injected so tests can stub
 * the spawn surface without forking real bash.
 *
 * @param {{
 *   projects: ProjectTemplate[],
 *   sessionsFile: string,
 *   ccG2ScriptPath: string,
 *   runLaunchDetached?: (args: string[], extraEnv: Record<string,string>) => Promise<{ ok: boolean, sessionName: string, tmuxTarget: string, workdir: string }>,
 *   tmuxHasSession?: (sessionName: string) => boolean,
 * }} cfg
 */
export function createSessionService(cfg) {
  const projectsById = new Map()
  for (const t of cfg.projects) projectsById.set(t.project_id, t)

  // In-memory mutex: at most 1 concurrent createSession.
  let creationInFlight = false

  const runLaunch = cfg.runLaunchDetached || defaultRunLaunchDetached(cfg.ccG2ScriptPath)
  const hasSession = cfg.tmuxHasSession || defaultTmuxHasSession

  async function persistSnapshot() {
    const snapshot = {
      sessions: Array.from(store.sessions.values()),
      activeSessionId: store.getActiveSessionId(),
      updatedAt: new Date().toISOString(),
    }
    try {
      await writeJsonSnapshot(cfg.sessionsFile, snapshot)
    } catch (err) {
      log(`[session-service] failed to persist sessions: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  /** @returns {ProjectPublic[]} */
  function listProjects() {
    return cfg.projects.map(publicProject)
  }

  /** @returns {import('../state/store.mjs').AgentSession[]} */
  function listSessions() {
    // newest first
    return Array.from(store.sessions.values()).sort((a, b) =>
      a.created_at < b.created_at ? 1 : -1,
    )
  }

  function getSession(id) {
    return store.sessions.get(id) || null
  }

  /**
   * Drop sessions whose tmux target no longer exists. Run at bootstrap to
   * clean up dead panes from a previous Hub run.
   */
  async function validateTmuxTargets() {
    let removed = 0
    for (const [id, s] of store.sessions) {
      const sessionName = (s.tmux_target || '').split(':')[0]
      if (!sessionName) continue
      try {
        if (!hasSession(sessionName)) {
          store.sessions.delete(id)
          if (store.getActiveSessionId() === id) store.setActiveSessionId(null)
          removed++
        }
      } catch {
        // tmux not installed / not running — leave entries in place
      }
    }
    if (removed > 0) {
      log(`[session-service] validateTmuxTargets removed ${removed} dead session(s)`)
      await persistSnapshot()
    }
  }

  /**
   * Register a session that was created outside this service (e.g. Voice
   * Entry's launch-detached path). Idempotent — calling twice with the same
   * session_id updates fields rather than throwing.
   *
   * @param {{ session_id: string, label: string, backend: string, project_id: string, tmux_target: string, source?: string }} input
   * @returns {Promise<{ session: import('../state/store.mjs').AgentSession }>}
   */
  async function registerSession(input) {
    if (!input || typeof input !== 'object') {
      throw new ValidationError('invalid body')
    }
    const session_id = typeof input.session_id === 'string' ? input.session_id.trim() : ''
    const label = typeof input.label === 'string' ? input.label.trim() : ''
    const backend = typeof input.backend === 'string' ? input.backend.trim() : ''
    const project_id = typeof input.project_id === 'string' ? input.project_id.trim() : ''
    const tmux_target = typeof input.tmux_target === 'string' ? input.tmux_target.trim() : ''
    const source = typeof input.source === 'string' && VALID_SOURCES.has(input.source) ? input.source : 'manual'
    if (!session_id) throw new ValidationError('session_id required')
    if (!label) throw new ValidationError('label required')
    if (!ALLOWED_BACKENDS.has(backend)) throw new ValidationError('backend must be claude-code or codex-cli')
    if (!project_id) throw new ValidationError('project_id required')
    if (!tmux_target) throw new ValidationError('tmux_target required')

    const now = new Date().toISOString()
    const existing = store.sessions.get(session_id)
    /** @type {import('../state/store.mjs').AgentSession} */
    const session = existing
      ? {
          ...existing,
          label,
          backend: /** @type {'claude-code'|'codex-cli'} */ (backend),
          project_id,
          tmux_target,
          source: /** @type {'pull-to-new-session'|'voice-entry'|'manual'} */ (source),
          updated_at: now,
        }
      : {
          session_id,
          label,
          backend: /** @type {'claude-code'|'codex-cli'} */ (backend),
          project_id,
          tmux_target,
          status: 'idle',
          created_at: now,
          updated_at: now,
          source: /** @type {'pull-to-new-session'|'voice-entry'|'manual'} */ (source),
        }
    store.sessions.set(session_id, session)
    await persistSnapshot()
    log(
      `[session-service] registerSession id=${session_id} label=${JSON.stringify(label)} backend=${backend} project=${project_id} source=${source} (${existing ? 'updated' : 'new'})`,
    )
    return { session }
  }

  /**
   * Mark a session active. Updates updated_at as a side effect.
   * Returns null if the session does not exist.
   */
  async function activateSession(sessionId) {
    const s = store.sessions.get(sessionId)
    if (!s) return null
    store.setActiveSessionId(sessionId)
    s.updated_at = new Date().toISOString()
    await persistSnapshot()
    log(`[session-service] activateSession id=${sessionId}`)
    return s
  }

  /**
   * Create a new session. Validates project_id ∈ allowlist, rejects
   * `_unmanaged`, validates labelHint, acquires an in-memory mutex,
   * spawns cc-g2.sh launch-detached, and registers the resulting session.
   *
   * @param {{ projectId: string, labelHint?: string }} input
   * @returns {Promise<{ session: import('../state/store.mjs').AgentSession }>}
   */
  async function createSession(input) {
    const projectId = typeof input?.projectId === 'string' ? input.projectId.trim() : ''
    let labelHint = typeof input?.labelHint === 'string' ? input.labelHint.trim() : ''

    const project = projectsById.get(projectId)
    if (!project) {
      throw new NotFoundError('project_id not in allowlist')
    }
    if (projectId === '_unmanaged') {
      throw new ValidationError('cannot create new sessions under _unmanaged')
    }
    if (!project.path) {
      throw new ValidationError(`project_id="${projectId}" has no path`)
    }
    if (labelHint) {
      if (!LABEL_REGEX.test(labelHint)) {
        throw new ValidationError('label_hint must match /^[A-Za-z0-9_-]{1,40}$/')
      }
    } else {
      labelHint = project.label
    }

    if (creationInFlight) {
      throw new ConflictError('creation in progress')
    }
    creationInFlight = true
    try {
      const newSessionId = randomUUID()
      const agent = project.start_template === 'codex' ? 'codex' : 'claude'
      const args = ['launch-detached', '--workdir', project.path, '--agent', agent]
      const extraEnv = {
        CC_G2_INTERNAL_JSON: '1',
        CC_G2_AGENT_SESSION_ID: newSessionId,
      }
      let result
      try {
        result = await runLaunch(args, extraEnv)
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        log(`[session-service] launch-detached failed: ${msg}`)
        throw new InternalError(`launch-detached failed: ${msg}`)
      }
      if (!result || !result.ok || !result.sessionName || !result.tmuxTarget) {
        throw new InternalError('launch-detached returned malformed JSON')
      }

      const now = new Date().toISOString()
      /** @type {import('../state/store.mjs').AgentSession} */
      const session = {
        session_id: newSessionId,
        label: labelHint,
        backend: project.default_backend,
        project_id: projectId,
        tmux_target: result.tmuxTarget,
        status: 'idle',
        created_at: now,
        updated_at: now,
        source: 'pull-to-new-session',
      }
      store.sessions.set(newSessionId, session)
      await persistSnapshot()
      log(
        `[session-service] createSession id=${newSessionId} project=${projectId} backend=${session.backend} tmux=${result.tmuxTarget}`,
      )
      return { session }
    } finally {
      creationInFlight = false
    }
  }

  return {
    listProjects,
    listSessions,
    getSession,
    validateTmuxTargets,
    registerSession,
    activateSession,
    createSession,
    // exposed for tests
    _isCreationInFlight: () => creationInFlight,
  }
}

// ---------------------------------------------------------------------------
// Error types — routes map these to HTTP status codes
// ---------------------------------------------------------------------------

export class ValidationError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ValidationError'
    this.status = 400
  }
}
export class NotFoundError extends Error {
  constructor(message) {
    super(message)
    this.name = 'NotFoundError'
    this.status = 404
  }
}
export class ConflictError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ConflictError'
    this.status = 409
  }
}
export class InternalError extends Error {
  constructor(message) {
    super(message)
    this.name = 'InternalError'
    this.status = 500
  }
}

// ---------------------------------------------------------------------------
// Default spawn implementations (real bash invocation). Tests override these.
// ---------------------------------------------------------------------------

/**
 * Default invocation of `bash <CC_G2_SH_PATH> launch-detached ...` with
 * CC_G2_INTERNAL_JSON=1. Returns the parsed JSON line printed to stdout.
 */
function defaultRunLaunchDetached(scriptPath) {
  const absolute = path.resolve(scriptPath)
  return (args, extraEnv) =>
    new Promise((resolve, reject) => {
      const child = execFile(
        'bash',
        [absolute, ...args],
        {
          env: { ...process.env, ...extraEnv },
          timeout: 60_000,
          maxBuffer: 4 * 1024 * 1024,
        },
        (err, stdout, stderr) => {
          if (err) {
            const msg = (stderr && stderr.toString().trim()) || err.message
            reject(new Error(msg))
            return
          }
          const text = String(stdout || '').trim()
          // launch-detached prints info() lines on stderr (with CC_G2_INTERNAL_JSON=1)
          // and the JSON to stdout. Be defensive and try the last line that parses.
          const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)
          for (let i = lines.length - 1; i >= 0; i--) {
            try {
              const parsed = JSON.parse(lines[i])
              resolve(parsed)
              return
            } catch { /* try previous */ }
          }
          reject(new Error('launch-detached produced no JSON output'))
        },
      )
      child.on('error', (err) => reject(err))
    })
}

function defaultTmuxHasSession(sessionName) {
  try {
    execFileSync('tmux', ['has-session', '-t', sessionName], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
