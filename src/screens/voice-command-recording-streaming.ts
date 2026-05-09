/**
 * voice-command-recording-streaming screen handler (Phase 2).
 *
 * - tap → finalize (Send) → voice-command-confirm
 * - double tap → cancel → idle
 * - 20s recording-max timer fires finalize() — wired in startVoiceCommandRecordingStreaming
 *
 * State updates (partial / final from Deepgram) come from the engine
 * subscription in `_helpers.startVoiceCommandRecordingStreaming`. This screen
 * is responsible for input only.
 */

import type { ScreenContext } from './types'
import type { NormalizedG2Event } from '../even-events'
import { isDoubleTapEventType } from '../even-events'

export async function handle(event: NormalizedG2Event, ctx: ScreenContext): Promise<void> {
  const eventType = event.eventType
  if (isDoubleTapEventType(eventType)) {
    await ctx.cancelVoiceCommandStreaming('user-cancel')
    return
  }
  if (event.kind === 'tap') {
    await ctx.finalizeVoiceCommandStreaming('user-tap')
    return
  }
}
