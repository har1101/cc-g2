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

export type Store = {
  notif: NotificationUIState
  reply: ReplyState
  voice: VoiceState
  dev: DevMicState
  dashboard: DashboardState
  idle: IdleState
  eventQueue: EventQueueState
  context: ContextState
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
  }

  const reply: ReplyState = {
    audioChunks: [],
    audioTotalBytes: 0,
    isRecording: false,
    stopInFlight: false,
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

  return { notif, reply, voice, dev, dashboard, idle, eventQueue, context }
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
  if (store.voice.recordingMaxTimer) {
    clearTimeout(store.voice.recordingMaxTimer)
    store.voice.recordingMaxTimer = null
  }
  if (store.voice.doneTimer) {
    clearTimeout(store.voice.doneTimer)
    store.voice.doneTimer = null
  }
}

/** reply 用 audio バッファをクリア (新しい録音開始時) */
export function resetReplyAudio(): void {
  store.reply.audioChunks = []
  store.reply.audioTotalBytes = 0
  store.reply.stopInFlight = false
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
