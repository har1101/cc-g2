/**
 * Notification list / dashboard polling controller (Phase 1.5c).
 *
 * 旧 main.ts に直接書かれていた:
 *  - `fetchContextStatus`
 *  - `flushPendingNotificationUi`
 *  - `startNotificationPolling`
 *  - `updateNotifInfo`
 *  - dashboard / 通知 list の DOM update
 *  - `notif-fetch-btn` / `notif-show-g2-btn` のイベントリスナー
 *
 * を 1 ファイルに集約。 動作は完全同等。 main.ts は `wireNotificationController(deps)`
 * で配線するだけ。
 */

import type { BridgeConnection } from './bridge'
import type { NotificationUIState } from './glasses-ui'
import type { GlassesUI } from './screens/types'
import type { createNotificationClient, NotificationItem } from './notifications'
import { appConfig, createHubHeaders } from './config'
import { store, type ContextSession, cancelIdleSingleTapTimer } from './state/store'

export type NotificationControllerDeps = {
  getConnection: () => BridgeConnection | null
  glassesUI: GlassesUI
  notifClient: ReturnType<typeof createNotificationClient>
  log: (msg: string) => void
  /** glasses-ui or render-queue が進行中なら true */
  isAnyRendering: () => boolean
  /** ensureNotifEventHandler 相当 (再接続時のハンドラ再登録) */
  ensureNotifEventHandler: (conn: BridgeConnection) => void
}

export type NotificationController = {
  fetchContextStatus(): Promise<void>
  flushPendingNotificationUi(reason: string): Promise<void>
  startNotificationPolling(): void
  updateNotifInfo(): void
  /** main.ts から呼び出す: dashboard pill を再描画 */
  updateDashboard(): void
  /** 個別 pill (例: 接続中... / 接続失敗) の手動更新 */
  setConnectionPill(text: string, tone: 'neutral' | 'ok' | 'warn' | 'error'): void
}

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
    case 'voice-command-recording-streaming': return 'vc-rec-s'
    case 'voice-command-confirm': return 'vc-conf'
    case 'voice-command-sending': return 'vc-send'
    case 'voice-command-done': return 'vc-done'
    case 'session-list': return 'sessions'
    case 'session-list-create-confirm': return 'sess-new'
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

function setPill(id: string, text: string, tone: 'neutral' | 'ok' | 'warn' | 'error' = 'neutral') {
  const el = document.getElementById(id)
  if (!el) return
  el.textContent = text
  el.className = `status-pill ${tone}`
}

function canAutoOpenForScreen(screen: NotificationUIState['screen']): boolean {
  // 録音/送信/voice-command/SessionList 中は割り込まない。
  // 他の画面では新着優先で一覧へ寄せる。
  return (
    screen !== 'reply-recording' &&
    screen !== 'reply-confirm' &&
    screen !== 'reply-sending' &&
    screen !== 'ask-question' &&
    screen !== 'voice-command-recording' &&
    screen !== 'voice-command-recording-streaming' &&
    screen !== 'voice-command-confirm' &&
    screen !== 'voice-command-sending' &&
    screen !== 'voice-command-done' &&
    screen !== 'session-list' &&
    screen !== 'session-list-create-confirm'
  )
}

export function createNotificationController(deps: NotificationControllerDeps): NotificationController {
  const { getConnection, glassesUI, notifClient, log, isAnyRendering, ensureNotifEventHandler } = deps
  const notifState = store.notif

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
    const conn = getConnection()
    const g2Tone = conn ? 'ok' : 'neutral'
    const g2Text = conn ? (conn.mode === 'bridge' ? '接続済み (Bridge)' : '接続済み (Mock)') : '未接続'
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

  async function flushPendingNotificationUi(reason: string) {
    const conn = getConnection()
    if (!conn || isAnyRendering()) return

    if (store.dashboard.pendingAutoOpenOnNew && appConfig.notificationAutoOpenOnNew && canAutoOpenForScreen(notifState.screen)) {
      // idle画面で待機中の single-tap タイマーがあればキャンセルしてから list へ遷移する
      cancelIdleSingleTapTimer()
      notifState.screen = 'list'
      notifState.selectedIndex = 0
      await glassesUI.showNotificationList(conn, notifState.items)
      store.dashboard.pendingAutoOpenOnNew = false
      log(`通知自動更新: ${notifState.items.length}件 (保留中の自動表示を再試行して成功 reason=${reason})`)
      return
    }

    if (store.dashboard.pendingListRefresh && notifState.screen === 'list') {
      await glassesUI.showNotificationList(conn, notifState.items)
      store.dashboard.pendingListRefresh = false
      log(`通知自動更新: ${notifState.items.length}件 (保留中のリスト更新を再試行して成功 reason=${reason})`)
    }
  }

  function startNotificationPolling() {
    if (store.dashboard.notifPollingStarted) return
    store.dashboard.notifPollingStarted = true
    log(`通知ポーリング開始: interval=${appConfig.notificationPollIntervalMs}ms autoOpen=${appConfig.notificationAutoOpenOnNew ? 'on' : 'off'}`)
    setInterval(async () => {
      const conn = getConnection()
      if (!conn) return
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
          cancelIdleSingleTapTimer()
          notifState.screen = 'list'
          notifState.selectedIndex = 0
          await glassesUI.showNotificationList(conn, items)
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
          await glassesUI.showNotificationList(conn, items)
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
    } else if (notifState.screen === 'session-list') {
      const sessions = store.sessionList.sessions
      const lines = ['[SessionList]', '0> ↓ Pull to create new']
      sessions.forEach((s, i) => {
        const sel = i + 1 === store.sessionList.selectedIndex ? '>' : ' '
        lines.push(`${sel}${i + 1} ${s.label} [${s.status}]`)
      })
      lines.push('Tap=open / DblTap=back / Pull=create')
      infoEl.textContent = lines.join('\n')
    } else if (notifState.screen === 'session-list-create-confirm') {
      const choices = store.sessionList.projects.filter((p) => p.project_id !== '_unmanaged')
      const cur = choices[store.sessionList.selectedProjectIndex]
      infoEl.textContent = [
        '[Create new session]',
        cur ? `→ ${cur.label} (${cur.default_backend})` : '(no projects)',
        `${choices.length === 0 ? 0 : store.sessionList.selectedProjectIndex + 1}/${choices.length}`,
        'Swipe=cycle / Tap=Create / DblTap=Cancel',
      ].join('\n')
    }
    updateDashboard()
  }

  // --- DOM event listeners (notif-fetch-btn / notif-show-g2-btn) ---
  const fetchBtn = document.getElementById('notif-fetch-btn')
  if (fetchBtn) {
    fetchBtn.addEventListener('click', async () => {
      const conn = getConnection()
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
          if (conn && !isAnyRendering()) {
            await glassesUI.showIdleLauncher(conn, { dimMode: appConfig.notificationIdleDimMode })
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
  }

  const showG2Btn = document.getElementById('notif-show-g2-btn')
  if (showG2Btn) {
    showG2Btn.addEventListener('click', async () => {
      const conn = getConnection()
      if (!conn) {
        log('未接続です。先にConnectしてください。')
        return
      }
      if (notifState.items.length === 0) {
        log('通知がありません。先に取得してください。')
        return
      }

      ensureNotifEventHandler(conn)
      // idle画面で待機中の single-tap タイマーがあればキャンセルしてから list へ遷移する
      cancelIdleSingleTapTimer()
      notifState.screen = 'list'
      notifState.selectedIndex = 0
      await glassesUI.showNotificationList(conn, notifState.items)
      startNotificationPolling()
      updateNotifInfo()
    })
  }

  return {
    fetchContextStatus,
    flushPendingNotificationUi,
    startNotificationPolling,
    updateNotifInfo,
    updateDashboard,
    setConnectionPill: (text, tone) => setPill('connection-status', text, tone),
  }
}
