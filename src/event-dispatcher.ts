/**
 * Single onEvent → screen handler dispatcher (Phase 1.5b).
 *
 * 旧 `main.ts` では `connection.onEvent(handleNotifEvent)` を初接続時に登録し、
 * `notifEventRegisteredFor` で重複登録を防いでいた。 1.5c で screen 分割を行うと
 * 「現 active な screen の handler を呼ぶ」 ように差し替える必要があるが、
 * その差し替えポイントがコード中に散らばっていると見通しが悪い。
 *
 * このモジュールは:
 * - `connection.onEvent` への登録を 1 度だけ行う (idempotent)。
 * - 受け取った EvenHubEvent をその時点の `handler` (setHandler で差し替え可能) に転送する。
 * - 1.5b 時点では handler に既存の `handleNotifEvent` をそのまま渡すので、
 *   挙動は完全に同等。 1.5c で screen 別 handler を切り替える時に活きる。
 */

import type { EvenHubEvent } from '@evenrealities/even_hub_sdk'
import type { BridgeConnection } from './bridge'

export type ScreenHandler = (event: EvenHubEvent) => void | Promise<void>

export type EventDispatcher = {
  /** 受信時に呼ばれる handler を設定する。 既存の handler は上書きされる */
  setHandler(handler: ScreenHandler | null): void
  /**
   * `conn.onEvent` に転送ハンドラを登録する。 同じ conn には 1 度だけ登録される
   * (再接続で別 conn が来たら新規登録される)。 旧 `notifEventRegisteredFor` 相当。
   */
  attach(conn: BridgeConnection): void
}

export type EventDispatcherDeps = {
  /** ロガー (handler 未設定で event が来た時の警告用) */
  log: (msg: string) => void
}

export function createEventDispatcher(deps: EventDispatcherDeps): EventDispatcher {
  let currentHandler: ScreenHandler | null = null
  let attachedConn: object | null = null

  function setHandler(handler: ScreenHandler | null) {
    currentHandler = handler
  }

  function attach(conn: BridgeConnection) {
    if (attachedConn === conn) return
    attachedConn = conn
    conn.onEvent((event) => {
      if (!currentHandler) {
        deps.log(`[event-dispatcher] event received without handler: ${JSON.stringify(event).slice(0, 120)}`)
        return
      }
      try {
        const result = currentHandler(event)
        if (result && typeof (result as Promise<void>).then === 'function') {
          ;(result as Promise<void>).catch((err) => {
            const msg = err instanceof Error ? err.message : String(err)
            deps.log(`[event-dispatcher] handler threw: ${msg}`)
          })
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        deps.log(`[event-dispatcher] handler threw (sync): ${msg}`)
      }
    })
  }

  return { setHandler, attach }
}
