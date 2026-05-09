/**
 * voice-command-sending screen handler (Phase 1.5c).
 *
 * 送信中: double-tap のみ "force return to idle" として受け付ける。
 * (15s relay timeout に張り付くのを避けるための退避経路)
 * 単タップ等は無視。
 */

import type { ScreenContext } from './types'
import type { NormalizedG2Event } from '../even-events'
import { isDoubleTapEventType } from '../even-events'
import { bumpVoiceGeneration, cancelIdleSingleTapTimer } from '../state/store'

export async function handle(event: NormalizedG2Event, ctx: ScreenContext): Promise<void> {
  const eventType = event.eventType
  if (isDoubleTapEventType(eventType)) {
    ctx.log('voice-command: 送信中に double tap → 強制 idle 復帰')
    cancelIdleSingleTapTimer()
    ctx.store.voice.sendCancelled = true
    bumpVoiceGeneration()
    await ctx.returnToIdleFromVoiceCommand('user-cancel-during-send')
    return
  }
  ctx.log('voice-command: 送信中の入力を無視')
}
