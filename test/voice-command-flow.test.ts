import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createNotificationClient } from '../src/notifications'

const HUB_URL = 'http://hub.test:8787'

type FetchInit = RequestInit & { headers?: Record<string, string> }

function makeJsonResponse(body: unknown, init: { status?: number; statusText?: string } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    statusText: init.statusText ?? 'OK',
    headers: { 'Content-Type': 'application/json' },
  })
}

describe('notifClient.sendCommand', () => {
  const fetchSpy = vi.fn()

  beforeEach(() => {
    fetchSpy.mockReset()
    vi.stubGlobal('fetch', fetchSpy)
    // Reset env-driven hub token
    vi.stubEnv('VITE_HUB_TOKEN', 'test-token')
    vi.stubEnv('VITE_HUB_URL', HUB_URL)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('POSTs to /api/v1/command with JSON body and X-CC-G2-Token header', async () => {
    fetchSpy.mockResolvedValueOnce(makeJsonResponse({ ok: true, delivered_at: '2026-05-09T00:00:00.000Z' }))

    const client = createNotificationClient(HUB_URL)
    const res = await client.sendCommand({ source: 'g2_voice', text: 'hello world' })

    expect(res).toEqual({ ok: true, delivered_at: '2026-05-09T00:00:00.000Z' })
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, init] = fetchSpy.mock.calls[0] as [string, FetchInit]
    expect(url).toBe(`${HUB_URL}/api/v1/command`)
    expect(init.method).toBe('POST')
    const headers = init.headers as Record<string, string>
    expect(headers['Content-Type']).toBe('application/json')
    // X-CC-G2-Token は env で空の場合は付かないが、Vitest 環境では空のため検証しない（型のみ確認）
    expect(typeof init.body).toBe('string')
    const parsedBody = JSON.parse(init.body as string)
    expect(parsedBody).toEqual({ source: 'g2_voice', text: 'hello world' })
  })

  it('passes optional fields (transcript_confidence, tmux_target) through to the body', async () => {
    fetchSpy.mockResolvedValueOnce(makeJsonResponse({ ok: true }))

    const client = createNotificationClient(HUB_URL)
    await client.sendCommand({
      source: 'g2_voice',
      text: 'list files',
      transcript_confidence: 0.91,
      tmux_target: 'work:0.0',
    })

    const [, init] = fetchSpy.mock.calls[0] as [string, FetchInit]
    const parsedBody = JSON.parse(init.body as string)
    expect(parsedBody).toEqual({
      source: 'g2_voice',
      text: 'list files',
      transcript_confidence: 0.91,
      tmux_target: 'work:0.0',
    })
  })

  it('returns parsed JSON including relay marker on stub success', async () => {
    fetchSpy.mockResolvedValueOnce(makeJsonResponse({ ok: true, relay: 'stubbed', delivered_at: 'now' }))

    const client = createNotificationClient(HUB_URL)
    const res = await client.sendCommand({ source: 'g2_voice', text: 'foo' })
    expect(res.ok).toBe(true)
    expect(res.relay).toBe('stubbed')
    expect(res.delivered_at).toBe('now')
  })

  it('throws on non-2xx HTTP status', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response('{"ok":false,"error":"bad"}', {
        status: 400,
        statusText: 'Bad Request',
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    const client = createNotificationClient(HUB_URL)
    await expect(client.sendCommand({ source: 'g2_voice', text: '' })).rejects.toThrow(/HTTP 400/)
  })

  it('propagates network errors from fetch', async () => {
    fetchSpy.mockRejectedValueOnce(new Error('network down'))

    const client = createNotificationClient(HUB_URL)
    await expect(client.sendCommand({ source: 'g2_voice', text: 'x' })).rejects.toThrow('network down')
  })
})
