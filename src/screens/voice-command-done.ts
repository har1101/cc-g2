/**
 * voice-command-done screen handler (Phase 1.5c).
 *
 * 完了画面: 任意の入力で done timer をクリアし即座に idle 復帰。
 */

import type { ScreenContext } from './types'
import type { NormalizedG2Event } from '../even-events'
import { clearVoiceDoneTimer } from '../state/store'

export async function handle(_event: NormalizedG2Event, ctx: ScreenContext): Promise<void> {
  clearVoiceDoneTimer()
  await ctx.returnToIdleFromVoiceCommand('user-tap-done')
}
