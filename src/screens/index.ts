/**
 * Per-screen handler dispatch table (Phase 1.5c).
 *
 * main.ts は ScreenContext を構築してから `dispatchScreen(event, ctx)` を呼ぶだけ。
 * 個別 screen module の `handle()` に転送される。
 *
 * 旧 `if (notifState.screen === 'list') { ... } else if (...) { ... }` の代わり。
 */

import type { ScreenContext, Screen } from './types'
import type { NormalizedG2Event } from '../even-events'

import * as idleScreen from './idle'
import * as listScreen from './list'
import * as detailScreen from './detail'
import * as detailActionsScreen from './detail-actions'
import * as askQuestionScreen from './ask-question'
import * as replyRecordingScreen from './reply-recording'
import * as replyConfirmScreen from './reply-confirm'
import * as replySendingScreen from './reply-sending'
import * as vcRecordingScreen from './voice-command-recording'
import * as vcRecordingStreamingScreen from './voice-command-recording-streaming'
import * as vcConfirmScreen from './voice-command-confirm'
import * as vcSendingScreen from './voice-command-sending'
import * as vcDoneScreen from './voice-command-done'
import * as sessionListScreen from './session-list'
import * as sessionListCreateConfirmScreen from './session-list-create-confirm'

type Handler = (event: NormalizedG2Event, ctx: ScreenContext) => Promise<void>

const SCREEN_HANDLERS: Record<Screen, Handler> = {
  'idle': idleScreen.handle,
  'list': listScreen.handle,
  'detail': detailScreen.handle,
  'detail-actions': detailActionsScreen.handle,
  'ask-question': askQuestionScreen.handle,
  'reply-recording': replyRecordingScreen.handle,
  'reply-confirm': replyConfirmScreen.handle,
  'reply-sending': replySendingScreen.handle,
  'voice-command-recording': vcRecordingScreen.handle,
  'voice-command-recording-streaming': vcRecordingStreamingScreen.handle,
  'voice-command-confirm': vcConfirmScreen.handle,
  'voice-command-sending': vcSendingScreen.handle,
  'voice-command-done': vcDoneScreen.handle,
  'session-list': sessionListScreen.handle,
  'session-list-create-confirm': sessionListCreateConfirmScreen.handle,
}

export async function dispatchScreen(event: NormalizedG2Event, ctx: ScreenContext): Promise<void> {
  const handler = SCREEN_HANDLERS[ctx.store.notif.screen]
  if (!handler) {
    ctx.log(`[screens] no handler for screen=${ctx.store.notif.screen}`)
    return
  }
  await handler(event, ctx)
}

export type { ScreenContext, Screen } from './types'
