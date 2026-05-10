// Tmux relay transport: spawns the configured HUB_REPLY_RELAY_CMD shell
// command (typically reply-relay.sh) per call and pipes the JSON payload to
// stdin. The script itself is intentionally not modified.
//
// `bypassSourceFilter` is preserved so /api/v1/command (and Phase 4 session
// routing) can opt out of the legacy HUB_REPLY_RELAY_SOURCES allowlist.
//
// Per-call env injection: the returned closure accepts an optional
// `opts.tmuxTarget` (and is open for future per-call vars) so Phase 4 can
// route reply-relay invocations to a session-specific tmux target via
// RELAY_TMUX_TARGET without baking env at construction time.
import { spawn } from 'node:child_process'

/**
 * Build a relay function bound to runtime config. Returning a closure
 * keeps callers (services/command-service) from depending on env-derived
 * hub config and lets index.mjs swap in a stub during tests if ever needed.
 *
 * NOTE: `cfg.env` is intentionally NOT supported. Per-call env injection
 * happens inside the returned closure so concurrent calls can pass different
 * RELAY_TMUX_TARGET values without sharing mutable state.
 *
 * @param {{
 *   cmd: string,                  // HUB_REPLY_RELAY_CMD (empty => stubbed)
 *   timeoutMs: number,            // HUB_REPLY_RELAY_TIMEOUT_MS
 *   allowedSources: Set<string>,  // HUB_REPLY_RELAY_SOURCES
 * }} cfg
 */
export function createTmuxRelay(cfg) {
  const cmd = cfg.cmd
  const timeoutMs = cfg.timeoutMs
  const allowedSources = cfg.allowedSources

  /**
   * @param {{ reply?: { source?: string }, [k:string]: any }} payload
   * @param {{ bypassSourceFilter?: boolean, tmuxTarget?: string }} [opts]
   * @returns {Promise<{ status: 'stubbed'|'forwarded'|'failed', error?: string }>}
   */
  return async function relayReplyIfConfigured(payload, opts = {}) {
    if (!cmd) return { status: 'stubbed' }
    const source = payload?.reply?.source || ''
    // /api/v1/command 経路はリレー専用エンドポイントなので bypassSourceFilter:true を渡し、
    // HUB_REPLY_RELAY_SOURCES に source が無くてもリレーするようにする。
    // 既存の reply 経路（一引数呼び出し）は従来通り allowlist を尊重する。
    if (
      !opts.bypassSourceFilter &&
      allowedSources.size > 0 &&
      source &&
      !allowedSources.has(source)
    ) {
      return { status: 'stubbed' }
    }

    // Per-call env: clone process.env and overlay any per-call variables.
    // Cloning (vs mutating process.env) keeps concurrent calls isolated.
    const childEnv = { ...process.env }
    if (opts.tmuxTarget) childEnv.RELAY_TMUX_TARGET = opts.tmuxTarget

    return new Promise((resolve) => {
      const child = spawn(cmd, {
        shell: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: childEnv,
      })

      let stdout = ''
      let stderr = ''
      const maxCapture = 2000
      let settled = false

      const finish = (result) => {
        if (settled) return
        settled = true
        resolve(result)
      }

      const timer = setTimeout(() => {
        child.kill('SIGTERM')
        finish({ status: 'failed', error: `relay timeout ${timeoutMs}ms` })
      }, timeoutMs)

      child.on('error', (err) => {
        clearTimeout(timer)
        finish({ status: 'failed', error: err instanceof Error ? err.message : String(err) })
      })

      child.stdout.on('data', (chunk) => {
        if (stdout.length < maxCapture) stdout += String(chunk)
      })
      child.stderr.on('data', (chunk) => {
        if (stderr.length < maxCapture) stderr += String(chunk)
      })

      child.on('close', (code) => {
        clearTimeout(timer)
        if (code === 0) {
          return finish({ status: 'forwarded' })
        }
        const msg = (stderr || stdout || '').trim()
        return finish({ status: 'failed', error: `relay exit=${code}${msg ? ` ${msg}` : ''}` })
      })

      child.stdin.write(JSON.stringify(payload))
      child.stdin.end()
    })
  }
}
