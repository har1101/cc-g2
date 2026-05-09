/**
 * Groq Whisper STT engine (Phase 1.5c).
 *
 * 旧 `stt.mjs` 内の `transcribeAudioWithGroq` をそのまま移植し、
 * factory 形式 `createGroqEngine()` で transcribe を提供する。
 *
 * 動作は完全に同等:
 * - apiKey 未設定 → mock 応答
 * - 設定あり → Groq Whisper REST API へ multipart で POST
 * - non-2xx → { ok: false, status, error }
 */

function decodeBase64ToUint8Array(value) {
  const buf = Buffer.from(String(value || ''), 'base64')
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
}

async function transcribeWithGroq(input, deps) {
  const { audioBase64, mimeType, model, language, responseFormat } = input
  const { apiKey, defaultModel } = deps

  const audioBytes = decodeBase64ToUint8Array(audioBase64)
  if (!apiKey) {
    const durationSec = ((audioBytes.byteLength - 44) / 2 / 16_000)
    return {
      ok: true,
      status: 200,
      payload: {
        ok: true,
        text: `（STTモック）録音 ${Math.max(durationSec, 0).toFixed(1)}秒 / ${audioBytes.byteLength} bytes`,
        provider: 'mock',
        model: 'mock',
      },
    }
  }

  const file = new File([audioBytes], 'audio.wav', { type: mimeType || 'audio/wav' })
  const form = new FormData()
  form.append('file', file)
  form.append('model', model || defaultModel)
  form.append('response_format', responseFormat || 'verbose_json')
  if (language) form.append('language', language)

  const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
    body: form,
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return {
      ok: false,
      status: res.status,
      error: `Groq STT failed: ${res.status} ${res.statusText} ${text}`.trim(),
    }
  }

  const json = await res.json()
  return {
    ok: true,
    status: 200,
    payload: {
      ok: true,
      text: String(json?.text || '').trim(),
      provider: 'groq',
      model: model || defaultModel,
    },
  }
}

/**
 * Factory: returns the Hub-side Groq engine.
 *
 * Phase 2 で Deepgram engine を増やしたら、 `routes/stt.mjs` 側に engine 選択
 * ロジック (deps から決定) を入れる想定。 1.5c では engine は 1 種類しかないので、
 * `createGroqEngine()` を route が直接 import する。
 */
export function createGroqEngine() {
  return {
    kind: 'groq-batch',
    transcribe: transcribeWithGroq,
  }
}
