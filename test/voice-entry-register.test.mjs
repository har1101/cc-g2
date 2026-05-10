// Phase 3 Pass 4: verify voice-entry POSTs /api/v1/sessions/register after a
// successful launch. Uses a tiny in-process Hub stub (HTTP server) to capture
// the request without spinning up the real notification-hub.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..')
const TEST_VOICE_TOKEN = 'voice-entry-test-token'
const TEST_HUB_TOKEN = 'hub-test-token'

function randomPort() {
  return 10000 + Math.floor(Math.random() * 50000)
}

async function waitForHealth(base) {
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(1000) })
      if (res.ok) return
    } catch { /* not ready */ }
    await new Promise((r) => setTimeout(r, 150))
  }
  throw new Error('voice-entry health check timed out')
}

describe('voice-entry → Hub /api/v1/sessions/register', () => {
  let proc
  let voiceBase = ''
  let hubServer
  let hubPort = 0
  let workspace = ''
  let registerCalls = []

  beforeAll(async () => {
    workspace = await mkdtemp(path.join(tmpdir(), 'voice-register-test-'))
    const repoRoot = path.join(workspace, 'repos')
    const stateDir = path.join(workspace, 'state')
    await mkdir(repoRoot, { recursive: true })
    await mkdir(stateDir, { recursive: true })
    await mkdir(path.join(repoRoot, 'alpha-tool'), { recursive: true })
    await writeFile(
      path.join(repoRoot, 'alpha-tool', 'package.json'),
      JSON.stringify({ name: 'alpha-tool' }),
      'utf8',
    )

    // ----- Hub stub -----
    hubPort = randomPort()
    hubServer = createServer((req, res) => {
      const auth = req.headers['x-cc-g2-token'] || ''
      if (req.method === 'POST' && req.url === '/api/v1/sessions/register') {
        if (auth !== TEST_HUB_TOKEN) {
          res.statusCode = 401
          res.end('{"ok":false,"error":"unauthorized"}')
          return
        }
        let body = ''
        req.on('data', (chunk) => { body += chunk.toString() })
        req.on('end', () => {
          let parsed = null
          try { parsed = JSON.parse(body) } catch { /* ignore */ }
          registerCalls.push(parsed)
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ ok: true, session: parsed }))
        })
        return
      }
      res.statusCode = 404
      res.end('{}')
    })
    await new Promise((resolve) => hubServer.listen(hubPort, '127.0.0.1', resolve))

    // ----- cc-g2.sh launch-detached stub -----
    const ccg2Stub = path.join(workspace, 'cc-g2-stub.sh')
    await writeFile(
      ccg2Stub,
      `#!/bin/sh
set -eu
cmd="$1"; shift || true
case "$cmd" in
  has-session) node -e 'console.log(JSON.stringify({ok:true, exists:false}))' ;;
  find-session) node -e 'console.log(JSON.stringify({ok:true, exists:false}))' ;;
  launch-detached)
    workdir=""; agent="claude"
    while [ $# -gt 0 ]; do
      case "$1" in
        --workdir) workdir="$2"; shift 2 ;;
        --agent) agent="$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    base=$(basename "$workdir")
    suffix=""; [ "$agent" = "codex" ] && suffix="-codex"
    node -e 'console.log(JSON.stringify({ok:true,sessionName:process.argv[1],tmuxTarget:process.argv[1]+":0.0",workdir:process.argv[2]}))' "g2-$base-stub$suffix" "$workdir"
    ;;
  *) echo "unknown $cmd" >&2; exit 1 ;;
esac
`,
      'utf8',
    )
    await chmod(ccg2Stub, 0o755)

    // ----- claude-bin stub (used by voice-entry's selector) -----
    const claudeStub = path.join(workspace, 'claude-stub.mjs')
    await writeFile(
      claudeStub,
      `const args = process.argv.slice(2)
const prompt = args[args.length - 1] || ''
const candidates = ['alpha-tool']
const line = prompt.split(/\\n/).find((l) => l.includes('alpha-tool'))
const target = line ? line.replace(/^- /, '').split(' | ')[0].trim() : ''
process.stdout.write(JSON.stringify({ mode: 'start', workdir: target, prompt: 'alpha task' }))
`,
      'utf8',
    )
    const claudeLauncher = path.join(workspace, 'claude-launcher.sh')
    await writeFile(
      claudeLauncher,
      `#!/bin/sh
exec ${JSON.stringify(process.execPath)} ${JSON.stringify(claudeStub)} "$@"
`,
      'utf8',
    )
    await chmod(claudeLauncher, 0o755)

    // ----- start voice-entry -----
    const port = randomPort()
    voiceBase = `http://127.0.0.1:${port}`
    proc = spawn('node', ['server/voice-entry/index.mjs'], {
      cwd: PROJECT_ROOT,
      env: {
        ...process.env,
        CC_G2_VOICE_ENTRY_BIND: '127.0.0.1',
        CC_G2_VOICE_ENTRY_PORT: String(port),
        CC_G2_VOICE_ENTRY_TOKEN: TEST_VOICE_TOKEN,
        CC_G2_VOICE_ENTRY_LAST_SESSION_FILE: path.join(stateDir, 'last-session.json'),
        CC_G2_VOICE_ENTRY_LOG_FILE: path.join(stateDir, 'voice-entry.log'),
        CC_G2_REPO_ROOTS: repoRoot,
        CC_G2_REPO_SCAN_DEPTH: '2',
        CC_G2_LAUNCH_SCRIPT: ccg2Stub,
        CLAUDE_BIN: claudeLauncher,
        // Phase 3: voice-entry needs HUB_URL + HUB_AUTH_TOKEN to call register.
        HUB_URL: `http://127.0.0.1:${hubPort}`,
        HUB_AUTH_TOKEN: TEST_HUB_TOKEN,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    await waitForHealth(voiceBase)
  }, 20000)

  afterAll(async () => {
    if (proc && !proc.killed) {
      proc.kill('SIGTERM')
      await new Promise((r) => setTimeout(r, 300))
      if (!proc.killed) proc.kill('SIGKILL')
    }
    if (hubServer) {
      await new Promise((resolve) => hubServer.close(resolve))
    }
    await rm(workspace, { recursive: true, force: true }).catch(() => {})
  })

  it('POSTs /api/v1/sessions/register with the launched session', async () => {
    registerCalls = []
    const res = await fetch(`${voiceBase}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${TEST_VOICE_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'openclaw',
        messages: [{ role: 'user', content: 'alpha tool で作業して' }],
      }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.choices[0].message.content).toContain('alpha-tool')

    // Wait briefly for the fire-and-forget register POST to land.
    const deadline = Date.now() + 3000
    while (registerCalls.length === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50))
    }
    expect(registerCalls.length).toBeGreaterThanOrEqual(1)
    const last = registerCalls[registerCalls.length - 1]
    expect(last).toMatchObject({
      backend: 'claude-code',
      project_id: '_unmanaged',
      source: 'voice-entry',
    })
    // Phase 3 Codex #9: voice-entry now pre-allocates an agentSessionId
    // (`voice-<uuid>`) and threads it through launchCcG2Session as
    // --agent-session-id, so the registered session_id matches the env var
    // CC_G2_AGENT_SESSION_ID injected into the spawned tmux session. The
    // legacy `voice-<sessionName>` form is only used as a fallback when no
    // agentSessionId is available (e.g. continue-existing flows).
    expect(last.session_id).toMatch(/^voice-[0-9a-f-]{36}$/)
    expect(last.tmux_target).toMatch(/^g2-alpha-tool-stub.*:0\.0$/)
  })
})
