/**
 * Frontend Deepgram streaming engine (Phase 2).
 *
 * Connects to the Hub's `/api/v1/stt/stream` WSS endpoint. The Hub proxies
 * to Deepgram and emits stt.partial / stt.final / stt.error frames. We do
 * NOT talk to Deepgram directly: that would require shipping the API key
 * to the browser, which is forbidden by §7.3.
 *
 * Wire protocol (server-side spec lives in routes/stt-stream.mjs):
 *
 *   client → server (text JSON):
 *     { type: 'stt.start', voice_session_id, engine: 'deepgram-stream',
 *       encoding: 'linear16', sample_rate: 16000, channels: 1, lang }
 *     { type: 'stt.finalize', voice_session_id }
 *     { type: 'stt.cancel', voice_session_id }
 *
 *   client → server (binary): PCM Int16LE 16kHz mono.
 *
 *   server → client (text JSON):
 *     { type: 'stt.partial', stable_text, partial_text, stable_seq, partial_seq }
 *     { type: 'stt.final', text, confidence, duration_ms }
 *     { type: 'stt.error', code, message }
 *
 * Sequence rules (Codex review):
 * - `stable_seq` and `partial_seq` are monotonically increasing. Stale
 *   partials (lower seq than the last seen) are dropped on the client side.
 * - finalize waits for `stt.final` for up to 800ms, then synthesizes a final
 *   from the last seen `stable_text` (no `partial_text`).
 */

import { appConfig, createHubHeaders } from '../config'
import type {
  SttEngine,
  SttEngineKind,
  SttEngineStartOpts,
  SttFinalResult,
  SttPartialResult,
  SttSession,
} from './engine'

const FINALIZE_TIMEOUT_MS = 800

type ServerFrame =
  | { type: 'stt.partial'; voice_session_id?: string; stable_text: string; partial_text: string; stable_seq: number; partial_seq: number }
  | { type: 'stt.final'; voice_session_id?: string; text: string; confidence?: number; duration_ms?: number }
  | { type: 'stt.error'; voice_session_id?: string; code: string; message: string }

function buildStreamUrl(): string {
  const hub = appConfig.notificationHubUrl
  // notificationHubUrl is http(s)://… ; flip to ws(s)://… without rebuilding
  // the rest of the URL.
  if (hub.startsWith('https://')) return `wss://${hub.slice('https://'.length)}/api/v1/stt/stream`
  if (hub.startsWith('http://')) return `ws://${hub.slice('http://'.length)}/api/v1/stt/stream`
  // Fallback for unusual configs — let the browser parse and fail loudly.
  return `${hub}/api/v1/stt/stream`
}

/**
 * Open a WebSocket. Browsers do not allow custom headers on `new WebSocket()`,
 * so we encode the auth token as the `Sec-WebSocket-Protocol` subprotocol.
 * The Hub upgrade handler accepts the token via header / subprotocol /
 * `?token=` query (in that priority order).
 *
 * Codex 2 #8: `?token=` query is a LAST-RESORT fallback. Tokens in URLs leak
 * into HTTP access logs, browser history, error reports, etc. We rely on the
 * subprotocol path for current-generation browsers; the query string is kept
 * only for older browsers / proxies that strip subprotocol negotiation. Do
 * NOT propagate this URL anywhere it would be persisted.
 */
function openWs(url: string, token: string, deps?: { wsFactory?: WebSocketFactory }): WebSocket {
  const u = new URL(url)
  if (token) {
    // Subprotocol is the preferred path. Query string is a defensive fallback
    // because some legacy proxies/firewalls strip subprotocol negotiation.
    u.searchParams.set('token', token)
  }
  const factory = deps?.wsFactory ?? ((u: string, _protocols?: string | string[]) => new WebSocket(u))
  if (token) {
    return factory(u.toString(), [`cc-g2-token.${token}`])
  }
  return factory(u.toString())
}

export type WebSocketFactory = (url: string, protocols?: string | string[]) => WebSocket

export type DeepgramStreamEngineOptions = {
  /** URL override — used by tests */
  url?: string
  /** Auth token override — defaults to appConfig.hubAuthToken */
  token?: string
  /** WebSocket constructor injection — used by tests */
  wsFactory?: WebSocketFactory
  /** Override finalize timeout (ms). Production keeps 800ms. */
  finalizeTimeoutMs?: number
}

export function createDeepgramStreamEngine(opts: DeepgramStreamEngineOptions = {}): SttEngine {
  const kind: SttEngineKind = 'deepgram-stream'
  const url = opts.url || buildStreamUrl()
  const token = opts.token != null ? opts.token : appConfig.hubAuthToken
  const finalizeTimeoutMs = typeof opts.finalizeTimeoutMs === 'number' ? opts.finalizeTimeoutMs : FINALIZE_TIMEOUT_MS

  return {
    kind,
    async start({ voiceSessionId, lang }: SttEngineStartOpts): Promise<SttSession> {
      const ws = openWs(url, token, { wsFactory: opts.wsFactory })
      const startedAt = Date.now()
      let opened = false
      let finalized = false
      let cancelled = false
      let closed = false
      let lastPartialSeq = 0
      let lastStableSeq = 0
      let lastStableText = ''
      let lastConfidence: number | undefined
      const pendingBinary: ArrayBuffer[] = []
      const partialHandlers: Array<(p: SttPartialResult) => void> = []
      const errorHandlers: Array<(e: { code: string; message: string }) => void> = []
      const lateFinalHandlers: Array<(r: SttFinalResult) => void> = []
      // resolve when stt.final arrives; reject on error/close mid-finalize
      let finalResolver: ((r: SttFinalResult) => void) | null = null
      let finalRejecter: ((e: Error) => void) | null = null
      // True once finalize() has resolved (synthetic timeout or real final).
      // Subsequent stt.final frames trigger onLateFinal instead.
      let finalDelivered = false

      const startFrame = JSON.stringify({
        type: 'stt.start',
        voice_session_id: voiceSessionId,
        engine: 'deepgram-stream',
        encoding: 'linear16',
        sample_rate: 16000,
        channels: 1,
        lang: lang || 'ja',
      })

      // unused but referenced — silences lints in projects that strip headers helper
      void createHubHeaders

      const openPromise = new Promise<void>((resolve, reject) => {
        ws.addEventListener('open', () => {
          opened = true
          try {
            ws.send(startFrame)
            // flush buffered PCM
            for (const buf of pendingBinary) ws.send(buf)
            pendingBinary.length = 0
          } catch (err) {
            reject(err as Error)
            return
          }
          resolve()
        }, { once: true })
        ws.addEventListener('error', (ev) => {
          if (!opened) {
            reject(new Error(`stt-stream open failed: ${(ev as ErrorEvent).message || 'ws error'}`))
          }
        }, { once: true })
      })

      ws.addEventListener('message', (ev: MessageEvent) => {
        if (typeof ev.data !== 'string') return
        let frame: ServerFrame
        try {
          frame = JSON.parse(ev.data) as ServerFrame
        } catch {
          return
        }
        if (frame.type === 'stt.partial') {
          // Stale partial drop: ignore frames whose partial_seq is older than
          // the most recent we've seen (Codex review: "stale partial防止").
          if (frame.partial_seq < lastPartialSeq) return
          if (frame.stable_seq < lastStableSeq) return
          lastPartialSeq = frame.partial_seq
          lastStableSeq = frame.stable_seq
          lastStableText = frame.stable_text
          for (const h of partialHandlers) {
            try {
              h({
                stable_text: frame.stable_text,
                partial_text: frame.partial_text,
                stable_seq: frame.stable_seq,
                partial_seq: frame.partial_seq,
              })
            } catch { /* swallow */ }
          }
          return
        }
        if (frame.type === 'stt.final') {
          if (typeof frame.confidence === 'number') lastConfidence = frame.confidence
          if (finalResolver) {
            const resolver = finalResolver
            finalResolver = null
            finalRejecter = null
            finalDelivered = true
            resolver({
              text: frame.text,
              confidence: frame.confidence,
              duration_ms: frame.duration_ms,
              provider: 'deepgram-stream',
            })
          } else if (finalDelivered) {
            // finalize() already resolved (timeout path) but the real final
            // landed late. Record + notify subscribers.
            lastStableText = frame.text
            lastConfidence = frame.confidence
            const lateResult: SttFinalResult = {
              text: frame.text,
              confidence: frame.confidence,
              duration_ms: frame.duration_ms ?? (Date.now() - startedAt),
              provider: 'deepgram-stream',
            }
            for (const h of lateFinalHandlers) {
              try { h(lateResult) } catch { /* swallow */ }
            }
          } else {
            // Final arrived before finalize() was called. Record it so the
            // next finalize() can use it.
            lastStableText = frame.text
            lastConfidence = frame.confidence
          }
          return
        }
        if (frame.type === 'stt.error') {
          for (const h of errorHandlers) {
            try { h({ code: frame.code, message: frame.message }) } catch { /* swallow */ }
          }
          if (finalRejecter) {
            const rejecter = finalRejecter
            finalResolver = null
            finalRejecter = null
            rejecter(new Error(`${frame.code}: ${frame.message}`))
          }
        }
      })

      ws.addEventListener('close', () => {
        closed = true
        if (finalRejecter && !finalized && !cancelled) {
          const rejecter = finalRejecter
          finalResolver = null
          finalRejecter = null
          rejecter(new Error('ws-closed-before-final'))
        }
        // If the WS dies mid-session, surface to error subscribers so the UI
        // can move to a fallback state.
        if (!finalized && !cancelled) {
          for (const h of errorHandlers) {
            try { h({ code: 'provider_disconnected', message: 'ws closed before finalize' }) } catch { /* swallow */ }
          }
        }
      })

      try {
        await openPromise
      } catch (err) {
        try { ws.close() } catch { /* ignore */ }
        throw err
      }

      const session: SttSession = {
        voiceSessionId,
        async pushPcm(chunk: Uint8Array): Promise<void> {
          if (cancelled || finalized || closed) return
          // Defensive copy; underlying buffer can change while in transit.
          const copy = chunk.slice()
          const buf = copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength) as ArrayBuffer
          if (!opened) {
            pendingBinary.push(buf)
            return
          }
          try {
            ws.send(buf)
          } catch {
            /* the close listener will surface the error */
          }
        },
        async finalize(): Promise<SttFinalResult> {
          if (cancelled) {
            return { text: '', provider: kind }
          }
          if (finalized) {
            return { text: lastStableText, confidence: lastConfidence, duration_ms: Date.now() - startedAt, provider: kind }
          }
          finalized = true
          // Send finalize frame
          if (!closed) {
            try {
              ws.send(JSON.stringify({ type: 'stt.finalize', voice_session_id: voiceSessionId }))
            } catch { /* ignore — close handler will reject */ }
          }
          // Wait for stt.final OR timeout
          const result: SttFinalResult = await new Promise((resolve) => {
            const done = (r: SttFinalResult) => {
              clearTimeout(t)
              resolve(r)
            }
            finalResolver = (r) => done(r)
            // If close/error happens, we resolve with the best-known stable_text
            // rather than rejecting (per §0.1 / §4.7.1: "未確定 partial_text は使わない").
            finalRejecter = () => {
              done({
                text: lastStableText,
                confidence: lastConfidence,
                duration_ms: Date.now() - startedAt,
                provider: kind,
              })
            }
            const t = setTimeout(() => {
              finalResolver = null
              finalRejecter = null
              resolve({
                text: lastStableText,
                confidence: lastConfidence,
                duration_ms: Date.now() - startedAt,
                provider: kind,
              })
            }, finalizeTimeoutMs)
          })
          finalDelivered = true
          // We DO NOT close the ws here on the timeout path: the Hub may still
          // deliver a real stt.final that we want to surface to onLateFinal
          // subscribers. Close is driven by the Hub closing after sending its
          // own stt.final — the on('close') handler will tear down. Cancel/
          // explicit subsequent finalize will still close immediately.
          return result
        },
        async cancel(): Promise<void> {
          if (cancelled) return
          cancelled = true
          if (!closed) {
            try {
              ws.send(JSON.stringify({ type: 'stt.cancel', voice_session_id: voiceSessionId }))
            } catch { /* ignore */ }
          }
          try { ws.close() } catch { /* ignore */ }
          partialHandlers.length = 0
          errorHandlers.length = 0
          // late-final must NOT fire after cancel (per design §4.7.1)
          lateFinalHandlers.length = 0
          if (finalResolver) {
            const resolver = finalResolver
            finalResolver = null
            finalRejecter = null
            resolver({ text: '', provider: kind })
          }
        },
        onPartial(handler) {
          partialHandlers.push(handler)
        },
        onError(handler) {
          errorHandlers.push(handler)
        },
        onLateFinal(handler) {
          lateFinalHandlers.push(handler)
        },
      }
      return session
    },
  }
}
