/**
 * Per-screen timing constants (Phase 1.5c).
 *
 * 旧 main.ts に直接書かれていた数値定数を 1 箇所に集約。
 * 値は変えない (behavior 不変が 1.5c の goal)。
 */

/** detail 画面で連続スクロールを抑制する cool-down */
export const DETAIL_SCROLL_COOLDOWN_MS = 250

/** tap 直後の scroll を誤発火と見なして無視する窓 */
export const TAP_SCROLL_SUPPRESS_MS = 150

/** idle で連続タップ → 一覧表示と判定する窓 */
export const IDLE_DOUBLE_TAP_WINDOW_MS = 700

/** idle 復帰直後の再オープン抑止クールダウン */
export const IDLE_REOPEN_COOLDOWN_MS = 4000

/** voice-command 録音の最大時間 (これを超えたら自動停止) */
export const VOICE_COMMAND_RECORDING_MAX_MS = 20_000

/** voice-command-done 表示後に自動で idle に戻るまでの時間 */
export const VOICE_COMMAND_DONE_AUTO_RETURN_MS = 2_000
