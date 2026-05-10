import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createGroqBatchEngine } from '../src/stt/groq-batch'

function makeJsonResponse(body: unknown, init: { status?: number; statusText?: string } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    statusText: init.statusText ?? 'OK',
    headers: { 'Content-Type': 'application/json' },
  })
}

function makeNonEmptyPcm(byteLength: number): Uint8Array {
  // groq-batch は length === 0 だと早期 return するので、 0 以外の値で埋める。
  const bytes = new Uint8Array(byteLength)
  for (let i = 0; i < byteLength; i++) bytes[i] = (i * 13 + 7) & 0xff
  return bytes
}

describe('createGroqBatchEngine', () => {
  const fetchSpy = vi.fn()

  beforeEach(() => {
    fetchSpy.mockReset()
    vi.stubGlobal('fetch', fetchSpy)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('start → pushPcm × N → finalize POSTs to /api/stt/transcriptions and returns text', async () => {
    fetchSpy.mockResolvedValueOnce(
      makeJsonResponse({ ok: true, text: 'hello world', provider: 'groq', model: 'whisper-large-v3' }),
    )

    const engine = createGroqBatchEngine()
    expect(engine.kind).toBe('groq-batch')

    const session = await engine.start({ voiceSessionId: 'voice-1' })
    expect(session.voiceSessionId).toBe('voice-1')

    await session.pushPcm(makeNonEmptyPcm(4))
    await session.pushPcm(makeNonEmptyPcm(8))
    await session.pushPcm(makeNonEmptyPcm(16))

    const result = await session.finalize()

    expect(result.text).toBe('hello world')
    expect(result.provider).toBe('groq-batch')
    expect(typeof result.duration_ms).toBe('number')

    // fetch は finalize 時に 1 度だけ呼ばれる
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit]
    // appConfig は module-load 時に固定されるため、 path 部のみ検証
    expect(typeof url).toBe('string')
    expect((url as string).endsWith('/api/stt/transcriptions')).toBe(true)
    expect(init.method).toBe('POST')
    expect(typeof init.body).toBe('string')

    // body には WAV を base64 化したデータが入っている
    const parsed = JSON.parse(init.body as string)
    expect(parsed.mimeType).toBe('audio/wav')
    expect(typeof parsed.audioBase64).toBe('string')
    expect(parsed.audioBase64.length).toBeGreaterThan(0)
    expect(parsed.language).toBe('ja')
  })

  it('cancel discards buffered audio and never calls fetch', async () => {
    const engine = createGroqBatchEngine()
    const session = await engine.start({ voiceSessionId: 'voice-cancel' })

    await session.pushPcm(makeNonEmptyPcm(4))
    await session.pushPcm(makeNonEmptyPcm(4))
    await session.cancel()

    // cancel 後の pushPcm は no-op
    await session.pushPcm(makeNonEmptyPcm(4))

    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('cancel is idempotent', async () => {
    const engine = createGroqBatchEngine()
    const session = await engine.start({ voiceSessionId: 'voice-cancel-twice' })

    await session.cancel()
    await session.cancel()

    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('reports provider="mock" when Hub returns mock', async () => {
    fetchSpy.mockResolvedValueOnce(
      makeJsonResponse({ ok: true, text: '（STTモック）', provider: 'mock', model: 'mock' }),
    )

    const engine = createGroqBatchEngine()
    const session = await engine.start({ voiceSessionId: 'voice-mock' })
    await session.pushPcm(makeNonEmptyPcm(8))
    const result = await session.finalize()

    expect(result.provider).toBe('mock')
    expect(result.text).toBe('（STTモック）')
  })

  it('finalize without any pushed PCM returns empty text without calling fetch', async () => {
    const engine = createGroqBatchEngine()
    const session = await engine.start({ voiceSessionId: 'voice-empty' })
    const result = await session.finalize()

    expect(result.text).toBe('')
    // 空 PCM の場合、 transcribePcmChunks は早期 return するので fetch は呼ばれない
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
