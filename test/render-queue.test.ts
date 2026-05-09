import { describe, expect, it, vi } from 'vitest'

import { createRenderQueue } from '../src/render-queue'

/** 解決を外部から制御できる Promise を作る */
function deferred<T = void>() {
  let resolve!: (value: T) => void
  let reject!: (err: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('render-queue', () => {
  it('serial: queueing two awaits the first', async () => {
    const queue = createRenderQueue()
    const order: string[] = []
    const first = deferred()

    const p1 = queue.enqueue(async () => {
      order.push('first-start')
      await first.promise
      order.push('first-end')
    })
    const p2 = queue.enqueue(async () => {
      order.push('second-start')
    })

    // first はまだ resolve していないので p2 は走っていない
    expect(order).toEqual(['first-start'])
    first.resolve()
    await Promise.all([p1, p2])
    expect(order).toEqual(['first-start', 'first-end', 'second-start'])
  })

  it('replace cancels pending non-started fn', async () => {
    const queue = createRenderQueue()
    const order: string[] = []
    const first = deferred()

    const p1 = queue.enqueue(async () => {
      order.push('first-start')
      await first.promise
      order.push('first-end')
    })
    // この pending は実行されないはず
    const p2 = queue.enqueue(async () => {
      order.push('second-should-skip')
    })
    // replace で 2nd を破棄して 3rd を「次」 に差し替え
    const p3 = queue.replace(async () => {
      order.push('third-start')
    })

    first.resolve()
    await Promise.all([p1, p2, p3])
    expect(order).toEqual(['first-start', 'first-end', 'third-start'])
  })

  it('throw in fn does not stop queue', async () => {
    const queue = createRenderQueue({ log: () => {} })
    const order: string[] = []
    const p1 = queue.enqueue(async () => {
      order.push('first')
      throw new Error('boom')
    })
    const p2 = queue.enqueue(async () => {
      order.push('second')
    })

    await expect(p1).rejects.toThrow('boom')
    await p2
    expect(order).toEqual(['first', 'second'])
  })

  it('isRendering reflects state', async () => {
    const queue = createRenderQueue()
    expect(queue.isRendering()).toBe(false)
    const gate = deferred()
    const p = queue.enqueue(async () => {
      await gate.promise
    })
    expect(queue.isRendering()).toBe(true)
    gate.resolve()
    await p
    expect(queue.isRendering()).toBe(false)
  })

  it('safeguard fires after consecutive errors and resets the counter', async () => {
    const safeguard = vi.fn(async () => {})
    const queue = createRenderQueue({ log: () => {}, safeguard, consecutiveErrorThreshold: 2 })

    // 1 回目の throw — まだ safeguard は呼ばれない
    await expect(queue.enqueue(async () => { throw new Error('a') })).rejects.toThrow('a')
    expect(safeguard).not.toHaveBeenCalled()
    // 2 回目で発動
    await expect(queue.enqueue(async () => { throw new Error('b') })).rejects.toThrow('b')
    expect(safeguard).toHaveBeenCalledTimes(1)
    // 一度成功すれば counter は reset される
    await queue.enqueue(async () => {})
    await expect(queue.enqueue(async () => { throw new Error('c') })).rejects.toThrow('c')
    expect(safeguard).toHaveBeenCalledTimes(1) // まだ 2 回目に達していない
  })

  it('replace with no pending acts like enqueue', async () => {
    const queue = createRenderQueue()
    const order: string[] = []
    await queue.replace(async () => { order.push('only') })
    expect(order).toEqual(['only'])
  })
})
