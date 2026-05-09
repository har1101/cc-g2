// /api/stt/transcriptions — wraps the Groq Whisper proxy in stt.mjs
import { getString, readRequestBody, safeJsonParse } from '../notification-utils.mjs'
import { isBodyTooLargeError, sendJson, sendRequestBodyTooLarge } from '../core/http.mjs'
import { transcribeAudioWithGroq } from '../stt.mjs'

export async function handle(req, res, ctx) {
  if (ctx.method !== 'POST' || ctx.pathname !== '/api/stt/transcriptions') return false
  const { deps } = ctx

  let rawBody
  try {
    rawBody = await readRequestBody(req, { maxBytes: deps.hubMaxSttBodyBytes })
  } catch (err) {
    if (isBodyTooLargeError(err)) {
      sendRequestBodyTooLarge(res, err)
      return true
    }
    throw err
  }
  const parsed = safeJsonParse(rawBody || '{}')
  if (!parsed.ok || !parsed.value || typeof parsed.value !== 'object') {
    sendJson(res, 400, { ok: false, error: 'Invalid JSON body' })
    return true
  }
  const p = parsed.value
  const audioBase64 = getString(p.audioBase64)
  if (!audioBase64) {
    sendJson(res, 400, { ok: false, error: '`audioBase64` is required' })
    return true
  }
  const result = await transcribeAudioWithGroq(
    {
      audioBase64,
      mimeType: getString(p.mimeType),
      model: getString(p.model),
      language: getString(p.language),
      responseFormat: getString(p.response_format),
    },
    {
      apiKey: deps.groqApiKey,
      defaultModel: deps.groqModelDefault,
    },
  )
  if (!result.ok) {
    sendJson(res, result.status, { ok: false, error: result.error })
    return true
  }
  sendJson(res, 200, result.payload)
  return true
}
