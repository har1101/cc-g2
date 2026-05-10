// Phase 5: integration tests for the policy classifier wired into the
// permission-request hook (Pass 2). Boots a real hub on a tmpdir, sends
// hook payloads with various tool inputs, and asserts:
//
//   - hard-deny commands short-circuit (no approval, immediate deny response,
//     permission-blocked notification stamped with reason)
//   - destructive commands stamp metadata.risk_tier='destructive' on the
//     approval and follow the normal long-poll flow
//   - normal commands still flow through unchanged
//
// Audit log assertions live in test/hub-audit-log.test.mjs (Pass 5).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..')
const TEST_HUB_TOKEN = 'test-hub-token'

function randomPort() { return 10000 + Math.floor(Math.random() * 50000) }

async function postJson(base, pathname, body, headers = {}) {
  const res = await fetch(`${base}${pathname}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-CC-G2-Token': TEST_HUB_TOKEN, ...headers },
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

describe('Notification Hub — Phase 5 policy classifier integration', () => {
  /** @type {import('node:child_process').ChildProcess} */
  let hubProc
  let hubBase = ''
  let tmpDataDir = ''

  beforeAll(async () => {
    tmpDataDir = await mkdtemp(path.join(tmpdir(), 'hub-policy-test-'))
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
        HUB_PERMISSION_THREAD_DEDUP_MS: '200',
        NTFY_BASE_URL: '',
        HUB_REPLY_RELAY_CMD: '',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    hubProc.stdout.on('data', () => {})
    hubProc.stderr.on('data', () => {})
    // wait for hub
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`${hubBase}/api/health`)
        if (r.ok) break
      } catch { /* ignore */ }
      await new Promise((r) => setTimeout(r, 100))
    }
  }, 10_000)

  afterAll(async () => {
    if (hubProc) {
      hubProc.kill('SIGTERM')
      await new Promise((r) => setTimeout(r, 200))
    }
    if (tmpDataDir) await rm(tmpDataDir, { recursive: true, force: true })
  })

  it('hard-deny: sudo command returns deny immediately without creating an approval', async () => {
    const result = await postJson(hubBase, '/api/hooks/permission-request', {
      session_id: 'pol-hd-1',
      cwd: '/tmp/pol-hd-1',
      tool_name: 'Bash',
      tool_input: { command: 'sudo apt update' },
    })
    expect(result.status).toBe(200)
    expect(result.data.hookSpecificOutput.decision.behavior).toBe('deny')
    expect(result.data.hookSpecificOutput.decision.message).toMatch(/hard_deny:sudo/)

    // No approval was created.
    const approvalsRes = await getJson(hubBase, '/api/approvals')
    const created = approvalsRes.data.items.filter(
      (a) => a.cwd === '/tmp/pol-hd-1',
    )
    expect(created).toHaveLength(0)

    // A permission-blocked notification was stored.
    const notifRes = await getJson(hubBase, '/api/notifications?limit=20')
    const blocked = notifRes.data.items.find(
      (n) => n.metadata?.cwd === '/tmp/pol-hd-1' && n.metadata?.hookType === 'permission-blocked',
    )
    expect(blocked).toBeDefined()
    expect(blocked.metadata.risk_tier).toBe('hard_deny')
    expect(blocked.metadata.reason).toBe('hard_deny:sudo')
    expect(blocked.metadata.input_preview).toBe('sudo apt update')
  })

  it('hard-deny: WebFetch returns deny with web_access_disabled reason', async () => {
    const result = await postJson(hubBase, '/api/hooks/permission-request', {
      session_id: 'pol-hd-web',
      cwd: '/tmp/pol-hd-web',
      tool_name: 'WebFetch',
      tool_input: { url: 'https://example.com' },
    })
    expect(result.status).toBe(200)
    expect(result.data.hookSpecificOutput.decision.behavior).toBe('deny')
    expect(result.data.hookSpecificOutput.decision.message).toMatch(/web_access_disabled/)
  })

  it('destructive: rm -rf dist creates an approval with risk_tier=destructive', async () => {
    const hookPromise = postJson(hubBase, '/api/hooks/permission-request', {
      session_id: 'pol-d-1',
      cwd: '/tmp/pol-d-1',
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf dist' },
    })
    await new Promise((r) => setTimeout(r, 400))

    const approvalsRes = await getJson(hubBase, '/api/approvals')
    const pending = approvalsRes.data.items.find(
      (a) => a.cwd === '/tmp/pol-d-1' && a.status === 'pending',
    )
    expect(pending).toBeDefined()

    // The linked notification carries risk_tier=destructive on its metadata.
    const notifRes = await getJson(hubBase, '/api/notifications?limit=20')
    const notif = notifRes.data.items.find((n) => n.id === pending.notificationId)
    expect(notif).toBeDefined()
    expect(notif.metadata.risk_tier).toBe('destructive')
    expect(typeof notif.metadata.timeout_at).toBe('string')

    // Approve to unblock the long-poll.
    await postJson(hubBase, `/api/approvals/${pending.id}/decide`, {
      decision: 'approve',
      source: 'g2',
    })
    const result = await hookPromise
    expect(result.data.hookSpecificOutput.decision.behavior).toBe('allow')
  })

  it('normal: regular Bash command flows through unchanged with risk_tier=normal', async () => {
    const hookPromise = postJson(hubBase, '/api/hooks/permission-request', {
      session_id: 'pol-n-1',
      cwd: '/tmp/pol-n-1',
      tool_name: 'Bash',
      tool_input: { command: 'echo hello' },
    })
    await new Promise((r) => setTimeout(r, 400))

    const approvalsRes = await getJson(hubBase, '/api/approvals')
    const pending = approvalsRes.data.items.find(
      (a) => a.cwd === '/tmp/pol-n-1' && a.status === 'pending',
    )
    expect(pending).toBeDefined()

    const notifRes = await getJson(hubBase, '/api/notifications?limit=20')
    const notif = notifRes.data.items.find((n) => n.id === pending.notificationId)
    expect(notif.metadata.risk_tier).toBe('normal')

    await postJson(hubBase, `/api/approvals/${pending.id}/decide`, {
      decision: 'approve',
      source: 'g2',
    })
    const result = await hookPromise
    expect(result.data.hookSpecificOutput.decision.behavior).toBe('allow')
  })

  it('audit log: permission.blocked + permission.classified entries are appended', async () => {
    await postJson(hubBase, '/api/hooks/permission-request', {
      session_id: 'pol-audit-hd',
      cwd: '/tmp/pol-audit-hd',
      tool_name: 'Bash',
      tool_input: { command: 'sudo whoami' },
    })
    // give the audit-log fire-and-forget appendFile a tick to settle
    await new Promise((r) => setTimeout(r, 200))

    const auditPath = path.join(tmpDataDir, 'audit.log.jsonl')
    const raw = await readFile(auditPath, 'utf8')
    const lines = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l))
    const classified = lines.filter((l) => l.event === 'permission.classified')
    const blocked = lines.filter((l) => l.event === 'permission.blocked')
    expect(classified.length).toBeGreaterThan(0)
    expect(blocked.length).toBeGreaterThan(0)
    const lastBlocked = blocked[blocked.length - 1]
    expect(lastBlocked.reason).toBe('hard_deny:sudo')
    expect(lastBlocked.input_preview).toBe('sudo whoami')
  })
})
