/**
 * Phase 2 Pass 3: frontend Deepgram streaming engine.
 *
 * Mocks the WebSocket via `wsFactory` injection. Verifies:
 * - stt.start frame on open
 * - pushPcm sends binary
 * - partials forwarded to onPartial
 * - stale partials (lower seq) are dropped
 * - finalize → stt.finalize sent + waits for stt.final
 * - finalize timeout returns last stable_text
 * - cancel → stt.cancel sent + ws.close
 * - ws close mid-session → onError fired
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createDeepgramStreamEngine } from '../src/stt/deepgram-stream'

type Listener = (ev: any) => void

class MockWebSocket {
  readyState: number
  CONNECTING = 0
  OPEN = 1
  CLOSING = 2
  CLOSED = 3
  url: string
  protocols: string | string[] | undefined
  sent: any[] = []
  listeners: Record<string, Listener[]> = {}

  constructor(url: string, protocols?: string | string[]) {
    this.url = url
    this.protocols = protocols
    this.readyState = this.CONNECTING
  }
  addEventListener(type: string, listener: Listener, _opts?: { once?: boolean }) {
    (this.listeners[type] ||= []).push(listener)
  }
  removeEventListener(type: string, listener: Listener) {
    const arr = this.listeners[type]
    if (!arr) return
    const i = arr.indexOf(listener)
    if (i >= 0) arr.splice(i, 1)
  }
  send(data: any) {
    this.sent.push(data)
  }
  close() {
    if (this.readyState === this.CLOSED) return
    this.readyState = this.CLOSED
    this.fire('close', { code: 1000, reason: '' })
  }
  fire(type: string, ev: any) {
    const arr = this.listeners[type]
    if (!arr) return
    for (const l of arr.slice()) l(ev)
  }
  // helpers
  open() {
    this.readyState = this.OPEN
    this.fire('open', {})
  }
  recv(json: any) {
    this.fire('message', { data: typeof json === 'string' ? json : JSON.stringify(json) })
  }
}

let mockWs: MockWebSocket | null = null

function makeEngine(opts: { token?: string; finalizeTimeoutMs?: number } = {}) {
  return createDeepgramStreamEngine({
    url: 'ws://127.0.0.1:0/api/v1/stt/stream',
    token: opts.token ?? 'tk',
    finalizeTimeoutMs: opts.finalizeTimeoutMs ?? 60,
    wsFactory: (url, protocols) => {
      mockWs = new MockWebSocket(url, protocols)
      return mockWs as unknown as WebSocket
    },
  })
}

describe('createDeepgramStreamEngine', () => {
  beforeEach(() => {
    mockWs = null
  })
  afterEach(() => {
    mockWs = null
  })

  it('sends stt.start on open and includes the token in the subprotocol/query', async () => {
    const engine = makeEngine()
    const startPromise = engine.start({ voiceSessionId: 'v1', lang: 'ja' })
    // open the underlying ws
    expect(mockWs).not.toBeNull()
    mockWs!.open()
    await startPromise
    // Token surfaced via query string and subprotocol
    expect(mockWs!.url).toContain('token=tk')
    expect(mockWs!.protocols).toEqual(['cc-g2-token.tk'])
    // stt.start was the first message
    const first = mockWs!.sent[0]
    expect(typeof first).toBe('string')
    const parsed = JSON.parse(first as string)
    expect(parsed.type).toBe('stt.start')
    expect(parsed.voice_session_id).toBe('v1')
    expect(parsed.engine).toBe('deepgram-stream')
    expect(parsed.encoding).toBe('linear16')
    expect(parsed.sample_rate).toBe(16000)
    expect(parsed.channels).toBe(1)
    expect(parsed.lang).toBe('ja')
  })

  it('pushPcm sends binary frames', async () => {
    const engine = makeEngine()
    const p = engine.start({ voiceSessionId: 'v1' })
    mockWs!.open()
    const session = await p
    await session.pushPcm(new Uint8Array([1, 2, 3]))
    await session.pushPcm(new Uint8Array([4, 5, 6, 7]))
    // sent[0] is stt.start, sent[1..] are binary
    const binary = mockWs!.sent.slice(1)
    expect(binary.length).toBe(2)
    // wsFactory mock receives ArrayBuffer
    expect(binary[0]).toBeInstanceOf(ArrayBuffer)
    expect((binary[0] as ArrayBuffer).byteLength).toBe(3)
    expect((binary[1] as ArrayBuffer).byteLength).toBe(4)
  })

  it('forwards stt.partial frames to onPartial', async () => {
    const engine = makeEngine()
    const p = engine.start({ voiceSessionId: 'v1' })
    mockWs!.open()
    const session = await p

    const partials: any[] = []
    session.onPartial!((pa) => partials.push(pa))

    mockWs!.recv({ type: 'stt.partial', stable_text: '', partial_text: 'こん', stable_seq: 0, partial_seq: 1 })
    mockWs!.recv({ type: 'stt.partial', stable_text: 'こんにちは。', partial_text: '', stable_seq: 1, partial_seq: 2 })

    expect(partials.length).toBe(2)
    expect(partials[1].stable_text).toBe('こんにちは。')
  })

  it('drops stale partials with lower partial_seq', async () => {
    const engine = makeEngine()
    const p = engine.start({ voiceSessionId: 'v1' })
    mockWs!.open()
    const session = await p

    const partials: any[] = []
    session.onPartial!((pa) => partials.push(pa))

    mockWs!.recv({ type: 'stt.partial', stable_text: '', partial_text: 'a', stable_seq: 0, partial_seq: 5 })
    mockWs!.recv({ type: 'stt.partial', stable_text: '', partial_text: 'b', stable_seq: 0, partial_seq: 4 })
    mockWs!.recv({ type: 'stt.partial', stable_text: '', partial_text: 'c', stable_seq: 0, partial_seq: 6 })

    expect(partials.map((x) => x.partial_text)).toEqual(['a', 'c'])
  })

  it('finalize sends stt.finalize and resolves with stt.final', async () => {
    const engine = makeEngine()
    const p = engine.start({ voiceSessionId: 'v1' })
    mockWs!.open()
    const session = await p

    const finalP = session.finalize()
    // ensure finalize frame was sent
    const lastSent = mockWs!.sent[mockWs!.sent.length - 1]
    expect(typeof lastSent).toBe('string')
    expect(JSON.parse(lastSent as string)).toMatchObject({ type: 'stt.finalize', voice_session_id: 'v1' })

    mockWs!.recv({ type: 'stt.final', text: 'hello world', confidence: 0.9, duration_ms: 1234 })
    const result = await finalP
    expect(result.text).toBe('hello world')
    expect(result.confidence).toBe(0.9)
    expect(result.provider).toBe('deepgram-stream')
  })

  it('finalize timeout returns last stable_text without partial_text', async () => {
    const engine = makeEngine({ finalizeTimeoutMs: 30 })
    const p = engine.start({ voiceSessionId: 'v1' })
    mockWs!.open()
    const session = await p

    mockWs!.recv({ type: 'stt.partial', stable_text: 'こんにちは。', partial_text: '元気で', stable_seq: 1, partial_seq: 5 })
    const result = await session.finalize()
    // Per design: 未確定 partial_text は確定として使わない。
    expect(result.text).toBe('こんにちは。')
    expect(result.provider).toBe('deepgram-stream')
  })

  it('cancel sends stt.cancel and closes the ws', async () => {
    const engine = makeEngine()
    const p = engine.start({ voiceSessionId: 'v1' })
    mockWs!.open()
    const session = await p

    await session.cancel()
    const sentText = mockWs!.sent.filter((x) => typeof x === 'string')
    const cancelFrame = sentText.map((s) => JSON.parse(s as string)).find((j) => j.type === 'stt.cancel')
    expect(cancelFrame).toBeDefined()
    expect(mockWs!.readyState).toBe(mockWs!.CLOSED)
  })

  it('ws close mid-session fires onError with provider_disconnected', async () => {
    const engine = makeEngine()
    const p = engine.start({ voiceSessionId: 'v1' })
    mockWs!.open()
    const session = await p

    const errors: any[] = []
    session.onError!((e) => errors.push(e))
    // Server-initiated close before finalize
    mockWs!.close()
    expect(errors.length).toBe(1)
    expect(errors[0].code).toBe('provider_disconnected')
  })
})
