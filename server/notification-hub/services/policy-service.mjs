// Policy service (Phase 5): three-tier permission classification.
//
// Tiers:
//   - 'normal'      → existing approval flow (G2 reviews, single-step)
//   - 'destructive' → G2 must do a 2-step swipe-up confirm; Hub force-denies
//                     `action=approve` without `two_step_confirmed=true`
//   - 'hard_deny'   → Hub denies immediately; no approval is created;
//                     G2 sees a permission.blocked notification
//
// Design constraint (v4 §5.1, Codex emphatic): regex-only matching gets
// bypassed by trivial flag-order / wrapper / path tricks. So Bash command
// classification *must* be structurally tokenized:
//   - argv split with quote / escape handling
//   - env-var prefix stripping (`KEY=VAL cmd ...`)
//   - wrapper stripping (`command sudo`, `env ... sudo`, `builtin cd`)
//   - absolute-path resolution (`/usr/bin/sudo` → `sudo`)
//   - segment-OR across `;`, `&&`, `||`, `|` (any segment hard-deny → hard-deny;
//     any destructive → destructive; else normal)
//
// DAG: this is a *leaf* service. It reads tool_name + tool_input only, never
// touches state/store, persistence, transport, or other services. routes/hooks
// is the sole caller (plus tests).
//
// Audit-log emission lives here (lazy import to keep the policy classify path
// fast and to avoid a service → state edge if audit-log later moves).

import path from 'node:path'
import { writeAuditEntry } from '../core/audit-log.mjs'

// ---------------------------------------------------------------------------
// Tokenizer: POSIX-light shell parser
// ---------------------------------------------------------------------------

/**
 * Tokenize a bash command into a list of segments, where each segment is an
 * argv array. Segments are split by `;`, `&&`, `||`, `|`. Inside a segment we
 * honour single quotes (literal), double quotes (literal w/ \" escape), and
 * backslash escapes.
 *
 * This is **not** a complete POSIX shell parser. It only needs to cover the
 * commands that real agents (Claude Code / Codex) emit. Heredocs, command
 * substitution, process substitution, and brace expansion are intentionally
 * not interpreted — they fall through as plain tokens, which is fine for our
 * downstream classifiers (we look at the head + flags, not deep semantics).
 *
 * @param {string} cmd
 * @returns {string[][]} list of argv arrays (one per segment)
 */
export function tokenizeBash(cmd) {
  const src = String(cmd ?? '')
  /** @type {string[][]} */
  const segments = []
  /** @type {string[]} */
  let argv = []
  let buf = ''
  let inSingle = false
  let inDouble = false
  let hasToken = false // true once we've started writing into the current word

  function flushToken() {
    if (hasToken) {
      argv.push(buf)
      buf = ''
      hasToken = false
    }
  }
  function flushSegment() {
    flushToken()
    if (argv.length > 0) segments.push(argv)
    argv = []
  }

  for (let i = 0; i < src.length; i++) {
    const ch = src[i]

    if (inSingle) {
      if (ch === "'") inSingle = false
      else { buf += ch; hasToken = true }
      continue
    }
    if (inDouble) {
      if (ch === '\\' && i + 1 < src.length) {
        const next = src[i + 1]
        // In double quotes, \ only escapes a small set; otherwise the \ is literal.
        if (next === '"' || next === '\\' || next === '$' || next === '`' || next === '\n') {
          buf += next
          hasToken = true
          i++
          continue
        }
        buf += ch
        hasToken = true
        continue
      }
      if (ch === '"') { inDouble = false; continue }
      buf += ch
      hasToken = true
      continue
    }

    // Unquoted
    if (ch === '\\' && i + 1 < src.length) {
      buf += src[i + 1]
      hasToken = true
      i++
      continue
    }
    if (ch === "'") { inSingle = true; hasToken = true; continue }
    if (ch === '"') { inDouble = true; hasToken = true; continue }
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      flushToken()
      continue
    }
    if (ch === ';') {
      flushSegment()
      continue
    }
    if (ch === '&' && src[i + 1] === '&') {
      flushSegment()
      i++
      continue
    }
    if (ch === '|' && src[i + 1] === '|') {
      flushSegment()
      i++
      continue
    }
    if (ch === '|') {
      flushSegment()
      continue
    }
    // Redirection operators terminate the current word but the redirect
    // target follows; we keep parsing but skip the operator itself.
    if (ch === '>' || ch === '<') {
      flushToken()
      // capture optional trailing > for >> by leaving the chars to the next
      // iteration — they'll just appear as a separate "token" we ignore.
      continue
    }
    buf += ch
    hasToken = true
  }
  flushSegment()
  return segments
}

// ---------------------------------------------------------------------------
// Wrapper / env stripping
// ---------------------------------------------------------------------------

/**
 * Strip leading `KEY=VAL` env-var prefixes from an argv. Returns a tuple of
 * [envEntries, rest] so callers can inspect both.
 *
 * @param {string[]} argv
 * @returns {{ env: string[], rest: string[] }}
 */
function splitLeadingEnv(argv) {
  const env = []
  let i = 0
  while (i < argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[i])) {
    env.push(argv[i])
    i++
  }
  return { env, rest: argv.slice(i) }
}

/**
 * Strip a single layer of `command|builtin|env [KEY=VAL...]` wrapper from the
 * head. Returns the same array if the head is not a wrapper.
 *
 * Note: does NOT recurse — `command env FOO=bar sudo ...` is unwrapped one
 * step at a time by the caller.
 *
 * @param {string[]} argv
 * @returns {{ argv: string[], extraEnv: string[] }}
 */
function stripOneWrapper(argv) {
  if (argv.length === 0) return { argv, extraEnv: [] }
  const head = path.basename(argv[0])
  if (head === 'command' || head === 'builtin' || head === 'exec') {
    return { argv: argv.slice(1), extraEnv: [] }
  }
  if (head === 'env') {
    // env may take its own flags; strip leading flags (-i, -u VAR, --) and env entries.
    let i = 1
    const extraEnv = []
    while (i < argv.length) {
      const a = argv[i]
      if (a === '--') { i++; break }
      if (a === '-i' || a === '--ignore-environment') { i++; continue }
      if (a === '-u' || a === '--unset') { i += 2; continue }
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(a)) { extraEnv.push(a); i++; continue }
      break
    }
    return { argv: argv.slice(i), extraEnv }
  }
  return { argv, extraEnv: [] }
}

/**
 * Fully unwrap leading wrappers + env prefixes. Returns the cleaned argv plus
 * the union of all stripped env entries (so we can scan them for SECRET=
 * style hard-denies).
 *
 * @param {string[]} argv
 * @returns {{ argv: string[], env: string[] }}
 */
function stripWrappersAndEnv(argv) {
  let working = argv
  let env = []
  for (let pass = 0; pass < 8; pass++) {
    const leading = splitLeadingEnv(working)
    if (leading.env.length > 0) {
      env = env.concat(leading.env)
      working = leading.rest
    }
    const unwrap = stripOneWrapper(working)
    if (unwrap.argv === working && unwrap.extraEnv.length === 0) break
    env = env.concat(unwrap.extraEnv)
    working = unwrap.argv
  }
  return { argv: working, env }
}

// ---------------------------------------------------------------------------
// Per-segment Bash classifier
// ---------------------------------------------------------------------------

const SECRET_ENV_RE = /^(?:.*_)?(?:SECRET|PASSWORD|API_?KEY|TOKEN|PASSWD)(?:_.*)?=/i

function containsSecretEnv(envEntries) {
  return envEntries.some((e) => SECRET_ENV_RE.test(e))
}

/**
 * `rm` targets the filesystem root if any of the positional args is `/` or a
 * glob that resolves to `/` (e.g. `/*`).
 */
function rmTargetsRoot(args) {
  for (const a of args) {
    if (a === '/' || a === '/*' || a === '/.' || a === '/..') return true
    // Patterns like "/" with trailing slash variants
    if (/^\/+$/.test(a)) return true
    if (/^\/[*?]+$/.test(a)) return true
  }
  return false
}

/**
 * `aws|gcloud|kubectl` running against a production context/profile/cluster.
 * We deliberately keep this conservative — only triggers on explicit prod tags.
 *
 * Recognises:
 *   - `--context production` / `--context=prod-*`
 *   - `--profile prod-*` / `--profile=prod-*`
 *   - `--cluster prod-*` / `--cluster=prod-*`
 *   - `--project prod-*`  (gcloud)
 *   - any `s3://prod-*` URI (aws s3 commands targeting prod-prefixed bucket)
 */
function hasProdContext(argv) {
  const prodFlagNames = new Set(['--context', '--profile', '--cluster', '--project'])
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (prodFlagNames.has(a) && i + 1 < argv.length && /^prod(uction)?(-|$)/i.test(argv[i + 1])) return true
    if (/^--(?:context|profile|cluster|project)=prod(uction)?(-|$)/i.test(a)) return true
    // s3://prod-* URI heuristic. Matches `s3://prod-bucket/...` etc.
    if (/^s3:\/\/prod(-|\/)/i.test(a)) return true
  }
  return false
}

/**
 * `rm` with a recursive flag (any spelling).
 * Recognises -r, -R, -rf, -fr, -rR, -Rr and any combined flag containing both
 * 'r' (or 'R') with optional 'f', e.g. -rfv, -vrf.
 */
function rmHasRecursiveFlag(argv) {
  for (const a of argv) {
    if (a === '--recursive') return true
    if (a === '-r' || a === '-R') return true
    if (/^-[A-Za-z]+$/.test(a) && /[rR]/.test(a)) return true
  }
  return false
}

/** Find first non-flag positional after argv[0] (exclusive). */
function firstNonFlagArgAfter(argv, startIndex) {
  let i = startIndex
  while (i < argv.length) {
    const a = argv[i]
    if (a === '--') return argv[i + 1] || null
    // git accepts `-C path` (two tokens), so also skip option arg pairs
    if (a === '-C' || a === '--git-dir' || a === '--work-tree' || a === '-c') {
      i += 2
      continue
    }
    if (a.startsWith('-')) {
      i++
      continue
    }
    return a
  }
  return null
}

/** True if any token equals exact `needle` after argv[0]. */
function argvIncludes(argv, needle) {
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === needle) return true
  }
  return false
}

function aws3Recursive(argv) {
  // pattern: aws s3 rm <uri> ... --recursive
  if (firstNonFlagArgAfter(argv, 1) !== 's3') return false
  if (firstNonFlagArgAfter(argv, 2) !== 'rm') return false
  return argvIncludes(argv, '--recursive')
}

function dockerSystemPrune(argv) {
  // accept `docker system prune` with any flags interleaved
  return argvIncludes(argv, 'system') && argvIncludes(argv, 'prune')
}

function kubectlDeleteProdNs(argv) {
  // pattern: kubectl ... delete namespace prod-*
  if (!argvIncludes(argv, 'delete')) return false
  if (!argvIncludes(argv, 'namespace') && !argvIncludes(argv, 'ns')) return false
  for (const a of argv) {
    if (typeof a === 'string' && /^prod(-|$)/.test(a)) return true
  }
  return false
}

function isGitPush(argv) {
  // `git -C /repo push`, `git push`, `git -c x=y push`. firstNonFlagArgAfter
  // skips `-C path` and `-c k=v` so it returns the subcommand.
  if (path.basename(argv[0]) !== 'git') return false
  return firstNonFlagArgAfter(argv, 1) === 'push'
}

function isPackagePublish(argv) {
  const head = path.basename(argv[0])
  if (head !== 'npm' && head !== 'pnpm' && head !== 'yarn') return false
  // skip mid-flags like `--filter pkg` or `--access public`
  return argvIncludes(argv, 'publish')
}

function isKubectlApply(argv) {
  if (!argvIncludes(argv, 'apply')) return false
  // require -f (file) since `kubectl apply` with no -f is a usage error anyway
  return argvIncludes(argv, '-f') || argv.some((a) => a.startsWith('--filename'))
}

function isTerraformApplyDangerous(argv) {
  if (!argvIncludes(argv, 'apply')) return false
  // If the user has explicitly disabled auto-approve, treat as normal-but-elevated
  // (still classify as destructive — apply mutates infra). Only `--auto-approve=false`
  // removes the destructive marker per spec.
  return !argv.some((a) => a === '--auto-approve=false')
}

function isMysqldumpAll(argv) {
  return argvIncludes(argv, '--all-databases')
}

/**
 * Classify a single bash segment (one argv).
 *
 * @param {string[]} rawArgv
 * @returns {{ tier: 'normal' | 'destructive' | 'hard_deny', reason?: string }}
 */
export function classifyBashSegment(rawArgv) {
  if (!Array.isArray(rawArgv) || rawArgv.length === 0) return { tier: 'normal' }
  const { argv, env } = stripWrappersAndEnv(rawArgv)
  if (argv.length === 0) {
    // env-only / wrapper-only segment with no command — treat as normal.
    return { tier: 'normal' }
  }
  // After unwrapping, also peel any nested env prefix (`env FOO=bar baz cmd`
  // has already been handled, but `command FOO=bar cmd` would not be valid
  // shell — so a single peel suffices in practice).
  const head = path.basename(argv[0])

  // Hard-deny first — these short-circuit regardless of any destructive marks.
  if (head === 'sudo') return { tier: 'hard_deny', reason: 'hard_deny:sudo' }
  if (containsSecretEnv(env)) return { tier: 'hard_deny', reason: 'hard_deny:secret' }
  if (head === 'rm' && rmTargetsRoot(argv.slice(1))) return { tier: 'hard_deny', reason: 'hard_deny:rm_root' }
  if ((head === 'aws' || head === 'gcloud' || head === 'kubectl') && hasProdContext(argv)) {
    return { tier: 'hard_deny', reason: 'hard_deny:production' }
  }
  if (head === 'docker' && dockerSystemPrune(argv)) {
    return { tier: 'hard_deny', reason: 'hard_deny:docker_prune_system' }
  }
  if (head === 'kubectl' && kubectlDeleteProdNs(argv)) {
    return { tier: 'hard_deny', reason: 'hard_deny:kubectl_delete_prod_ns' }
  }

  // Destructive next — order is "any of these match" (intent-OR).
  if (head === 'rm' && rmHasRecursiveFlag(argv)) return { tier: 'destructive', reason: 'destructive:rm' }
  if (isGitPush(argv)) return { tier: 'destructive', reason: 'destructive:git_push' }
  if (isPackagePublish(argv)) return { tier: 'destructive', reason: 'destructive:publish' }
  if (head === 'kubectl' && isKubectlApply(argv)) return { tier: 'destructive', reason: 'destructive:kubectl_apply' }
  if (head === 'terraform' && isTerraformApplyDangerous(argv)) return { tier: 'destructive', reason: 'destructive:terraform_apply' }
  if (head === 'dropdb') return { tier: 'destructive', reason: 'destructive:dropdb' }
  if (head === 'mysqldump' && isMysqldumpAll(argv)) return { tier: 'destructive', reason: 'destructive:mysqldump_all' }
  if (head === 'aws' && aws3Recursive(argv)) return { tier: 'destructive', reason: 'destructive:aws_s3_rm_recursive' }

  return { tier: 'normal' }
}

/**
 * Classify a full bash command string. Tokenizes, segment-classifies, then
 * reduces by "OR of tiers" (hard_deny > destructive > normal).
 *
 * @param {string} cmd
 * @returns {{ tier: 'normal' | 'destructive' | 'hard_deny', reason?: string }}
 */
export function classifyBashCommand(cmd) {
  const segments = tokenizeBash(cmd)
  if (segments.length === 0) return { tier: 'normal' }
  /** @type {{ tier: 'normal' | 'destructive' | 'hard_deny', reason?: string }} */
  let aggregate = { tier: 'normal' }
  for (const seg of segments) {
    const r = classifyBashSegment(seg)
    if (r.tier === 'hard_deny') return r
    if (r.tier === 'destructive' && aggregate.tier !== 'destructive') aggregate = r
  }
  return aggregate
}

// ---------------------------------------------------------------------------
// Top-level classify(): tool-name dispatch
// ---------------------------------------------------------------------------

/**
 * Classify a permission request. Logs `permission.classified` to the audit
 * log so every decision (including normal) is auditable.
 *
 * @param {{ tool_name?: string, tool_input?: any, agent_session_id?: string, request_id?: string }} params
 * @returns {{ tier: 'normal' | 'destructive' | 'hard_deny', reason?: string }}
 */
export function classify(params) {
  const toolName = typeof params?.tool_name === 'string' ? params.tool_name : ''
  const toolInput = params?.tool_input ?? {}

  /** @type {{ tier: 'normal' | 'destructive' | 'hard_deny', reason?: string }} */
  let result = { tier: 'normal' }
  if (toolName === 'WebFetch' || toolName === 'WebSearch') {
    result = { tier: 'hard_deny', reason: 'hard_deny:web_access_disabled' }
  } else if (toolName === 'Bash') {
    const cmd = typeof toolInput?.command === 'string' ? toolInput.command : ''
    result = classifyBashCommand(cmd)
  } else if (toolName === 'Edit' || toolName === 'Write' || toolName === 'AskUserQuestion') {
    result = { tier: 'normal' }
  } else {
    result = { tier: 'normal' }
  }

  // Audit-log every classification (best-effort — never throws to caller).
  try {
    const inputPreview = inputPreviewFor(toolName, toolInput)
    writeAuditEntry({
      event: 'permission.classified',
      tool_name: toolName,
      input_preview: inputPreview,
      tier: result.tier,
      reason: result.reason,
      agent_session_id: params?.agent_session_id,
      request_id: params?.request_id,
    })
  } catch { /* swallow */ }

  return result
}

/**
 * Build a short string preview of the tool_input suitable for audit logs and
 * the permission.blocked notification body. Mirrors approval-service's
 * inputPreview style (`command` first, then `file_path`, else JSON).
 */
export function inputPreviewFor(toolName, toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return ''
  if (typeof toolInput.command === 'string') return toolInput.command
  if (typeof toolInput.file_path === 'string') return toolInput.file_path
  if (typeof toolInput.url === 'string') return toolInput.url
  try {
    const json = JSON.stringify(toolInput)
    return json.length > 200 ? `${json.slice(0, 200)}…` : json
  } catch {
    return ''
  }
}
