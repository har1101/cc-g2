/**
 * Phase 2 Pass 1: WSS upgrade scaffold.
 *
 * Tests the `attachSttStreamWss(httpServer, deps)` route in isolation:
 * - 401 on missing/invalid X-CC-G2-Token
 * - rate-limit beyond maxConcurrent
 * - stt.start validation
 * - PCM forwarded to engine
 * - stt.finalize → stt.final
 * - stt.cancel
 * - close without finalize → engine.cancel called
 *
 * The engine is mocked; the real Deepgram engine is tested separately in
 * Pass 2 (test/hub-stt-deepgram-engine.test.mjs).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import { once } from 'node:events'
import WebSocket from 'ws'

import { attachSttStreamWss, _resetActiveConnections } from '../server/notification-hub/routes/stt-stream.mjs'

function fakeEngineFactory() {
  const sessions = []
  function createEngine() {
    return {
      kind: 'deepgram-stream',
      async start({ voiceSessionId, lang }) {
        const partialHandlers = []
        const errorHandlers = []
        const pushed = []
        let finalized = false
        let cancelled = false
        const session = {
          voiceSessionId,
          lang,
          pushed,
          partialHandlers,
          errorHandlers,
          isFinalized: () => finalized,
          isCancelled: () => cancelled,
          async pushPcm(chunk) {
            pushed.push(chunk)
          },
          async finalize() {
            finalized = true
            return { text: 'hello world', confidence: 0.9, duration_ms: 1234 }
          },
          async cancel() {
            cancelled = true
          },
          onPartial(h) { partialHandlers.push(h) },
          onError(h) { errorHandlers.push(h) },
          /** Test-only: emit a partial back to the client. */
          emitPartial(p) { for (const h of partialHandlers) h(p) },
          emitError(e) { for (const h of errorHandlers) h(e) },
        }
        sessions.push(session)
        return session
      },
    }
  }
  return { createEngine, sessions }
}

async function startTestServer(deps) {
  _resetActiveConnections()
  const server = createServer((_req, res) => {
    res.statusCode = 404
    res.end('not found')
  })
  attachSttStreamWss(server, deps)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return {
    server,
    url: `ws://127.0.0.1:${port}/api/v1/stt/stream`,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

function nextMessage(ws) {
  return new Promise((resolve, reject) => {
    const onMsg = (data) => {
      ws.off('message', onMsg)
      ws.off('close', onClose)
      ws.off('error', onError)
      resolve(data)
    }
    const onClose = (code, reason) => {
      ws.off('message', onMsg)
      ws.off('error', onError)
      reject(Object.assign(new Error('closed before message'), { code, reason: reason && reason.toString() }))
    }
    const onError = (err) => {
      ws.off('message', onMsg)
      ws.off('close', onClose)
      reject(err)
    }
    ws.on('message', onMsg)
    ws.on('close', onClose)
    ws.on('error', onError)
  })
}

function nextClose(ws) {
  return new Promise((resolve) => {
    ws.once('close', (code, reason) => resolve({ code, reason: reason ? reason.toString() : '' }))
  })
}

describe('hub stt-stream route (Pass 1)', () => {
  let env

  afterEach(async () => {
    if (env) await env.close()
    env = null
    _resetActiveConnections()
  })

  it('rejects upgrades with no token when hubAuthToken is set', async () => {
    const factory = fakeEngineFactory()
    env = await startTestServer({
      hubAuthToken: 'secret',
      createSttEngine: factory.createEngine,
    })
    const ws = new WebSocket(env.url)
    const result = await new Promise((resolve) => {
      ws.on('error', (err) => resolve({ kind: 'error', err }))
      ws.on('unexpected-response', (_req, res) => resolve({ kind: 'http', status: res.statusCode }))
      ws.on('open', () => resolve({ kind: 'open' }))
    })
    if (result.kind === 'open') ws.close()
    expect(result.kind).not.toBe('open')
    if (result.kind === 'http') expect(result.status).toBe(401)
  })

  it('accepts when hubAuthToken matches', async () => {
    const factory = fakeEngineFactory()
    env = await startTestServer({
      hubAuthToken: 'secret',
      createSttEngine: factory.createEngine,
    })
    const ws = new WebSocket(env.url, { headers: { 'X-CC-G2-Token': 'secret' } })
    await once(ws, 'open')
    expect(ws.readyState).toBe(WebSocket.OPEN)
    ws.close()
    await once(ws, 'close')
  })

  it('accepts token via Sec-WebSocket-Protocol subprotocol (browser path)', async () => {
    const factory = fakeEngineFactory()
    env = await startTestServer({
      hubAuthToken: 'secret',
      createSttEngine: factory.createEngine,
    })
    // Browsers can't set arbitrary headers but can negotiate subprotocols.
    const ws = new WebSocket(env.url, ['cc-g2-token.secret'])
    await once(ws, 'open')
    expect(ws.readyState).toBe(WebSocket.OPEN)
    expect(ws.protocol).toBe('cc-g2-token.secret')
    ws.close()
    await once(ws, 'close')
  })

  it('accepts token via ?token= query string (older browser fallback)', async () => {
    const factory = fakeEngineFactory()
    env = await startTestServer({
      hubAuthToken: 'secret',
      createSttEngine: factory.createEngine,
    })
    const ws = new WebSocket(`${env.url}?token=secret`)
    await once(ws, 'open')
    expect(ws.readyState).toBe(WebSocket.OPEN)
    ws.close()
    await once(ws, 'close')
  })

  it('rejects when subprotocol token is wrong', async () => {
    const factory = fakeEngineFactory()
    env = await startTestServer({
      hubAuthToken: 'secret',
      createSttEngine: factory.createEngine,
    })
    const ws = new WebSocket(env.url, ['cc-g2-token.bad'])
    const result = await new Promise((resolve) => {
      ws.on('error', (err) => resolve({ kind: 'error', err }))
      ws.on('unexpected-response', (_req, res) => resolve({ kind: 'http', status: res.statusCode }))
      ws.on('open', () => resolve({ kind: 'open' }))
    })
    if (result.kind === 'open') ws.close()
    expect(result.kind).not.toBe('open')
    if (result.kind === 'http') expect(result.status).toBe(401)
  })

  it('rate-limits beyond maxConcurrent', async () => {
    const factory = fakeEngineFactory()
    env = await startTestServer({
      hubAuthToken: '',
      createSttEngine: factory.createEngine,
      maxConcurrent: 2,
    })
    const ws1 = new WebSocket(env.url)
    const ws2 = new WebSocket(env.url)
    await once(ws1, 'open')
    await once(ws2, 'open')

    const ws3 = new WebSocket(env.url)
    const blocked = await new Promise((resolve) => {
      ws3.on('error', () => {})
      ws3.on('unexpected-response', (_req, res) => resolve(res.statusCode))
      ws3.on('open', () => resolve('open'))
    })
    expect(blocked).toBe(503)
    ws1.close(); ws2.close()
    await Promise.all([once(ws1, 'close'), once(ws2, 'close')])
  })

  it('rejects invalid stt.start frame', async () => {
    const factory = fakeEngineFactory()
    env = await startTestServer({ hubAuthToken: '', createSttEngine: factory.createEngine })
    const ws = new WebSocket(env.url)
    await once(ws, 'open')

    ws.send(JSON.stringify({ type: 'stt.start', voice_session_id: 'v1', engine: 'wrong' }))
    const data = await nextMessage(ws)
    const msg = JSON.parse(data.toString())
    expect(msg.type).toBe('stt.error')
    expect(msg.code).toBe('invalid_start')
    await nextClose(ws)
  })

  it('forwards PCM to engine and returns stt.final on finalize', async () => {
    const factory = fakeEngineFactory()
    env = await startTestServer({ hubAuthToken: '', createSttEngine: factory.createEngine })
    const ws = new WebSocket(env.url)
    await once(ws, 'open')

    ws.send(JSON.stringify({
      type: 'stt.start',
      voice_session_id: 'v1',
      engine: 'deepgram-stream',
      encoding: 'linear16',
      sample_rate: 16000,
      channels: 1,
      lang: 'ja',
    }))
    // give the server one tick to construct the session
    await new Promise((r) => setTimeout(r, 10))

    ws.send(Buffer.from([1, 2, 3, 4]))
    ws.send(Buffer.from([5, 6, 7, 8]))
    await new Promise((r) => setTimeout(r, 10))
    ws.send(JSON.stringify({ type: 'stt.finalize', voice_session_id: 'v1' }))

    const data = await nextMessage(ws)
    const msg = JSON.parse(data.toString())
    expect(msg.type).toBe('stt.final')
    expect(msg.text).toBe('hello world')
    await nextClose(ws)

    expect(factory.sessions).toHaveLength(1)
    const s = factory.sessions[0]
    expect(s.pushed.length).toBe(2)
    expect(s.isFinalized()).toBe(true)
  })

  it('forwards engine partials to the client', async () => {
    const factory = fakeEngineFactory()
    env = await startTestServer({ hubAuthToken: '', createSttEngine: factory.createEngine })
    const ws = new WebSocket(env.url)
    await once(ws, 'open')

    ws.send(JSON.stringify({
      type: 'stt.start',
      voice_session_id: 'v1',
      engine: 'deepgram-stream',
      encoding: 'linear16',
      sample_rate: 16000,
      channels: 1,
      lang: 'ja',
    }))
    await new Promise((r) => setTimeout(r, 20))
    expect(factory.sessions.length).toBe(1)
    const s = factory.sessions[0]
    s.emitPartial({ stable_text: 'こん', partial_text: 'にちは', stable_seq: 1, partial_seq: 5 })

    const data = await nextMessage(ws)
    const msg = JSON.parse(data.toString())
    expect(msg.type).toBe('stt.partial')
    expect(msg.stable_text).toBe('こん')
    expect(msg.partial_text).toBe('にちは')
    expect(msg.stable_seq).toBe(1)
    expect(msg.partial_seq).toBe(5)
    ws.close()
    await once(ws, 'close')
  })

  it('cancels engine when client closes without finalize', async () => {
    const factory = fakeEngineFactory()
    env = await startTestServer({ hubAuthToken: '', createSttEngine: factory.createEngine })
    const ws = new WebSocket(env.url)
    await once(ws, 'open')

    ws.send(JSON.stringify({
      type: 'stt.start',
      voice_session_id: 'v1',
      engine: 'deepgram-stream',
      encoding: 'linear16',
      sample_rate: 16000,
      channels: 1,
      lang: 'ja',
    }))
    await new Promise((r) => setTimeout(r, 20))
    expect(factory.sessions.length).toBe(1)
    ws.close()
    await once(ws, 'close')
    // give the server a tick to fire cancel()
    await new Promise((r) => setTimeout(r, 20))
    expect(factory.sessions[0].isCancelled()).toBe(true)
  })

  it('explicit stt.cancel calls engine.cancel and closes', async () => {
    const factory = fakeEngineFactory()
    env = await startTestServer({ hubAuthToken: '', createSttEngine: factory.createEngine })
    const ws = new WebSocket(env.url)
    await once(ws, 'open')

    ws.send(JSON.stringify({
      type: 'stt.start',
      voice_session_id: 'v2',
      engine: 'deepgram-stream',
      encoding: 'linear16',
      sample_rate: 16000,
      channels: 1,
      lang: 'ja',
    }))
    await new Promise((r) => setTimeout(r, 10))
    ws.send(JSON.stringify({ type: 'stt.cancel', voice_session_id: 'v2' }))
    await once(ws, 'close')
    expect(factory.sessions[0].isCancelled()).toBe(true)
  })
})
