/**
 * Backward-compat shim for `transcribeAudioWithGroq` (Phase 1.5c).
 *
 * 1.5c までは routes/stt.mjs が `transcribeAudioWithGroq(input, deps)` を
 * 呼んでいた。 1.5c では engine 抽出のため実装は `stt/groq-engine.mjs` に
 * 移動した。 このファイルは旧 import path を保つための薄いラッパで、
 * 既存の external 利用者がいる場合に備えて残してある。
 *
 * 内部 (routes/stt.mjs) は engine factory を直接 import しているため、
 * Phase 2 でこの shim が完全に未参照になったら削除してよい。
 */

import { createGroqEngine } from './stt/groq-engine.mjs'

const engine = createGroqEngine()

export async function transcribeAudioWithGroq(input, deps) {
  return engine.transcribe(input, deps)
}
