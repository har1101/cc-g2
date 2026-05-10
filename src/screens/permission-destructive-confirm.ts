/**
 * Phase 5: destructive 2-step confirm screen handler.
 *
 * Thin wrapper that delegates to the handler co-located with the actions
 * screen (detail-actions.ts). Lives in its own module so screens/index.ts
 * can dispatch on `notif.screen === 'permission-destructive-confirm'`
 * without coupling all the helper code into one file.
 */

import type { ScreenContext } from './types'
import type { NormalizedG2Event } from '../even-events'
import { handleDestructiveConfirm } from './detail-actions'

export async function handle(event: NormalizedG2Event, ctx: ScreenContext): Promise<void> {
  await handleDestructiveConfirm(event, ctx)
}
