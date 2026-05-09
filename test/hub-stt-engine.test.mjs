import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createGroqEngine } from '../server/notification-hub/stt/groq-engine.mjs'

function audioBase64(byteLength) {
  // 中身の値は任意。 0 以外なら mock 分岐に流せる
  const bytes = new Uint8Array(byteLength)
  for (let i = 0; i < byteLength; i++) bytes[i] = (i * 7 + 3) & 0xff
  return Buffer.from(bytes).toString('base64')
}

describe('hub stt groq-engine', () => {
  let originalFetch
  beforeEach(() => {
    originalFetch = globalThis.fetch
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('returns mock payload when apiKey is missing (no fetch call)', async () => {
    const fetchSpy = vi.fn()
    globalThis.fetch = fetchSpy

    const engine = createGroqEngine()
    const result = await engine.transcribe(
      { audioBase64: audioBase64(64), mimeType: 'audio/wav', model: 'whisper-large-v3', language: 'ja' },
      { apiKey: '', defaultModel: 'whisper-large-v3' },
    )

    expect(result.ok).toBe(true)
    expect(result.status).toBe(200)
    expect(result.payload.provider).toBe('mock')
    expect(result.payload.model).toBe('mock')
    expect(typeof result.payload.text).toBe('string')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('POSTs to Groq when apiKey is set and returns provider=groq on success', async () => {
    const fetchSpy = vi.fn(async () => {
      return new Response(JSON.stringify({ text: '  hello from groq  ' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    })
    globalThis.fetch = fetchSpy

    const engine = createGroqEngine()
    const result = await engine.transcribe(
      { audioBase64: audioBase64(64), mimeType: 'audio/wav', model: 'whisper-large-v3', language: 'ja' },
      { apiKey: 'sk-test', defaultModel: 'whisper-large-v3' },
    )

    expect(result.ok).toBe(true)
    expect(result.status).toBe(200)
    expect(result.payload.provider).toBe('groq')
    expect(result.payload.text).toBe('hello from groq')
    expect(result.payload.model).toBe('whisper-large-v3')

    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toBe('https://api.groq.com/openai/v1/audio/transcriptions')
    expect(init.method).toBe('POST')
    expect(init.headers.Authorization).toBe('Bearer sk-test')
  })

  it('returns ok:false with error message when Groq responds non-2xx', async () => {
    globalThis.fetch = vi.fn(async () => {
      return new Response('upstream offline', { status: 502, statusText: 'Bad Gateway' })
    })

    const engine = createGroqEngine()
    const result = await engine.transcribe(
      { audioBase64: audioBase64(64), mimeType: 'audio/wav' },
      { apiKey: 'sk-test', defaultModel: 'whisper-large-v3' },
    )

    expect(result.ok).toBe(false)
    expect(result.status).toBe(502)
    expect(result.error).toMatch(/Groq STT failed/)
    expect(result.error).toMatch(/502/)
  })

  it('engine.kind is "groq-batch"', () => {
    const engine = createGroqEngine()
    expect(engine.kind).toBe('groq-batch')
  })
})
