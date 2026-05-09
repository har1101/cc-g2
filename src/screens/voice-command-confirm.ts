/**
 * voice-command-confirm screen handler (Phase 1.5c).
 *
 * - tap → 送信
 * - double tap → キャンセル → idle 復帰
 */

import type { ScreenContext } from './types'
import type { NormalizedG2Event } from '../even-events'
import { isDoubleTapEventType } from '../even-events'
import { bumpVoiceGeneration } from '../state/store'

export async function handle(event: NormalizedG2Event, ctx: ScreenContext): Promise<void> {
  const eventType = event.eventType
  if (isDoubleTapEventType(eventType)) {
    ctx.log('voice-command: 確認画面 → キャンセル')
    bumpVoiceGeneration()
    // Phase 2 Pass 5: late-final が届いても無視する。
    ctx.store.voice.sendOrCancelInProgress = true
    ctx.store.voice.finalText = ''
    if (ctx.store.voice.lateFinalUpdatedTimer) {
      clearTimeout(ctx.store.voice.lateFinalUpdatedTimer)
      ctx.store.voice.lateFinalUpdatedTimer = null
    }
    await ctx.returnToIdleFromVoiceCommand('user-cancel-confirm')
    return
  }
  if (event.kind === 'tap') {
    await ctx.sendVoiceCommandAndShowResult()
    return
  }
}
