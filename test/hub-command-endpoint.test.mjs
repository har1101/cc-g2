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
    headers: { 'Content-Type': 'application/json', 'X-CC-G2-Token': TEST_HUB_TOKEN, ...headers },
    body: JSON.stringify(body),
  })
  let data = null
  try {
    data = await res.json()
  } catch {
    data = null
  }
  return { status: res.status, data }
}

async function getJson(base, pathname) {
  const res = await fetch(`${base}${pathname}`, {
    headers: { 'X-CC-G2-Token': TEST_HUB_TOKEN },
  })
  return { status: res.status, data: await res.json() }
}

async function waitForHub(base, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1000) })
      if (res.ok) return true
    } catch {
      // not ready
    }
    await new Promise((r) => setTimeout(r, 150))
  }
  return false
}

async function startHub({ env = {} } = {}) {
  const port = randomPort()
  const base = `http://127.0.0.1:${port}`
  const dataDir = await mkdtemp(path.join(tmpdir(), 'hub-cmd-test-'))
  const proc = spawn('node', ['server/notification-hub/index.mjs'], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      HUB_PORT: String(port),
      HUB_BIND_MODE: 'localhost',
      HUB_DATA_DIR: dataDir,
      HUB_AUTH_TOKEN: TEST_HUB_TOKEN,
      NTFY_BASE_URL: '',
      HUB_REPLY_RELAY_CMD: '',
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const ok = await waitForHub(base)
  if (!ok) {
    proc.kill('SIGKILL')
    throw new Error('hub did not start')
  }
  return { proc, base, dataDir, port }
}

async function stopHub(handle) {
  if (!handle) return
  const { proc, dataDir } = handle
  if (proc && !proc.killed) {
    proc.kill('SIGTERM')
    await new Promise((r) => setTimeout(r, 200))
    if (!proc.killed) proc.kill('SIGKILL')
  }
  if (dataDir) await rm(dataDir, { recursive: true, force: true }).catch(() => {})
}

describe('Notification Hub — POST /api/v1/command', () => {
  /** @type {{proc:any, base:string, dataDir:string, port:number}} */
  let hub

  beforeAll(async () => {
    hub = await startHub()
  }, 15000)

  afterAll(async () => {
    await stopHub(hub)
  })

  it('happy path: returns 200 with delivered_at and stubbed status when relay is unset', async () => {
    const before = Date.now()
    const { status, data } = await postJson(hub.base, '/api/v1/command', {
      source: 'g2_voice',
      text: 'テストが落ちた理由を調べて',
      transcript_confidence: 0.91,
      tmux_target: 'g2-myproj-a1b2:0.0',
    })
    expect(status).toBe(200)
    expect(data.ok).toBe(true)
    expect(typeof data.delivered_at).toBe('string')
    expect(new Date(data.delivered_at).getTime()).toBeGreaterThanOrEqual(before - 1000)
    expect(data.relay).toBe('stubbed')

    const { data: notifs } = await getJson(hub.base, '/api/notifications?limit=20')
    const match = notifs.items.find(
      (n) => n.metadata?.hookType === 'g2-command' && n.title === '[g2-command]',
    )
    expect(match).toBeDefined()
    expect(match.metadata.tmuxTarget).toBe('g2-myproj-a1b2:0.0')
    expect(match.metadata.transcriptConfidence).toBe(0.91)
  })

  it('returns 401 without auth token', async () => {
    const res = await fetch(`${hub.base}/api/v1/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'g2_voice', text: 'hi' }),
    })
    expect(res.status).toBe(401)
    const data = await res.json()
    expect(data.ok).toBe(false)
    expect(data.error).toBe('Unauthorized')
  })

  it('returns 400 on invalid JSON body', async () => {
    const res = await fetch(`${hub.base}/api/v1/command`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CC-G2-Token': TEST_HUB_TOKEN },
      body: 'not json',
    })
    expect(res.status).toBe(400)
    const data = await res.json()
    expect(data.error).toBe('invalid JSON body')
  })

  it('returns 400 when text is missing', async () => {
    const { status, data } = await postJson(hub.base, '/api/v1/command', {
      source: 'g2_voice',
    })
    expect(status).toBe(400)
    expect(data.error).toBe('text is required')
  })

  it('returns 400 when text is empty after sanitization', async () => {
    const { status, data } = await postJson(hub.base, '/api/v1/command', {
      source: 'g2_voice',
      text: '   \x01\x02   ',
    })
    expect(status).toBe(400)
    expect(data.error).toBe('text is required')
  })

  it('returns 400 when text is too long', async () => {
    const { status, data } = await postJson(hub.base, '/api/v1/command', {
      source: 'g2_voice',
      text: 'a'.repeat(2001),
    })
    expect(status).toBe(400)
    expect(data.error).toBe('text too long')
  })

  it('returns 400 on invalid source', async () => {
    const { status, data } = await postJson(hub.base, '/api/v1/command', {
      source: 'web',
      text: 'hello',
    })
    expect(status).toBe(400)
    expect(data.error).toBe('invalid source')
  })

  it('strips control characters but preserves \\n and \\t', async () => {
    const { status, data } = await postJson(hub.base, '/api/v1/command', {
      source: 'g2_text',
      text: 'hello\x01world\nfoo\tbar',
    })
    expect(status).toBe(200)
    expect(data.ok).toBe(true)

    const { data: notifs } = await getJson(hub.base, '/api/notifications?limit=20')
    const match = notifs.items.find(
      (n) => n.metadata?.hookType === 'g2-command' && n.summary?.includes('helloworld'),
    )
    expect(match).toBeDefined()
    expect(match.summary).toContain('helloworld\nfoo\tbar')
  })

  it('returns 400 on invalid tmux_target shape', async () => {
    const { status, data } = await postJson(hub.base, '/api/v1/command', {
      source: 'g2_voice',
      text: 'x',
      tmux_target: 'bad target with spaces',
    })
    expect(status).toBe(400)
    expect(data.error).toBe('invalid tmux_target')
  })
})

describe('Notification Hub — POST /api/v1/command relay invocation', () => {
  /** @type {{proc:any, base:string, dataDir:string, port:number}} */
  let hub
  /** @type {string} */
  let captureFile = ''
  /** @type {string} */
  let scriptDir = ''

  beforeAll(async () => {
    scriptDir = await mkdtemp(path.join(tmpdir(), 'hub-cmd-relay-'))
    captureFile = path.join(scriptDir, 'relay-stdin.log')
    const relayScript = path.join(scriptDir, 'capture-relay.sh')
    await writeFile(
      relayScript,
      `#!/bin/sh
cat >> ${JSON.stringify(captureFile)}
printf '\\n---\\n' >> ${JSON.stringify(captureFile)}
exit 0
`,
      'utf8',
    )
    await chmod(relayScript, 0o755)
    hub = await startHub({ env: { HUB_REPLY_RELAY_CMD: relayScript } })
  }, 15000)

  afterAll(async () => {
    await stopHub(hub)
    if (scriptDir) await rm(scriptDir, { recursive: true, force: true }).catch(() => {})
  })

  it('forwards sanitized text to the relay command stdin', async () => {
    const text = 'voice command with\x01control chars\nand newline'
    const { status, data } = await postJson(hub.base, '/api/v1/command', {
      source: 'g2_voice',
      text,
    })
    expect(status).toBe(200)
    expect(data.ok).toBe(true)
    expect(data.relay).toBeUndefined()

    const deadline = Date.now() + 4000
    let captured = ''
    while (Date.now() < deadline) {
      try {
        captured = await readFile(captureFile, 'utf8')
      } catch {
        captured = ''
      }
      if (captured.includes('---')) break
      await new Promise((r) => setTimeout(r, 50))
    }
    expect(captured).toContain('voice command with')
    expect(captured).toContain('control chars')
    expect(captured).not.toContain('')
    expect(captured).toContain('"hookType":"g2-command"')
    expect(captured).toContain('"source":"g2_voice"')
  })
})
