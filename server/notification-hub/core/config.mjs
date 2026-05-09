// Hub-wide configuration parsed from process.env. Keeping this in a single
// module makes Phase 2-5's growing config surface easier to review.
import path from 'node:path'

const legacyHubBind = process.env.HUB_BIND
const bindModeRaw = process.env.HUB_BIND_MODE
let bindMode = bindModeRaw || 'tailnet'
if (!['tailnet', 'localhost', 'any'].includes(bindMode)) {
  console.warn(`[hub] unknown HUB_BIND_MODE="${bindMode}" — falling back to "tailnet"`)
  bindMode = 'tailnet'
}
const tailscaleIp = String(process.env.HUB_TAILSCALE_IP || '').trim()

// Internal hook scripts hard-code http://127.0.0.1:8787, so 'tailnet' must keep
// loopback reachable while phones reach us via the Tailscale IP. See design §7.1.
export function resolveBindHosts() {
  if (!bindModeRaw && legacyHubBind) {
    console.warn('[hub] HUB_BIND is deprecated — set HUB_BIND_MODE (tailnet|localhost|any) instead')
    return [legacyHubBind]
  }
  if (bindMode === 'localhost') return ['127.0.0.1']
  if (bindMode === 'any') return ['0.0.0.0']
  const hosts = ['127.0.0.1']
  if (tailscaleIp) hosts.push(tailscaleIp)
  else console.warn('[hub] HUB_TAILSCALE_IP not set — listening on loopback only')
  return hosts
}

function boolFromEnv(name) {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env[name] || '').toLowerCase())
}

export const config = {
  port: Number(process.env.HUB_PORT || '8787'),
  dataDir: path.resolve(process.env.HUB_DATA_DIR || 'tmp/notification-hub'),
  hubAuthToken: String(process.env.HUB_AUTH_TOKEN || '').trim(),
  hubAllowedOrigins: new Set(
    String(process.env.HUB_ALLOWED_ORIGINS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  ),
  hubPersistRaw: boolFromEnv('HUB_PERSIST_RAW'),
  hubPersistToolInput: boolFromEnv('HUB_PERSIST_TOOL_INPUT'),
  groqApiKey: String(process.env.GROQ_API_KEY || '').trim(),
  groqModelDefault: String(process.env.GROQ_MODEL || 'whisper-large-v3').trim(),
  // Phase 2: Deepgram streaming. Empty apiKey → engine refuses to start with
  // code 'no_api_key'; the frontend should fall back to groq-batch in that
  // case (handled by VITE_STT_ENGINE_VOICE_COMMAND env).
  deepgramApiKey: String(process.env.DEEPGRAM_API_KEY || '').trim(),
  deepgramModel: String(process.env.DEEPGRAM_MODEL || 'nova-3').trim(),
  deepgramLanguage: String(process.env.DEEPGRAM_LANGUAGE || 'ja').trim(),
  hubReplyRelayCmd: String(process.env.HUB_REPLY_RELAY_CMD || '').trim(),
  hubReplyRelayTimeoutMs: Math.max(
    1000,
    Number.parseInt(process.env.HUB_REPLY_RELAY_TIMEOUT_MS || '15000', 10) || 15000,
  ),
  // Phase 1 voice/text commands ride the same relay path; allowlist them by default.
  hubReplyRelaySources: new Set(
    String(process.env.HUB_REPLY_RELAY_SOURCES || 'g2,web,g2_voice,g2_text')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  ),
  hubPermissionThreadDedupMs: Math.max(
    0,
    Number.parseInt(process.env.HUB_PERMISSION_THREAD_DEDUP_MS || '8000', 10) || 8000,
  ),
  hubMaxBodyBytes: Math.max(
    1024,
    Number.parseInt(process.env.HUB_MAX_BODY_BYTES || '1048576', 10) || 1048576,
  ),
  hubMaxSttBodyBytes: 0, // patched below to honor the (max-body, env) ceiling
}
config.hubMaxSttBodyBytes = Math.max(
  config.hubMaxBodyBytes,
  Number.parseInt(process.env.HUB_MAX_STT_BODY_BYTES || '12582912', 10) || 12582912,
)
