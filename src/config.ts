function readBool(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value === '') return fallback
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase())
}

function readInt(value: string | undefined, fallback: number): number {
  if (value == null || value === '') return fallback
  const n = Number.parseInt(value, 10)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return n
}

function readSttEngineKind(value: string | undefined): 'groq-batch' | 'deepgram-stream' {
  const v = (value || '').trim().toLowerCase()
  return v === 'deepgram-stream' ? 'deepgram-stream' : 'groq-batch'
}

export const appConfig = {
  sttEnabled: readBool(import.meta.env.VITE_STT_ENABLED, true),
  sttForceError: readBool(import.meta.env.VITE_STT_FORCE_ERROR, false),
  groqModel: (import.meta.env.VITE_GROQ_MODEL as string | undefined)?.trim() || 'whisper-large-v3',
  hubAuthToken: (import.meta.env.VITE_HUB_TOKEN as string | undefined)?.trim() ?? '',
  notificationHubUrl: (import.meta.env.VITE_HUB_URL as string | undefined)?.trim() || `http://${globalThis.location?.hostname || '127.0.0.1'}:8787`,
  notificationAutoOpenOnNew: readBool(import.meta.env.VITE_NOTIF_AUTO_OPEN_ON_NEW, true),
  notificationIdleDimMode: readBool(import.meta.env.VITE_NOTIF_IDLE_DIM_MODE, true),
  notificationPollIntervalMs: readInt(import.meta.env.VITE_NOTIF_POLL_INTERVAL_MS, 1500),
  /** Web Speech API の比較診断を有効にする（開発時のみ） */
  webSpeechCompare: readBool(import.meta.env.VITE_WEBSPEECH_COMPARE, false),
  // Phase 2: voice-command engine selection. Permission コメント (短文) は
  // 常に groq-batch を使うため、 ここは voice-command 用のみ。
  // - groq-batch (default, Phase 1 互換)
  // - deepgram-stream (Phase 2 新規パス、 DEEPGRAM_API_KEY 必要)
  //
  // 設計書 §Phase 2.4 では deepgram-stream を default に挙げているが、
  // fork 運用で API key 未設定の環境がいきなり 502 を吐くのを避けるため、
  // 実装 default は groq-batch のまま。 deepgram-stream を有効にしたい場合は
  // .env.local に `VITE_STT_ENGINE_VOICE_COMMAND=deepgram-stream` + Hub 側で
  // `DEEPGRAM_API_KEY` を設定する。
  sttEngineVoiceCommand: readSttEngineKind(import.meta.env.VITE_STT_ENGINE_VOICE_COMMAND as string | undefined),
}

export function canUseGroqStt() {
  return appConfig.sttEnabled
}

export function createHubHeaders(extra?: HeadersInit): HeadersInit {
  const base: Record<string, string> = {}
  if (appConfig.hubAuthToken) base['X-CC-G2-Token'] = appConfig.hubAuthToken

  if (!extra) return base
  if (Array.isArray(extra)) return [...Object.entries(base), ...extra]
  if (extra instanceof Headers) {
    const merged = new Headers(extra)
    for (const [key, value] of Object.entries(base)) merged.set(key, value)
    return merged
  }
  return { ...base, ...extra }
}
