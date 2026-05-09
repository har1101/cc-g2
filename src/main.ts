import './styles.css'
import type { EvenHubEvent } from '@evenrealities/even_hub_sdk'
import { initBridge, type BridgeConnection } from './bridge'
import { createGlassesUI, type NotificationUIState, type AskQuestionData } from './glasses-ui'
import { log } from './log'
import { transcribePcmChunks } from './stt/groq'
import { formatForG2Display } from './g2-format'
import { appConfig, canUseGroqStt, createHubHeaders } from './config'
import { getWebSpeechSupport, startWebSpeechCapture } from './stt/webspeech'
import { createNotificationClient, type NotificationDetail, type NotificationItem } from './notifications'
import { G2_EVENT, getNormalizedEventType, isDoubleTapEventType, isTapEventType, normalizeHubEvent } from './even-events'
import {
  bumpVoiceGeneration,
  cancelIdleSingleTapTimer,
  clearVoiceDoneTimer,
  clearVoiceRecordingMaxTimer,
  resetDevAudio,
  resetReplyAudio,
  resetVoiceToIdle,
  store,
  type ContextSession,
} from './state/store'
import { createAudioSession, type AudioSession, type AudioSessionHandle } from './audio-session'
import { createRenderQueue, type RenderQueue } from './render-queue'

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

let connection: BridgeConnection | null = null
const glassesUI = createGlassesUI()
const notifClient = createNotificationClient(appConfig.notificationHubUrl)
// 全 module-level state は src/state/store.ts に集約 (Phase 1.5b)。
// 短いエイリアス notifState を残して既存の "notifState.screen" などの記述を保つ。
const notifState = store.notif

// Audio session (Phase 1.5b): connection 初期化後に一度だけ作る。 各 owner
// (reply-comment / voice-command / dev-mic) は acquire() で排他取得し、
// 終了時に release() する。 release は冪等なので途中失敗でも安全に呼べる。
let audioSession: AudioSession | null = null
let currentReplyAudioHandle: AudioSessionHandle | null = null
let currentVoiceAudioHandle: AudioSessionHandle | null = null
let currentDevAudioHandle: AudioSessionHandle | null = null

/**
 * G2 描画ジョブを直列化する render queue (Phase 1.5b)。
 * `glassesUI` 自身が内部 lock を持っているため、 ここでの直列化は冗長に見えるが、
 * 1.5c 以降の screen 分割で「複数 screen が同時に describe される」 状況での
 * 唯一の真実の source にする目的で先に導入する。
 *
 * NOTE: 1.5b では既存の `glassesUI.show*` を全箇所ラップしない (behavior 不変が
 * 第一の goal であり、 既存の SDK 内部 lock で十分機能しているため)。 1.5c で
 * screen module が増えたタイミングで `renderQueue.enqueue` 経由に揃える。
 */
const renderQueue: RenderQueue = createRenderQueue({
  log: (msg) => log(msg),
  // safeguard: 連続 throw が 3 回続いたら idle launcher に戻す。
  // connection が確定していない可能性があるので nullable check する。
  safeguard: async () => {
    if (!connection) return
    try {
      await glassesUI.showIdleLauncher(connection, { dimMode: appConfig.notificationIdleDimMode })
    } catch { /* swallow — render-queue は次の job に進む */ }
  },
})

/** glasses-ui か render-queue のどちらかが進行中なら true。 イベント保留判定に使う */
function isAnyRendering(): boolean {
  return glassesUI.isRendering() || renderQueue.isRendering()
}

const DETAIL_SCROLL_COOLDOWN_MS = 250
const TAP_SCROLL_SUPPRESS_MS = 150
const IDLE_DOUBLE_TAP_WINDOW_MS = 700
const IDLE_REOPEN_COOLDOWN_MS = 4000
const VOICE_COMMAND_RECORDING_MAX_MS = 20_000
const VOICE_COMMAND_DONE_AUTO_RETURN_MS = 2_000

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function screenLabel(screen: NotificationUIState['screen']): string {
  switch (screen) {
    case 'idle': return 'idle'
    case 'list': return 'list'
    case 'detail': return 'detail'
    case 'detail-actions': return 'actions'
    case 'ask-question': return 'ask-q'
    case 'reply-recording': return 'recording'
    case 'reply-confirm': return 'confirm'
    case 'reply-sending': return 'sending'
    case 'voice-command-recording': return 'vc-rec'
    case 'voice-command-confirm': return 'vc-conf'
    case 'voice-command-sending': return 'vc-send'
    case 'voice-command-done': return 'vc-done'
  }
}

function replyStatusLabel(item: NotificationItem): string {
  switch (item.replyStatus) {
    case 'replied': return 'replied'
    case 'delivered': return 'delivered'
    case 'decided': return 'decided'
    case 'pending': return 'pending'
    default: return 'new'
  }
}

function formatRelativeTime(ms: number | null): string {
  if (!ms) return 'まだありません'
  const diff = Date.now() - ms
  if (diff < 5_000) return 'たった今'
  if (diff < 60_000) return `${Math.floor(diff / 1000)}秒前`
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}分前`
  return new Date(ms).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' })
}

function getReplyResultMessage(res: { reply?: { status?: string; result?: string; error?: string; ignoredReason?: string } } | undefined): { ok: boolean; message?: string } {
  const reply = res?.reply
  if (!reply) return { ok: true }
  if (reply.status === 'failed') {
    return { ok: false, message: reply.error || 'reply failed' }
  }
  if (reply.result === 'ignored') {
    if (reply.ignoredReason === 'approval-not-pending') {
      return { ok: false, message: 'この承認は既に無効です' }
    }
    if (reply.ignoredReason === 'approval-link-not-found') {
      return { ok: false, message: '承認リンクが見つかりません' }
    }
    return { ok: false, message: reply.error || 'reply ignored' }
  }
  return { ok: true }
}

function setPill(id: string, text: string, tone: 'neutral' | 'ok' | 'warn' | 'error' = 'neutral') {
  const el = document.getElementById(id)
  if (!el) return
  el.textContent = text
  el.className = `status-pill ${tone}`
}

function renderRecentNotifications() {
  const listEl = document.getElementById('recent-notifs')
  if (!listEl) return
  const items = notifState.items.slice(0, 5)
  if (items.length === 0) {
    listEl.innerHTML = '<li class="queue-empty">通知はまだありません。</li>'
    return
  }
  listEl.innerHTML = items.map((item, index) => {
    const active = notifState.screen === 'list' && index === notifState.selectedIndex ? ' active' : ''
    const title = escapeHtml(item.title)
    const source = escapeHtml(item.source)
    const status = escapeHtml(replyStatusLabel(item))
    const age = escapeHtml(new Date(item.createdAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }))
    return `<li class="queue-item${active}">
      <div class="queue-title">${title}</div>
      <div class="queue-meta">${source} · ${status} · ${age}</div>
    </li>`
  }).join('')
}

function updateDashboard() {
  const g2Tone = connection ? 'ok' : 'neutral'
  const g2Text = connection ? (connection.mode === 'bridge' ? '接続済み (Bridge)' : '接続済み (Mock)') : '未接続'
  setPill('connection-status', g2Text, g2Tone)

  if (store.dashboard.hubReachable == null) setPill('hub-status', '未確認', 'neutral')
  else setPill('hub-status', store.dashboard.hubReachable ? 'reachable' : 'error', store.dashboard.hubReachable ? 'ok' : 'error')

  const notifTone = notifState.items.length > 0 ? 'ok' : 'neutral'
  setPill('notif-count', `${notifState.items.length}件`, notifTone)
  setPill('g2-screen-status', screenLabel(notifState.screen), 'neutral')

  const syncEl = document.getElementById('last-sync-status')
  if (syncEl) syncEl.textContent = `最終更新: ${formatRelativeTime(store.dashboard.lastNotifRefreshAt)}`

  renderRecentNotifications()
}

// --- Context status polling ---
async function fetchContextStatus() {
  try {
    const res = await fetch(`${appConfig.notificationHubUrl}/api/context-status`, {
      headers: createHubHeaders(),
    })
    if (!res.ok) return
    const data = await res.json() as { ok: boolean; sessions: ContextSession[] }
    if (data.sessions && data.sessions.length > 0) {
      store.context.sessions = data.sessions
      store.context.latestPct = Math.max(...data.sessions.map((s) => s.usedPercentage))
    }
  } catch { /* ignore */ }
}

/** 通知のmetadata.cwdに一致するセッションのコンテキスト占有率を返す */
function getContextPctForNotification(detail: { metadata?: Record<string, unknown> }): number | undefined {
  const cwd = detail.metadata?.cwd
  if (typeof cwd !== 'string' || store.context.sessions.length === 0) return store.context.latestPct
  const matches = store.context.sessions.filter((s) => s.cwd === cwd)
  if (matches.length === 0) return store.context.latestPct
  return Math.max(...matches.map((s) => s.usedPercentage))
}

// --- Connect ---
document.getElementById('connect-btn')!.addEventListener('click', async () => {
  setPill('connection-status', '接続中...', 'warn')
  log('Bridge接続を開始...')

  try {
    connection = await initBridge()
    updateDashboard()
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

    if (!store.dev.speechCapabilityLogged) {
      log(
        `STT設定: enabled=${appConfig.sttEnabled ? 'yes' : 'no'}, forceError=${appConfig.sttForceError ? 'yes' : 'no'}, provider=${canUseGroqStt() ? 'hub' : 'mock'}`,
      )
      if (appConfig.webSpeechCompare) {
        const cap = getWebSpeechSupport()
        log(
          `Web Speech API可否: SpeechRecognition=${cap.speechRecognition ? 'yes' : 'no'}, webkitSpeechRecognition=${cap.webkitSpeechRecognition ? 'yes' : 'no'}`,
        )
      }
      store.dev.speechCapabilityLogged = true
    }

    if (!audioSession) {
      // PCM listener は audio-session が一度だけ登録する。
      // 各 owner の acquire/handle.onPcm/release で chunks を集める。
      audioSession = createAudioSession({
        startAudio: () => connection!.startAudio(),
        stopAudio: () => connection!.stopAudio(),
        onAudio: (handler) => connection!.onAudio(handler),
      })
      store.dev.audioListenerAttached = true
    }
    ensureNotifEventHandler(connection)
    startNotificationPolling()
  } catch (err) {
    setPill('connection-status', '接続失敗', 'error')
    log(`接続失敗: ${err}`)
  }
})

// --- Text Display ---
document.getElementById('send-text-btn')!.addEventListener('click', async () => {
  const text = (document.getElementById('display-text') as HTMLInputElement).value
  if (!connection) {
    log('未接続です。先にConnectしてください。')
    return
  }
  log(`テキスト送信: "${text}"`)
  await glassesUI.showText(connection, text)
})

// --- Approval UI ---
document.getElementById('approval-btn')!.addEventListener('click', async () => {
  const resultEl = document.getElementById('approval-result')!
  if (!connection) {
    log('未接続です。先にConnectしてください。')
    return
  }
  resultEl.textContent = '承認待ち...'
  log('承認リクエスト送信: ファイル編集の承認')

  const result = await glassesUI.requestApproval(connection, {
    title: 'ファイル編集の承認',
    detail: 'src/auth.ts +12行/-3行',
    options: ['Approve', 'Deny'],
  })

  resultEl.textContent = `結果: ${result}`
  resultEl.classList.add(result === 'Approve' ? 'approved' : 'rejected')
  log(`承認結果: ${result}`)
})

// --- Mic ---
document.getElementById('mic-start-btn')!.addEventListener('click', async () => {
  if (!connection || !audioSession) {
    log('未接続です。先にConnectしてください。')
    return
  }
  resetDevAudio()
  const micStatus = document.getElementById('mic-status')!
  const startBtn = document.getElementById('mic-start-btn') as HTMLButtonElement
  const stopBtn = document.getElementById('mic-stop-btn') as HTMLButtonElement
  const audioInfo = document.getElementById('audio-info')!

  store.dev.webSpeechFinalText = ''
  store.dev.webSpeechInterimText = ''
  store.dev.webSpeechError = ''
  if (appConfig.webSpeechCompare) {
    const wsCap = getWebSpeechSupport()
    if (wsCap.available) {
      try {
        store.dev.webSpeechSession = startWebSpeechCapture(({ finalText, interimText }) => {
          store.dev.webSpeechFinalText = finalText
          store.dev.webSpeechInterimText = interimText
        })
        log('Web Speech比較キャプチャ開始（ブラウザ/端末マイク系）')
      } catch (err) {
        store.dev.webSpeechSession = null
        store.dev.webSpeechError = err instanceof Error ? err.message : String(err)
        log(`Web Speech開始失敗: ${store.dev.webSpeechError}`)
      }
    }
  }

  // evenhub-simulator requires at least one created page/container before audioControl().
  if (connection.mode === 'bridge' && !glassesUI.hasRenderedPage(connection)) {
    log('マイク前にG2ベースページを初期化（simulator対策）')
    await glassesUI.ensureBasePage(connection, 'マイク録音中...')
  }

  try {
    currentDevAudioHandle = await audioSession.acquire('dev-mic')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log(`マイク開始失敗: ${msg}`)
    micStatus.textContent = `開始失敗: ${msg}`
    return
  }
  store.dev.isRecording = true
  startBtn.disabled = true
  stopBtn.disabled = false
  micStatus.textContent = '録音中...'
  audioInfo.textContent = ''
  log('マイク開始')

  currentDevAudioHandle.onPcm((pcm) => {
    if (!store.dev.isRecording) return
    store.dev.audioChunks.push(pcm)
    store.dev.audioTotalBytes += pcm.length
    const durationMs = (store.dev.audioTotalBytes / 2) / 16 // 16kHz, 16bit = 2 bytes/sample
    audioInfo.textContent = [
      `チャンク数: ${store.dev.audioChunks.length}`,
      `合計バイト: ${store.dev.audioTotalBytes}`,
      `推定時間: ${(durationMs / 1000).toFixed(1)}秒`,
      `最新チャンク: ${pcm.length} bytes`,
    ].join('\n')
  })
})

document.getElementById('mic-stop-btn')!.addEventListener('click', async () => {
  if (!connection) return
  const micStatus = document.getElementById('mic-status')!
  const startBtn = document.getElementById('mic-start-btn') as HTMLButtonElement
  const stopBtn = document.getElementById('mic-stop-btn') as HTMLButtonElement
  const audioInfo = document.getElementById('audio-info')!

  store.dev.isRecording = false
  if (currentDevAudioHandle) {
    await currentDevAudioHandle.release()
    currentDevAudioHandle = null
  }
  if (appConfig.webSpeechCompare && store.dev.webSpeechSession) {
    try {
      const ws = await store.dev.webSpeechSession.stop()
      store.dev.webSpeechFinalText = ws.finalText
      store.dev.webSpeechInterimText = ws.interimText
      if (ws.error) store.dev.webSpeechError = ws.error
      log(
        `Web Speech停止: final=${ws.finalText ? 'yes' : 'no'}, interim=${ws.interimText ? 'yes' : 'no'}${ws.error ? `, error=${ws.error}` : ''}`,
      )
    } catch (err) {
      store.dev.webSpeechError = err instanceof Error ? err.message : String(err)
      log(`Web Speech停止失敗: ${store.dev.webSpeechError}`)
    } finally {
      store.dev.webSpeechSession = null
    }
  }
  startBtn.disabled = false
  stopBtn.disabled = true

  micStatus.textContent = `録音完了 (${store.dev.audioChunks.length}チャンク, ${store.dev.audioTotalBytes}バイト)`
  log(`マイク停止: ${store.dev.audioChunks.length}チャンク, ${store.dev.audioTotalBytes}バイト取得`)

  if (store.dev.audioTotalBytes === 0) {
    return
  }

  micStatus.textContent = 'STT処理中...'
  log('STT開始')

  try {
    const stt = await transcribePcmChunks(store.dev.audioChunks)
    const formatted = formatForG2Display(stt.text || '（認識結果なし）')
    micStatus.textContent = `STT完了 (${stt.provider}${stt.model ? `:${stt.model}` : ''})`
    const infoLines = [
      audioInfo.textContent,
      '',
      `STT provider: ${stt.provider}${stt.model ? ` (${stt.model})` : ''}`,
      `STT text: ${stt.text || '（空）'}`,
    ]
    if (appConfig.webSpeechCompare) {
      const cap = getWebSpeechSupport()
      infoLines.push(
        `Web Speech API: SpeechRecognition=${cap.speechRecognition ? 'yes' : 'no'}, webkitSpeechRecognition=${cap.webkitSpeechRecognition ? 'yes' : 'no'}`,
        `Web Speech final: ${store.dev.webSpeechFinalText || '（空）'}`,
        `Web Speech interim: ${store.dev.webSpeechInterimText || '（空）'}`,
        `Web Speech error: ${store.dev.webSpeechError || 'なし'}`,
      )
    }
    infoLines.push('', 'G2表示用:', formatted)
    audioInfo.textContent = infoLines.join('\n')
    log(`STT完了: provider=${stt.provider}${stt.model ? ` model=${stt.model}` : ''}`)
    log(`STT結果: ${stt.text || '（空）'}`)
    if (appConfig.webSpeechCompare && store.dev.webSpeechFinalText) {
      log(`Web Speech結果(比較): ${store.dev.webSpeechFinalText}`)
    }
    await glassesUI.showText(connection, formatted)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    micStatus.textContent = 'STT失敗'
    log(`STT失敗: ${message}`)
    if (connection) {
      await glassesUI.showText(connection, 'STT失敗\n再試行してください')
    }
  }
})

// --- AskUserQuestion helpers ---
function isAskUserQuestionNotification(detail: NotificationDetail): boolean {
  const meta = detail.metadata
  return !!(meta && (meta.hookType === 'ask-user-question' || meta.toolName === 'AskUserQuestion'))
}

function extractAskQuestions(detail: NotificationDetail): AskQuestionData[] {
  const meta = detail.metadata
  if (!meta) return []
  const questions = meta.questions
  if (!Array.isArray(questions)) return []
  return questions.filter(
    (q: unknown): q is AskQuestionData =>
      !!q && typeof q === 'object' && 'question' in q && 'options' in q && Array.isArray((q as AskQuestionData).options),
  )
}

// --- Notifications ---
// notifState / 状態フラグは store.notif / store.dashboard に集約済み (Phase 1.5b)。

function canAutoOpenForScreen(screen: NotificationUIState['screen']): boolean {
  // 録音/送信/voice-command 中は割り込まない。他の画面では新着優先で一覧へ寄せる。
  return (
    screen !== 'reply-recording' &&
    screen !== 'reply-confirm' &&
    screen !== 'reply-sending' &&
    screen !== 'ask-question' &&
    screen !== 'voice-command-recording' &&
    screen !== 'voice-command-confirm' &&
    screen !== 'voice-command-sending' &&
    screen !== 'voice-command-done'
  )
}

async function flushPendingNotificationUi(reason: string) {
  if (!connection || isAnyRendering()) return

  if (store.dashboard.pendingAutoOpenOnNew && appConfig.notificationAutoOpenOnNew && canAutoOpenForScreen(notifState.screen)) {
    // idle画面で待機中の single-tap タイマーがあればキャンセルしてから list へ遷移する
    cancelPendingIdleSingleTap()
    notifState.screen = 'list'
    notifState.selectedIndex = 0
    await glassesUI.showNotificationList(connection, notifState.items)
    store.dashboard.pendingAutoOpenOnNew = false
    log(`通知自動更新: ${notifState.items.length}件 (保留中の自動表示を再試行して成功 reason=${reason})`)
    return
  }

  if (store.dashboard.pendingListRefresh && notifState.screen === 'list') {
    await glassesUI.showNotificationList(connection, notifState.items)
    store.dashboard.pendingListRefresh = false
    log(`通知自動更新: ${notifState.items.length}件 (保留中のリスト更新を再試行して成功 reason=${reason})`)
  }
}

function startNotificationPolling() {
  if (store.dashboard.notifPollingStarted) return
  store.dashboard.notifPollingStarted = true
  log(`通知ポーリング開始: interval=${appConfig.notificationPollIntervalMs}ms autoOpen=${appConfig.notificationAutoOpenOnNew ? 'on' : 'off'}`)
  setInterval(async () => {
    if (!connection) return
    fetchContextStatus()
    await flushPendingNotificationUi('polling')
    // 描画中はスキップ（SDK呼び出し衝突防止）
    if (isAnyRendering()) return
    try {
      const items = await notifClient.list(20)
      store.dashboard.hubReachable = true
      store.dashboard.lastNotifRefreshAt = Date.now()
      const toKey = (list: NotificationItem[]) => list.map((i) => `${i.id}:${i.replyStatus ?? ''}`).join(',')
      const oldKey = toKey(notifState.items)
      const oldIdSet = new Set(notifState.items.map((i) => i.id))
      const newKey = toKey(items)
      if (oldKey === newKey) return // 変化なし

      notifState.items = items
      const hasNewItems = items.some((item) => !oldIdSet.has(item.id))
      const statusEl = document.getElementById('notif-status')!
      statusEl.textContent = `${items.length}件 (自動更新)`
      const wantsAutoOpen = hasNewItems && appConfig.notificationAutoOpenOnNew
      const canAutoOpenNow = wantsAutoOpen && canAutoOpenForScreen(notifState.screen) && !isAnyRendering()

      // 新着が来た時点で pending を立てておく。
      // これにより reply-sending 等で一度スキップしても、画面復帰後の次サイクルで回収できる。
      if (wantsAutoOpen && !canAutoOpenNow) {
        if (!store.dashboard.pendingAutoOpenOnNew) {
          const reason = canAutoOpenForScreen(notifState.screen) ? '描画中' : `screen=${notifState.screen}`
          log(`通知自動更新: ${items.length}件 (新着あり/自動表示を保留 reason=${reason})`)
        }
        store.dashboard.pendingAutoOpenOnNew = true
      }

      if (canAutoOpenNow) {
        // idle画面で待機中の single-tap タイマーがあればキャンセルしてから list へ遷移する
        cancelPendingIdleSingleTap()
        notifState.screen = 'list'
        notifState.selectedIndex = 0
        await glassesUI.showNotificationList(connection!, items)
        store.dashboard.pendingAutoOpenOnNew = false
        log(`通知自動更新: ${items.length}件 (新着検知で自動表示)`)
      } else if (notifState.screen === 'list' && !isAnyRendering()) {
        // ユーザー操作直後はリスト再描画を遅延し、連続rebuild競合を抑える
        if (Date.now() - store.dashboard.lastG2UserEventAt < 4000) {
          log(`通知自動更新: ${items.length}件 (操作中のため描画保留)`)
          updateNotifInfo()
          return
        }
        // リスト画面かつ描画中でなければG2を更新
        await glassesUI.showNotificationList(connection!, items)
        store.dashboard.pendingListRefresh = false
        log(`通知自動更新: ${items.length}件 (リスト更新)`)
      } else {
        if (hasNewItems && notifState.screen === 'list') {
          store.dashboard.pendingListRefresh = true
        }
        const mode = hasNewItems
          ? `新着あり/自動表示スキップ screen=${notifState.screen} autoOpen=${appConfig.notificationAutoOpenOnNew ? 'on' : 'off'}`
          : 'バックグラウンド'
        log(`通知自動更新: ${items.length}件 (${mode})`)
      }
      updateNotifInfo()
    } catch {
      store.dashboard.hubReachable = false
      updateDashboard()
      // ポーリング失敗は静かに無視
    }
  }, appConfig.notificationPollIntervalMs)
}

function updateNotifInfo() {
  const infoEl = document.getElementById('notif-info')!
  if (notifState.screen === 'idle') {
    const autoOpenLabel = appConfig.notificationAutoOpenOnNew ? 'ON' : 'OFF'
    infoEl.textContent = `待機中（G2でダブルタップすると通知一覧）\n新着自動表示: ${autoOpenLabel}`
  } else if (notifState.screen === 'list') {
    const lines = notifState.items.map((item, i) => {
      const marker = i === notifState.selectedIndex ? '>' : ' '
      return `${marker} ${item.title} (${item.source})`
    })
    infoEl.textContent = lines.length > 0 ? lines.join('\n') : '通知なし'
  } else if (notifState.screen === 'detail' && notifState.detailItem) {
    const d = notifState.detailItem
    const replyHint = d.replyCapable ? ' | Click=操作メニュー' : ''
    infoEl.textContent = [
      `[詳細] ${d.title}`,
      `Source: ${d.source} | replyCapable: ${d.replyCapable}`,
      `Chunk: ${notifState.detailPageIndex + 1}/${notifState.detailPages.length} (firmware scroll)`,
      `操作: FW自動スクロール, 境界到達→チャンク切替, DblClick=戻る${replyHint}`,
      '',
      notifState.detailPages[notifState.detailPageIndex] ?? '',
    ].join('\n')
  } else if (notifState.screen === 'detail-actions' && notifState.detailItem) {
    infoEl.textContent = [
      `[操作] ${notifState.detailItem.title}`,
      '0=コメント, 1=Approve, 2=Deny, 3=◀ 戻る',
      'Click=選択, DblClick=詳細に戻る',
    ].join('\n')
  } else if (notifState.screen === 'ask-question') {
    const q = notifState.askQuestions[notifState.askQuestionIndex]
    const opts = q ? q.options.map((o, i) => `${i}=${o.label}`).join(', ') : ''
    infoEl.textContent = [
      `[質問 ${notifState.askQuestionIndex + 1}/${notifState.askQuestions.length}]`,
      q?.question ?? '',
      opts,
      'Click=選択, DblClick=戻る',
    ].join('\n')
  } else if (notifState.screen === 'reply-recording') {
    infoEl.textContent = `[返信録音中] ${store.reply.audioTotalBytes} bytes\nDblClick=停止, Swipe=キャンセル`
  } else if (notifState.screen === 'reply-confirm') {
    infoEl.textContent = `[返信確認]\n"${notifState.replyText}"\n\n送信=0, 再録=1, キャンセル=2`
  } else if (notifState.screen === 'reply-sending') {
    infoEl.textContent = '[返信送信中...]'
  } else if (notifState.screen === 'voice-command-recording') {
    infoEl.textContent = `[音声コマンド録音中] ${store.voice.audioTotalBytes} bytes\nTap=停止, DblTap=キャンセル`
  } else if (notifState.screen === 'voice-command-confirm') {
    infoEl.textContent = `[音声コマンド確認]\n"${store.voice.finalText}"\n\nTap=送信, DblTap=キャンセル`
  } else if (notifState.screen === 'voice-command-sending') {
    infoEl.textContent = '[音声コマンド送信中...]'
  } else if (notifState.screen === 'voice-command-done') {
    infoEl.textContent = '[音声コマンド完了]'
  }
  updateDashboard()
}

document.getElementById('notif-fetch-btn')!.addEventListener('click', async () => {
  const statusEl = document.getElementById('notif-status')!
  statusEl.textContent = '取得中...'
  try {
    const items = await notifClient.list(20)
    store.dashboard.hubReachable = true
    store.dashboard.lastNotifRefreshAt = Date.now()
    notifState.items = items
    notifState.selectedIndex = 0
    if (notifState.screen !== 'list') {
      notifState.screen = 'idle'
      if (connection && !isAnyRendering()) {
        await glassesUI.showIdleLauncher(connection, { dimMode: appConfig.notificationIdleDimMode })
      }
    }
    statusEl.textContent = `${items.length}件取得`
    document.getElementById('notif-show-g2-btn')!.removeAttribute('disabled')
    startNotificationPolling()
    updateNotifInfo()
    log(`通知取得: ${items.length}件`)
  } catch (err) {
    store.dashboard.hubReachable = false
    const msg = err instanceof Error ? err.message : String(err)
    statusEl.textContent = `取得失敗: ${msg}`
    log(`通知取得失敗: ${msg}`)
    updateDashboard()
  }
})

// 送信結果画面からリスト一覧に復帰する共通処理
async function returnToListFromResult() {
  if (notifState.screen === 'list') return // 既に復帰済み
  log('結果画面 → 通知一覧に復帰')
  notifState.screen = 'list'
  notifState.detailItem = null
  notifState.replyText = ''
  notifState.selectedIndex = 0
  notifState.askQuestions = []
  notifState.askQuestionIndex = 0
  notifState.askAnswers = {}
  if (connection) {
    try {
      notifState.items = await notifClient.list(20)
    } catch { /* fallback to cached */ }
    await glassesUI.showNotificationList(connection, notifState.items)
  }
  updateNotifInfo()
  await flushPendingNotificationUi('result-return')
}

function clearPendingNotifEvent() {
  store.eventQueue.pendingNotifEvent = null
  if (store.eventQueue.pendingNotifEventFlushTimer) {
    clearTimeout(store.eventQueue.pendingNotifEventFlushTimer)
    store.eventQueue.pendingNotifEventFlushTimer = null
  }
}

/** キュー中のイベントがスクロールの場合のみクリアする（tap/doubleTap等は保持） */
function clearPendingScrollEvent() {
  if (!store.eventQueue.pendingNotifEvent) return
  const eventType = getNormalizedEventType(store.eventQueue.pendingNotifEvent)
  if (eventType === G2_EVENT.SCROLL_TOP || eventType === G2_EVENT.SCROLL_BOTTOM) {
    clearPendingNotifEvent()
  }
}

async function enterIdleScreen(reason: string) {
  notifState.screen = 'idle'
  notifState.detailItem = null
  notifState.replyText = ''
  store.idle.idleTapDuringRender = false
  store.idle.lastIdleEventAt = 0
  cancelPendingIdleSingleTap()
  store.idle.idleOpenBlockedUntil = Date.now() + IDLE_REOPEN_COOLDOWN_MS
  clearPendingNotifEvent()
  if (connection) {
    await glassesUI.showIdleLauncher(connection, { dimMode: appConfig.notificationIdleDimMode })
  }
  updateNotifInfo()
  log(`${reason} (idle reopen blocked ${IDLE_REOPEN_COOLDOWN_MS}ms)`)
}

// Timer/state helpers は store.ts に集約 (Phase 1.5b):
//   cancelPendingIdleSingleTap → cancelIdleSingleTapTimer
//   clearVoiceCommandRecordingMaxTimer → clearVoiceRecordingMaxTimer
//   clearVoiceCommandDoneTimer → clearVoiceDoneTimer
//   resetVoiceCommandStateToIdle → resetVoiceToIdle
// 既存呼び出し箇所はそのまま維持し、 thin alias で繋ぐ。
const cancelPendingIdleSingleTap = cancelIdleSingleTapTimer
const clearVoiceCommandRecordingMaxTimer = clearVoiceRecordingMaxTimer
const clearVoiceCommandDoneTimer = clearVoiceDoneTimer
const resetVoiceCommandStateToIdle = resetVoiceToIdle

/**
 * reply (permission コメント) 録音を開始するヘルパ。
 * 旧コードでは 3 箇所 (detail-actions のコメント / ask-question の "その他（音声）" /
 * reply-confirm の再録) で `await connection.startAudio()` を直接呼んでいたが、
 * Phase 1.5b では audio-session.acquire('reply-comment') 経由で排他取得し、
 * onPcm で chunks を貯める。 失敗時は handle が undefined のまま return される。
 */
async function startReplyAudioRecording(): Promise<boolean> {
  if (!connection || !audioSession) return false
  resetReplyAudio()
  try {
    currentReplyAudioHandle = await audioSession.acquire('reply-comment')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log(`返信録音 開始失敗: ${msg}`)
    return false
  }
  currentReplyAudioHandle.onPcm((pcm) => {
    if (!store.reply.isRecording) return
    store.reply.audioChunks.push(pcm)
    store.reply.audioTotalBytes += pcm.length
  })
  store.reply.isRecording = true
  return true
}

/** reply 録音を停止。 audio handle を解放する。 stopAudio 失敗時もログだけ吐いて続行 */
async function stopReplyAudioRecording(): Promise<void> {
  store.reply.isRecording = false
  if (currentReplyAudioHandle) {
    try {
      await currentReplyAudioHandle.release()
    } catch (err) {
      log(`返信録音 stopAudio失敗: ${err instanceof Error ? err.message : String(err)}`)
    }
    currentReplyAudioHandle = null
  }
}

async function startVoiceCommandRecording() {
  if (!connection) return
  if (store.voice.startInFlight) {
    log('voice-command: 重複開始イベントを無視 (start-in-flight)')
    return
  }
  store.voice.startInFlight = true
  // start のたびに世代を 1 つ進める。stop/send 側はこの値をキャプチャしておき、
  // await 後にグローバルが進んでいたら（=cancel または再 start 済み）状態を上書きしない。
  const gen = ++store.voice.generation
  try {
    store.voice.audioChunks = []
    store.voice.audioTotalBytes = 0
    store.voice.finalText = ''
    store.voice.stopInFlight = false
    store.voice.startedAt = Date.now()
    store.voice.isRecording = true
    notifState.screen = 'voice-command-recording'

    await glassesUI.showVoiceCommandRecording(connection, { bytes: 0 })
    // simulator 互換: audioControl 前にベースページが必要
    if (connection.mode === 'bridge' && !glassesUI.hasRenderedPage(connection)) {
      await glassesUI.ensureBasePage(connection, '音声コマンド録音中...')
    }
    if (!audioSession) throw new Error('audio-session not initialized')
    currentVoiceAudioHandle = await audioSession.acquire('voice-command')
    currentVoiceAudioHandle.onPcm((pcm) => {
      if (!store.voice.isRecording) return
      store.voice.audioChunks.push(pcm)
      store.voice.audioTotalBytes += pcm.length
    })

    clearVoiceCommandRecordingMaxTimer()
    store.voice.recordingMaxTimer = setTimeout(() => {
      void stopVoiceCommandRecording('timeout')
    }, VOICE_COMMAND_RECORDING_MAX_MS)

    updateNotifInfo()
    log(`voice-command: 録音開始 (single tap) gen=${gen}`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log(`voice command: 録音開始失敗 ${msg}`)
    // 録音開始の途中失敗は state を必ず idle に戻す。世代も進めて、もし stopAudio など
    // 既にスケジュール済みのコールバックが返ってきても無視されるようにする。
    resetVoiceCommandStateToIdle()
    store.voice.generation++
    if (currentVoiceAudioHandle) {
      try { await currentVoiceAudioHandle.release() } catch { /* ignore */ }
      currentVoiceAudioHandle = null
    }
    try {
      await returnToIdleFromVoiceCommand('start-failed')
    } catch (idleErr) {
      log(`voice-command: idle 復帰失敗 ${idleErr instanceof Error ? idleErr.message : String(idleErr)}`)
      notifState.screen = 'idle'
    }
  } finally {
    store.voice.startInFlight = false
  }
}

async function stopVoiceCommandRecording(reason: string) {
  if (!connection) return
  if (store.voice.stopInFlight) {
    log(`voice-command: 重複停止イベントを無視 reason=${reason}`)
    return
  }
  // entry 時に現世代をキャプチャ。各 await 後にこの値が陳腐化していないか確認することで、
  // ユーザーが double-tap でキャンセルした流れと競合した時の上書きを防ぐ。
  const gen = store.voice.generation
  store.voice.stopInFlight = true
  clearVoiceCommandRecordingMaxTimer()

  const isStillCurrent = () => {
    if (store.voice.generation !== gen) return false
    // start/stop/confirm 以外の画面に遷移していたらキャンセル済み（idle など）。
    if (
      notifState.screen !== 'voice-command-recording' &&
      notifState.screen !== 'voice-command-confirm'
    ) {
      return false
    }
    return true
  }

  try {
    if (store.voice.isRecording) {
      store.voice.isRecording = false
      if (currentVoiceAudioHandle) {
        await currentVoiceAudioHandle.release()
        currentVoiceAudioHandle = null
      }
    }
    if (!isStillCurrent()) {
      log(`voice-command: stop result discarded (cancelled) reason=${reason} stage=stopAudio`)
      return
    }

    const elapsedMs = Date.now() - store.voice.startedAt
    log(`voice-command: 停止 reason=${reason} gen=${gen} elapsed=${elapsedMs}ms bytes=${store.voice.audioTotalBytes}`)

    if (store.voice.audioTotalBytes === 0) {
      log('voice-command: 録音内容なし → idle')
      await returnToIdleFromVoiceCommand('empty-audio')
      return
    }

    const chunks = store.voice.audioChunks
    try {
      const stt = await transcribePcmChunks(chunks)
      if (!isStillCurrent()) {
        log(`voice-command: stop result discarded (cancelled) reason=${reason} stage=stt`)
        return
      }
      const text = (stt.text ?? '').trim()
      log(`voice-command STT完了: provider=${stt.provider} text="${text}"`)

      if (!text) {
        log('voice-command: STT空 → idle (送信せず)')
        await returnToIdleFromVoiceCommand('empty-stt')
        return
      }

      store.voice.finalText = text
      notifState.screen = 'voice-command-confirm'
      await glassesUI.showVoiceCommandConfirm(connection, text)
      if (!isStillCurrent()) {
        log(`voice-command: stop result discarded (cancelled) reason=${reason} stage=confirm-render`)
        return
      }
      updateNotifInfo()
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      log(`voice-command STT失敗: ${msg}`)
      if (store.voice.generation !== gen) {
        log('voice-command: STT失敗の表示をキャンセル (gen mismatch)')
        return
      }
      notifState.screen = 'voice-command-done'
      await glassesUI.showVoiceCommandDone(connection, false)
      if (store.voice.generation !== gen) {
        log('voice-command: STT失敗の表示後 gen mismatch → idle 維持')
        return
      }
      updateNotifInfo()
      scheduleVoiceCommandDoneReturn()
    }
  } finally {
    store.voice.stopInFlight = false
  }
}

async function cancelVoiceCommandRecording(reason: string) {
  if (!connection) return
  // 進行中の stop / send が await 後に状態を上書きできないよう世代を進める。
  store.voice.generation++
  clearVoiceCommandRecordingMaxTimer()
  if (store.voice.isRecording) {
    store.voice.isRecording = false
    if (currentVoiceAudioHandle) {
      try {
        await currentVoiceAudioHandle.release()
      } catch (err) {
        log(`voice-command stopAudio失敗: ${err instanceof Error ? err.message : String(err)}`)
      }
      currentVoiceAudioHandle = null
    }
  }
  store.voice.audioChunks = []
  store.voice.audioTotalBytes = 0
  store.voice.finalText = ''
  log(`voice-command: キャンセル reason=${reason}`)
  await returnToIdleFromVoiceCommand(reason)
}

async function returnToIdleFromVoiceCommand(reason: string) {
  if (!connection) return
  clearVoiceCommandDoneTimer()
  notifState.screen = 'idle'
  await glassesUI.showIdleLauncher(connection, { dimMode: appConfig.notificationIdleDimMode })
  updateNotifInfo()
  log(`voice-command → idle (${reason})`)
}

function scheduleVoiceCommandDoneReturn() {
  clearVoiceCommandDoneTimer()
  store.voice.doneTimer = setTimeout(() => {
    store.voice.doneTimer = null
    void returnToIdleFromVoiceCommand('done-timeout')
  }, VOICE_COMMAND_DONE_AUTO_RETURN_MS)
}

async function sendVoiceCommandAndShowResult() {
  if (!connection) return
  const text = store.voice.finalText
  if (!text) {
    await returnToIdleFromVoiceCommand('empty-text-send')
    return
  }
  // entry 時に世代をキャプチャ。store.voice.sendCancelled も併用するが、こちらは
  // 全キャンセル経路（cancel/start 再起動）を網羅する一般化されたガード。
  const gen = store.voice.generation
  // 新規送信開始時にキャンセルフラグをリセット
  store.voice.sendCancelled = false
  notifState.screen = 'voice-command-sending'
  await glassesUI.showVoiceCommandSending(connection)
  if (store.voice.generation !== gen) {
    log('voice-command: send result discarded (cancelled) stage=sending-render')
    return
  }
  updateNotifInfo()

  let ok = false
  try {
    const res = await notifClient.sendCommand({ source: 'g2_voice', text })
    ok = !!res?.ok
    log(`voice-command 送信完了: ok=${ok} delivered_at=${res?.delivered_at ?? '-'} relay=${res?.relay ?? '-'}`)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    log(`voice-command 送信失敗: ${msg}`)
    ok = false
  }

  // await 中にユーザーが double-tap で強制 idle 復帰していたら結果画面をスキップ
  if (
    store.voice.generation !== gen ||
    notifState.screen !== 'voice-command-sending' ||
    store.voice.sendCancelled
  ) {
    log('voice-command: send result discarded (user cancelled)')
    return
  }

  notifState.screen = 'voice-command-done'
  await glassesUI.showVoiceCommandDone(connection, ok)
  if (store.voice.generation !== gen) {
    log('voice-command: done render後 gen mismatch → 自動復帰スキップ')
    return
  }
  updateNotifInfo()
  scheduleVoiceCommandDoneReturn()
}

function queuePendingNotifEvent(conn: BridgeConnection, event: EvenHubEvent) {
  store.eventQueue.pendingNotifEvent = event
  if (store.eventQueue.pendingNotifEventFlushTimer) return
  store.eventQueue.pendingNotifEventFlushTimer = setTimeout(() => {
    store.eventQueue.pendingNotifEventFlushTimer = null
    if (isAnyRendering() || store.eventQueue.notifEventInFlight || !store.eventQueue.pendingNotifEvent) {
      if (store.eventQueue.pendingNotifEvent) queuePendingNotifEvent(conn, store.eventQueue.pendingNotifEvent)
      return
    }
    const nextEvent = store.eventQueue.pendingNotifEvent
    store.eventQueue.pendingNotifEvent = null
    void handleNotifEvent(conn, nextEvent)
  }, 120)
}

function shouldIgnoreDetailScroll(eventType: number | undefined): boolean {
  if (eventType !== G2_EVENT.SCROLL_TOP && eventType !== G2_EVENT.SCROLL_BOTTOM) return false
  const now = Date.now()
  if ((now - store.eventQueue.lastTapEventAt) < TAP_SCROLL_SUPPRESS_MS) {
    log('[event] detail scroll suppressed: tap直後')
    return true
  }
  if ((now - store.eventQueue.lastDetailScrollAt) < DETAIL_SCROLL_COOLDOWN_MS) {
    log('[event] detail scroll suppressed: cooldown')
    return true
  }
  store.eventQueue.lastDetailScrollAt = now
  return false
}

// G2イベントリスナーを接続に登録（再接続時は新しい eventHandlers 配列になるため再登録が必要）
function ensureNotifEventHandler(conn: BridgeConnection) {
  if (store.dashboard.notifEventRegisteredFor === conn) return
  conn.onEvent((event) => {
      void handleNotifEvent(conn, event)
  })
  store.dashboard.notifEventRegisteredFor = conn
}

async function handleNotifEvent(conn: BridgeConnection, event: EvenHubEvent) {
  if (store.eventQueue.notifEventInFlight) {
    queuePendingNotifEvent(conn, event)
    return
  }
  store.eventQueue.notifEventInFlight = true
  try {
      if (!connection) return
      const normalized = normalizeHubEvent(event)
      if (normalized.kind === 'unknown') {
        log(
          `[event] ignored unknown screen=${notifState.screen} text=${JSON.stringify(event.textEvent)} list=${JSON.stringify(event.listEvent)} sys=${JSON.stringify(event.sysEvent)}`,
        )
        return
      }
      store.dashboard.lastG2UserEventAt = Date.now()
      const eventType = normalized.eventType
      if (normalized.kind === 'tap' || normalized.kind === 'doubleTap') {
        store.eventQueue.lastTapEventAt = Date.now()
      }

      // idle画面: 単タップ=音声コマンド開始 / 二連タップ or SDK DOUBLE_CLICK=通知一覧
      if (notifState.screen === 'idle') {
        const now = Date.now()
        const isDoubleTapEvent = isDoubleTapEventType(eventType)
        const isTapLikeEvent = normalized.kind === 'tap' || normalized.kind === 'doubleTap'
        const isRapidTap = isTapLikeEvent && (now - store.idle.lastIdleEventAt) < IDLE_DOUBLE_TAP_WINDOW_MS
        if (now < store.idle.idleOpenBlockedUntil) {
          if (isTapLikeEvent) {
            log(`[event] idle open suppressed: cooldown remaining=${store.idle.idleOpenBlockedUntil - now}ms`)
            store.idle.lastIdleEventAt = now
          }
          return
        }
        if (isTapLikeEvent) store.idle.lastIdleEventAt = now
        if (isAnyRendering()) {
          if (!isTapLikeEvent) return
          store.idle.idleTapDuringRender = true
          log(`[event] idle描画中 (保留フラグON)`)
          return
        }

        // 二連タップ判定
        const treatedAsDouble = store.idle.idleTapDuringRender || isDoubleTapEvent || isRapidTap
        store.idle.idleTapDuringRender = false
        log(`[event] screen=idle eventType=${eventType} rapid=${isRapidTap} double=${treatedAsDouble}`)

        if (treatedAsDouble) {
          // 連打: 一覧表示 — 直前の single-tap 待機をキャンセル
          cancelPendingIdleSingleTap()
          if (notifState.items.length === 0) {
            log('通知がありません。先に取得してください。')
            return
          }
          store.idle.lastIdleEventAt = 0
          notifState.screen = 'list'
          notifState.selectedIndex = 0
          await glassesUI.showNotificationList(connection!, notifState.items)
          updateNotifInfo()
          log('待機画面から通知一覧を表示 (double tap)')
          return
        }

        if (!isTapLikeEvent) return
        // 単タップ: voice-command 録音を IDLE_DOUBLE_TAP_WINDOW_MS 後に開始（連打の猶予）
        if (store.reply.isRecording || store.voice.isRecording || store.reply.stopInFlight || store.voice.stopInFlight) {
          log('[event] idle single tap ignored: 既に録音中')
          return
        }
        if (store.idle.singleTapTimer) return
        store.idle.singleTapTimer = setTimeout(() => {
          store.idle.singleTapTimer = null
          if (notifState.screen !== 'idle') return
          if (store.reply.isRecording || store.voice.isRecording || store.reply.stopInFlight || store.voice.stopInFlight) {
            log('voice-command: 開始キャンセル (録音中)')
            return
          }
          if (isAnyRendering()) {
            log('voice-command: 開始キャンセル (描画中)')
            return
          }
          void startVoiceCommandRecording()
        }, IDLE_DOUBLE_TAP_WINDOW_MS)
        return
      }

      if (isAnyRendering()) {
        log('[event] 描画中のため保留')
        queuePendingNotifEvent(conn, event)
        return
      }

      log(
        `[event] screen=${notifState.screen} eventType=${eventType} text=${JSON.stringify(event.textEvent)} list=${JSON.stringify(event.listEvent)} sys=${JSON.stringify(event.sysEvent)}`,
      )

      if (notifState.screen === 'list') {
        if (isDoubleTapEventType(eventType)) {
          await enterIdleScreen('通知一覧を閉じて待機に戻る (double tap)')
          return
        }

        // SDK標準ListContainer: listEventからクリック選択を取得
        // ※実機ではスクロール方向が物理操作と逆（ファームウェア仕様、許容）
        if (normalized.source === 'list') {
          if (normalized.containerName !== 'notif-list') return
          const maybeIndex = typeof normalized.index === 'number'
            ? normalized.index
            : notifState.selectedIndex
          if (typeof maybeIndex !== 'number') {
            log('通知一覧: index未同梱イベントのため無視')
            return
          }
          const index = maybeIndex
          notifState.selectedIndex = index
          const item = notifState.items[index]
          if (!item) return
          log(`通知選択: "${item.title}" (index=${notifState.selectedIndex})`)
          try {
            const detail = await notifClient.detail(item.id)
            notifState.detailItem = detail

            // AskUserQuestion: 詳細画面をスキップして選択肢画面へ直接遷移
            if (isAskUserQuestionNotification(detail)) {
              const questions = extractAskQuestions(detail)
              if (questions.length > 0) {
                notifState.askQuestions = questions
                notifState.askQuestionIndex = 0
                notifState.askAnswers = {}
                notifState.screen = 'ask-question'
                await glassesUI.showAskUserQuestion(connection!, questions[0], 0, questions.length)
                clearPendingScrollEvent()
                updateNotifInfo()
                return
              }
            }

            const pageCount = glassesUI.getDetailPageCount(detail.fullText)
            notifState.detailPages = Array.from({ length: pageCount }, (_, i) => String(i))
            notifState.detailPageIndex = 0
            notifState.screen = 'detail'
            await glassesUI.showNotificationDetail(connection!, detail, 0, pageCount, getContextPctForNotification(detail))
            // 描画中（createStartUpフォールバックで数秒かかる）にキューされたスクロールイベントを破棄
            // tap/doubleTap等の非スクロールイベントは保持する
            clearPendingScrollEvent()
            store.eventQueue.lastDetailScrollAt = Date.now()
            updateNotifInfo()
          } catch (err) {
            log(`通知詳細取得失敗: ${err instanceof Error ? err.message : String(err)}`)
          }
        }
      } else if (notifState.screen === 'detail') {
        // 詳細画面: スクロールでページ送り＋画面遷移
        if (!notifState.detailItem) return
        // ghostリストコンテナからのイベントを無視（detail画面ではtextEventとsysEventのみ有効）
        if (normalized.source === 'list') return
        // detailPages は showNotificationDetail() で都度算出される（ここでは長さのみ参照）
        const pageCount = notifState.detailPages.length
        if (isDoubleTapEventType(eventType)) {
          log('通知詳細: double tap → リストに戻る')
          notifState.screen = 'list'
          notifState.detailItem = null
          notifState.selectedIndex = 0
          await glassesUI.showNotificationList(connection!, notifState.items)
          updateNotifInfo()
          return
        }
        if (shouldIgnoreDetailScroll(eventType)) return

        // 一覧画面と同じく、実機の逆方向スクロール挙動をそのまま許容する。
        // eventType=1 (物理下) → 前ページ / 最初のページで更に戻る → リストに戻る
        // eventType=2 (物理上) → 次ページ / 最終ページで更に進む → アクションメニュー
        if (eventType === G2_EVENT.SCROLL_TOP) {
          if (notifState.detailPageIndex > 0) {
            notifState.detailPageIndex--
            await glassesUI.showNotificationDetail(
              connection!, notifState.detailItem, notifState.detailPageIndex, pageCount, getContextPctForNotification(notifState.detailItem),
            )
            // 描画完了後にスクロールイベントのみクリア＋クールダウン更新（誤発火を防止）
            clearPendingScrollEvent()
            store.eventQueue.lastDetailScrollAt = Date.now()
          } else {
            log('通知詳細: 最初のページ → リストに戻る')
            notifState.screen = 'list'
            notifState.detailItem = null
            notifState.selectedIndex = 0
            await glassesUI.showNotificationList(connection!, notifState.items)
          }
          updateNotifInfo()
          return
        }

        // eventType=2 → 次ページ / 最終ページで更に進む → アクションメニュー
        if (eventType === G2_EVENT.SCROLL_BOTTOM) {
          if (notifState.detailPageIndex < pageCount - 1) {
            notifState.detailPageIndex++
            await glassesUI.showNotificationDetail(
              connection!, notifState.detailItem, notifState.detailPageIndex, pageCount, getContextPctForNotification(notifState.detailItem),
            )
            // 描画完了後にスクロールイベントのみクリア＋クールダウン更新（誤発火を防止）
            clearPendingScrollEvent()
            store.eventQueue.lastDetailScrollAt = Date.now()
          } else if (notifState.detailItem.replyCapable) {
            log('通知詳細: 最終ページ → アクションメニュー')
            notifState.screen = 'detail-actions'
            await glassesUI.showNotificationActions(connection!, notifState.detailItem)
          }
          updateNotifInfo()
          return
        }
      } else if (notifState.screen === 'detail-actions') {
        if (!notifState.detailItem) return

        // SDK標準ListContainer: listEventからクリック選択を取得
        if (normalized.source === 'list') {
          const index = normalized.index ?? 0

          // ◀ 戻る (index=3)
          if (index === 3) {
            log('通知アクション: 一覧に戻る')
            notifState.screen = 'list'
            notifState.detailItem = null
            notifState.selectedIndex = 0
            await glassesUI.showNotificationList(connection!, notifState.items)
            updateNotifInfo()
            return
          }

          if (index === 1 || index === 2) {
            // Approve(1) or Deny(2)
            const action = index === 1 ? 'approve' : 'deny'
            log(`通知アクション送信: ${action} notificationId=${notifState.detailItem.id}`)
            notifState.screen = 'reply-sending'
            updateNotifInfo()
            try {
              const res = await notifClient.reply(notifState.detailItem.id, {
                action,
                source: 'g2',
              })
              const status = res.reply?.status || 'ok'
              const result = getReplyResultMessage(res)
              log(`通知アクション送信完了: action=${action} status=${status}`)
              // await 中にユーザー操作でリストに戻っていたら結果画面をスキップ
              if (notifState.screen === 'reply-sending') {
                if (result.ok) {
                  await glassesUI.showReplyResult(connection!, true, action === 'approve' ? 'Approve' : 'Deny')
                } else {
                  await glassesUI.showReplyResult(connection!, false, result.message || status)
                }
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err)
              log(`通知アクション送信失敗: action=${action} ${msg}`)
              if (notifState.screen === 'reply-sending') {
                await glassesUI.showReplyResult(connection!, false, msg)
              }
            }
            setTimeout(() => returnToListFromResult(), 3000)
            return
          }

          if (index === 0) {
            // コメント
            log('通知アクション: コメント（録音開始）')
            notifState.screen = 'reply-recording'
            notifState.replyText = ''

            await glassesUI.showReplyRecording(connection!)

            if (connection!.mode === 'bridge' && !glassesUI.hasRenderedPage(connection!)) {
              await glassesUI.ensureBasePage(connection!, 'マイク録音中...')
            }
            await startReplyAudioRecording()
            updateNotifInfo()
            return
          }
        }
      } else if (notifState.screen === 'ask-question') {
        // AskUserQuestion 選択肢画面
        if (!notifState.detailItem) return

        if (isDoubleTapEventType(eventType)) {
          log('AskUserQuestion: double tap → リストに戻る')
          notifState.screen = 'list'
          notifState.detailItem = null
          notifState.askQuestions = []
          notifState.askQuestionIndex = 0
          notifState.askAnswers = {}
          await glassesUI.showNotificationList(connection!, notifState.items)
          updateNotifInfo()
          return
        }

        if (normalized.source === 'list') {
          if (normalized.containerName !== 'ask-q-lst') return
          const index = normalized.index ?? 0
          const currentQ = notifState.askQuestions[notifState.askQuestionIndex]
          if (!currentQ) return
          const optionCount = currentQ.options.length
          // optionCount+0: 「その他（音声）」, optionCount+1: 「◀ 戻る」

          if (index === optionCount + 1) {
            // ◀ 戻る
            log('AskUserQuestion: 戻る → リスト')
            notifState.screen = 'list'
            notifState.detailItem = null
            notifState.askQuestions = []
            notifState.askQuestionIndex = 0
            notifState.askAnswers = {}
            await glassesUI.showNotificationList(connection!, notifState.items)
            updateNotifInfo()
            return
          }

          if (index === optionCount) {
            // その他（音声入力）→ 録音画面へ
            log('AskUserQuestion: その他（音声入力）')
            notifState.screen = 'reply-recording'
            notifState.replyText = ''
            await glassesUI.showReplyRecording(connection!)
            if (connection!.mode === 'bridge' && !glassesUI.hasRenderedPage(connection!)) {
              await glassesUI.ensureBasePage(connection!, 'マイク録音中...')
            }
            await startReplyAudioRecording()
            updateNotifInfo()
            return
          }

          if (index < optionCount) {
            // 選択肢を選んだ
            const selectedLabel = currentQ.options[index].label
            notifState.askAnswers[currentQ.question] = selectedLabel
            log(`AskUserQuestion: 選択 "${selectedLabel}" for "${currentQ.question}"`)

            // 次の質問があるか？
            if (notifState.askQuestionIndex < notifState.askQuestions.length - 1) {
              notifState.askQuestionIndex++
              const nextQ = notifState.askQuestions[notifState.askQuestionIndex]
              await glassesUI.showAskUserQuestion(connection!, nextQ, notifState.askQuestionIndex, notifState.askQuestions.length)
              updateNotifInfo()
              return
            }

            // 全質問に回答完了 → Hub に送信
            log(`AskUserQuestion: 全質問回答完了 answers=${JSON.stringify(notifState.askAnswers)}`)
            notifState.screen = 'reply-sending'
            updateNotifInfo()
            try {
              const res = await notifClient.reply(notifState.detailItem.id, {
                action: 'answer',
                answerData: notifState.askAnswers,
                source: 'g2',
              })
              const result = getReplyResultMessage(res)
              log(`AskUserQuestion: 送信完了 status=${res.reply?.status || 'ok'}`)
              if (notifState.screen === 'reply-sending') {
                if (result.ok) {
                  await glassesUI.showReplyResult(connection!, true, `回答: ${selectedLabel}`)
                } else {
                  await glassesUI.showReplyResult(connection!, false, result.message || 'error')
                }
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err)
              log(`AskUserQuestion: 送信失敗 ${msg}`)
              if (notifState.screen === 'reply-sending') {
                await glassesUI.showReplyResult(connection!, false, msg)
              }
            }
            setTimeout(() => returnToListFromResult(), 3000)
            return
          }
        }
      } else if (notifState.screen === 'reply-recording') {
        // 録音中画面:
        // - 単タップ相当は sysEvent {} とノイズが区別できないため使わない
        // - DOUBLE_CLICK を確実な停止入力として扱う
        if (isDoubleTapEventType(eventType)) {
          if (!store.reply.isRecording || store.reply.stopInFlight) {
            log('返信録音: 重複停止イベントを無視')
            return
          }
          store.reply.stopInFlight = true
          log('返信録音: 停止 → STT処理開始')
          await stopReplyAudioRecording()

          await glassesUI.showReplySttProcessing(connection!)

          if (store.reply.audioTotalBytes === 0) {
            log('返信録音: 音声データなし → 前画面に戻る')
            if (notifState.detailItem && isAskUserQuestionNotification(notifState.detailItem) && notifState.askQuestions.length > 0) {
              notifState.screen = 'ask-question'
              const q = notifState.askQuestions[notifState.askQuestionIndex]
              await glassesUI.showAskUserQuestion(connection!, q, notifState.askQuestionIndex, notifState.askQuestions.length)
            } else {
              notifState.screen = 'detail-actions'
              if (notifState.detailItem) {
                await glassesUI.showNotificationActions(connection!, notifState.detailItem)
              }
            }
            updateNotifInfo()
            store.reply.stopInFlight = false
            return
          }

          try {
            const stt = await transcribePcmChunks(store.reply.audioChunks)
            const text = stt.text || ''
            log(`返信STT完了: provider=${stt.provider} text="${text}"`)

            if (!text) {
              log('返信STT: テキスト空 → 前画面に戻る')
              if (notifState.detailItem && isAskUserQuestionNotification(notifState.detailItem) && notifState.askQuestions.length > 0) {
                notifState.screen = 'ask-question'
                const q = notifState.askQuestions[notifState.askQuestionIndex]
                await glassesUI.showAskUserQuestion(connection!, q, notifState.askQuestionIndex, notifState.askQuestions.length)
              } else {
                notifState.screen = 'detail-actions'
                if (notifState.detailItem) {
                  await glassesUI.showNotificationActions(connection!, notifState.detailItem)
                }
              }
              updateNotifInfo()
              store.reply.stopInFlight = false
              return
            }

            notifState.replyText = text
            notifState.screen = 'reply-confirm'
            await glassesUI.showReplyConfirm(connection!, text)
            updateNotifInfo()
            store.reply.stopInFlight = false
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err)
            log(`返信STT失敗: ${msg}`)
            await glassesUI.showReplyResult(connection!, false, msg)
            // 3秒後に前画面に戻る
            setTimeout(async () => {
              if (notifState.detailItem && connection && isAskUserQuestionNotification(notifState.detailItem) && notifState.askQuestions.length > 0) {
                notifState.screen = 'ask-question'
                const q = notifState.askQuestions[notifState.askQuestionIndex]
                await glassesUI.showAskUserQuestion(connection, q, notifState.askQuestionIndex, notifState.askQuestions.length)
              } else {
                notifState.screen = 'detail-actions'
                if (notifState.detailItem && connection) {
                  await glassesUI.showNotificationActions(connection, notifState.detailItem)
                }
              }
              updateNotifInfo()
              store.reply.stopInFlight = false
            }, 3000)
          }
          return
        }

        // スクロール入力はキャンセル → 前画面に戻る
        if (eventType === G2_EVENT.SCROLL_TOP || eventType === G2_EVENT.SCROLL_BOTTOM) {
          log('返信録音: キャンセル → 前画面に戻る')
          await stopReplyAudioRecording()
          if (notifState.detailItem && isAskUserQuestionNotification(notifState.detailItem) && notifState.askQuestions.length > 0) {
            notifState.screen = 'ask-question'
            const q = notifState.askQuestions[notifState.askQuestionIndex]
            await glassesUI.showAskUserQuestion(connection!, q, notifState.askQuestionIndex, notifState.askQuestions.length)
          } else {
            notifState.screen = 'detail-actions'
            if (notifState.detailItem) {
              await glassesUI.showNotificationActions(connection!, notifState.detailItem)
            }
          }
          updateNotifInfo()
          store.reply.stopInFlight = false
          return
        }
      } else if (notifState.screen === 'reply-confirm') {
        // SDK標準ListContainer: listEventからクリック選択を取得
        if (normalized.source === 'list') {
          const index = normalized.index ?? 0

          if (index === 0) {
            // 送信
            if (!notifState.detailItem || !notifState.replyText) return
            log(`返信送信: notificationId=${notifState.detailItem.id}`)
            notifState.screen = 'reply-sending'
            try {
              // AskUserQuestion の「その他（音声）」経由の場合は answer として送信
              const isAskQ = isAskUserQuestionNotification(notifState.detailItem)
              const replyReq = isAskQ
                ? {
                    action: 'answer' as const,
                    answerData: {
                      ...notifState.askAnswers,
                      [notifState.askQuestions[notifState.askQuestionIndex]?.question ?? '']: notifState.replyText,
                    },
                    source: 'g2' as const,
                  }
                : {
                    action: 'comment' as const,
                    comment: notifState.replyText,
                    source: 'g2' as const,
                  }
              const res = await notifClient.reply(notifState.detailItem.id, replyReq)
              const status = res.reply?.status || 'ok'
              const result = getReplyResultMessage(res)
              log(`返信送信完了: status=${status}`)
              // await 中にユーザー操作でリストに戻っていたら結果画面をスキップ
              if (notifState.screen === 'reply-sending') {
                if (result.ok) {
                  await glassesUI.showReplyResult(connection!, true)
                } else {
                  await glassesUI.showReplyResult(connection!, false, result.message || status)
                }
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err)
              log(`返信送信失敗: ${msg}`)
              if (notifState.screen === 'reply-sending') {
                await glassesUI.showReplyResult(connection!, false, msg)
              }
            }
            // 3秒後に一覧に戻る（ユーザー操作で先に戻った場合はスキップ）
            setTimeout(() => returnToListFromResult(), 3000)
            return
          }

          if (index === 1) {
            // 再録
            log('返信確認: 再録')
            notifState.screen = 'reply-recording'
            notifState.replyText = ''
            await glassesUI.showReplyRecording(connection!)
            await startReplyAudioRecording()
            updateNotifInfo()
            return
          }

          if (index === 2 || index === 3) {
            // キャンセル / ◀ 戻る → 前画面に戻る
            log(`返信確認: ${index === 2 ? 'キャンセル' : '戻る'} → 前画面に戻る`)
            notifState.replyText = ''
            if (notifState.detailItem && isAskUserQuestionNotification(notifState.detailItem) && notifState.askQuestions.length > 0) {
              notifState.screen = 'ask-question'
              const q = notifState.askQuestions[notifState.askQuestionIndex]
              await glassesUI.showAskUserQuestion(connection!, q, notifState.askQuestionIndex, notifState.askQuestions.length)
            } else {
              notifState.screen = 'detail-actions'
              if (notifState.detailItem) {
                await glassesUI.showNotificationActions(connection!, notifState.detailItem)
              }
            }
            updateNotifInfo()
            return
          }
        }
      } else if (notifState.screen === 'reply-sending') {
        // 送信結果画面: 任意の操作（タップ/スワイプ）で即座にリスト一覧に戻る
        log('結果画面: ユーザー操作で即座に復帰')
        await returnToListFromResult()
      } else if (notifState.screen === 'voice-command-recording') {
        // 単タップ=停止/送信, 二連タップ=キャンセル
        if (isDoubleTapEventType(eventType)) {
          await cancelVoiceCommandRecording('user-cancel')
          return
        }
        if (normalized.kind === 'tap') {
          await stopVoiceCommandRecording('user-tap')
          return
        }
      } else if (notifState.screen === 'voice-command-confirm') {
        if (isDoubleTapEventType(eventType)) {
          log('voice-command: 確認画面 → キャンセル')
          store.voice.generation++
          store.voice.finalText = ''
          await returnToIdleFromVoiceCommand('user-cancel-confirm')
          return
        }
        if (normalized.kind === 'tap') {
          await sendVoiceCommandAndShowResult()
          return
        }
      } else if (notifState.screen === 'voice-command-sending') {
        // 送信中: double-tap のみ "force return to idle" として受け付ける
        // (15s relay timeout に張り付くのを避けるための退避経路)
        if (isDoubleTapEventType(eventType)) {
          log('voice-command: 送信中に double tap → 強制 idle 復帰')
          cancelPendingIdleSingleTap()
          store.voice.sendCancelled = true
          store.voice.generation++
          await returnToIdleFromVoiceCommand('user-cancel-during-send')
          return
        }
        log('voice-command: 送信中の入力を無視')
      } else if (notifState.screen === 'voice-command-done') {
        clearVoiceCommandDoneTimer()
        await returnToIdleFromVoiceCommand('user-tap-done')
      }
  } finally {
    store.eventQueue.notifEventInFlight = false
    if (store.eventQueue.pendingNotifEvent && !isAnyRendering()) {
      queuePendingNotifEvent(conn, store.eventQueue.pendingNotifEvent)
    }
  }
}

document.getElementById('notif-show-g2-btn')!.addEventListener('click', async () => {
  if (!connection) {
    log('未接続です。先にConnectしてください。')
    return
  }
  if (notifState.items.length === 0) {
    log('通知がありません。先に取得してください。')
    return
  }

  ensureNotifEventHandler(connection)
  // idle画面で待機中の single-tap タイマーがあればキャンセルしてから list へ遷移する
  cancelPendingIdleSingleTap()
  notifState.screen = 'list'
  notifState.selectedIndex = 0
  await glassesUI.showNotificationList(connection, notifState.items)
  startNotificationPolling()
  updateNotifInfo()
})

updateDashboard()
