import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, rm, writeFile, chmod, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createTmuxRelay } from '../server/notification-hub/transport/tmux-relay.mjs'

// These tests verify the per-call env injection seam introduced for Phase 4
// session routing: createTmuxRelay() must NOT bake env at closure creation,
// and the returned closure must accept { tmuxTarget } per call so that two
// concurrent invocations see independent RELAY_TMUX_TARGET values.

describe('transport/tmux-relay — per-call env injection', () => {
  /** @type {string} */
  let workDir
  /** @type {string} */
  let captureScript
  /** @type {string} */
  let outDir

  beforeAll(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'tmux-relay-test-'))
    outDir = path.join(workDir, 'out')
    await rm(outDir, { recursive: true, force: true }).catch(() => {})
    await writeFile(path.join(workDir, '.gitkeep'), '')
    // Tiny capture script: writes the relevant env var (or "UNSET") plus the
    // payload from stdin to a uniquely named file derived from $CAPTURE_KEY.
    captureScript = path.join(workDir, 'capture.sh')
    const sh = `#!/bin/sh
mkdir -p "${outDir}"
val="\${RELAY_TMUX_TARGET-UNSET}"
key="\${CAPTURE_KEY:-default}"
out="${outDir}/\${key}.txt"
printf 'env=%s\\n' "$val" > "$out"
cat >> "$out"
exit 0
`
    await writeFile(captureScript, sh)
    await chmod(captureScript, 0o755)
  }, 10000)

  afterAll(async () => {
    if (workDir) await rm(workDir, { recursive: true, force: true }).catch(() => {})
  })

  function makeRelay(extraCmdEnv = '') {
    return createTmuxRelay({
      cmd: `${extraCmdEnv} sh ${captureScript}`,
      timeoutMs: 5000,
      allowedSources: new Set(),
    })
  }

  async function readCapture(key) {
    const file = path.join(outDir, `${key}.txt`)
    return readFile(file, 'utf8')
  }

  it('passes RELAY_TMUX_TARGET to the spawned child when tmuxTarget is provided', async () => {
    const relay = makeRelay('CAPTURE_KEY=case-with')
    const result = await relay({ reply: { source: 's' }, hello: 1 }, { tmuxTarget: 'g2-foo:0.0' })
    expect(result.status).toBe('forwarded')
    const captured = await readCapture('case-with')
    expect(captured).toContain('env=g2-foo:0.0')
  })

  it('does NOT set RELAY_TMUX_TARGET in the child env when tmuxTarget is omitted', async () => {
    const relay = makeRelay('CAPTURE_KEY=case-without')
    const result = await relay({ reply: { source: 's' }, hello: 2 })
    expect(result.status).toBe('forwarded')
    const captured = await readCapture('case-without')
    expect(captured).toContain('env=UNSET')
  })

  it('two concurrent calls with different tmuxTarget values do not see each other env', async () => {
    const relayA = makeRelay('CAPTURE_KEY=case-conc-a')
    const relayB = makeRelay('CAPTURE_KEY=case-conc-b')
    const [resA, resB] = await Promise.all([
      relayA({ reply: { source: 's' }, n: 'a' }, { tmuxTarget: 'g2-aaa:0.0' }),
      relayB({ reply: { source: 's' }, n: 'b' }, { tmuxTarget: 'g2-bbb:0.0' }),
    ])
    expect(resA.status).toBe('forwarded')
    expect(resB.status).toBe('forwarded')
    const a = await readCapture('case-conc-a')
    const b = await readCapture('case-conc-b')
    expect(a).toContain('env=g2-aaa:0.0')
    expect(a).not.toContain('g2-bbb:0.0')
    expect(b).toContain('env=g2-bbb:0.0')
    expect(b).not.toContain('g2-aaa:0.0')
    // Confirm process.env was not polluted by the per-call overlay.
    expect(process.env.RELAY_TMUX_TARGET).toBeUndefined()
  })
})
