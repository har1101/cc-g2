// Phase 5 Pass 7: POST /api/v1/permissions/:id/ack-blocked
//
// Acknowledges a hard-deny notification. Looks up by metadata.request_id
// (canonical) or notification.id (fallback). Stamps blockedAckAt on the
// notification metadata and emits permission.blocked_ack to the audit log.

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

describe('Notification Hub — POST /api/v1/permissions/:id/ack-blocked', () => {
  /** @type {import('node:child_process').ChildProcess} */
  let hubProc
  let hubBase = ''
  let tmpDataDir = ''

  beforeAll(async () => {
    tmpDataDir = await mkdtemp(path.join(tmpdir(), 'hub-ackbl-test-'))
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

  it('ack by request_id stamps blockedAckAt and writes audit entry', async () => {
    // Trigger a hard-deny so a permission-blocked notification is created.
    const hookRes = await postJson(hubBase, '/api/hooks/permission-request', {
      session_id: 'ack-1',
      cwd: '/tmp/ack-1',
      tool_name: 'Bash',
      tool_input: { command: 'sudo apt update' },
    })
    expect(hookRes.data.hookSpecificOutput.decision.behavior).toBe('deny')

    const notifRes = await getJson(hubBase, '/api/notifications?limit=20')
    const blocked = notifRes.data.items.find(
      (n) => n.metadata?.cwd === '/tmp/ack-1' && n.metadata?.hookType === 'permission-blocked',
    )
    expect(blocked).toBeDefined()
    const requestId = blocked.metadata.request_id
    expect(typeof requestId).toBe('string')

    // Ack via request_id (canonical lookup).
    const ack = await postJson(hubBase, `/api/v1/permissions/${requestId}/ack-blocked`, {
      source: 'g2',
    })
    expect(ack.status).toBe(200)
    expect(ack.data.ok).toBe(true)
    expect(typeof ack.data.ackAt).toBe('string')

    // Verify metadata.blockedAckAt is now set.
    const after = await getJson(hubBase, '/api/notifications?limit=20')
    const blockedAfter = after.data.items.find((n) => n.id === blocked.id)
    expect(blockedAfter.metadata.blockedAckAt).toBe(ack.data.ackAt)
    expect(blockedAfter.metadata.blockedAckSource).toBe('g2')

    // Audit log captures permission.blocked_ack
    const auditPath = path.join(tmpDataDir, 'audit.log.jsonl')
    const raw = await readFile(auditPath, 'utf8')
    const lines = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l))
    const ackEvents = lines.filter((l) => l.event === 'permission.blocked_ack' && l.request_id === requestId)
    expect(ackEvents.length).toBeGreaterThan(0)
  })

  it('ack by notification id (fallback path) also works', async () => {
    await postJson(hubBase, '/api/hooks/permission-request', {
      session_id: 'ack-2',
      cwd: '/tmp/ack-2',
      tool_name: 'WebFetch',
      tool_input: { url: 'https://example.com' },
    })

    const notifRes = await getJson(hubBase, '/api/notifications?limit=20')
    const blocked = notifRes.data.items.find(
      (n) => n.metadata?.cwd === '/tmp/ack-2' && n.metadata?.hookType === 'permission-blocked',
    )
    expect(blocked).toBeDefined()

    const ack = await postJson(hubBase, `/api/v1/permissions/${blocked.id}/ack-blocked`, {
      source: 'g2',
      device_id: 'g2-test-device',
    })
    expect(ack.status).toBe(200)
    expect(ack.data.notification_id).toBe(blocked.id)
  })

  it('returns 404 for an unknown id', async () => {
    const ack = await postJson(hubBase, '/api/v1/permissions/no-such-id/ack-blocked', { source: 'g2' })
    expect(ack.status).toBe(404)
    expect(ack.data.ok).toBe(false)
  })
})
