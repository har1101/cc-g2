/**
 * Deepgram streaming STT engine (Phase 2).
 *
 * Implements the Hub-side `SttEngine` shape:
 *
 *   const engine = createDeepgramEngine({ apiKey, model, language })
 *   const session = await engine.start({ voiceSessionId, lang })
 *   session.onPartial(p => ...)
 *   session.onError(e => ...)
 *   await session.pushPcm(uint8)   // forwarded as binary to Deepgram WS
 *   await session.finalize()       // → { text, confidence, duration_ms }
 *   await session.cancel()
 *
 * Deepgram contract (see https://developers.deepgram.com/docs/streaming):
 * - `is_final=false` transcripts are interim partials → emit `partial_text`
 *   and bump `partial_seq`.
 * - `is_final=true` transcripts are stable → concatenate to `stable_text`
 *   and bump `stable_seq` (NEVER rewind).
 * - `CloseStream` JSON message tells Deepgram to flush final + close.
 *
 * Sequence rules (Codex review #11):
 * - `stable_seq` and `partial_seq` are monotonically increasing across the
 *   whole session. `partial_seq` advances on every interim AND every is_final
 *   so listeners always see a fresh value when stable advances.
 * - `finalize()` waits up to 800ms for an additional `is_final=true`. If
 *   none arrives, returns the existing `stable_text` (with an empty trailing
 *   partial).
 *
 * The websocket dependency is `ws` (already in package.json for the
 * server route). For unit tests we accept a `wsFactory` injection so the
 * connection can be mocked without standing up a real Deepgram socket.
 */

import { WebSocket } from 'ws'

const FINALIZE_TIMEOUT_MS = 800
const DEEPGRAM_ENDPOINT = 'wss://api.deepgram.com/v1/listen'

function buildDeepgramUrl({ model, language }) {
  const u = new URL(DEEPGRAM_ENDPOINT)
  u.searchParams.set('model', model)
  if (language) u.searchParams.set('language', language)
  u.searchParams.set('encoding', 'linear16')
  u.searchParams.set('sample_rate', '16000')
  u.searchParams.set('channels', '1')
  u.searchParams.set('interim_results', 'true')
  u.searchParams.set('endpointing', '600')
  u.searchParams.set('smart_format', 'true')
  return u.toString()
}

function defaultWsFactory(url, headers) {
  return new WebSocket(url, { headers })
}

export function createDeepgramEngine(config = {}) {
  const apiKey = String(config.apiKey || '').trim()
  const model = String(config.model || 'nova-3').trim()
  const language = String(config.language || 'ja').trim()
  const wsFactory = typeof config.wsFactory === 'function' ? config.wsFactory : defaultWsFactory
  const finalizeTimeoutMs = Number.isFinite(config.finalizeTimeoutMs) && config.finalizeTimeoutMs >= 0
    ? config.finalizeTimeoutMs
    : FINALIZE_TIMEOUT_MS

  return {
    kind: 'deepgram-stream',
    async start({ voiceSessionId, lang } = {}) {
      if (!apiKey) {
        const err = new Error('DEEPGRAM_API_KEY is not configured')
        err.code = 'no_api_key'
        throw err
      }
      const useLang = (typeof lang === 'string' && lang) ? lang : language

      const url = buildDeepgramUrl({ model, language: useLang })
      const dgWs = wsFactory(url, { Authorization: `Token ${apiKey}` })

      // Session state (closure) ----------------------------------------------
      let stableText = ''
      let stableSeq = 0
      let partialSeq = 0
      let lastConfidence = undefined
      let opened = false
      let closed = false
      let finalized = false
      let cancelled = false
      const startedAt = Date.now()
      const partialHandlers = []
      const errorHandlers = []
      // Buffer PCM that arrives before the WS is open. Deepgram does not
      // ack the upgrade until the URL has been negotiated; in practice this
      // is ~50ms but tests mock the open() event so we still need a queue.
      const pendingPcm = []

      // --- ws lifecycle ---
      const openPromise = new Promise((resolve, reject) => {
        dgWs.once('open', () => {
          opened = true
          // flush any buffered PCM
          for (const chunk of pendingPcm) {
            try { dgWs.send(chunk) } catch { /* ignore */ }
          }
          pendingPcm.length = 0
          resolve()
        })
        dgWs.once('error', (err) => {
          if (!opened) reject(err)
          // After open, errors are surfaced via emitError (see below).
        })
      })

      // The most recent is_final transcript seen during finalize. Used as
      // the canonical text to return.
      let lastFinalText = ''

      // The current pending interim text, NOT yet stable. We resend it on
      // every partial so the client can keep the trailing buffer in sync.
      let currentPartial = ''

      function emitPartial() {
        const snapshot = {
          stable_text: stableText,
          partial_text: currentPartial,
          stable_seq: stableSeq,
          partial_seq: partialSeq,
        }
        for (const h of partialHandlers) {
          try { h(snapshot) } catch { /* ignore subscriber errors */ }
        }
      }

      function emitError(err) {
        for (const h of errorHandlers) {
          try { h(err) } catch { /* ignore */ }
        }
      }

      // --- Deepgram → emit ---
      function handleDgMessage(raw) {
        let payload
        try {
          payload = JSON.parse(raw.toString('utf8'))
        } catch {
          return
        }
        // Deepgram message types we care about:
        //   { type: 'Results', channel: { alternatives: [...] }, is_final, speech_final, ... }
        //   { type: 'Metadata', ... }
        //   { type: 'Error', ... }
        if (payload.type === 'Error') {
          emitError({ code: 'provider_error', message: payload.description || 'deepgram error' })
          return
        }
        if (payload.type !== 'Results' && payload.type !== undefined) {
          return
        }
        const alternatives = payload?.channel?.alternatives
        const transcript = (Array.isArray(alternatives) && alternatives[0]?.transcript) || ''
        const confidence = Array.isArray(alternatives) ? alternatives[0]?.confidence : undefined
        const isFinal = !!payload.is_final
        if (typeof confidence === 'number') lastConfidence = confidence

        if (isFinal) {
          if (transcript) {
            // Concatenate; Deepgram already includes spaces/punctuation
            // when smart_format is enabled, but we still join with space
            // to be safe across utterance boundaries.
            //
            // Codex 2 #3: Deepgram normally emits each `is_final=true` for a
            // distinct speech segment, so plain concatenation is correct in
            // the common case. However, overlapping is_final deltas (rare,
            // mostly during refinements at word boundaries) could duplicate
            // text. If field-tested traces show this, swap to a suffix-overlap
            // de-dup pass here. For now we keep the simpler, predictable
            // append + observability via lastFinalText so we can detect it.
            stableText = stableText ? `${stableText}${transcript}` : transcript
            lastFinalText = transcript
            stableSeq += 1
            partialSeq += 1 // advance partial too so listeners observe a fresh seq
          } else {
            // Empty final (silence boundary). Still bump seq to mark progress
            // so a stale-partial receiver doesn't get confused.
            stableSeq += 1
            partialSeq += 1
          }
          currentPartial = ''
          emitPartial()
          return
        }

        // Interim
        currentPartial = transcript
        partialSeq += 1
        emitPartial()
      }

      dgWs.on('message', handleDgMessage)
      dgWs.on('close', () => {
        closed = true
      })
      dgWs.on('error', (err) => {
        // Post-open errors → emit as engine error
        if (opened) {
          emitError({ code: 'provider_disconnected', message: err && err.message ? err.message : String(err) })
        }
      })

      // Wait until the WS is open OR errors out.
      try {
        await openPromise
      } catch (e) {
        const err = new Error(`Deepgram WS open failed: ${e && e.message ? e.message : String(e)}`)
        err.code = 'provider_open_failed'
        throw err
      }

      // --- session methods ---
      const session = {
        voiceSessionId,
        async pushPcm(chunk) {
          if (cancelled || finalized || closed) return
          if (!chunk || chunk.byteLength === 0) return
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)
          if (!opened) {
            pendingPcm.push(buf)
            return
          }
          try {
            dgWs.send(buf)
          } catch (err) {
            emitError({ code: 'send_failed', message: err && err.message ? err.message : String(err) })
          }
        },
        async finalize() {
          if (cancelled) return { text: '', confidence: undefined, duration_ms: 0 }
          if (finalized) return { text: stableText, confidence: lastConfidence, duration_ms: Date.now() - startedAt }
          finalized = true

          // Tell Deepgram to flush + close.
          try {
            if (!closed && opened) {
              dgWs.send(JSON.stringify({ type: 'CloseStream' }))
            }
          } catch { /* ignore */ }

          // Wait up to finalizeTimeoutMs for one more is_final or for the
          // socket to close — whichever comes first.
          const startSeq = stableSeq
          await new Promise((resolve) => {
            let done = false
            const finish = () => {
              if (done) return
              done = true
              cleanup()
              resolve()
            }
            const onMsg = (raw) => {
              // handleDgMessage already updated stableSeq/lastFinalText.
              if (stableSeq > startSeq && currentPartial === '') finish()
            }
            const onClose = () => finish()
            const cleanup = () => {
              dgWs.off('message', onMsg)
              dgWs.off('close', onClose)
              clearTimeout(t)
            }
            dgWs.on('message', onMsg)
            dgWs.on('close', onClose)
            const t = setTimeout(finish, finalizeTimeoutMs)
          })

          // Close the WS regardless (Deepgram already received CloseStream).
          try { dgWs.close() } catch { /* ignore */ }

          return {
            text: stableText,
            confidence: lastConfidence,
            duration_ms: Date.now() - startedAt,
          }
        },
        async cancel() {
          if (cancelled) return
          cancelled = true
          pendingPcm.length = 0
          try { dgWs.close() } catch { /* ignore */ }
        },
        onPartial(handler) {
          if (typeof handler === 'function') partialHandlers.push(handler)
        },
        onError(handler) {
          if (typeof handler === 'function') errorHandlers.push(handler)
        },
      }
      // Expose lastFinalText for tests; not part of the public contract.
      Object.defineProperty(session, '_lastFinalText', {
        get: () => lastFinalText,
        enumerable: false,
      })
      return session
    },
  }
}
