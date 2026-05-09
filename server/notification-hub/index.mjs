// notification-hub entry point. Owns:
//   - service wiring (cfg-bound wrappers around the layered services)
//   - the request dispatcher (router-style array of route handlers)
//   - HTTP server lifecycle + graceful shutdown
// Real work lives in routes/* → services/* → state/*, transport/*, core/*.
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { log } from './core/log.mjs'
import { config, resolveBindHosts } from './core/config.mjs'
import {
  applyCors,
  isBodyTooLargeError,
  parseUrl,
  sendJson,
  sendRequestBodyTooLarge,
} from './core/http.mjs'
import { isPublicApiRequest, requireApiAuth as coreRequireApiAuth } from './core/auth.mjs'
import { bootstrap as persistenceBootstrap, buildPaths } from './state/persistence.mjs'
import {
  addNotification as notificationServiceAdd,
  forwardReplyIfConfigured,
  processReply as notificationServiceProcessReply,
} from './services/notification-service.mjs'
import {
  buildHookResponseFromApproval,
  cleanupApprovalsOnStop as approvalServiceCleanupOnStop,
  cleanupOnRequesterDisconnect as approvalServiceCleanupOnDisconnect,
  createApproval as approvalServiceCreate,
  markApprovalCleanup as approvalServiceMarkCleanup,
  matchPendingApprovalForReply as approvalServiceMatchForReply,
  resolveApproval as approvalServiceResolve,
  waitForDecision as approvalServiceWaitForDecision,
} from './services/approval-service.mjs'
import { createTmuxRelay } from './transport/tmux-relay.mjs'
import * as healthRoute from './routes/health.mjs'
import * as authRoute from './routes/auth.mjs'
import * as hooksRoute from './routes/hooks.mjs'
import * as notificationsRoute from './routes/notifications.mjs'
import * as approvalsRoute from './routes/approvals.mjs'
import * as sttRoute from './routes/stt.mjs'
import * as clientEventsRoute from './routes/client-events.mjs'
import * as locationRoute from './routes/location.mjs'
import * as contextStatusRoute from './routes/context-status.mjs'
import * as commandRoute from './routes/command.mjs'
import * as uiRoute from './routes/ui.mjs'

const { notificationsFile, repliesFile, clientEventsFile, approvalsFile } = buildPaths({
  dataDir: config.dataDir,
})

// --- service wiring ------------------------------------------------------
const approvalCfg = () => ({
  approvalsFile,
  persistToolInput: config.hubPersistToolInput,
})

// Thin wrapper that injects hub-level config and applies the stop-hook
// auto-cleanup side effect. Keeps notification-service free of approval-layer
// knowledge while preserving the all-in-one addNotification call sites.
async function addNotification(payload, logPrefix = 'notification') {
  const result = await notificationServiceAdd(payload, logPrefix, {
    persistRaw: config.hubPersistRaw,
    permissionThreadDedupMs: config.hubPermissionThreadDedupMs,
    notificationsFile,
  })
  if (result.duplicate) return result

  const item = result.item
  const hookType = item?.metadata?.hookType
  if (hookType === 'stop' && item.metadata?.sessionId) {
    approvalServiceCleanupOnStop(
      { sessionId: item.metadata.sessionId, decidedAt: new Date().toISOString() },
      approvalCfg(),
    )
  }
  return result
}

const createApproval = (params) =>
  approvalServiceCreate(params, {
    addNotification,
    approvalsFile,
    persistToolInput: config.hubPersistToolInput,
  })

const resolveApproval = (id, decision, comment, by) =>
  approvalServiceResolve(id, decision, comment, by, approvalCfg())

const markApprovalCleanup = (record, resolution, by, at) =>
  approvalServiceMarkCleanup(record, resolution, by, at, approvalCfg())

const cleanupApprovalOnDisconnect = (approvalId) =>
  approvalServiceCleanupOnDisconnect(approvalId, approvalCfg())

const waitForApprovalDecision = (params) => approvalServiceWaitForDecision(params)

const relayReplyIfConfigured = createTmuxRelay({
  cmd: config.hubReplyRelayCmd,
  timeoutMs: config.hubReplyRelayTimeoutMs,
  allowedSources: config.hubReplyRelaySources,
})

const processReply = (input) =>
  notificationServiceProcessReply(input, {
    matchPendingApprovalForReply: approvalServiceMatchForReply,
    resolveApproval,
    forwardReplyIfConfigured,
    relayReplyIfConfigured,
    repliesFile,
  })

// macOS-only desktop heads-up. Routes that need it call deps.spawnLocalNotification.
function spawnLocalNotification(toolName) {
  try {
    const child = spawn('terminal-notifier', [
      '-title', 'Permission',
      '-message', `${toolName} approval pending`,
      '-open', `http://127.0.0.1:${config.port}/ui`,
      '-sound', 'Glass',
    ], { timeout: 5000, stdio: 'ignore' })
    child.on('error', () => {}) // コマンド未導入時の ENOENT を無視
  } catch { /* ignore */ }
}

// --- request dispatcher --------------------------------------------------
const routeHandlers = [
  healthRoute.handle,
  authRoute.handle,
  hooksRoute.handle,
  sttRoute.handle,
  clientEventsRoute.handle,
  locationRoute.handle,
  contextStatusRoute.handle,
  commandRoute.handle,
  approvalsRoute.handle,
  notificationsRoute.handle,
  uiRoute.handle,
]

const deps = {
  hubAuthToken: config.hubAuthToken,
  hubMaxBodyBytes: config.hubMaxBodyBytes,
  hubMaxSttBodyBytes: config.hubMaxSttBodyBytes,
  hubPersistRaw: config.hubPersistRaw,
  groqApiKey: config.groqApiKey,
  groqModelDefault: config.groqModelDefault,
  notificationsFile,
  repliesFile,
  clientEventsFile,
  addNotification,
  createApproval,
  resolveApproval,
  markApprovalCleanup,
  cleanupApprovalOnDisconnect,
  waitForApprovalDecision,
  buildHookResponseFromApproval,
  forwardReplyIfConfigured,
  relayReplyIfConfigured,
  processReply,
  spawnLocalNotification,
}

const handler = async (req, res) => {
  const method = req.method || 'GET'
  const url = parseUrl(req)
  const pathname = url.pathname

  if (!applyCors(req, res, config.hubAllowedOrigins)) {
    return sendJson(res, 403, { ok: false, error: 'Origin not allowed' })
  }
  if (method === 'OPTIONS') {
    res.statusCode = 204
    return res.end()
  }
  if (pathname.startsWith('/api/') && !isPublicApiRequest(method, pathname)) {
    if (!coreRequireApiAuth(req, res, config.hubAuthToken)) return
  }

  const ctx = { method, pathname, url, deps }
  try {
    for (const route of routeHandlers) {
      if (await route(req, res, ctx)) return
    }
    return sendJson(res, 404, { ok: false, error: 'Not found' })
  } catch (err) {
    if (isBodyTooLargeError(err)) {
      return sendRequestBodyTooLarge(res, err)
    }
    throw err
  }
}

// --- bootstrap + listen --------------------------------------------------
await persistenceBootstrap({
  dataDir: config.dataDir,
  notificationsFile,
  repliesFile,
  approvalsFile,
})

const bindHosts = resolveBindHosts()
const servers = bindHosts.map((bindHost) => {
  const s = createServer(handler)
  s.on('error', (err) => {
    log(`[hub] listen failed on ${bindHost}: ${err.code} ${err.message}`)
    process.exitCode = 1
    shutdown('listen-error')
  })
  s.listen(config.port, bindHost, () => {
    log(`notification-hub listening on http://${bindHost}:${config.port}`)
  })
  return s
})

let shuttingDown = false
function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  log(`notification-hub shutting down (${signal})`)
  for (const s of servers) {
    try { s.close() } catch {}
    try { s.closeAllConnections() } catch {}
  }
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
