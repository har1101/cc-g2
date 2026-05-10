// Client-events service: append-only event log for frontend telemetry.
// Owns validation/normalization and JSONL persistence.
// May call: state/persistence, notification-utils, core/log.
import { randomUUID } from 'node:crypto'
import { getString } from '../notification-utils.mjs'
import { appendJsonl } from '../state/persistence.mjs'

/**
 * Append a single client-event line to the JSONL log.
 *
 * @param {any} payload - already-parsed JSON body from the route
 * @param {{ clientEventsFile: string }} cfg
 * @returns {Promise<{ ok: true, line: any }>}
 */
export async function appendClientEvent(payload, cfg) {
  const p = (payload && typeof payload === 'object') ? payload : {}
  const line = {
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    source: getString(p.source, 'web-client'),
    message: getString(p.message),
    level: getString(p.level, 'info'),
    context: typeof p.context === 'object' && p.context !== null ? p.context : undefined,
  }
  await appendJsonl(cfg.clientEventsFile, line)
  return { ok: true, line }
}
