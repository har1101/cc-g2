/**
 * ScreenContext — bundle of dependencies that screen handlers need (Phase 1.5c).
 *
 * 旧 main.ts では module-level の closure を全 handler が触っていたが、
 * screen 分割すると「どの handler に何を渡しているか」 が見えにくくなる。
 * ScreenContext はこの依存関係を 1 つの object にまとめ、 main.ts が
 * `buildScreenContext()` で 1 つ作って screen.handle に渡す。
 *
 * `connection` は再接続で差し替わるため、 context は handler 呼び出しごとに
 * 構築する (helper closure を持ち回らない)。
 *
 * NOTE: helper はあえて関数として ctx に詰めている。 こうすることで test 側で
 * mock しやすく、 screen 単独テストの土台になる。
 */

import type { BridgeConnection } from '../bridge'
import { type createGlassesUI, type NotificationUIState } from '../glasses-ui'
import type { NotificationDetail } from '../notifications'
import type { createNotificationClient } from '../notifications'
import type { AudioSession } from '../audio-session'
import type { RenderQueue } from '../render-queue'
import type { SttEngine } from '../stt/engine'
import type { store } from '../state/store'

export type GlassesUI = ReturnType<typeof createGlassesUI>
export type Screen = NotificationUIState['screen']

export type ScreenContext = {
  /** イベント受信時点の bridge 接続 (event handler 内で同期的に使う場合のみ) */
  conn: BridgeConnection
  /**
   * 現在の bridge 接続を取得する live accessor。 setTimeout / await 後など
   * 「再接続でハンドルが差し替わる」 可能性がある箇所では `conn` ではなく
   * これを使う。 切断中なら null を返す。
   */
  getConnection(): BridgeConnection | null
  /** glasses 描画 facade */
  glassesUI: GlassesUI
  /** central state store (notif / reply / voice / dashboard / ...) */
  store: typeof store
  /** Hub クライアント */
  notifClient: ReturnType<typeof createNotificationClient>
  /** PCM ownership broker (reply / voice / dev-mic) */
  audioSession: AudioSession
  /** 描画ジョブの直列化 (Phase 1.5b) */
  renderQueue: RenderQueue
  /** STT engine for voice-command path (groq-batch / Phase 2: deepgram-stream) */
  sttEngine: SttEngine
  /**
   * STT engine for permission コメント (返信) path. Phase 2 以降、 voice-command
   * は streaming に切り替わっても、 短文の reply パスは常に groq-batch を維持する。
   */
  sttEngineForReply: SttEngine
  /** ログ出力 (UI #event-log + console) */
  log: (msg: string) => void

  // ----- behavior helpers (main.ts 由来) -----

  /** dashboard 状態と event log のリフレッシュ */
  updateNotifInfo(): void
  /** 結果画面 → 通知一覧復帰 */
  returnToListFromResult(): Promise<void>
  /** "通知一覧/詳細を全部閉じて待機画面に戻る" */
  enterIdleScreen(reason: string): Promise<void>
  /** notification.metadata.cwd に対応する context % を返す */
  getContextPctForNotification(detail: { metadata?: Record<string, unknown> }): number | undefined
  /** detail スクロールが現在無視すべきか */
  shouldIgnoreDetailScroll(eventType: number | undefined): boolean
  /** イベント保留キューのスクロール部分のみクリア */
  clearPendingScrollEvent(): void
  /** 「描画中 or render-queue 進行中」 */
  isAnyRendering(): boolean

  // ----- voice-command lifecycle -----
  startVoiceCommandRecording(): Promise<void>
  stopVoiceCommandRecording(reason: string): Promise<void>
  cancelVoiceCommandRecording(reason: string): Promise<void>
  sendVoiceCommandAndShowResult(): Promise<void>
  returnToIdleFromVoiceCommand(reason: string): Promise<void>
  scheduleVoiceCommandDoneReturn(): void
  // ----- voice-command streaming (Phase 2) -----
  finalizeVoiceCommandStreaming(reason: string): Promise<void>
  cancelVoiceCommandStreaming(reason: string): Promise<void>

  // ----- reply (permission コメント) lifecycle -----
  startReplyAudioRecording(): Promise<boolean>
  stopReplyAudioRecording(): Promise<void>

  // ----- AskUserQuestion / 結果メッセージ -----
  isAskUserQuestionNotification(detail: NotificationDetail): boolean
}
