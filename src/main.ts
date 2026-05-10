import './styles.css'
import { initBridge, type BridgeConnection } from './bridge'
import { createGlassesUI } from './glasses-ui'
import { log } from './log'
import { appConfig } from './config'
import { createNotificationClient } from './notifications'
import { store } from './state/store'
import { createAudioSession, type AudioSession } from './audio-session'
import { createRenderQueue, type RenderQueue } from './render-queue'
import { createEventDispatcher, type EventDispatcher } from './event-dispatcher'
import { createGroqBatchEngine } from './stt/groq-batch'
import { createDeepgramStreamEngine } from './stt/deepgram-stream'
import type { SttEngine } from './stt/engine'
import {
  installScreenHelpers,
  isAnyRendering,
  isAskUserQuestionNotification,
  getContextPctForNotification,
  shouldIgnoreDetailScroll,
  clearPendingScrollEvent,
  enterIdleScreen,
  enterSessionListScreen,
  returnToListFromResult,
  startReplyAudioRecording,
  stopReplyAudioRecording,
  startVoiceCommandRecording,
  stopVoiceCommandRecording,
  cancelVoiceCommandRecording,
  sendVoiceCommandAndShowResult,
  returnToIdleFromVoiceCommand,
  scheduleVoiceCommandDoneReturn,
  finalizeVoiceCommandStreaming,
  cancelVoiceCommandStreaming,
} from './screens/_helpers'
import type { ScreenContext } from './screens/types'
import { createNotifEventDispatcher } from './screens/dispatch'
import { wireDevTools, logSpeechCapabilities } from './dev-tools'
import { createNotificationController } from './notification-controller'

// ---------------------------------------------------------------------------
// DOM scaffolding
// ---------------------------------------------------------------------------

const appRoot = document.querySelector<HTMLDivElement>('#app')!
const uiSearch = new URLSearchParams(globalThis.location?.search || '')
const devUiEnabled = import.meta.env.DEV || uiSearch.get('dev') === '1'

appRoot.innerHTML = `
  <header class="hero">
    <h1>cc-g2</h1>
    <p class="subtitle">Claude Code companion for Even G2</p>
    <p class="hero-copy">G2 で通知を見て、承認・拒否・音声コメントを返すための companion console。</p>
  </header>

  <section class="card hero-card">
    <div class="hero-actions">
      <button id="connect-btn" class="btn btn-primary" type="button">Connect Glasses</button>
      <button id="notif-fetch-btn" class="btn" type="button">Refresh Notifications</button>
      <button id="notif-show-g2-btn" class="btn" type="button" disabled>Open On G2</button>
      <button id="sessions-show-g2-btn" class="btn" type="button" disabled>Open Sessions</button>
    </div>
    <div class="status-grid">
      <div class="status-block">
        <span class="status-label">G2</span>
        <span id="connection-status" class="status-pill">未接続</span>
      </div>
      <div class="status-block">
        <span class="status-label">Hub</span>
        <span id="hub-status" class="status-pill">未確認</span>
      </div>
      <div class="status-block">
        <span class="status-label">Notifications</span>
        <span id="notif-count" class="status-pill">0件</span>
      </div>
      <div class="status-block">
        <span class="status-label">G2 Screen</span>
        <span id="g2-screen-status" class="status-pill">idle</span>
      </div>
    </div>
    <p id="last-sync-status" class="inline-note">最終更新: まだありません</p>
  </section>

  <section class="card">
    <div class="section-head">
      <div>
        <h2>Recent Notifications</h2>
        <p class="card-copy">最新 5 件。スマホ側では状態確認、主操作は G2 側で行います。</p>
      </div>
      <span id="notif-status" class="inline-status">未取得</span>
    </div>
    <ul id="recent-notifs" class="queue-list"></ul>
    <pre id="notif-info" class="queue-detail"></pre>
  </section>

  ${devUiEnabled ? `
  <details class="card dev-card">
    <summary>Developer Tools</summary>
    <div class="tool-grid">
      <section class="tool-block">
        <h2>テキスト表示テスト</h2>
        <input id="display-text" type="text" placeholder="G2に表示するテキスト" value="Hello from claw-lab!" />
        <button id="send-text-btn" class="btn" type="button">G2に送信</button>
      </section>

      <section class="tool-block">
        <h2>承認UIテスト</h2>
        <p class="tool-copy">G2上にリスト表示して承認/拒否を試す</p>
        <button id="approval-btn" class="btn" type="button">承認リクエスト送信</button>
        <span id="approval-result" class="status-line">未実行</span>
      </section>

      <section class="tool-block">
        <h2>マイクテスト</h2>
        <button id="mic-start-btn" class="btn" type="button">録音開始</button>
        <button id="mic-stop-btn" class="btn" type="button" disabled>録音停止</button>
        <p id="mic-status" class="status-line">待機中</p>
        <pre id="audio-info"></pre>
      </section>
    </div>
  </details>

  <details class="card dev-card">
    <summary>Event Log</summary>
    <pre id="event-log"></pre>
  </details>
  ` : `
  <section class="card debug-note">
    <h2>Debug UI</h2>
    <p class="card-copy">Developer Tools と Event Log は <code>?dev=1</code> を付けると表示されます。</p>
  </section>
  `}
`

// ---------------------------------------------------------------------------
// Module-level state (connection / audio / render)
// ---------------------------------------------------------------------------

let connection: BridgeConnection | null = null
let audioSession: AudioSession | null = null

const glassesUI = createGlassesUI()
const notifClient = createNotificationClient(appConfig.notificationHubUrl)
// Phase 2: two STT engines wired in parallel.
// - voice-command path: configurable (groq-batch / deepgram-stream)
// - permission コメント (返信) path: always groq-batch (短文)
const sttEngineForReply: SttEngine = createGroqBatchEngine()
const sttEngine: SttEngine = appConfig.sttEngineVoiceCommand === 'deepgram-stream'
  ? createDeepgramStreamEngine()
  : createGroqBatchEngine()
log(`STT engine for voice-command: ${sttEngine.kind}`)

const renderQueue: RenderQueue = createRenderQueue({
  log: (msg) => log(msg),
  // safeguard: 連続 throw が 3 回続いたら idle launcher に戻す。
  safeguard: async () => {
    if (!connection) return
    try {
      await glassesUI.showIdleLauncher(connection, { dimMode: appConfig.notificationIdleDimMode })
    } catch { /* swallow */ }
  },
})

const eventDispatcher: EventDispatcher = createEventDispatcher({ log: (msg) => log(msg) })

// ---------------------------------------------------------------------------
// Notification controller (dashboard / polling / 通知一覧)
// ---------------------------------------------------------------------------

const notifController = createNotificationController({
  getConnection: () => connection,
  glassesUI,
  notifClient,
  log,
  isAnyRendering: () => isAnyRendering(),
  ensureNotifEventHandler: (conn) => ensureNotifEventHandler(conn),
})

// ---------------------------------------------------------------------------
// Screen helpers wiring (lifecycle 関数を inject)
// ---------------------------------------------------------------------------

installScreenHelpers({
  getConnection: () => connection,
  getAudioSession: () => audioSession,
  glassesUI,
  notifClient,
  renderQueue,
  sttEngine,
  sttEngineForReply,
  log,
  appConfig: { notificationIdleDimMode: appConfig.notificationIdleDimMode },
  updateNotifInfo: () => notifController.updateNotifInfo(),
  flushPendingNotificationUi: (reason) => notifController.flushPendingNotificationUi(reason),
})

// ---------------------------------------------------------------------------
// ScreenContext builder + dispatcher
// ---------------------------------------------------------------------------

function buildScreenContext(): ScreenContext {
  if (!connection) throw new Error('buildScreenContext called without connection')
  if (!audioSession) throw new Error('buildScreenContext called without audioSession')
  return {
    conn: connection,
    getConnection: () => connection,
    glassesUI,
    store,
    notifClient,
    audioSession,
    renderQueue,
    sttEngine,
    sttEngineForReply,
    log,
    updateNotifInfo: () => notifController.updateNotifInfo(),
    returnToListFromResult,
    enterIdleScreen,
    getContextPctForNotification,
    shouldIgnoreDetailScroll,
    clearPendingScrollEvent,
    isAnyRendering: () => isAnyRendering(),
    startVoiceCommandRecording,
    stopVoiceCommandRecording,
    cancelVoiceCommandRecording,
    sendVoiceCommandAndShowResult,
    returnToIdleFromVoiceCommand,
    scheduleVoiceCommandDoneReturn,
    finalizeVoiceCommandStreaming,
    cancelVoiceCommandStreaming,
    startReplyAudioRecording,
    stopReplyAudioRecording,
    isAskUserQuestionNotification,
    enterSessionListScreen,
  }
}

const handleNotifEvent = createNotifEventDispatcher({
  log,
  isAnyRendering: () => isAnyRendering(),
  buildScreenContext,
})

// G2 イベントリスナーは event-dispatcher 経由で 1 度だけ登録 (Phase 1.5b)。
function ensureNotifEventHandler(conn: BridgeConnection) {
  if (store.dashboard.notifEventRegisteredFor === conn) return
  eventDispatcher.setHandler((event) => handleNotifEvent(event))
  eventDispatcher.attach(conn)
  store.dashboard.notifEventRegisteredFor = conn
}

// ---------------------------------------------------------------------------
// DOM event listeners (Connect + dev tools + notification controller)
// ---------------------------------------------------------------------------

document.getElementById('connect-btn')!.addEventListener('click', async () => {
  notifController.setConnectionPill('接続中...', 'warn')
  log('Bridge接続を開始...')

  try {
    connection = await initBridge()
    notifController.updateDashboard()
    log(`接続成功: ${connection.mode} モード`)

    if (connection.bridge) {
      try {
        const info = await connection.bridge.getDeviceInfo()
        if (info) {
          log(
            `DeviceInfo: model=${info.model}, sn=${info.sn || '-'}, connectType=${info.status?.connectType || '-'}, battery=${info.status?.batteryLevel ?? '-'}%`,
          )
        } else {
          log('DeviceInfo: 取得結果なし')
        }
      } catch (err) {
        log(`DeviceInfo取得失敗: ${err instanceof Error ? err.message : String(err)}`)
      }

      if (!store.dev.deviceStatusListenerAttached) {
        try {
          connection.bridge.onDeviceStatusChanged((status) => {
            log(
              `DeviceStatus: connectType=${status.connectType}, wearing=${status.isWearing}, battery=${status.batteryLevel}%`,
            )
          })
          store.dev.deviceStatusListenerAttached = true
        } catch (err) {
          log(`DeviceStatus購読失敗: ${err instanceof Error ? err.message : String(err)}`)
        }
      }
    }

    logSpeechCapabilities(log)

    if (!audioSession) {
      // PCM listener は audio-session が一度だけ登録する。
      audioSession = createAudioSession({
        startAudio: () => connection!.startAudio(),
        stopAudio: () => connection!.stopAudio(),
        onAudio: (handler) => connection!.onAudio(handler),
      })
      store.dev.audioListenerAttached = true
    }
    ensureNotifEventHandler(connection)
    notifController.startNotificationPolling()
    document.getElementById('sessions-show-g2-btn')?.removeAttribute('disabled')
  } catch (err) {
    notifController.setConnectionPill('接続失敗', 'error')
    log(`接続失敗: ${err}`)
  }
})

// Phase 3: SessionList entry point. Click handler stays here (not in
// notification-controller) because it is a sibling to Connect Glasses, lives
// outside the notification list lifecycle, and depends on enterSessionListScreen
// which is bound to the screen helpers wired below.
const sessionsBtn = document.getElementById('sessions-show-g2-btn')
if (sessionsBtn) {
  sessionsBtn.addEventListener('click', async () => {
    if (!connection) {
      log('未接続です。先にConnectしてください。')
      return
    }
    sessionsBtn.removeAttribute('disabled')
    ensureNotifEventHandler(connection)
    try {
      await enterSessionListScreen('dashboard button')
    } catch (err) {
      log(`SessionList起動失敗: ${err instanceof Error ? err.message : String(err)}`)
    }
  })
}

wireDevTools({
  getConnection: () => connection,
  getAudioSession: () => audioSession,
  glassesUI,
  log,
})

// 初期描画
notifController.updateDashboard()
