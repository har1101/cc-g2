/**
 * reply-sending screen handler (Phase 1.5c).
 *
 * 送信結果画面: 任意の操作 (タップ/スワイプ) で即座にリスト一覧に戻る。
 * 旧 main.ts では 1 行だが、 screen 別 handler の対称性のため 1 ファイルに分離。
 */

import type { ScreenContext } from './types'
import type { NormalizedG2Event } from '../even-events'

export async function handle(_event: NormalizedG2Event, ctx: ScreenContext): Promise<void> {
  ctx.log('結果画面: ユーザー操作で即座に復帰')
  await ctx.returnToListFromResult()
}
