// Phase 5: server-side destructive 2-step guard.
//
// processReply() must rewrite an `action='approve'` reply to a forced deny
// when the linked notification's metadata.risk_tier === 'destructive' AND
// the body lacks `two_step_confirmed: true`.
//
// Tests:
//   - destructive approve without two_step_confirmed → forced deny
//   - destructive approve with two_step_confirmed=true → real approve
//   - normal approve → unchanged

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

describe('Notification Hub — Phase 5 destructive 2-step guard', () => {
  /** @type {import('node:child_process').ChildProcess} */
  let hubProc
  let hubBase = ''
  let tmpDataDir = ''

  beforeAll(async () => {
    tmpDataDir = await mkdtemp(path.join(tmpdir(), 'hub-destruct-test-'))
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

  it('destructive approve without two_step_confirmed → forced deny', async () => {
    const hookPromise = postJson(hubBase, '/api/hooks/permission-request', {
      session_id: 'destruct-1',
      cwd: '/tmp/destruct-1',
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf dist' },
    })
    await new Promise((r) => setTimeout(r, 400))

    const approvalsRes = await getJson(hubBase, '/api/approvals')
    const pending = approvalsRes.data.items.find((a) => a.cwd === '/tmp/destruct-1' && a.status === 'pending')
    expect(pending).toBeDefined()

    // Caller forgets the two_step_confirmed flag. Hub must rewrite to deny.
    const replyRes = await postJson(hubBase, `/api/notifications/${pending.notificationId}/reply`, {
      action: 'approve',
      source: 'g2',
    })
    expect(replyRes.status).toBe(200)
    expect(replyRes.data.reply.resolvedAction).toBe('deny')

    const result = await hookPromise
    expect(result.data.hookSpecificOutput.decision.behavior).toBe('deny')
    expect(result.data.hookSpecificOutput.decision.message).toMatch(/forced_deny:no_two_step/)

    // Audit log captures forced_deny + answered events
    const auditPath = path.join(tmpDataDir, 'audit.log.jsonl')
    const raw = await readFile(auditPath, 'utf8')
    const lines = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l))
    expect(lines.some((l) => l.event === 'permission.forced_deny' && l.reason === 'forced_deny:no_two_step')).toBe(true)
    expect(lines.some((l) => l.event === 'permission.answered' && l.forced_deny === true)).toBe(true)
  })

  it('destructive approve with two_step_confirmed=true → real approve', async () => {
    const hookPromise = postJson(hubBase, '/api/hooks/permission-request', {
      session_id: 'destruct-2',
      cwd: '/tmp/destruct-2',
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf build' },
    })
    await new Promise((r) => setTimeout(r, 400))

    const approvalsRes = await getJson(hubBase, '/api/approvals')
    const pending = approvalsRes.data.items.find((a) => a.cwd === '/tmp/destruct-2' && a.status === 'pending')
    expect(pending).toBeDefined()

    const replyRes = await postJson(hubBase, `/api/notifications/${pending.notificationId}/reply`, {
      action: 'approve',
      source: 'g2',
      two_step_confirmed: true,
    })
    expect(replyRes.status).toBe(200)
    expect(replyRes.data.reply.resolvedAction).toBe('approve')

    const result = await hookPromise
    expect(result.data.hookSpecificOutput.decision.behavior).toBe('allow')
  })

  it('normal approve → unchanged (no rewrite)', async () => {
    const hookPromise = postJson(hubBase, '/api/hooks/permission-request', {
      session_id: 'normal-1',
      cwd: '/tmp/normal-1',
      tool_name: 'Bash',
      tool_input: { command: 'echo hi' },
    })
    await new Promise((r) => setTimeout(r, 400))

    const approvalsRes = await getJson(hubBase, '/api/approvals')
    const pending = approvalsRes.data.items.find((a) => a.cwd === '/tmp/normal-1' && a.status === 'pending')
    expect(pending).toBeDefined()

    const replyRes = await postJson(hubBase, `/api/notifications/${pending.notificationId}/reply`, {
      action: 'approve',
      source: 'g2',
    })
    expect(replyRes.status).toBe(200)
    expect(replyRes.data.reply.resolvedAction).toBe('approve')

    const result = await hookPromise
    expect(result.data.hookSpecificOutput.decision.behavior).toBe('allow')
  })
})
