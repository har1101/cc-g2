/**
 * voice-command-recording screen handler (Phase 1.5c).
 *
 * - tap → 停止 → STT → 結果に応じて voice-command-confirm / voice-command-done
 * - double tap → キャンセル → idle 復帰
 */

import type { ScreenContext } from './types'
import type { NormalizedG2Event } from '../even-events'
import { isDoubleTapEventType } from '../even-events'

export async function handle(event: NormalizedG2Event, ctx: ScreenContext): Promise<void> {
  const eventType = event.eventType
  if (isDoubleTapEventType(eventType)) {
    await ctx.cancelVoiceCommandRecording('user-cancel')
    return
  }
  if (event.kind === 'tap') {
    await ctx.stopVoiceCommandRecording('user-tap')
    return
  }
}
