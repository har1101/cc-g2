import { appConfig, canUseGroqStt, createHubHeaders } from '../config'
import { concatChunks, encodePcm16kMonoS16leToWav } from '../audio/wav'
import type { SttEngine, SttEngineKind, SttFinalResult, SttSession } from './engine'

/**
 * Groq batch STT (Phase 1).
 *
 * 録音中はメモリに PCM を貯め、 `finalize()` で WAV にエンコードして
 * Hub `/api/stt/transcriptions` に POST する。
 *
 * Phase 2 で Deepgram streaming engine が増えたら、 main.ts は
 * `createGroqBatchEngine()` を別の factory に差し替えるだけで動くように
 * SttEngine interface に揃える。
 */

/** 旧 API: 後方互換のため残す。 戻り値の `provider` も旧 'groq'/'mock' のまま */
export type SttResult = {
  text: string
  provider: 'groq' | 'mock'
  model?: string
}

export async function transcribePcmChunks(chunks: Uint8Array[]): Promise<SttResult> {
  if (appConfig.sttForceError) {
    throw new Error('Forced STT error (VITE_STT_FORCE_ERROR=true)')
  }

  const pcm = concatChunks(chunks)
  if (pcm.byteLength === 0) {
    return {
      text: '',
      provider: 'mock',
    }
  }

  if (!canUseGroqStt()) {
    const durationSec = ((pcm.byteLength / 2) / 16_000).toFixed(1)
    return {
      text: `（STTモック）録音 ${durationSec}秒 / ${pcm.byteLength} bytes`,
      provider: 'mock',
    }
  }

  const wav = encodePcm16kMonoS16leToWav(pcm)
  return transcribeWavWithGroq(wav)
}

async function transcribeWavWithGroq(wavBytes: Uint8Array): Promise<SttResult> {
  const audioBase64 = bytesToBase64(wavBytes)
  const res = await fetch(`${appConfig.notificationHubUrl}/api/stt/transcriptions`, {
    method: 'POST',
    headers: createHubHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      audioBase64,
      mimeType: 'audio/wav',
      model: appConfig.groqModel,
      language: 'ja',
      response_format: 'verbose_json',
    }),
  })

  if (!res.ok) {
    const text = await safeReadText(res)
    throw new Error(`Hub STT failed: ${res.status} ${res.statusText} ${text}`.trim())
  }

  const json = (await res.json()) as { text?: string; provider?: 'groq' | 'mock'; model?: string }
  return {
    text: (json.text ?? '').trim(),
    provider: json.provider ?? 'groq',
    model: json.model ?? appConfig.groqModel,
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300)
  } catch {
    return ''
  }
}

// ---------------------------------------------------------------------------
// SttEngine adapter (Phase 1.5c)
// ---------------------------------------------------------------------------

/**
 * Groq batch を SttEngine 形式で wrap する factory。
 *
 * - `start({ voiceSessionId })` で空のセッションを返す。
 * - `pushPcm(chunk)` は内部 buffer に貯めるだけ (network 呼ばない)。
 * - `finalize()` で `transcribePcmChunks` を 1 度だけ呼び、 結果を
 *   `SttFinalResult` 形式で返す。
 * - `cancel()` は buffer を破棄するだけ。 fetch は呼ばない。
 *
 * Streaming engine と違い `onPartial` は emit しない (subscribe しても呼ばれない)。
 */
export function createGroqBatchEngine(): SttEngine {
  const kind: SttEngineKind = 'groq-batch'

  return {
    kind,
    async start({ voiceSessionId }) {
      const chunks: Uint8Array[] = []
      let cancelled = false
      let finalized = false
      const startedAt = Date.now()

      const session: SttSession = {
        voiceSessionId,
        async pushPcm(chunk) {
          if (cancelled || finalized) return
          chunks.push(chunk)
        },
        async finalize(): Promise<SttFinalResult> {
          if (cancelled) {
            // cancelled → finalize の順は通常起きないが、 念のため空結果を返す。
            return { text: '', provider: kind }
          }
          finalized = true
          const result = await transcribePcmChunks(chunks)
          const elapsed = Date.now() - startedAt
          return {
            text: result.text,
            // batch engine は confidence を返せない。
            confidence: undefined,
            duration_ms: elapsed,
            provider: result.provider === 'mock' ? 'mock' : kind,
          }
        },
        async cancel() {
          if (finalized || cancelled) return
          cancelled = true
          chunks.length = 0
        },
        // batch engine では partial / error は emit しないが、 caller の
        // 配線を簡潔にするため interface 上は subscribe を受け取れるようにする。
        onPartial() { /* batch engine: never emits */ },
        onError() { /* batch engine: never emits */ },
      }
      return session
    },
  }
}
