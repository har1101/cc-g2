// Command service: handles the /api/v1/command pipeline (free-text commands
// from G2 voice / G2 text). Sanitizes the text, persists a synthetic
// notification + reply, and relays via the configured tmux relay.
//
// Allowed dependencies:
//   command-service → notification-service → state/store + state/persistence
// command-service may also call core/log directly. Routes call this; the
// service does not know about HTTP.
import { randomUUID } from 'node:crypto'
import { log } from '../core/log.mjs'
import { persistedNotification } from '../notification-utils.mjs'
import * as store from '../state/store.mjs'
import { appendJsonl } from '../state/persistence.mjs'
import { persistReply } from './notification-service.mjs'

/**
 * Validate, sanitize, and process an incoming command. Persists the
 * synthetic notification + reply and invokes the relay.
 *
 * @param {{
 *   source: unknown,
 *   text: unknown,
 *   transcriptConfidence?: unknown,
 *   tmuxTarget?: unknown,
 * }} input
 * @param {{
 *   relay: (payload: any, opts: { bypassSourceFilter: boolean }) => Promise<{status:string, error?:string}>,
 *   notificationsFile: string,
 *   repliesFile: string,
 *   persistRaw: boolean,
 * }} cfg
 * @returns {Promise<{ status: number, body: any }>}
 */
export async function processCommand(input, cfg) {
  const source = typeof input.source === 'string' ? input.source : ''
  if (source !== 'g2_voice' && source !== 'g2_text') {
    return {
      status: 400,
      body: { ok: false, error: source ? 'invalid source' : 'source is required' },
    }
  }
  if (typeof input.text !== 'string') {
    return { status: 400, body: { ok: false, error: 'text is required' } }
  }
  // 入力をターミナル/ログに渡しても安全になるよう以下を行う:
  // 1) NFC 正規化で結合文字列を canonical 化（日本語・絵文字は破壊しない）
  // 2) C0(\n,\t は除外) + DEL + C1 を除去
  // 3) ZWSP/ZWNJ/ZWJ/BOM を除去（不可視文字でのスプーフィング対策）
  // 4) BiDi 上書き（U+202A-U+202E, U+2066-U+2069）を除去
  // 5) Line/Paragraph Separator (U+2028/U+2029) を除去
  const sanitizedText = String(input.text)
    .normalize('NFC')
    .replace(/[\x00-\x08\x0B-\x1F\x7F-\x9F]/gu, '')
    .replace(/[\u{200B}-\u{200D}\u{FEFF}]/gu, '')
    .replace(/[\u{202A}-\u{202E}\u{2066}-\u{2069}]/gu, '')
    .replace(/[\u{2028}\u{2029}]/gu, '')
    .trim()
  if (!sanitizedText) {
    return { status: 400, body: { ok: false, error: 'text is required' } }
  }
  if (sanitizedText.length > 2000) {
    return { status: 400, body: { ok: false, error: 'text too long' } }
  }

  let transcriptConfidence
  if (input.transcriptConfidence != null) {
    const n = Number(input.transcriptConfidence)
    if (Number.isFinite(n) && n >= 0 && n <= 1) transcriptConfidence = n
  }
  let tmuxTarget
  if (input.tmuxTarget != null) {
    if (typeof input.tmuxTarget !== 'string' || !/^[A-Za-z0-9_./:-]{1,128}$/.test(input.tmuxTarget)) {
      return { status: 400, body: { ok: false, error: 'invalid tmux_target' } }
    }
    tmuxTarget = input.tmuxTarget
  }

  const commandId = `cmd_${randomUUID()}`
  const createdAt = new Date().toISOString()
  // hookType=g2-command keeps reply-relay.sh on the plain-text branch (not approval keypress).
  const notification = {
    id: commandId,
    source: 'claude-code',
    title: '[g2-command]',
    summary: sanitizedText.slice(0, 80),
    fullText: sanitizedText,
    createdAt,
    replyCapable: false,
    metadata: {
      hookType: 'g2-command',
      ...(tmuxTarget ? { tmuxTarget } : {}),
      ...(transcriptConfidence != null ? { transcriptConfidence } : {}),
    },
  }
  /** @type {import('../state/store.mjs').ReplyRecord} */
  const reply = {
    id: `cmdrep_${randomUUID()}`,
    notificationId: commandId,
    replyText: sanitizedText,
    createdAt,
    status: 'stubbed',
    action: 'comment',
    source,
  }

  store.notifications.push(notification)
  store.notificationsById.set(notification.id, notification)
  await appendJsonl(cfg.notificationsFile, persistedNotification(notification, { persistRaw: cfg.persistRaw }))

  let relay
  try {
    // /api/v1/command はリレー専用エンドポイントなので、HUB_REPLY_RELAY_SOURCES に
    // g2_voice / g2_text が無くても必ずリレーする (operator が legacy 'g2,web' のままでも
    // voice command が silently 'stubbed' にならないようにする)
    relay = await cfg.relay({ reply, notification }, { bypassSourceFilter: true })
    if (relay.status === 'forwarded') reply.status = 'forwarded'
    else if (relay.status === 'failed') reply.status = 'failed'
    else reply.status = 'stubbed'
    if (relay.error) reply.error = relay.error
    await persistReply(reply, { repliesFile: cfg.repliesFile })
  } catch (err) {
    const errMessage = err instanceof Error ? err.message : String(err)
    reply.status = 'failed'
    reply.error = errMessage
    log(`command relay threw id=${commandId} source=${source} error=${errMessage}`)
    // Best-effort audit append; do not double-throw.
    try {
      await persistReply(reply, { repliesFile: cfg.repliesFile })
    } catch (appendErr) {
      log(
        `command reply append failed id=${commandId} error=${appendErr instanceof Error ? appendErr.message : String(appendErr)}`,
      )
    }
    return { status: 502, body: { ok: false, error: 'relay failed', details: errMessage } }
  }

  log(
    `command accepted id=${commandId} source=${source} length=${sanitizedText.length} status=${relay.status}`,
  )

  if (relay.status === 'failed') {
    return { status: 502, body: { ok: false, error: 'relay failed', details: relay.error } }
  }
  if (relay.status === 'stubbed') {
    return { status: 200, body: { ok: true, delivered_at: createdAt, relay: 'stubbed' } }
  }
  return { status: 200, body: { ok: true, delivered_at: createdAt } }
}
