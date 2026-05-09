// JSONL persistence and bootstrap (replay-on-start) for the in-memory store.
// Files are append-only; bootstrap reconstructs the store from disk.
//
// Phase 3 adds a sessions.json *snapshot* (full overwrite on each change) for
// the AgentSession registry, since session lifecycles are short and we always
// want a complete current view rather than an event log.
import { mkdir, readFile, appendFile, writeFile, rename } from 'node:fs/promises'
import path from 'node:path'
import { log } from '../core/log.mjs'
import * as store from './store.mjs'

/**
 * @param {{ dataDir: string }} opts
 */
export function buildPaths(opts) {
  const dataDir = opts.dataDir
  return {
    dataDir,
    notificationsFile: path.join(dataDir, 'notifications.jsonl'),
    repliesFile: path.join(dataDir, 'replies.jsonl'),
    clientEventsFile: path.join(dataDir, 'client-events.jsonl'),
    approvalsFile: path.join(dataDir, 'approvals.jsonl'),
    sessionsFile: path.join(dataDir, 'sessions.json'),
  }
}

async function ensureDataDir(dataDir) {
  await mkdir(dataDir, { recursive: true })
}

async function loadJsonl(filePath) {
  try {
    const raw = await readFile(filePath, 'utf8')
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') return []
    throw err
  }
}

export async function appendJsonl(filePath, obj) {
  await appendFile(filePath, `${JSON.stringify(obj)}\n`, 'utf8')
}

/**
 * Atomically write a JSON snapshot via tmp file + rename.
 * Used by sessions.json (Phase 3) where we always want the full current view.
 */
export async function writeJsonSnapshot(filePath, obj) {
  const tmp = `${filePath}.tmp`
  await writeFile(tmp, `${JSON.stringify(obj, null, 2)}\n`, 'utf8')
  await rename(tmp, filePath)
}

async function loadJsonSnapshot(filePath) {
  try {
    const raw = await readFile(filePath, 'utf8')
    return JSON.parse(raw)
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') return null
    throw err
  }
}

/**
 * Boot the in-memory store from on-disk JSONL files. Idempotent for the
 * caller (always re-creates dataDir) but mutates the shared store module.
 * @param {{ dataDir: string, notificationsFile: string, repliesFile: string, approvalsFile: string }} paths
 */
export async function bootstrap(paths) {
  await ensureDataDir(paths.dataDir)
  const storedNotifications = await loadJsonl(paths.notificationsFile)
  for (const item of storedNotifications) {
    store.notifications.push(item)
    if (item && item.id) store.notificationsById.set(item.id, item)
    const extId =
      item &&
      item.metadata &&
      typeof item.metadata === 'object' &&
      typeof item.metadata.externalId === 'string'
        ? item.metadata.externalId
        : ''
    if (extId) store.notificationExternalIds.add(extId)
  }
  const storedReplies = await loadJsonl(paths.repliesFile)
  for (const reply of storedReplies) store.replies.push(reply)
  const storedApprovals = await loadJsonl(paths.approvalsFile)
  for (const a of storedApprovals) {
    if (a && a.id && !a._event) {
      store.approvals.push(a)
      store.approvalsById.set(a.id, a)
      if (a.notificationId) store.approvalsByNotificationId.set(a.notificationId, a)
    } else if (a && a._event === 'decided' && a.id) {
      const existing = store.approvalsById.get(a.id)
      if (existing) {
        existing.status = a.status
        existing.decision = a.decision
        existing.resolution = a.resolution
        existing.comment = a.comment
        existing.decidedBy = a.decidedBy
        existing.decidedAt = a.decidedAt
        if (a.deliveredAt) existing.deliveredAt = a.deliveredAt
      }
    }
  }
  // Phase 3: restore AgentSession registry from sessions.json snapshot.
  if (paths.sessionsFile) {
    const snapshot = await loadJsonSnapshot(paths.sessionsFile)
    if (snapshot && Array.isArray(snapshot.sessions)) {
      for (const s of snapshot.sessions) {
        if (s && typeof s === 'object' && typeof s.session_id === 'string') {
          store.sessions.set(s.session_id, s)
        }
      }
    }
    if (snapshot && typeof snapshot.activeSessionId === 'string') {
      store.setActiveSessionId(snapshot.activeSessionId)
    }
  }
  log(
    `notification-hub loaded notifications=${store.notifications.length} replies=${store.replies.length} approvals=${store.approvals.length} sessions=${store.sessions.size} dataDir=${paths.dataDir}`,
  )
}
