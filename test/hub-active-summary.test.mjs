import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..')
const TEST_HUB_TOKEN = 'test-hub-token'

function randomPort() {
  return 10000 + Math.floor(Math.random() * 50000)
}

async function postJson(base, pathname, body) {
  const res = await fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CC-G2-Token': TEST_HUB_TOKEN },
    body: JSON.stringify(body),
  })
  return { status: res.status, data: await res.json() }
}

async function getJson(base, pathname) {
  const res = await fetch(`${base}${pathname}`, {
    headers: { 'X-CC-G2-Token': TEST_HUB_TOKEN },
  })
  return { status: res.status, data: await res.json() }
}

// Phase 4 — GET /api/v1/sessions/active-summary
//
// Purpose: the frontend polling controller calls this once per tick instead
// of paging the full notifications + sessions lists. The endpoint must:
//   - return active_session_id: null when no session has been activated
//     and group ALL pending counts (including 'unknown' bucket)
//   - after activation, exclude the active session from the count map
//   - bucket approvals without metadata.agentSessionId under 'unknown'

describe('Phase 4 — GET /api/v1/sessions/active-summary', () => {
  /** @type {import('node:child_process').ChildProcess} */
  let hubProc
  let hubBase = ''
  let workspace = ''

  beforeAll(async () => {
    workspace = await mkdtemp(path.join(tmpdir(), 'hub-active-summary-test-'))
    const tmpDataDir = path.join(workspace, 'data')
    const projectsFile = path.join(workspace, 'projects.json')
    await writeFile(
      projectsFile,
      JSON.stringify({
        projects: [
          {
            project_id: '_unmanaged',
            label: 'Unmanaged',
            path: '',
            default_backend: 'claude-code',
            start_template: 'claude',
          },
        ],
      }),
      'utf8',
    )

    const port = randomPort()
    hubBase = `http://127.0.0.1:${port}`

    hubProc = spawn('node', ['server/notification-hub/index.mjs'], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        HUB_PORT: String(port),
        HUB_BIND: '127.0.0.1',
        HUB_DATA_DIR: tmpDataDir,
        HUB_AUTH_TOKEN: TEST_HUB_TOKEN,
        NTFY_BASE_URL: '',
        HUB_REPLY_RELAY_CMD: '',
        CC_G2_PROJECTS_FILE: projectsFile,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const deadline = Date.now() + 8000
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${hubBase}/api/health`, { signal: AbortSignal.timeout(1000) })
        if (res.ok) break
      } catch { /* not ready */ }
      await new Promise((r) => setTimeout(r, 150))
    }
    const check = await fetch(`${hubBase}/api/health`).then((r) => r.json())
    expect(check.ok).toBe(true)
  }, 15000)

  afterAll(async () => {
    if (hubProc && !hubProc.killed) {
      hubProc.kill('SIGTERM')
      await new Promise((r) => setTimeout(r, 300))
      if (!hubProc.killed) hubProc.kill('SIGKILL')
    }
    await rm(workspace, { recursive: true, force: true }).catch(() => {})
  })

  it('returns active_session_id: null and groups all pending counts when no session is active', async () => {
    // Two pending approvals on different agentSessionIds, plus one with no
    // session (should land in the 'unknown' bucket).
    await postJson(hubBase, '/api/approvals', {
      toolName: 'Bash',
      toolInput: { command: 'echo a' },
      cwd: '/tmp/active-summary-a',
      metadata: { agentSessionId: 'sess-aaa-summary' },
    })
    await postJson(hubBase, '/api/approvals', {
      toolName: 'Bash',
      toolInput: { command: 'echo b' },
      cwd: '/tmp/active-summary-b',
      metadata: { agentSessionId: 'sess-bbb-summary' },
    })
    await postJson(hubBase, '/api/approvals', {
      toolName: 'Bash',
      toolInput: { command: 'echo c' },
      cwd: '/tmp/active-summary-no-session',
    })

    const { status, data } = await getJson(hubBase, '/api/v1/sessions/active-summary')
    expect(status).toBe(200)
    expect(data.ok).toBe(true)
    expect(data.active_session_id).toBeNull()
    expect(data.pending_counts_by_other_session['sess-aaa-summary']).toBe(1)
    expect(data.pending_counts_by_other_session['sess-bbb-summary']).toBe(1)
    expect(data.pending_counts_by_other_session.unknown).toBeGreaterThanOrEqual(1)
  })

  it('excludes the active session from pending_counts after activate', async () => {
    // Register two sessions so we can activate one of them.
    const sessAId = 'sess-active-summary-a-id'
    const sessBId = 'sess-active-summary-b-id'
    await postJson(hubBase, '/api/v1/sessions/register', {
      session_id: sessAId,
      label: 'sa',
      backend: 'claude-code',
      project_id: '_unmanaged',
      tmux_target: 'g2-sa:0.0',
      source: 'manual',
    })
    await postJson(hubBase, '/api/v1/sessions/register', {
      session_id: sessBId,
      label: 'sb',
      backend: 'claude-code',
      project_id: '_unmanaged',
      tmux_target: 'g2-sb:0.0',
      source: 'manual',
    })
    // Two approvals each, attributed to a and b.
    for (let i = 0; i < 2; i++) {
      await postJson(hubBase, '/api/approvals', {
        toolName: 'Bash',
        toolInput: { command: `echo a-${i}` },
        cwd: `/tmp/active-summary-pair-a-${i}`,
        metadata: { agentSessionId: sessAId },
      })
      await postJson(hubBase, '/api/approvals', {
        toolName: 'Bash',
        toolInput: { command: `echo b-${i}` },
        cwd: `/tmp/active-summary-pair-b-${i}`,
        metadata: { agentSessionId: sessBId },
      })
    }

    // Before activation, both ids appear in the map.
    const before = await getJson(hubBase, '/api/v1/sessions/active-summary')
    expect(before.data.active_session_id).toBeNull()
    expect(before.data.pending_counts_by_other_session[sessAId]).toBeGreaterThanOrEqual(2)
    expect(before.data.pending_counts_by_other_session[sessBId]).toBeGreaterThanOrEqual(2)

    // Activate session A.
    const activate = await postJson(hubBase, `/api/v1/sessions/${sessAId}/activate`, {})
    expect(activate.status).toBe(200)

    const after = await getJson(hubBase, '/api/v1/sessions/active-summary')
    expect(after.status).toBe(200)
    expect(after.data.active_session_id).toBe(sessAId)
    // A is hidden, B remains.
    expect(after.data.pending_counts_by_other_session[sessAId]).toBeUndefined()
    expect(after.data.pending_counts_by_other_session[sessBId]).toBeGreaterThanOrEqual(2)
  })
})
