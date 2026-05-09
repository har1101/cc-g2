/**
 * /api/v1/stt/stream — WSS endpoint for live STT (Phase 2).
 *
 * The HTTP server is `node:http`'s createServer; this module exposes
 * `attachSttStreamWss(httpServer, deps)` which:
 *
 * - Creates a `WebSocketServer({ noServer: true })` and wires it to the
 *   server's `upgrade` event for paths starting with `/api/v1/stt/stream`.
 * - Verifies `X-CC-G2-Token` header. Invalid → close(4401, 'Unauthorized').
 * - Caps simultaneous active connections (default 10). Exceeded →
 *   close(1013, 'RateLimit').
 * - Parses the first text frame as JSON `stt.start`. Validates fields.
 * - Wires text frames to engine.finalize / engine.cancel; binary frames
 *   to engine.pushPcm; engine partial / error → text frames back.
 *
 * The actual STT engine is injected (`deps.createSttEngine`). The Deepgram
 * engine lives in `stt/deepgram-engine.mjs` (Pass 2).
 */

import { WebSocketServer } from 'ws'
import { log } from '../core/log.mjs'

const STREAM_PATH = '/api/v1/stt/stream'
const DEFAULT_MAX_CONCURRENT = 10

let activeConnections = 0

/**
 * Validate the parsed `stt.start` payload. Returns null on success, or
 * an `{ code, message }` describing the first failure.
 */
function validateStartFrame(p) {
  if (!p || typeof p !== 'object') return { code: 'invalid_start', message: 'expected object' }
  if (p.type !== 'stt.start') return { code: 'invalid_start', message: 'first frame must be stt.start' }
  if (typeof p.voice_session_id !== 'string' || !p.voice_session_id) {
    return { code: 'invalid_start', message: 'voice_session_id required' }
  }
  if (p.engine !== 'deepgram-stream') {
    return { code: 'invalid_start', message: `unsupported engine: ${p.engine}` }
  }
  if (p.encoding !== 'linear16') {
    return { code: 'invalid_start', message: 'encoding must be linear16' }
  }
  if (p.sample_rate !== 16000) {
    return { code: 'invalid_start', message: 'sample_rate must be 16000' }
  }
  if (p.channels !== 1) {
    return { code: 'invalid_start', message: 'channels must be 1' }
  }
  if (p.lang != null && typeof p.lang !== 'string') {
    return { code: 'invalid_start', message: 'lang must be a string' }
  }
  return null
}

function safeSendJson(ws, obj) {
  try {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(obj))
    }
  } catch (err) {
    log('[stt-stream] send failed:', err && err.message ? err.message : err)
  }
}

function closeWithCode(ws, code, reason) {
  try {
    ws.close(code, reason)
  } catch {
    /* ignore */
  }
}

/**
 * Per-connection handler. Wires `ws` ↔ engine session.
 *
 * @param {{ ws: import('ws').WebSocket, req: import('http').IncomingMessage, createSttEngine: () => any, log: (msg: string) => void }} ctx
 */
async function runStreamSession(ctx) {
  const { ws, createSttEngine } = ctx
  let session = null
  let sessionReady = null // Promise<void> resolved once `session` is non-null
  let finalized = false
  let cancelled = false
  let closed = false
  let voiceSessionId = ''
  // Per-session inbound serializer: every message handler chains onto this
  // promise so PCM that arrives before stt.start finishes still ends up
  // pushed in arrival order, and finalize cannot run until all queued PCM
  // has been pushed.
  let queue = Promise.resolve()

  ws.on('error', (err) => {
    log('[stt-stream] ws error:', err && err.message ? err.message : err)
  })

  ws.on('close', () => {
    closed = true
    activeConnections = Math.max(0, activeConnections - 1)
    // If the client disappeared without finalize/cancel, drop the upstream.
    queue = queue.then(() => {
      if (session && !finalized && !cancelled) {
        return Promise.resolve(session.cancel()).catch(() => {})
      }
    }).catch(() => {})
  })

  async function handleStart(payload) {
    const err = validateStartFrame(payload)
    if (err) {
      safeSendJson(ws, { type: 'stt.error', voice_session_id: payload?.voice_session_id || '', code: err.code, message: err.message })
      closeWithCode(ws, 1008, err.code)
      return
    }
    voiceSessionId = payload.voice_session_id
    let resolveReady
    sessionReady = new Promise((r) => { resolveReady = r })
    try {
      const engine = createSttEngine()
      session = await engine.start({
        voiceSessionId,
        lang: typeof payload.lang === 'string' ? payload.lang : 'ja',
      })
    } catch (e) {
      const code = e && e.code ? e.code : 'engine_init_failed'
      const message = e && e.message ? e.message : String(e)
      safeSendJson(ws, { type: 'stt.error', voice_session_id: voiceSessionId, code, message })
      closeWithCode(ws, 1011, code)
      resolveReady()
      return
    }

    if (typeof session.onPartial === 'function') {
      session.onPartial((p) => {
        if (closed || finalized || cancelled) return
        safeSendJson(ws, {
          type: 'stt.partial',
          voice_session_id: voiceSessionId,
          stable_text: p.stable_text,
          partial_text: p.partial_text,
          stable_seq: p.stable_seq,
          partial_seq: p.partial_seq,
        })
      })
    }
    if (typeof session.onError === 'function') {
      session.onError((errEv) => {
        if (closed) return
        safeSendJson(ws, {
          type: 'stt.error',
          voice_session_id: voiceSessionId,
          code: errEv.code || 'provider_error',
          message: errEv.message || '',
        })
        closeWithCode(ws, 1011, errEv.code || 'provider_error')
      })
    }
    resolveReady()
  }

  async function handleBinary(data) {
    if (!sessionReady) return // PCM before stt.start — drop silently
    await sessionReady
    if (!session) return
    try {
      const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
      await session.pushPcm(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength))
    } catch (err) {
      const msg = err && err.message ? err.message : String(err)
      safeSendJson(ws, { type: 'stt.error', voice_session_id: voiceSessionId, code: 'engine_error', message: msg })
      closeWithCode(ws, 1011, 'engine_error')
    }
  }

  async function handleFinalize() {
    if (!sessionReady) return
    await sessionReady
    if (!session || finalized || cancelled) return
    finalized = true
    try {
      const final = await session.finalize()
      safeSendJson(ws, {
        type: 'stt.final',
        voice_session_id: voiceSessionId,
        text: final.text,
        confidence: final.confidence,
        duration_ms: final.duration_ms,
      })
    } catch (e) {
      const msg = e && e.message ? e.message : String(e)
      safeSendJson(ws, { type: 'stt.error', voice_session_id: voiceSessionId, code: 'finalize_failed', message: msg })
    } finally {
      closeWithCode(ws, 1000, 'final')
    }
  }

  async function handleCancel() {
    if (!sessionReady) {
      closeWithCode(ws, 1000, 'cancelled')
      return
    }
    await sessionReady
    if (!session || finalized || cancelled) return
    cancelled = true
    try {
      await session.cancel()
    } catch {
      /* ignore */
    } finally {
      closeWithCode(ws, 1000, 'cancelled')
    }
  }

  ws.on('message', (data, isBinary) => {
    if (closed) return
    if (isBinary) {
      const copy = Buffer.isBuffer(data) ? data : Buffer.from(data)
      queue = queue.then(() => handleBinary(copy)).catch(() => {})
      return
    }
    const text = data.toString('utf8')
    let payload
    try {
      payload = JSON.parse(text)
    } catch {
      safeSendJson(ws, { type: 'stt.error', voice_session_id: voiceSessionId, code: 'invalid_json', message: 'malformed JSON' })
      closeWithCode(ws, 1003, 'invalid_json')
      return
    }
    if (!sessionReady) {
      // First text frame must be stt.start.
      queue = queue.then(() => handleStart(payload)).catch((err) => {
        log('[stt-stream] start handler crash:', err && err.message ? err.message : err)
      })
      return
    }
    if (payload && payload.type === 'stt.finalize') {
      queue = queue.then(() => handleFinalize()).catch(() => {})
      return
    }
    if (payload && payload.type === 'stt.cancel') {
      queue = queue.then(() => handleCancel()).catch(() => {})
      return
    }
    safeSendJson(ws, {
      type: 'stt.error',
      voice_session_id: voiceSessionId,
      code: 'unexpected_frame',
      message: `unexpected frame type=${payload?.type || 'unknown'}`,
    })
  })
}

/**
 * Attach the STT-stream WSS to `httpServer`. Idempotent: re-attaching to
 * the same server appends another `upgrade` listener — the caller controls
 * lifetimes in `index.mjs` (one attach per http server).
 *
 * `deps`:
 * - `hubAuthToken`: required token. If empty, all requests are accepted
 *   (mirrors the HTTP path semantics).
 * - `createSttEngine`: factory that returns a Hub-side `SttEngine`. The
 *   factory is called per-connection (one engine per session).
 * - `maxConcurrent` (optional, default 10): cap on simultaneous live
 *   sessions across this hub process.
 *
 * Exported for unit tests; `index.mjs` calls it once at boot per http server.
 */
export function attachSttStreamWss(httpServer, deps) {
  const { hubAuthToken, createSttEngine } = deps
  const maxConcurrent = Number.isFinite(deps.maxConcurrent) && deps.maxConcurrent > 0
    ? deps.maxConcurrent
    : DEFAULT_MAX_CONCURRENT
  if (typeof createSttEngine !== 'function') {
    throw new Error('attachSttStreamWss: createSttEngine is required')
  }

  // handleProtocols: when the browser advertises `cc-g2-token.<token>` we echo
  // it back so the connection completes. ws default would otherwise reject the
  // subprotocol and break the auth path used by browsers.
  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (offered) => {
      for (const p of offered) {
        if (typeof p === 'string' && p.startsWith('cc-g2-token.')) return p
      }
      return false
    },
  })

  httpServer.on('upgrade', (req, socket, head) => {
    if (!req.url || !req.url.startsWith(STREAM_PATH)) {
      // Some other upgrade endpoint will eventually exist; do nothing here so
      // we don't kill upgrades for paths we don't own.
      return
    }

    // Auth check. Browsers cannot set arbitrary headers on the WS upgrade,
    // so we accept the token via three transport channels in priority order:
    //   1. `X-CC-G2-Token` header (Node ws clients, curl)
    //   2. `Sec-WebSocket-Protocol: cc-g2-token.<token>` subprotocol (browsers)
    //   3. `?token=<token>` query string (fallback for older browsers)
    if (hubAuthToken) {
      const headerToken = String(req.headers['x-cc-g2-token'] || '').trim()
      const protoHeader = String(req.headers['sec-websocket-protocol'] || '')
      const subprotoToken = protoHeader
        .split(',')
        .map((p) => p.trim())
        .filter((p) => p.startsWith('cc-g2-token.'))
        .map((p) => p.slice('cc-g2-token.'.length))[0] || ''
      let queryToken = ''
      try {
        const u = new URL(req.url, 'http://localhost')
        queryToken = u.searchParams.get('token')?.trim() || ''
      } catch { /* invalid URL — leave queryToken empty */ }

      const provided = headerToken || subprotoToken || queryToken
      if (provided !== hubAuthToken) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
    }

    // Rate limit.
    if (activeConnections >= maxConcurrent) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n')
      socket.destroy()
      return
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      activeConnections += 1
      runStreamSession({ ws, req, createSttEngine }).catch((err) => {
        log('[stt-stream] session error:', err && err.message ? err.message : err)
        try { ws.close(1011, 'session_error') } catch { /* ignore */ }
      })
    })
  })

  return {
    wss,
    /** test-only: peek at the gate */
    _activeCount: () => activeConnections,
  }
}

/** Test helper: reset the in-process counter. Not used at runtime. */
export function _resetActiveConnections() {
  activeConnections = 0
}

export const STT_STREAM_PATH = STREAM_PATH
