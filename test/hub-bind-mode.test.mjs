import { describe, it, expect, afterEach } from 'vitest'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..')
const TEST_HUB_TOKEN = 'test-hub-bind-token'

// Use ::1 (IPv6 loopback) as a stand-in "Tailnet IP" — 127.0.0.2 is not aliased
// on stock macOS, but ::1 is always available alongside 127.0.0.1.
const FAKE_TAILNET_IP = '::1'

let portCounter = 18787

function nextPort() {
  return portCounter++
}

function getStatus(host, port) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      {
        host,
        port,
        path: '/api/health',
        headers: { 'X-CC-G2-Token': TEST_HUB_TOKEN },
        timeout: 1500,
      },
      (res) => {
        res.resume()
        resolve(res.statusCode)
      },
    )
    req.on('error', reject)
    req.on('timeout', () => {
      req.destroy(new Error('timeout'))
    })
  })
}

async function waitFor(host, port, timeoutMs = 6000) {
  const deadline = Date.now() + timeoutMs
  let lastErr
  while (Date.now() < deadline) {
    try {
      const status = await getStatus(host, port)
      if (status === 200) return true
    } catch (err) {
      lastErr = err
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  throw lastErr || new Error(`Hub on ${host}:${port} did not become ready`)
}

async function spawnHub({ port, mode, tailIp, legacyBind }) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'hub-bind-test-'))
  const env = {
    ...process.env,
    HUB_PORT: String(port),
    HUB_DATA_DIR: dataDir,
    HUB_AUTH_TOKEN: TEST_HUB_TOKEN,
    NTFY_BASE_URL: '',
    HUB_REPLY_RELAY_CMD: '',
  }
  delete env.HUB_BIND
  delete env.HUB_BIND_MODE
  delete env.HUB_TAILSCALE_IP
  if (mode !== undefined) env.HUB_BIND_MODE = mode
  if (tailIp !== undefined) env.HUB_TAILSCALE_IP = tailIp
  if (legacyBind !== undefined) env.HUB_BIND = legacyBind

  const proc = spawn('node', ['server/notification-hub/index.mjs'], {
    cwd: PROJECT_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderrBuf = ''
  proc.stderr.on('data', (chunk) => {
    stderrBuf += chunk.toString('utf8')
  })
  let stdoutBuf = ''
  proc.stdout.on('data', (chunk) => {
    stdoutBuf += chunk.toString('utf8')
  })
  return {
    proc,
    dataDir,
    getStderr: () => stderrBuf,
    getStdout: () => stdoutBuf,
  }
}

async function teardown(handle) {
  if (!handle) return
  const { proc, dataDir } = handle
  if (proc && !proc.killed) {
    proc.kill('SIGTERM')
    await new Promise((resolve) => {
      const t = setTimeout(() => {
        if (!proc.killed) proc.kill('SIGKILL')
        resolve()
      }, 1500)
      proc.on('exit', () => {
        clearTimeout(t)
        resolve()
      })
    })
  }
  if (dataDir) await rm(dataDir, { recursive: true, force: true }).catch(() => {})
}

describe('Notification Hub — bind mode selector', () => {
  /** @type {Awaited<ReturnType<typeof spawnHub>> | null} */
  let handle = null

  afterEach(async () => {
    await teardown(handle)
    handle = null
  })

  it('tailnet mode: listens on loopback AND HUB_TAILSCALE_IP', async () => {
    const port = nextPort()
    handle = await spawnHub({ port, mode: 'tailnet', tailIp: FAKE_TAILNET_IP })

    await waitFor('127.0.0.1', port)
    const loopbackStatus = await getStatus('127.0.0.1', port)
    expect(loopbackStatus).toBe(200)

    const tailStatus = await getStatus(FAKE_TAILNET_IP, port)
    expect(tailStatus).toBe(200)
  }, 15000)

  it('tailnet mode without HUB_TAILSCALE_IP: loopback only (warning emitted)', async () => {
    const port = nextPort()
    handle = await spawnHub({ port, mode: 'tailnet' })

    await waitFor('127.0.0.1', port)
    const loopbackStatus = await getStatus('127.0.0.1', port)
    expect(loopbackStatus).toBe(200)

    // best-effort: warning should mention Tailscale unavailability
    expect(handle.getStderr()).toMatch(/Tailscale/i)
  }, 15000)

  it('localhost mode: binds only to 127.0.0.1 (non-loopback rejected)', async () => {
    const port = nextPort()
    handle = await spawnHub({ port, mode: 'localhost' })

    await waitFor('127.0.0.1', port)
    const loopbackStatus = await getStatus('127.0.0.1', port)
    expect(loopbackStatus).toBe(200)

    let connectError
    try {
      await getStatus(FAKE_TAILNET_IP, port)
    } catch (err) {
      connectError = err
    }
    expect(connectError).toBeDefined()
    expect(String(connectError && connectError.code)).toMatch(/ECONNREFUSED|ENOTFOUND|EADDRNOTAVAIL/)
  }, 15000)

  it('any mode: binds 0.0.0.0 (loopback reachable)', async () => {
    const port = nextPort()
    handle = await spawnHub({ port, mode: 'any' })

    await waitFor('127.0.0.1', port)
    const loopbackStatus = await getStatus('127.0.0.1', port)
    expect(loopbackStatus).toBe(200)

    expect(handle.getStdout()).toMatch(/listening on http:\/\/0\.0\.0\.0:/)
  }, 15000)

  it('legacy HUB_BIND env var still works (mapped to any-style single host)', async () => {
    const port = nextPort()
    handle = await spawnHub({ port, legacyBind: '127.0.0.1' })

    await waitFor('127.0.0.1', port)
    const loopbackStatus = await getStatus('127.0.0.1', port)
    expect(loopbackStatus).toBe(200)

    expect(handle.getStderr()).toMatch(/HUB_BIND/i)
  }, 15000)
})
