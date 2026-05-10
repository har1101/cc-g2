/**
 * Hub-side STT engine interface (Phase 1.5c).
 *
 * Hub では現状 1 つの provider (Groq Whisper) しか持たないが、 Phase 2 で
 * Deepgram (server-relayed streaming) を追加する想定で、
 *
 *   route → engine.transcribe(input, deps) → engine 固有 fetch
 *
 * という形に層を 1 枚増やしておく。 既存の `stt.mjs` 内の Groq 呼び出しは
 * `groq-engine.mjs` に分離され、 `stt.mjs` は backward-compat 用 wrapper として残す。
 *
 * 各 engine は以下の形で `transcribe` を提供する:
 *
 *   transcribe(
 *     { audioBase64, mimeType, model, language, responseFormat },
 *     { apiKey, defaultModel },
 *   ) -> Promise<
 *     | { ok: true,  status: 200, payload: { ok: true, text, provider, model } }
 *     | { ok: false, status: number, error: string }
 *   >
 *
 * `routes/stt.mjs` はこの shape を assume する。
 */

/** input shape (型ヒントとして export) */
export const SttEngineInputShape = Object.freeze({
  audioBase64: 'string',
  mimeType: 'string?',
  model: 'string?',
  language: 'string?',
  responseFormat: 'string?',
})

/** deps shape (型ヒントとして export) */
export const SttEngineDepsShape = Object.freeze({
  apiKey: 'string?',
  defaultModel: 'string',
})
