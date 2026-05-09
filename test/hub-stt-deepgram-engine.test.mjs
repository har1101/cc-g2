/**
 * Phase 2 Pass 2: Deepgram engine.
 *
 * Mocks the upstream Deepgram WS via a `wsFactory` injection. Verifies:
 * - missing apiKey → throws `no_api_key` on start()
 * - interim messages → onPartial called with monotonic partial_seq
 * - is_final → stable_seq advances, partial_seq advances, partial_text resets
 * - multiple is_finals → seqs never rewind
 * - finalize timeout → returns last stable_text
 * - finalize with late is_final → returns concatenated stable_text
 * - cancel → no further partials emitted, ws closed
 */

import { afterEach, describe, expect, it } from 'vitest'
import { EventEmitter } from 'node:events'

import { createDeepgramEngine } from '../server/notification-hub/stt/deepgram-engine.mjs'

// Tiny mock of the `ws` WebSocket. Only the surface used by deepgram-engine.
class MockWs extends EventEmitter {
  constructor() {
    super()
    this.sent = []
    this.closed = false
    this.opened = false
  }
  send(data) {
    if (this.closed) return
    this.sent.push(data)
  }
  close() {
    if (this.closed) return
    this.closed = true
    setImmediate(() => this.emit('close'))
  }
  off(ev, h) { return this.removeListener(ev, h) }
  /** Test helper: simulate the upgrade succeeding. */
  open() {
    this.opened = true
    this.emit('open')
  }
  /** Test helper: emit a Deepgram Results message. */
  emitResults({ transcript, isFinal, confidence }) {
    const payload = {
      type: 'Results',
      channel: {
        alternatives: [
          { transcript, confidence: confidence ?? 0.8 },
        ],
      },
      is_final: !!isFinal,
    }
    this.emit('message', Buffer.from(JSON.stringify(payload), 'utf8'))
  }
  emitError(message) {
    const payload = { type: 'Error', description: message }
    this.emit('message', Buffer.from(JSON.stringify(payload), 'utf8'))
  }
}

function makeEngineWithMock(extra = {}) {
  const mock = new MockWs()
  const engine = createDeepgramEngine({
    apiKey: 'fake',
    model: 'nova-3',
    language: 'ja',
    wsFactory: () => mock,
    finalizeTimeoutMs: 50,
    ...extra,
  })
  return { engine, mock }
}

describe('hub deepgram-engine', () => {
  afterEach(() => {
    /* nothing global */
  })

  it('throws no_api_key when DEEPGRAM_API_KEY is missing', async () => {
    const engine = createDeepgramEngine({ apiKey: '' })
    await expect(engine.start({ voiceSessionId: 'v1' })).rejects.toMatchObject({ code: 'no_api_key' })
  })

  it('opens the upstream WS with the right URL and headers', async () => {
    let capturedUrl = ''
    let capturedHeaders = null
    const mock = new MockWs()
    const engine = createDeepgramEngine({
      apiKey: 'sk-test',
      model: 'nova-3',
      language: 'ja',
      wsFactory: (url, headers) => {
        capturedUrl = url
        capturedHeaders = headers
        return mock
      },
      finalizeTimeoutMs: 30,
    })
    setImmediate(() => mock.open())
    const session = await engine.start({ voiceSessionId: 'v1' })
    expect(capturedUrl).toContain('wss://api.deepgram.com/v1/listen')
    expect(capturedUrl).toContain('model=nova-3')
    expect(capturedUrl).toContain('language=ja')
    expect(capturedUrl).toContain('encoding=linear16')
    expect(capturedUrl).toContain('sample_rate=16000')
    expect(capturedUrl).toContain('interim_results=true')
    expect(capturedHeaders).toEqual({ Authorization: 'Token sk-test' })
    await session.cancel()
  })

  it('forwards PCM as binary frames after open', async () => {
    const { engine, mock } = makeEngineWithMock()
    setImmediate(() => mock.open())
    const session = await engine.start({ voiceSessionId: 'v1' })
    await session.pushPcm(new Uint8Array([1, 2, 3]))
    await session.pushPcm(new Uint8Array([4, 5, 6]))
    expect(mock.sent.length).toBe(2)
    expect(mock.sent[0]).toBeInstanceOf(Buffer)
    expect(Array.from(mock.sent[0])).toEqual([1, 2, 3])
    await session.cancel()
  })

  it('emits onPartial with monotonic partial_seq for interim results', async () => {
    const { engine, mock } = makeEngineWithMock()
    setImmediate(() => mock.open())
    const session = await engine.start({ voiceSessionId: 'v1' })

    const partials = []
    session.onPartial((p) => partials.push({ ...p }))

    mock.emitResults({ transcript: 'こん', isFinal: false })
    mock.emitResults({ transcript: 'こんに', isFinal: false })
    mock.emitResults({ transcript: 'こんにちは', isFinal: false })

    expect(partials.length).toBe(3)
    expect(partials[0].partial_text).toBe('こん')
    expect(partials[2].partial_text).toBe('こんにちは')
    expect(partials[0].partial_seq).toBe(1)
    expect(partials[1].partial_seq).toBe(2)
    expect(partials[2].partial_seq).toBe(3)
    expect(partials[2].stable_seq).toBe(0)
    expect(partials[2].stable_text).toBe('')
    await session.cancel()
  })

  it('advances stable_seq on is_final and never rewinds across multiple finals', async () => {
    const { engine, mock } = makeEngineWithMock()
    setImmediate(() => mock.open())
    const session = await engine.start({ voiceSessionId: 'v1' })

    const partials = []
    session.onPartial((p) => partials.push({ ...p }))

    mock.emitResults({ transcript: 'こん', isFinal: false })
    mock.emitResults({ transcript: 'こんにちは。', isFinal: true })
    mock.emitResults({ transcript: '元気', isFinal: false })
    mock.emitResults({ transcript: '元気ですか。', isFinal: true })

    // After first final
    const after1 = partials.find((p) => p.stable_seq === 1)
    expect(after1).toBeDefined()
    expect(after1.stable_text).toBe('こんにちは。')
    expect(after1.partial_text).toBe('')

    // After second final
    const last = partials[partials.length - 1]
    expect(last.stable_seq).toBe(2)
    expect(last.stable_text).toBe('こんにちは。元気ですか。')
    expect(last.partial_text).toBe('')

    // Monotonic check across the entire emission sequence
    let prevPartialSeq = 0
    let prevStableSeq = 0
    for (const p of partials) {
      expect(p.partial_seq).toBeGreaterThanOrEqual(prevPartialSeq)
      expect(p.stable_seq).toBeGreaterThanOrEqual(prevStableSeq)
      prevPartialSeq = p.partial_seq
      prevStableSeq = p.stable_seq
    }
    await session.cancel()
  })

  it('finalize returns the last stable_text after timeout when no more finals arrive', async () => {
    const { engine, mock } = makeEngineWithMock({ finalizeTimeoutMs: 30 })
    setImmediate(() => mock.open())
    const session = await engine.start({ voiceSessionId: 'v1' })

    mock.emitResults({ transcript: 'hello world.', isFinal: true })
    // No further finals; finalize should time out and return current stable_text.
    const result = await session.finalize()
    expect(result.text).toBe('hello world.')
    expect(typeof result.duration_ms).toBe('number')
    // CloseStream was sent
    const sentText = mock.sent.find((d) => typeof d === 'string')
    expect(sentText).toBe(JSON.stringify({ type: 'CloseStream' }))
  })

  it('finalize waits for a late is_final within the timeout window', async () => {
    const { engine, mock } = makeEngineWithMock({ finalizeTimeoutMs: 200 })
    setImmediate(() => mock.open())
    const session = await engine.start({ voiceSessionId: 'v1' })

    // Kick off finalize, then deliver a late final.
    const p = session.finalize()
    setTimeout(() => mock.emitResults({ transcript: 'late final.', isFinal: true }), 30)
    const result = await p
    expect(result.text).toBe('late final.')
  })

  it('cancel discards pending state and closes the WS', async () => {
    const { engine, mock } = makeEngineWithMock()
    setImmediate(() => mock.open())
    const session = await engine.start({ voiceSessionId: 'v1' })

    const partials = []
    session.onPartial((p) => partials.push(p))

    mock.emitResults({ transcript: 'foo', isFinal: false })
    await session.cancel()
    // After cancel the WS should be closed; subsequent push is a no-op.
    expect(mock.closed).toBe(true)
    await session.pushPcm(new Uint8Array([9, 9, 9]))
    expect(mock.sent.filter((d) => Buffer.isBuffer(d)).length).toBe(0)
  })

  it('emits onError when Deepgram sends an Error message', async () => {
    const { engine, mock } = makeEngineWithMock()
    setImmediate(() => mock.open())
    const session = await engine.start({ voiceSessionId: 'v1' })
    const errors = []
    session.onError((e) => errors.push(e))
    mock.emitError('boom')
    expect(errors.length).toBe(1)
    expect(errors[0].code).toBe('provider_error')
    await session.cancel()
  })
})
