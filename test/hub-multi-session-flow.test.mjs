import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..')
const TEST_HUB_TOKEN = 'test-hub-token'

function randomPort() {
  return 10000 + Math.floor(Math.random() * 50000)
}

async function postJson(base, pathname, body, headers = {}) {
  const res = await fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-CC-G2-Token': TEST_HUB_TOKEN,
      ...headers,
    },
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

// Phase 4 — end-to-end multi-session flow.
//
// Two AgentSessions register tmux targets a/b. Two simultaneous hooks fire
// with distinct X-Agent-Session-Id headers; the resulting approvals must
// carry the right metadata.agentSessionId. Replying to one approval must
// drive the tmux relay with that session's tmux_target (verified via a stub
// relay command that captures RELAY_TMUX_TARGET to a file). The notifications
// API filter and active-summary endpoint are exercised on the same Hub.

describe('Phase 4 — multi-session end-to-end flow', () => {
  /** @type {import('node:child_process').ChildProcess} */
  let hubProc
  let hubBase = ''
  let workspace = ''
  let relayCaptureDir = ''
  let relayScript = ''

  const sessAId = 'multi-session-flow-aaa'
  const sessBId = 'multi-session-flow-bbb'
  const tmuxA = 'g2-multi-flow-a:0.0'
  const tmuxB = 'g2-multi-flow-b:0.0'

  beforeAll(async () => {
    workspace = await mkdtemp(path.join(tmpdir(), 'hub-multi-session-flow-'))
    relayCaptureDir = path.join(workspace, 'relay-out')
    relayScript = path.join(workspace, 'relay-stub.sh')

    // Stub relay: writes RELAY_TMUX_TARGET + stdin payload to a per-target
    // capture file. Used by the Hub via HUB_REPLY_RELAY_CMD.
    await writeFile(
      relayScript,
      `#!/bin/sh
mkdir -p "${relayCaptureDir}"
val="\${RELAY_TMUX_TARGET-UNSET}"
sanitized=$(printf '%s' "$val" | tr ':/' '__')
file="${relayCaptureDir}/relay-$sanitized.txt"
printf 'env=%s\\n' "$val" > "$file"
cat >> "$file"
exit 0
`,
      'utf8',
    )
    await chmod(relayScript, 0o755)

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
        HUB_REPLY_RELAY_CMD: `sh ${relayScript}`,
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

    // Register the two sessions used by every test below.
    const regA = await postJson(hubBase, '/api/v1/sessions/register', {
      session_id: sessAId,
      label: 'multi-a',
      backend: 'claude-code',
      project_id: '_unmanaged',
      tmux_target: tmuxA,
      source: 'manual',
    })
    expect(regA.status).toBe(200)
    const regB = await postJson(hubBase, '/api/v1/sessions/register', {
      session_id: sessBId,
      label: 'multi-b',
      backend: 'claude-code',
      project_id: '_unmanaged',
      tmux_target: tmuxB,
      source: 'manual',
    })
    expect(regB.status).toBe(200)
  }, 15000)

  afterAll(async () => {
    if (hubProc && !hubProc.killed) {
      hubProc.kill('SIGTERM')
      await new Promise((r) => setTimeout(r, 300))
      if (!hubProc.killed) hubProc.kill('SIGKILL')
    }
    await rm(workspace, { recursive: true, force: true }).catch(() => {})
  })

  it('routes per-session hooks → approvals with metadata.agentSessionId, GET /api/notifications?session_id filters correctly, reply drives tmux relay with the right target, and active-summary updates after activate', async () => {
    // Fire two permission-request hooks back-to-back, each carrying its own
    // X-Agent-Session-Id header. Each hook longpolls until the matching
    // approval is decided — we keep the promises and resolve them at the end
    // of the test.
    const hookPromiseA = postJson(
      hubBase,
      '/api/hooks/permission-request',
      {
        session_id: 'cc-A',
        cwd: '/tmp/multi-flow-a',
        tool_name: 'Bash',
        tool_input: { command: 'echo from-A' },
      },
      { 'X-Agent-Session-Id': sessAId, 'X-Tmux-Target': tmuxA },
    )
    const hookPromiseB = postJson(
      hubBase,
      '/api/hooks/permission-request',
      {
        session_id: 'cc-B',
        cwd: '/tmp/multi-flow-b',
        tool_name: 'Bash',
        tool_input: { command: 'echo from-B' },
      },
      { 'X-Agent-Session-Id': sessBId, 'X-Tmux-Target': tmuxB },
    )

    // Wait for both approvals to land in the pending list.
    let pendingA, pendingB
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      const { data } = await getJson(hubBase, '/api/approvals')
      pendingA = data.items.find((a) => a.cwd === '/tmp/multi-flow-a')
      pendingB = data.items.find((a) => a.cwd === '/tmp/multi-flow-b')
      if (pendingA && pendingB) break
      await new Promise((r) => setTimeout(r, 100))
    }
    expect(pendingA).toBeDefined()
    expect(pendingB).toBeDefined()

    // The notifications behind the approvals must be tagged with the right
    // agentSessionId. We read from the full /api/notifications list.
    const allNotifs = await getJson(hubBase, '/api/notifications?limit=100')
    const notifA = allNotifs.data.items.find((n) => n.id === pendingA.notificationId)
    const notifB = allNotifs.data.items.find((n) => n.id === pendingB.notificationId)
    expect(notifA?.metadata?.agentSessionId).toBe(sessAId)
    expect(notifB?.metadata?.agentSessionId).toBe(sessBId)

    // GET /api/notifications?session_id=<a> only surfaces session A's items.
    const sessA = await getJson(hubBase, `/api/notifications?session_id=${encodeURIComponent(sessAId)}&limit=100`)
    expect(sessA.status).toBe(200)
    expect(sessA.data.ok).toBe(true)
    const sessAIds = sessA.data.items.map((n) => n.id)
    expect(sessAIds).toContain(notifA.id)
    expect(sessAIds).not.toContain(notifB.id)

    // Symmetric check for session B.
    const sessB = await getJson(hubBase, `/api/notifications?session_id=${encodeURIComponent(sessBId)}&limit=100`)
    expect(sessB.data.items.map((n) => n.id)).toContain(notifB.id)
    expect(sessB.data.items.map((n) => n.id)).not.toContain(notifA.id)

    // Reply to approval A via /api/notifications/:id/reply with action=approve.
    // The relay stub captures RELAY_TMUX_TARGET to a file derived from the
    // sanitized target, so we can prove A's reply hit tmuxA and not tmuxB.
    // BUT: action=approve resolves the approval via approval-broker which
    // bypasses tmux relay (shouldRelay = false). To exercise the relay path
    // we send a plain comment that doesn't match approve/deny keywords —
    // that path keeps shouldRelay alive on a permission-request approval...
    // ...except permission-request goes through the resolved-as-deny+comment
    // branch which also skips relay. So we use a non-approval notification
    // for the relay assertion: a plain MOSHI notification with replyCapable
    // = true and no approval link still relays.
    //
    // Inject a plain MOSHI notification carrying agentSessionId for session A.
    const moshiResp = await postJson(hubBase, '/api/notify/moshi', {
      title: 'PingA',
      summary: 'session A relay test',
      body: 'session A relay test',
      replyCapable: true,
      hookType: 'generic',
      metadata: { agentSessionId: sessAId },
    })
    expect(moshiResp.status).toBe(201)
    const moshiAId = moshiResp.data.item.id
    // Sanity check: new notification participates in per-session filter.
    const sessACheck = await getJson(hubBase, `/api/notifications?session_id=${encodeURIComponent(sessAId)}&limit=100`)
    expect(sessACheck.data.items.map((n) => n.id)).toContain(moshiAId)

    // Reply with a free-form comment so processReply forwards it to relay.
    const replyResp = await postJson(hubBase, `/api/notifications/${encodeURIComponent(moshiAId)}/reply`, {
      replyText: 'hello from test',
      source: 'g2',
    })
    expect(replyResp.status).toBe(200)
    expect(replyResp.data.reply.status).toBe('forwarded')

    // Read the captured relay output. Filename uses the sanitized tmux target.
    const sanitized = tmuxA.replace(/[:/]/g, '_')
    const relayPath = path.join(relayCaptureDir, `relay-${sanitized}.txt`)
    let captured = ''
    const captureDeadline = Date.now() + 2000
    while (Date.now() < captureDeadline) {
      try {
        captured = await readFile(relayPath, 'utf8')
        if (captured) break
      } catch { /* not yet */ }
      await new Promise((r) => setTimeout(r, 50))
    }
    expect(captured).toContain(`env=${tmuxA}`)
    // Negative: session B's relay file must not exist (we only replied to A).
    const sanitizedB = tmuxB.replace(/[:/]/g, '_')
    const relayPathB = path.join(relayCaptureDir, `relay-${sanitizedB}.txt`)
    let bExists = true
    try { await readFile(relayPathB, 'utf8') } catch { bExists = false }
    expect(bExists).toBe(false)

    // Activate session A and verify active-summary excludes A but counts B.
    const activateA = await postJson(hubBase, `/api/v1/sessions/${sessAId}/activate`, {})
    expect(activateA.status).toBe(200)

    const summary = await getJson(hubBase, '/api/v1/sessions/active-summary')
    expect(summary.status).toBe(200)
    expect(summary.data.active_session_id).toBe(sessAId)
    expect(summary.data.pending_counts_by_other_session[sessAId]).toBeUndefined()
    expect(summary.data.pending_counts_by_other_session[sessBId]).toBeGreaterThanOrEqual(1)

    // Clean up the longpolling hooks by deciding both approvals.
    await postJson(hubBase, `/api/approvals/${pendingA.id}/decide`, { decision: 'approve' })
    await postJson(hubBase, `/api/approvals/${pendingB.id}/decide`, { decision: 'approve' })
    const [resultA, resultB] = await Promise.all([hookPromiseA, hookPromiseB])
    expect(resultA.data.hookSpecificOutput.decision.behavior).toBe('allow')
    expect(resultB.data.hookSpecificOutput.decision.behavior).toBe('allow')
  }, 30000)
})
