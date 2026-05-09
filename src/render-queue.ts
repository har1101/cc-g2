/**
 * Serialized G2 render queue (Phase 1.5b).
 *
 * `glasses-ui` の show* 系は createPageContainer / rebuildPage を内部で呼ぶため
 * 実機で 3 秒近くかかることがある。 同時に 2 つ走ると SDK がエラーを返したり
 * ベースページの構築に失敗したりするので、 ここで直列化する。
 *
 * 既存 `glassesUI.isRendering()` は単一フラグだったが、 render-queue は
 * 「現在実行中 1 + 待機中 1」 の小さなキューを保持する。
 *
 * - `enqueue(fn)`: fn を末尾に追加。 直前のジョブが終わるまで await する。
 * - `replace(fn)`: 待機中の未開始ジョブを破棄して fn を「次に走る」 ジョブに差し替える。
 *   実行中のジョブは止められない (await 中の SDK 呼び出しはそのまま流す)。
 * - 例外時はログを出して continue する。 連続例外時は safeguard fn にフォールバック。
 */

export type RenderFn = () => Promise<void>

export type RenderQueue = {
  /** Run a render fn. Returns when fn settles. Serial by default. */
  enqueue(fn: RenderFn): Promise<void>
  /**
   * 待機中ジョブをキャンセルして fn を「次」 に差し替える。 fn の Promise を返す。
   * 実行中ジョブは止めない (cancellable な単位ではないため)。
   */
  replace(fn: RenderFn): Promise<void>
  /** 現在ジョブ実行中なら true */
  isRendering(): boolean
}

export type RenderQueueOptions = {
  /** ロガー (例外を吐くときに使う)。 デフォルトは console.warn */
  log?: (msg: string) => void
  /**
   * 連続して `consecutiveErrorThreshold` 回 throw された場合に呼ばれる。
   * idle 復帰など、 「壊れた状態をリセットする」 fn を渡す想定。
   */
  safeguard?: RenderFn
  /** safeguard を発動する連続例外数 (デフォルト 3) */
  consecutiveErrorThreshold?: number
}

type Pending = {
  fn: RenderFn
  resolve: () => void
  reject: (err: unknown) => void
  cancelled: boolean
}

export function createRenderQueue(options: RenderQueueOptions = {}): RenderQueue {
  const log = options.log ?? ((msg) => console.warn(msg))
  const safeguard = options.safeguard
  const errorThreshold = options.consecutiveErrorThreshold ?? 3

  let running = false
  // 待機列。 通常は最大 1 件 (replace で上書きされる) だが、 enqueue 連続呼び出しで
  // 増えてもよい。
  const queue: Pending[] = []
  let consecutiveErrors = 0

  async function pump(): Promise<void> {
    if (running) return
    running = true
    try {
      while (queue.length > 0) {
        const next = queue.shift()!
        if (next.cancelled) {
          next.resolve()
          continue
        }
        try {
          await next.fn()
          consecutiveErrors = 0
          next.resolve()
        } catch (err) {
          consecutiveErrors++
          const msg = err instanceof Error ? err.message : String(err)
          log(`[render-queue] job threw: ${msg}`)
          next.reject(err)
          if (safeguard && consecutiveErrors >= errorThreshold) {
            log(`[render-queue] consecutive errors (${consecutiveErrors}) → safeguard`)
            try {
              await safeguard()
              consecutiveErrors = 0
            } catch (sgErr) {
              const sgMsg = sgErr instanceof Error ? sgErr.message : String(sgErr)
              log(`[render-queue] safeguard threw: ${sgMsg}`)
            }
          }
        }
      }
    } finally {
      running = false
    }
  }

  function enqueue(fn: RenderFn): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      queue.push({ fn, resolve, reject, cancelled: false })
      void pump()
    })
  }

  function replace(fn: RenderFn): Promise<void> {
    // 待機中の未開始ジョブをすべて cancel する (実行中はそのまま走らせる)。
    for (const pending of queue) {
      pending.cancelled = true
    }
    return enqueue(fn)
  }

  return {
    enqueue,
    replace,
    isRendering: () => running,
  }
}
