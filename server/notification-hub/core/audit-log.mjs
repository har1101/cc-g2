// Append-only JSONL audit log for permission events (Phase 5 §5.6).
//
// Events: permission.classified | permission.answered | permission.blocked |
//         permission.forced_deny
//
// File path defaults to `${HUB_DATA_DIR}/audit.log.jsonl`. The file is
// created on first write; rotation is out-of-scope (manual / cron, 30-day
// retention is documentation-only).
//
// All writes are best-effort: failures log to core/log but never throw to
// the caller, so a disk-full situation cannot break the permission flow.
//
// DAG: leaf module. Imports core/log + core/config only. No service edges.
import { appendFile } from 'node:fs/promises'
import path from 'node:path'
import { config } from './config.mjs'
import { log } from './log.mjs'

let auditFile = path.join(config.dataDir, 'audit.log.jsonl')

/**
 * Override the audit log file path. Used by tests to redirect the log into a
 * tmpdir. Production callers should not need this.
 * @param {string} filePath
 */
export function setAuditFilePath(filePath) {
  auditFile = filePath
}

export function getAuditFilePath() {
  return auditFile
}

/**
 * Append one JSONL entry. Adds `ts` (ISO-8601) automatically.
 * Fire-and-forget — never throws to the caller.
 *
 * @param {{ event: string, [k: string]: unknown }} entry
 */
export function writeAuditEntry(entry) {
  if (!entry || typeof entry !== 'object' || typeof entry.event !== 'string') return
  const ts = typeof entry.ts === 'string' ? entry.ts : new Date().toISOString()
  // Build a copy with ts at the front of the JSON output for grep-friendliness.
  const { ts: _ignored, ...rest } = entry
  const line = JSON.stringify({ ts, ...rest })
  appendFile(auditFile, `${line}\n`, 'utf8').catch((err) => {
    log(`audit-log append failed: ${err instanceof Error ? err.message : String(err)}`)
  })
}
