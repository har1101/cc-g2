// Phase 5 Codex pass: /api/approvals/:id/decide must enforce the destructive
// 2-step guard, not just /api/notifications/:id/reply. Web-UI direct deciders
// previously bypassed it.
//
// Tests:
//   - destructive risk_tier with no two_step_confirmed → forced deny
//   - destructive risk_tier with two_step_confirmed=true → real approve
//   - normal risk_tier → unchanged (existing baseline)

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

describe('Notification Hub — Phase 5 destructive guard on /api/approvals/:id/decide', () => {
  /** @type {import('node:child_process').ChildProcess} */
  let hubProc
  let hubBase = ''
  let tmpDataDir = ''

  beforeAll(async () => {
    tmpDataDir = await mkdtemp(path.join(tmpdir(), 'hub-decide-guard-'))
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

  it('destructive approve via /decide without two_step_confirmed → forced deny', async () => {
    // Use the permission-request hook so the notification metadata picks up
    // risk_tier='destructive' from the policy classifier (rm -rf dist).
    const hookPromise = postJson(hubBase, '/api/hooks/permission-request', {
      session_id: 'decide-destruct-1',
      cwd: '/tmp/decide-destruct-1',
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf dist' },
    })
    await new Promise((r) => setTimeout(r, 400))

    const approvalsRes = await getJson(hubBase, '/api/approvals')
    const pending = approvalsRes.data.items.find((a) => a.cwd === '/tmp/decide-destruct-1' && a.status === 'pending')
    expect(pending).toBeDefined()

    // Hit /api/approvals/:id/decide directly with approve and no
    // two_step_confirmed — the route must rewrite the decision to deny.
    const decideRes = await postJson(hubBase, `/api/approvals/${pending.id}/decide`, {
      decision: 'approve',
      source: 'web-ui',
    })
    expect(decideRes.status).toBe(200)
    expect(decideRes.data.approval.decision).toBe('deny')

    const result = await hookPromise
    expect(result.data.hookSpecificOutput.decision.behavior).toBe('deny')

    // Audit log captures forced_deny event from the route side
    const auditPath = path.join(tmpDataDir, 'audit.log.jsonl')
    const raw = await readFile(auditPath, 'utf8')
    const lines = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l))
    expect(lines.some((l) => l.event === 'permission.forced_deny' && l.reason === 'forced_deny:no_two_step')).toBe(true)
  })

  it('destructive approve via /decide with two_step_confirmed=true → real approve', async () => {
    const hookPromise = postJson(hubBase, '/api/hooks/permission-request', {
      session_id: 'decide-destruct-2',
      cwd: '/tmp/decide-destruct-2',
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf build' },
    })
    await new Promise((r) => setTimeout(r, 400))

    const approvalsRes = await getJson(hubBase, '/api/approvals')
    const pending = approvalsRes.data.items.find((a) => a.cwd === '/tmp/decide-destruct-2' && a.status === 'pending')
    expect(pending).toBeDefined()

    const decideRes = await postJson(hubBase, `/api/approvals/${pending.id}/decide`, {
      decision: 'approve',
      source: 'web-ui',
      two_step_confirmed: true,
    })
    expect(decideRes.status).toBe(200)
    expect(decideRes.data.approval.decision).toBe('approve')

    const result = await hookPromise
    expect(result.data.hookSpecificOutput.decision.behavior).toBe('allow')
  })

  it('normal risk_tier approve via /decide → unchanged (no rewrite)', async () => {
    const hookPromise = postJson(hubBase, '/api/hooks/permission-request', {
      session_id: 'decide-normal-1',
      cwd: '/tmp/decide-normal-1',
      tool_name: 'Bash',
      tool_input: { command: 'echo hi' },
    })
    await new Promise((r) => setTimeout(r, 400))

    const approvalsRes = await getJson(hubBase, '/api/approvals')
    const pending = approvalsRes.data.items.find((a) => a.cwd === '/tmp/decide-normal-1' && a.status === 'pending')
    expect(pending).toBeDefined()

    const decideRes = await postJson(hubBase, `/api/approvals/${pending.id}/decide`, {
      decision: 'approve',
      source: 'web-ui',
    })
    expect(decideRes.status).toBe(200)
    expect(decideRes.data.approval.decision).toBe('approve')

    const result = await hookPromise
    expect(result.data.hookSpecificOutput.decision.behavior).toBe('allow')
  })
})
