/**
 * Deepgram streaming STT engine (Phase 2 — Pass 1 stub).
 *
 * The full implementation lands in Pass 2; for now we expose a `createDeepgramEngine`
 * that satisfies the `SttEngine` shape but throws `no_api_key` on `start()` when
 * an apiKey is missing. This lets `index.mjs` wire `attachSttStreamWss` to the
 * factory without depending on Pass 2 internals.
 */

export function createDeepgramEngine(_config = {}) {
  return {
    kind: 'deepgram-stream',
    async start() {
      const err = new Error('Deepgram engine not yet implemented (Pass 1 stub)')
      err.code = 'engine_unavailable'
      throw err
    },
  }
}
