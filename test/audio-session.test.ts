import { describe, expect, it, vi } from 'vitest'

import { createAudioSession } from '../src/audio-session'

/**
 * `connection` を模擬する小さな harness。
 * - `pcm(bytes)` で PCM チャンクを listener に押し込める
 * - `startAudio` / `stopAudio` 呼び出しを集計する
 */
function createTestRig() {
  let registered: ((pcm: Uint8Array) => void) | null = null
  const startAudio = vi.fn(async () => {})
  const stopAudio = vi.fn(async () => {})
  const session = createAudioSession({
    startAudio,
    stopAudio,
    onAudio: (handler) => {
      registered = handler
    },
  })
  return {
    session,
    startAudio,
    stopAudio,
    pcm(bytes: number) {
      if (!registered) throw new Error('listener not registered')
      registered(new Uint8Array(bytes))
    },
  }
}

describe('audio-session', () => {
  it('acquire() returns handle and release stops device', async () => {
    const { session, startAudio, stopAudio } = createTestRig()
    expect(session.current()).toBe('idle')

    const handle = await session.acquire('voice-command')
    expect(session.current()).toBe('voice-command')
    expect(startAudio).toHaveBeenCalledTimes(1)
    expect(stopAudio).not.toHaveBeenCalled()

    await handle.release()
    expect(session.current()).toBe('idle')
    expect(stopAudio).toHaveBeenCalledTimes(1)
  })

  it('rejects second acquire while held with audio-busy:<owner>', async () => {
    const { session } = createTestRig()
    const first = await session.acquire('reply-comment')
    await expect(session.acquire('voice-command')).rejects.toThrow('audio-busy: reply-comment')
    // first is still healthy
    expect(session.current()).toBe('reply-comment')
    await first.release()
  })

  it('after release, subsequent acquire succeeds', async () => {
    const { session } = createTestRig()
    const first = await session.acquire('reply-comment')
    await first.release()
    const second = await session.acquire('voice-command')
    expect(session.current()).toBe('voice-command')
    await second.release()
    expect(session.current()).toBe('idle')
  })

  it('onPcm receives only chunks while held; after release ignored', async () => {
    const { session, pcm } = createTestRig()
    const handle = await session.acquire('voice-command')

    const chunks: number[] = []
    handle.onPcm((b) => chunks.push(b.length))
    pcm(10)
    pcm(40)
    expect(chunks).toEqual([10, 40])

    await handle.release()
    pcm(100) // release 後は誰も受け取らない
    expect(chunks).toEqual([10, 40])
  })

  it('PCM before onPcm() is registered is silently dropped (no throw)', async () => {
    const { session, pcm } = createTestRig()
    const handle = await session.acquire('voice-command')
    expect(() => pcm(5)).not.toThrow()
    await handle.release()
  })

  it('startAudio failure is propagated and ownership stays idle', async () => {
    let registered: ((pcm: Uint8Array) => void) | null = null
    const startAudio = vi.fn(async () => {
      throw new Error('mic init failed')
    })
    const stopAudio = vi.fn(async () => {})
    const session = createAudioSession({
      startAudio,
      stopAudio,
      onAudio: (handler) => {
        registered = handler
      },
    })

    await expect(session.acquire('voice-command')).rejects.toThrow('mic init failed')
    expect(session.current()).toBe('idle')
    // 後続の acquire は成功するべき
    startAudio.mockResolvedValueOnce(undefined)
    const handle = await session.acquire('voice-command')
    expect(session.current()).toBe('voice-command')
    expect(registered).not.toBeNull()
    await handle.release()
  })

  it('release is idempotent (multiple calls do not double-stop)', async () => {
    const { session, stopAudio } = createTestRig()
    const handle = await session.acquire('reply-comment')
    await handle.release()
    await handle.release()
    expect(stopAudio).toHaveBeenCalledTimes(1)
  })

  it('PCM dispatched only to current handle, not previously released ones', async () => {
    const { session, pcm } = createTestRig()
    const first = await session.acquire('reply-comment')
    const firstChunks: number[] = []
    first.onPcm((b) => firstChunks.push(b.length))
    pcm(20)
    await first.release()

    const second = await session.acquire('voice-command')
    const secondChunks: number[] = []
    second.onPcm((b) => secondChunks.push(b.length))
    pcm(30)

    expect(firstChunks).toEqual([20])
    expect(secondChunks).toEqual([30])
    await second.release()
  })
})
