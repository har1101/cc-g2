/**
 * STT engine interface (Phase 1.5c).
 *
 * Phase 1 では Groq の "batch" (録音 → WAV → 1 リクエスト) しか存在しないが、
 * Phase 2 で Deepgram streaming (push PCM → partial / final) を導入するため、
 * すべての呼び出し側がこの interface 経由で 1) start 2) push 3) finalize / cancel
 * の 4 段階で書かれていれば差し替えが効く。
 *
 * 注意:
 * - `pushPcm` は streaming engine では即座に upstream へ送る。 batch engine では
 *   メモリに貯めるだけで、 `finalize` 時に一括送信する。
 * - `cancel` は idempotent。 finalize 後に呼んでも no-op。
 * - `onPartial` は streaming engine 専用 (batch engine は呼ばない)。
 *   subscribe しなくても finalize は最終結果を返す。
 *
 * 1.5c の goal は "interface を導入する" だけ。 main.ts 側はまだ
 * groq-batch しか使わないが、 配線が engine を経由する形になっているのが重要。
 */

export type SttEngineKind = 'groq-batch' | 'deepgram-stream' | 'mock'

/** finalize で返る最終文字起こし結果 */
export type SttFinalResult = {
  text: string
  /** confidence は streaming engine のみ。 batch では undefined */
  confidence?: number
  /** 録音 / 認識にかかった時間 (任意) */
  duration_ms?: number
  /** どの実装が結果を返したか。 mock も含む */
  provider: SttEngineKind
}

/**
 * Streaming engine が emit する中間結果。
 * - `stable_text`: 確定済み (再認識でも変化しない)
 * - `partial_text`: まだ揺れる可能性あり
 * - `*_seq` は順序保証用の monotonically-increasing 番号
 */
export type SttPartialResult = {
  stable_text: string
  partial_text: string
  stable_seq: number
  partial_seq: number
}

/** 1 つの録音セッション。 start() で取得する */
export type SttSession = {
  /** start 時の voice session 識別子 (ログ / 整合性チェック用) */
  voiceSessionId: string
  /** PCM チャンクを 1 つ追加。 batch engine ではメモリに貯めるだけ */
  pushPcm(chunk: Uint8Array): Promise<void>
  /** 録音終了 → 最終結果を返す */
  finalize(): Promise<SttFinalResult>
  /** 録音をキャンセル。 finalize は呼ばない。 idempotent */
  cancel(): Promise<void>
  /** streaming engine の partial subscribe。 batch engine は実装してもよいが呼ばない */
  onPartial?(handler: (p: SttPartialResult) => void): void
  /** engine 内で発生したエラーの subscribe */
  onError?(handler: (err: { code: string; message: string }) => void): void
}

export type SttEngineStartOpts = {
  voiceSessionId: string
  /** "ja" / "en" など */
  lang?: string
}

export type SttEngine = {
  kind: SttEngineKind
  start(opts: SttEngineStartOpts): Promise<SttSession>
}
