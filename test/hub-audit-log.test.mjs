// Phase 5 §5.6: audit-log integration. Verify that the four event types
// land in tmp/notification-hub/audit.log.jsonl with the expected fields.
//
// Events covered:
//   - permission.classified  (every classify() call)
//   - permission.blocked     (hard-deny path, no approval created)
//   - permission.answered    (every approval-bound reply)
//   - permission.forced_deny (destructive approve without two_step_confirmed)

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

async function readAudit(tmpDataDir) {
  const auditPath = path.join(tmpDataDir, 'audit.log.jsonl')
  const raw = await readFile(auditPath, 'utf8').catch(() => '')
  return raw.split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

describe('Notification Hub — audit-log JSONL', () => {
  /** @type {import('node:child_process').ChildProcess} */
  let hubProc
  let hubBase = ''
  let tmpDataDir = ''

  beforeAll(async () => {
    tmpDataDir = await mkdtemp(path.join(tmpdir(), 'hub-audit-test-'))
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

  it('writes ts + event for every entry; ts is ISO-8601', async () => {
    // Trigger a classification so at least one entry exists.
    await postJson(hubBase, '/api/hooks/permission-request', {
      session_id: 'audit-shape',
      cwd: '/tmp/audit-shape',
      tool_name: 'WebFetch',
      tool_input: { url: 'https://example.com' },
    })
    await new Promise((r) => setTimeout(r, 200))

    const lines = await readAudit(tmpDataDir)
    expect(lines.length).toBeGreaterThan(0)
    for (const l of lines) {
      expect(typeof l.ts).toBe('string')
      expect(() => new Date(l.ts).toISOString()).not.toThrow()
      expect(typeof l.event).toBe('string')
    }
  })

  it('captures all four event types across a destructive flow', async () => {
    // 1. permission.classified + permission.blocked from hard-deny
    await postJson(hubBase, '/api/hooks/permission-request', {
      session_id: 'audit-flow-hd',
      cwd: '/tmp/audit-flow-hd',
      tool_name: 'Bash',
      tool_input: { command: 'sudo whoami' },
    })

    // 2. permission.classified + permission.forced_deny + permission.answered
    //    from a destructive approval where caller forgot two_step_confirmed
    const hookPromise = postJson(hubBase, '/api/hooks/permission-request', {
      session_id: 'audit-flow-d',
      cwd: '/tmp/audit-flow-d',
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf dist' },
    })
    await new Promise((r) => setTimeout(r, 400))
    const apprs = await getJson(hubBase, '/api/approvals')
    const pending = apprs.data.items.find((a) => a.cwd === '/tmp/audit-flow-d' && a.status === 'pending')
    expect(pending).toBeDefined()
    await postJson(hubBase, `/api/notifications/${pending.notificationId}/reply`, {
      action: 'approve',
      source: 'g2',
    })
    await hookPromise

    await new Promise((r) => setTimeout(r, 200))

    const lines = await readAudit(tmpDataDir)
    const eventCounts = {}
    for (const l of lines) eventCounts[l.event] = (eventCounts[l.event] || 0) + 1

    expect(eventCounts['permission.classified'] || 0).toBeGreaterThan(0)
    expect(eventCounts['permission.blocked'] || 0).toBeGreaterThan(0)
    expect(eventCounts['permission.forced_deny'] || 0).toBeGreaterThan(0)
    expect(eventCounts['permission.answered'] || 0).toBeGreaterThan(0)

    const blocked = lines.find((l) => l.event === 'permission.blocked' && l.input_preview === 'sudo whoami')
    expect(blocked).toBeDefined()
    expect(blocked.reason).toBe('hard_deny:sudo')

    const forced = lines.find((l) => l.event === 'permission.forced_deny')
    expect(forced.reason).toBe('forced_deny:no_two_step')
  })
})
