/**
 * Phase 2 Pass 5: late-final / stale-partial handling on the frontend
 * Deepgram stream engine.
 *
 * Verifies:
 * - finalize() resolves on timeout when no stt.final is seen
 * - a stt.final arriving AFTER the timeout fires onLateFinal handlers
 * - cancel() prevents late-final delivery
 */

import { describe, expect, it } from 'vitest'

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
  addEventListener(t: string, l: Listener) { (this.listeners[t] ||= []).push(l) }
  removeEventListener(t: string, l: Listener) {
    const a = this.listeners[t]; if (!a) return
    const i = a.indexOf(l); if (i >= 0) a.splice(i, 1)
  }
  send(data: any) { this.sent.push(data) }
  close() {
    if (this.readyState === this.CLOSED) return
    this.readyState = this.CLOSED
    this.fire('close', { code: 1000 })
  }
  fire(t: string, e: any) { for (const l of (this.listeners[t] || []).slice()) l(e) }
  open() { this.readyState = this.OPEN; this.fire('open', {}) }
  recv(j: any) { this.fire('message', { data: typeof j === 'string' ? j : JSON.stringify(j) }) }
}

let mockWs: MockWebSocket | null = null

function makeEngine(opts: { finalizeTimeoutMs?: number } = {}) {
  return createDeepgramStreamEngine({
    url: 'ws://127.0.0.1:0/api/v1/stt/stream',
    token: 'tk',
    finalizeTimeoutMs: opts.finalizeTimeoutMs ?? 30,
    wsFactory: (url, protocols) => {
      mockWs = new MockWebSocket(url, protocols)
      return mockWs as unknown as WebSocket
    },
  })
}

describe('deepgram-stream late-final', () => {
  it('fires onLateFinal when stt.final arrives after the timeout', async () => {
    const engine = makeEngine({ finalizeTimeoutMs: 30 })
    const startP = engine.start({ voiceSessionId: 'v1' })
    mockWs!.open()
    const session = await startP
    const lateFinals: any[] = []
    session.onLateFinal!((r) => lateFinals.push(r))

    // emit one stable then start finalize, let it time out, then deliver final
    mockWs!.recv({ type: 'stt.partial', stable_text: 'こん。', partial_text: '', stable_seq: 1, partial_seq: 1 })
    const result = await session.finalize()
    expect(result.text).toBe('こん。')
    // Now deliver a late stt.final (provider was slow). The mock ws is still
    // OPEN because finalize() does NOT close it on the timeout path.
    mockWs!.recv({ type: 'stt.final', text: 'こんにちは。', confidence: 0.95, duration_ms: 1234 })
    expect(lateFinals.length).toBe(1)
    expect(lateFinals[0].text).toBe('こんにちは。')
    expect(lateFinals[0].confidence).toBe(0.95)
  })

  it('does NOT fire onLateFinal after cancel()', async () => {
    const engine = makeEngine({ finalizeTimeoutMs: 30 })
    const startP = engine.start({ voiceSessionId: 'v1' })
    mockWs!.open()
    const session = await startP
    const lateFinals: any[] = []
    session.onLateFinal!((r) => lateFinals.push(r))

    await session.finalize() // times out
    await session.cancel()
    mockWs!.recv({ type: 'stt.final', text: 'late!' })
    expect(lateFinals.length).toBe(0)
  })

  it('finalize() arriving real stt.final does NOT also trigger onLateFinal', async () => {
    const engine = makeEngine({ finalizeTimeoutMs: 200 })
    const startP = engine.start({ voiceSessionId: 'v1' })
    mockWs!.open()
    const session = await startP
    const lateFinals: any[] = []
    session.onLateFinal!((r) => lateFinals.push(r))

    const finalP = session.finalize()
    mockWs!.recv({ type: 'stt.final', text: 'real-final.' })
    const result = await finalP
    expect(result.text).toBe('real-final.')
    expect(lateFinals.length).toBe(0)
  })
})
