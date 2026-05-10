/**
 * Central state store for cc-g2 frontend (Phase 1.5b).
 *
 * Phase 1.5b の goal: main.ts に散らばっていた module-level `let` 変数を 1 つの
 * `store` オブジェクトに集約する。 移行を機械的にするため、 既存の名前 (例:
 * `voiceCommandIsRecording`) は `store.voice.isRecording` のようにスライス側に
 * 同名で写す。 mutation は `setVoiceFinalText()` のような小さな helper で囲って、
 * 後続フェーズで「どこから書いたか」を grep しやすくする。
 *
 * NOTE: 値の意味やタイミングは一切変えていない。 単なる住所変更のみ。
 */

import type { EvenHubEvent } from '@evenrealities/even_hub_sdk'
import type { NotificationUIState } from '../glasses-ui'
import type { WebSpeechSession } from '../stt/webspeech'
import type { AgentSession, ProjectMeta } from '../notifications'

export type ContextSession = {
  sessionId: string
  cwd: string
  usedPercentage: number
  model: string
}

/** 返信 (permission コメント) 用の audio バッファ + recording state */
export type ReplyState = {
  audioChunks: Uint8Array[]
  audioTotalBytes: number
  isRecording: boolean
  stopInFlight: boolean
  /**
   * Phase 5: reply-recording 内の watchdog timer 群。
   * - recordingMaxTimer: 30s 強制 finalize (REPLY_RECORDING_MAX_MS)
   * - timeoutCoordinationTimer: permission timeout 残り 3s に到達したら強制 deny
   * 両方とも reply-recording entry / cancel / finalize で reset する。
   */
  recordingMaxTimer: ReturnType<typeof setTimeout> | null
  timeoutCoordinationTimer: ReturnType<typeof setTimeout> | null
}

/** voice-command (走行中セッションへの自由テキスト送信) 用 state */
export type VoiceState = {
  audioChunks: Uint8Array[]
  audioTotalBytes: number
  isRecording: boolean
  stopInFlight: boolean
  startInFlight: boolean
  finalText: string
  startedAt: number
  /** start のたびに increment され、 await 後に陳腐化を検知するための世代 token */
  generation: number
  /** 送信中に double-tap で強制 idle 復帰したことを表すキャンセルフラグ */
  sendCancelled: boolean
  recordingMaxTimer: ReturnType<typeof setTimeout> | null
  doneTimer: ReturnType<typeof setTimeout> | null
  // ----- Phase 2: streaming state (Deepgram path) -----
  /** confirmed-stable transcript so far (engine emits is_final → concatenated) */
  stableText: string
  /** in-flight not-yet-final transcript */
  partialText: string
  /** monotonically-increasing seq numbers (drop stale partials below these) */
  stableSeq: number
  partialSeq: number
  /** late-final post-timeout: original confirm text, used by (updated) badge logic */
  preFinalText: string
  /** confirm 画面で "(updated)" バッジを 1 秒だけ表示する用 */
  lateFinalUpdatedTimer: ReturnType<typeof setTimeout> | null
  /** 送信が始まった (or キャンセル済み) → 遅延 final は破棄する */
  sendOrCancelInProgress: boolean
}

/** Dev UI のマイクテスト用 audio バッファ */
export type DevMicState = {
  isRecording: boolean
  audioChunks: Uint8Array[]
  audioTotalBytes: number
  audioListenerAttached: boolean
  speechCapabilityLogged: boolean
  webSpeechSession: WebSpeechSession | null
  webSpeechFinalText: string
  webSpeechInterimText: string
  webSpeechError: string
  deviceStatusListenerAttached: boolean
}

/** dashboard / 通知一覧の周辺 UI state */
export type DashboardState = {
  hubReachable: boolean | null
  lastNotifRefreshAt: number | null
  notifPollingStarted: boolean
  /** ハンドラ登録済みの connection を追跡 (再接続検知用) */
  notifEventRegisteredFor: object | null
  lastG2UserEventAt: number
  pendingAutoOpenOnNew: boolean
  pendingListRefresh: boolean
}

/** idle 画面で 700ms 待ちの single-tap タイマーや 二連タップ判定状態 */
export type IdleState = {
  lastIdleEventAt: number
  idleTapDuringRender: boolean
  idleOpenBlockedUntil: number
  singleTapTimer: ReturnType<typeof setTimeout> | null
}

/** 描画中に届いたイベントを保留するキューの状態 */
export type EventQueueState = {
  pendingNotifEvent: EvenHubEvent | null
  pendingNotifEventFlushTimer: ReturnType<typeof setTimeout> | null
  notifEventInFlight: boolean
  lastDetailScrollAt: number
  lastTapEventAt: number
}

/** /api/context-status の polling 結果 */
export type ContextState = {
  sessions: ContextSession[]
  latestPct: number | undefined
}

/**
 * Phase 3: SessionList screen state.
 *
 * `sessions` / `projects` are populated lazily on entry to the SessionList
 * screen (or by the polling controller), then mutated in place on user
 * actions. `screen` mirrors the active sub-screen so handlers can dispatch on
 * a single field — the global `notif.screen` carries 'session-list' or
 * 'session-list-create-confirm' to plug into the existing dispatcher.
 */
export type SessionListState = {
  /** sub-screen marker — keeps create-confirm logic next to the list view */
  screen: 'session-list' | 'session-list-create-confirm'
  sessions: AgentSession[]
  /** index 0 == sentinel "↓ Pull to create new" */
  selectedIndex: number
  pendingCreate: boolean
  projects: ProjectMeta[]
  selectedProjectIndex: number
  createConfirmTimer: ReturnType<typeof setTimeout> | null
}

/**
 * Phase 4: cross-screen multi-session UI state.
 *
 * `activeSessionId` mirrors the Hub's getActiveSessionId() — set when the
 * user activates a session row from SessionList (or via active-summary
 * polling). SessionList renders an `(active)` label next to this id.
 *
 * `pendingCountsByOtherSession` is populated from
 * /api/v1/sessions/active-summary on each polling tick and rendered as
 * `(N pending)` badges on non-active rows.
 */
export type SessionUiState = {
  activeSessionId: string | null
  pendingCountsByOtherSession: Record<string, number>
}

export type Store = {
  notif: NotificationUIState
  reply: ReplyState
  voice: VoiceState
  dev: DevMicState
  dashboard: DashboardState
  idle: IdleState
  eventQueue: EventQueueState
  context: ContextState
  sessionList: SessionListState
  sessionUi: SessionUiState
}

/** 既定値で store を生成。 main.ts は import 時にこのインスタンスをそのまま使う。 */
function createStore(): Store {
  const notif: NotificationUIState = {
    screen: 'idle',
    items: [],
    selectedIndex: 0,
    detailPages: [],
    detailPageIndex: 0,
    detailItem: null,
    replyText: '',
    askQuestions: [],
    askQuestionIndex: 0,
    askAnswers: {},
    // Phase 5
    permissionConfirm: { stepCount: 0, risk_tier: null, targetItemId: null, timer: null },
    blocked: { targetItemId: null, timer: null },
  }

  const reply: ReplyState = {
    audioChunks: [],
    audioTotalBytes: 0,
    isRecording: false,
    stopInFlight: false,
    recordingMaxTimer: null,
    timeoutCoordinationTimer: null,
  }

  const voice: VoiceState = {
    audioChunks: [],
    audioTotalBytes: 0,
    isRecording: false,
    stopInFlight: false,
    startInFlight: false,
    finalText: '',
    startedAt: 0,
    generation: 0,
    sendCancelled: false,
    recordingMaxTimer: null,
    doneTimer: null,
    stableText: '',
    partialText: '',
    stableSeq: 0,
    partialSeq: 0,
    preFinalText: '',
    lateFinalUpdatedTimer: null,
    sendOrCancelInProgress: false,
  }

  const dev: DevMicState = {
    isRecording: false,
    audioChunks: [],
    audioTotalBytes: 0,
    audioListenerAttached: false,
    speechCapabilityLogged: false,
    webSpeechSession: null,
    webSpeechFinalText: '',
    webSpeechInterimText: '',
    webSpeechError: '',
    deviceStatusListenerAttached: false,
  }

  const dashboard: DashboardState = {
    hubReachable: null,
    lastNotifRefreshAt: null,
    notifPollingStarted: false,
    notifEventRegisteredFor: null,
    lastG2UserEventAt: 0,
    pendingAutoOpenOnNew: false,
    pendingListRefresh: false,
  }

  const idle: IdleState = {
    lastIdleEventAt: 0,
    idleTapDuringRender: false,
    idleOpenBlockedUntil: 0,
    singleTapTimer: null,
  }

  const eventQueue: EventQueueState = {
    pendingNotifEvent: null,
    pendingNotifEventFlushTimer: null,
    notifEventInFlight: false,
    lastDetailScrollAt: 0,
    lastTapEventAt: 0,
  }

  const context: ContextState = {
    sessions: [],
    latestPct: undefined,
  }

  const sessionList: SessionListState = {
    screen: 'session-list',
    sessions: [],
    selectedIndex: 0,
    pendingCreate: false,
    projects: [],
    selectedProjectIndex: 0,
    createConfirmTimer: null,
  }

  const sessionUi: SessionUiState = {
    activeSessionId: null,
    pendingCountsByOtherSession: {},
  }

  return { notif, reply, voice, dev, dashboard, idle, eventQueue, context, sessionList, sessionUi }
}

export const store: Store = createStore()

// ---------------------------------------------------------------------------
// Mutation helpers (small wrappers — future audits can grep call sites)
// ---------------------------------------------------------------------------

/** voice-command の世代 token を 1 つ進める。start/cancel の両方から呼ばれる */
export function bumpVoiceGeneration(): number {
  return ++store.voice.generation
}

/** voice-command の sticky な録音バッファ・FinalText・タイマーをまとめて idle 状態に戻す */
export function resetVoiceToIdle(): void {
  store.voice.isRecording = false
  store.voice.stopInFlight = false
  store.voice.audioChunks = []
  store.voice.audioTotalBytes = 0
  store.voice.finalText = ''
  store.voice.stableText = ''
  store.voice.partialText = ''
  store.voice.stableSeq = 0
  store.voice.partialSeq = 0
  store.voice.preFinalText = ''
  store.voice.sendOrCancelInProgress = false
  if (store.voice.recordingMaxTimer) {
    clearTimeout(store.voice.recordingMaxTimer)
    store.voice.recordingMaxTimer = null
  }
  if (store.voice.doneTimer) {
    clearTimeout(store.voice.doneTimer)
    store.voice.doneTimer = null
  }
  if (store.voice.lateFinalUpdatedTimer) {
    clearTimeout(store.voice.lateFinalUpdatedTimer)
    store.voice.lateFinalUpdatedTimer = null
  }
}

/** reply 用 audio バッファをクリア (新しい録音開始時) */
export function resetReplyAudio(): void {
  store.reply.audioChunks = []
  store.reply.audioTotalBytes = 0
  store.reply.stopInFlight = false
}

/** Phase 5: reply-recording の watchdog タイマーを全部止める */
export function clearReplyRecordingTimers(): void {
  if (store.reply.recordingMaxTimer) {
    clearTimeout(store.reply.recordingMaxTimer)
    store.reply.recordingMaxTimer = null
  }
  if (store.reply.timeoutCoordinationTimer) {
    clearTimeout(store.reply.timeoutCoordinationTimer)
    store.reply.timeoutCoordinationTimer = null
  }
}

/** dev mic の audio バッファをクリア */
export function resetDevAudio(): void {
  store.dev.audioChunks = []
  store.dev.audioTotalBytes = 0
}

/** voice の recordingMax timer をクリア */
export function clearVoiceRecordingMaxTimer(): void {
  if (store.voice.recordingMaxTimer) {
    clearTimeout(store.voice.recordingMaxTimer)
    store.voice.recordingMaxTimer = null
  }
}

/** voice の done timer をクリア */
export function clearVoiceDoneTimer(): void {
  if (store.voice.doneTimer) {
    clearTimeout(store.voice.doneTimer)
    store.voice.doneTimer = null
  }
}

/** idle の単タップ待機タイマーをクリア */
export function cancelIdleSingleTapTimer(): void {
  if (store.idle.singleTapTimer) {
    clearTimeout(store.idle.singleTapTimer)
    store.idle.singleTapTimer = null
  }
}

/** Phase 3: SessionList — clear the create-confirm auto-cancel timer */
export function clearSessionListCreateConfirmTimer(): void {
  if (store.sessionList.createConfirmTimer) {
    clearTimeout(store.sessionList.createConfirmTimer)
    store.sessionList.createConfirmTimer = null
  }
}

/**
 * Phase 4: cache the active session id locally so SessionList can render the
 * `(active)` marker without re-querying. Mirrors the Hub's getActiveSessionId
 * value — the source of truth still lives server-side.
 */
export function setActiveSessionId(id: string | null): void {
  store.sessionUi.activeSessionId = id
}

/**
 * Phase 4: replace the per-session pending-count map. Polling controller
 * calls this from each /api/v1/sessions/active-summary tick so SessionList
 * badges reflect the latest server view.
 */
export function setPendingCountsByOtherSession(map: Record<string, number>): void {
  store.sessionUi.pendingCountsByOtherSession = map
}
