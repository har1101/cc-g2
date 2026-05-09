/**
 * Idle screen handler (Phase 1.5c).
 *
 * 単タップ → IDLE_DOUBLE_TAP_WINDOW_MS 後に voice-command 録音開始
 * (ただし窓内に 2 度目のタップが来たら double tap として扱う)
 * 二連タップ → 通知一覧表示
 *
 * 動作は旧 main.ts と完全同等。 startVoiceCommandRecording 等の lifecycle は
 * `_helpers.ts` に集約済み。
 */

import type { ScreenContext } from './types'
import type { NormalizedG2Event } from '../even-events'
import { isDoubleTapEventType } from '../even-events'
import { cancelIdleSingleTapTimer } from '../state/store'
import { IDLE_DOUBLE_TAP_WINDOW_MS } from './_constants'

export async function handle(event: NormalizedG2Event, ctx: ScreenContext): Promise<void> {
  const { store, conn, glassesUI, log } = ctx
  const eventType = event.eventType
  const now = Date.now()
  const isDoubleTapEvent = isDoubleTapEventType(eventType)
  const isTapLikeEvent = event.kind === 'tap' || event.kind === 'doubleTap'
  const isRapidTap = isTapLikeEvent && (now - store.idle.lastIdleEventAt) < IDLE_DOUBLE_TAP_WINDOW_MS

  if (now < store.idle.idleOpenBlockedUntil) {
    if (isTapLikeEvent) {
      log(`[event] idle open suppressed: cooldown remaining=${store.idle.idleOpenBlockedUntil - now}ms`)
      store.idle.lastIdleEventAt = now
    }
    return
  }
  if (isTapLikeEvent) store.idle.lastIdleEventAt = now
  if (ctx.isAnyRendering()) {
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
    cancelIdleSingleTapTimer()
    if (store.notif.items.length === 0) {
      log('通知がありません。先に取得してください。')
      return
    }
    store.idle.lastIdleEventAt = 0
    store.notif.screen = 'list'
    store.notif.selectedIndex = 0
    await glassesUI.showNotificationList(conn, store.notif.items)
    ctx.updateNotifInfo()
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
    if (store.notif.screen !== 'idle') return
    if (store.reply.isRecording || store.voice.isRecording || store.reply.stopInFlight || store.voice.stopInFlight) {
      log('voice-command: 開始キャンセル (録音中)')
      return
    }
    if (ctx.isAnyRendering()) {
      log('voice-command: 開始キャンセル (描画中)')
      return
    }
    void ctx.startVoiceCommandRecording()
  }, IDLE_DOUBLE_TAP_WINDOW_MS)
}
