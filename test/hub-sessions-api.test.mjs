import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn } from 'node:child_process'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
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

describe('Phase 3 — Hub /api/v1/sessions API', () => {
  /** @type {import('node:child_process').ChildProcess} */
  let hubProc
  let hubBase = ''
  let tmpDataDir = ''
  let workspace = ''
  let projectsFile = ''
  let launchScript = ''
  let scriptCallLogFile = ''

  beforeAll(async () => {
    workspace = await mkdtemp(path.join(tmpdir(), 'hub-sessions-test-'))
    tmpDataDir = path.join(workspace, 'data')
    projectsFile = path.join(workspace, 'projects.json')
    launchScript = path.join(workspace, 'cc-g2-stub.sh')
    scriptCallLogFile = path.join(workspace, 'launch-calls.jsonl')

    // Allowlist: one real project + the _unmanaged sentinel.
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
          {
            project_id: 'demo',
            label: 'Demo',
            path: '/tmp/demo-workspace',
            default_backend: 'claude-code',
            start_template: 'claude',
          },
        ],
      }),
      'utf8',
    )

    // Stub script that fakes launch-detached output and logs the args it
    // received so the test can verify the allowlist resolution + env vars.
    // Reads CC_G2_DELAY_MS and CC_G2_FAIL from the env to support the
    // concurrent-creation and error-path tests.
    await writeFile(
      launchScript,
      `#!/usr/bin/env bash
set -eu
LOG=${JSON.stringify(scriptCallLogFile)}
mode="$1"; shift || true
if [ "$mode" != "launch-detached" ]; then
  echo "stub: unsupported mode $mode" >&2
  exit 2
fi
WORKDIR=""
AGENT="claude"
while [ $# -gt 0 ]; do
  case "$1" in
    --workdir) WORKDIR="$2"; shift 2 ;;
    --agent) AGENT="$2"; shift 2 ;;
    *) shift ;;
  esac
done
SESSION_ID="\${CC_G2_AGENT_SESSION_ID:-no-id}"
INTERNAL="\${CC_G2_INTERNAL_JSON:-0}"
node -e 'const fs=require("fs");fs.appendFileSync(process.argv[1], JSON.stringify({workdir:process.argv[2],agent:process.argv[3],sessionId:process.argv[4],internalJson:process.argv[5],ts:Date.now()})+"\\n")' "$LOG" "$WORKDIR" "$AGENT" "$SESSION_ID" "$INTERNAL"
if [ "\${CC_G2_DELAY_MS:-0}" -gt 0 ]; then
  sleep "$(awk "BEGIN { print \${CC_G2_DELAY_MS}/1000 }")"
fi
if [ -n "\${CC_G2_FAIL:-}" ]; then
  echo "stub: forced fail" >&2
  exit 7
fi
SESSION_NAME="g2-stub-$(echo "$WORKDIR" | tr '/' '-' | sed 's/^-//')"
node -e 'process.stdout.write(JSON.stringify({ok:true,sessionName:process.argv[1],tmuxTarget:process.argv[1]+":0.0",workdir:process.argv[2]}))' "$SESSION_NAME" "$WORKDIR"
`,
      'utf8',
    )
    await chmod(launchScript, 0o755)

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
        CC_G2_LAUNCH_SCRIPT: launchScript,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const deadline = Date.now() + 8000
    while (Date.now() < deadline) {
      try {
        const res = await fetch(`${hubBase}/api/health`, { signal: AbortSignal.timeout(1000) })
        if (res.ok) break
      } catch { /* not ready yet */ }
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

  it('GET /api/v1/projects — returns public projects without `path`', async () => {
    const { status, data } = await getJson(hubBase, '/api/v1/projects')
    expect(status).toBe(200)
    expect(data.ok).toBe(true)
    expect(Array.isArray(data.items)).toBe(true)
    expect(data.items.length).toBe(2)
    for (const item of data.items) {
      expect(item).toHaveProperty('project_id')
      expect(item).toHaveProperty('label')
      expect(item).toHaveProperty('default_backend')
      expect(item).toHaveProperty('start_template')
      expect(item).not.toHaveProperty('path')
    }
  })

  it('POST /api/v1/sessions — creates a session for a valid project_id', async () => {
    const { status, data } = await postJson(hubBase, '/api/v1/sessions', { project_id: 'demo' })
    expect(status).toBe(200)
    expect(data.ok).toBe(true)
    expect(data.session.project_id).toBe('demo')
    expect(data.session.backend).toBe('claude-code')
    expect(data.session.tmux_target).toMatch(/^g2-stub-.+:0\.0$/)
    expect(data.session.source).toBe('pull-to-new-session')
    expect(data.session.session_id).toEqual(expect.any(String))
    // listSessions should now include this entry, and the `path` must NOT leak.
    const list = await getJson(hubBase, '/api/v1/sessions')
    const match = list.data.items.find((s) => s.session_id === data.session.session_id)
    expect(match).toBeDefined()
    expect(match).not.toHaveProperty('path')
    expect(match).not.toHaveProperty('project_path')
  })

  it('POST /api/v1/sessions — 404 for unknown project_id', async () => {
    const { status, data } = await postJson(hubBase, '/api/v1/sessions', { project_id: 'nope' })
    expect(status).toBe(404)
    expect(data.ok).toBe(false)
    expect(data.error).toMatch(/allowlist/i)
  })

  it('POST /api/v1/sessions — 400 for _unmanaged sentinel', async () => {
    const { status, data } = await postJson(hubBase, '/api/v1/sessions', { project_id: '_unmanaged' })
    expect(status).toBe(400)
    expect(data.ok).toBe(false)
    expect(data.error).toMatch(/_unmanaged/i)
  })

  it('POST /api/v1/sessions — 400 for bad label_hint', async () => {
    const { status, data } = await postJson(hubBase, '/api/v1/sessions', {
      project_id: 'demo',
      label_hint: 'has spaces and 日本語',
    })
    expect(status).toBe(400)
    expect(data.ok).toBe(false)
  })

  it('POST /api/v1/sessions/register — idempotent', async () => {
    const body = {
      session_id: 'voice-entry-fixed-id-1',
      label: 'voice-test',
      backend: 'claude-code',
      project_id: '_unmanaged',
      tmux_target: 'g2-voice-test:0.0',
      source: 'voice-entry',
    }
    const first = await postJson(hubBase, '/api/v1/sessions/register', body)
    expect(first.status).toBe(200)
    expect(first.data.session.label).toBe('voice-test')
    // second call with same id but updated label — should NOT throw / 409
    const second = await postJson(hubBase, '/api/v1/sessions/register', { ...body, label: 'voice-test-2' })
    expect(second.status).toBe(200)
    expect(second.data.session.session_id).toBe(body.session_id)
    expect(second.data.session.label).toBe('voice-test-2')
  })

  it('POST /api/v1/sessions/register — 400 for bad backend', async () => {
    const { status } = await postJson(hubBase, '/api/v1/sessions/register', {
      session_id: 'x',
      label: 'x',
      backend: 'garbage-backend',
      project_id: 'demo',
      tmux_target: 'x:0.0',
    })
    expect(status).toBe(400)
  })

  it('POST /api/v1/sessions/:id/activate — 200 on success, 404 otherwise', async () => {
    // create + activate
    const created = await postJson(hubBase, '/api/v1/sessions', { project_id: 'demo' })
    expect(created.status).toBe(200)
    const id = created.data.session.session_id
    const activate = await postJson(hubBase, `/api/v1/sessions/${id}/activate`, {})
    expect(activate.status).toBe(200)
    expect(activate.data.ok).toBe(true)
    expect(activate.data.session.session_id).toBe(id)
    // unknown id
    const missing = await postJson(hubBase, `/api/v1/sessions/does-not-exist/activate`, {})
    expect(missing.status).toBe(404)
  })

  it('POST /api/v1/sessions — concurrent calls: second sees 409', async () => {
    // Re-launch hub with a delay so the first request is still spawning when the
    // second arrives. Use a separate process tied to a dedicated port.
    const port = randomPort()
    const proc = spawn('node', ['server/notification-hub/index.mjs'], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        HUB_PORT: String(port),
        HUB_BIND: '127.0.0.1',
        HUB_DATA_DIR: path.join(workspace, 'data-concurrent'),
        HUB_AUTH_TOKEN: TEST_HUB_TOKEN,
        NTFY_BASE_URL: '',
        HUB_REPLY_RELAY_CMD: '',
        CC_G2_PROJECTS_FILE: projectsFile,
        CC_G2_LAUNCH_SCRIPT: launchScript,
        CC_G2_DELAY_MS: '500',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const concBase = `http://127.0.0.1:${port}`
    try {
      const deadline = Date.now() + 8000
      while (Date.now() < deadline) {
        try {
          const res = await fetch(`${concBase}/api/health`, { signal: AbortSignal.timeout(1000) })
          if (res.ok) break
        } catch { /* not ready */ }
        await new Promise((r) => setTimeout(r, 150))
      }
      const [first, second] = await Promise.all([
        postJson(concBase, '/api/v1/sessions', { project_id: 'demo' }),
        // tiny delay to ensure first acquires the mutex first
        new Promise((r) => setTimeout(r, 50)).then(() =>
          postJson(concBase, '/api/v1/sessions', { project_id: 'demo' }),
        ),
      ])
      // First should succeed; second should hit the in-progress mutex.
      expect([first.status, second.status].sort()).toEqual([200, 409])
      const conflict = first.status === 409 ? first : second
      expect(conflict.data.error).toMatch(/in progress/i)
    } finally {
      proc.kill('SIGTERM')
      await new Promise((r) => setTimeout(r, 300))
      if (!proc.killed) proc.kill('SIGKILL')
    }
  }, 30000)
})
