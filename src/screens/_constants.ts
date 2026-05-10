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

/** Phase 3: SessionList create-confirm 自動キャンセルまでの時間 */
export const CREATE_CONFIRM_AUTO_CANCEL_MS = 10_000

/**
 * Phase 5 §5.5: reply-recording (permission コメント) の最大録音時間.
 * voice-command と異なり permission timeout (60s default) と coordination するため
 * voice-command の 20s より長めに設定。 30s ハード上限。
 */
export const REPLY_RECORDING_MAX_MS = 30_000

/**
 * Phase 5: permission timeout 残り時間がこの window に入ったら強制 finalize。
 * server 側に届く前に間に合わせるための余裕分。
 */
export const REPLY_TIMEOUT_FORCE_FINALIZE_MS = 3_000

/**
 * Phase 5: STT error 時に「再録 retry できる残り時間」の閾値。
 * これより多ければ permission-actions に戻して retry 余地を残す。
 * これ以下なら plain deny にフォールバック。
 */
export const REPLY_STT_RETRY_THRESHOLD_MS = 5_000
