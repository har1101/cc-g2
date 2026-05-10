/**
 * G2 event → screen handler dispatch glue (Phase 1.5c).
 *
 * 旧 main.ts の `handleNotifEvent` の本体ロジックを抜き出した:
 * - `notifEventInFlight` ロックで再入を防ぐ
 * - 描画中は `pendingNotifEvent` キューに退避し、 120ms 後に再評価
 * - in-flight が解けた直後に保留があれば最後の 1 件だけ処理する
 * - normalize 後に screen 別 handler に委譲
 *
 * `dispatchScreen` (= screens/index.ts) を実体に呼び分ける薄い層。 idle 画面の
 * 一連の "render-busy フラグを立てる" ロジックなども `screens/idle.ts` に移動済み。
 */

import type { EvenHubEvent } from '@evenrealities/even_hub_sdk'
import type { ScreenContext } from './types'
import { dispatchScreen } from './index'
import { normalizeHubEvent } from '../even-events'
import { store } from '../state/store'

export type DispatchDeps = {
  log: (msg: string) => void
  isAnyRendering: () => boolean
  /** ScreenContext を構築 (event 都度) */
  buildScreenContext: () => ScreenContext
}

export function createNotifEventDispatcher(deps: DispatchDeps): (event: EvenHubEvent) => Promise<void> {
  const { log, isAnyRendering, buildScreenContext } = deps

  function queuePendingNotifEvent(event: EvenHubEvent) {
    store.eventQueue.pendingNotifEvent = event
    if (store.eventQueue.pendingNotifEventFlushTimer) return
    store.eventQueue.pendingNotifEventFlushTimer = setTimeout(() => {
      store.eventQueue.pendingNotifEventFlushTimer = null
      if (isAnyRendering() || store.eventQueue.notifEventInFlight || !store.eventQueue.pendingNotifEvent) {
        if (store.eventQueue.pendingNotifEvent) queuePendingNotifEvent(store.eventQueue.pendingNotifEvent)
        return
      }
      const nextEvent = store.eventQueue.pendingNotifEvent
      store.eventQueue.pendingNotifEvent = null
      void handle(nextEvent)
    }, 120)
  }

  async function handle(event: EvenHubEvent): Promise<void> {
    if (store.eventQueue.notifEventInFlight) {
      queuePendingNotifEvent(event)
      return
    }
    store.eventQueue.notifEventInFlight = true
    try {
      // 旧 main.ts の `if (!connection) return` 相当。 ScreenContext 構築前に
      // 試行することで、 connection が消えていた場合は無音で抜ける。
      let ctx: ScreenContext
      try {
        ctx = buildScreenContext()
      } catch {
        return
      }
      const normalized = normalizeHubEvent(event)
      if (normalized.kind === 'unknown') {
        log(
          `[event] ignored unknown screen=${store.notif.screen} text=${JSON.stringify(event.textEvent)} list=${JSON.stringify(event.listEvent)} sys=${JSON.stringify(event.sysEvent)}`,
        )
        return
      }
      store.dashboard.lastG2UserEventAt = Date.now()
      const eventType = normalized.eventType
      if (normalized.kind === 'tap' || normalized.kind === 'doubleTap') {
        store.eventQueue.lastTapEventAt = Date.now()
      }

      // idle screen の "render-busy 中の保留フラグ" は idle handler 自身に責任があるが、
      // それ以外の screen で render 中なら即時保留する (旧 main.ts と同じ挙動)。
      if (store.notif.screen !== 'idle' && isAnyRendering()) {
        log('[event] 描画中のため保留')
        queuePendingNotifEvent(event)
        return
      }

      if (store.notif.screen !== 'idle') {
        log(
          `[event] screen=${store.notif.screen} eventType=${eventType} text=${JSON.stringify(event.textEvent)} list=${JSON.stringify(event.listEvent)} sys=${JSON.stringify(event.sysEvent)}`,
        )
      }

      await dispatchScreen(normalized, ctx)
    } finally {
      store.eventQueue.notifEventInFlight = false
      if (store.eventQueue.pendingNotifEvent && !isAnyRendering()) {
        queuePendingNotifEvent(store.eventQueue.pendingNotifEvent)
      }
    }
  }

  return handle
}
