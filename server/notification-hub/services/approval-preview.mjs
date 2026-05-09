// Pure tool-input preview formatters used by the permission-request route
// to build the notification body sent to the G2 / Web UI.
//
// State-less: no store / persistence access. Imports are limited to other
// state-less modules (none today).
//
// DAG: this module is leaf — nothing imports services/state/transport from
// here. routes/* and services/approval-service may import it.

/**
 * Build a human-readable preview string for a hook tool_input.
 *
 * @param {string} toolName
 * @param {unknown} toolInput
 * @returns {string}
 */
export function buildToolPreview(toolName, toolInput) {
  if (toolName === 'Bash') {
    return toolInput?.command || ''
  } else if (toolName === 'apply_patch') {
    return buildApplyPatchPreview(toolInput)
  } else if (toolName === 'Edit') {
    const file = toolInput?.file_path || ''
    const old = (toolInput?.old_string || '').slice(0, 2000)
    const new_ = (toolInput?.new_string || '').slice(0, 2000)
    return `${file}\n--- old ---\n${old}\n+++ new +++\n${new_}`
  } else if (toolName === 'Write') {
    const file = toolInput?.file_path || ''
    const content = (toolInput?.content || '').slice(0, 2000)
    return `${file}\n${content}`
  } else {
    return JSON.stringify(toolInput || {}).slice(0, 2000)
  }
}

function buildApplyPatchPreview(toolInput) {
  const patch = getApplyPatchRawString(toolInput)
  if (patch === null) return JSON.stringify(toolInput || {}).slice(0, 2000)

  const fileLines = []
  const seen = new Set()
  for (const line of patch.split(/\r?\n/)) {
    const match = line.match(/^\*\*\* (Add|Update|Delete) File: (.+)$/)
    if (match) {
      const label = match[1] === 'Add' ? 'add' : match[1] === 'Update' ? 'edit' : 'delete'
      const key = `${label}:${match[2]}`
      if (!seen.has(key)) {
        seen.add(key)
        fileLines.push(`- ${label} ${match[2]}`)
      }
    }
  }

  const patchLines = patch
    .replace(/\r\n/g, '\n')
    .split('\n')
    .slice(0, 80)
    .map((line) => (line.length > 160 ? `${line.slice(0, 159)}…` : line))
    .join('\n')

  const summary = fileLines.length > 0
    ? ['Files:', ...fileLines.slice(0, 12), ''].join('\n')
    : ''
  const truncated = patch.split(/\r?\n/).length > 80 ? '\n…' : ''
  return `${summary}${patchLines}${truncated}`.slice(0, 4000)
}

function getApplyPatchRawString(toolInput) {
  for (const key of ['command', 'input', 'patch']) {
    const value = toolInput?.[key]
    if (typeof value === 'string' && value.length > 0) return value
  }
  return null
}
