import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { loadProjectAllowlist } from '../server/notification-hub/services/session-service.mjs'

describe('Phase 3 — project allowlist loader', () => {
  let tmp = ''
  beforeAll(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), 'projects-allowlist-'))
  })
  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true }).catch(() => {})
  })

  it('parses a valid file and returns the project list', async () => {
    const file = path.join(tmp, 'projects.valid.json')
    await writeFile(
      file,
      JSON.stringify({
        projects: [
          {
            project_id: '_unmanaged',
            label: 'Unmanaged',
            path: '',
            default_backend: 'claude-code',
            start_template: 'claude',
          },
          {
            project_id: 'demo',
            label: 'Demo',
            path: '/tmp/demo',
            default_backend: 'codex-cli',
            start_template: 'codex',
          },
        ],
      }),
      'utf8',
    )
    const list = await loadProjectAllowlist({ projectsFile: file })
    expect(list).toHaveLength(2)
    expect(list[0]).toMatchObject({ project_id: '_unmanaged', label: 'Unmanaged' })
    expect(list[1]).toMatchObject({ project_id: 'demo', label: 'Demo', path: '/tmp/demo' })
  })

  it('filters out entries with bad path / bad backend / missing fields', async () => {
    const file = path.join(tmp, 'projects.bad-entries.json')
    await writeFile(
      file,
      JSON.stringify({
        projects: [
          { project_id: 'ok', label: 'OK', path: '/tmp/ok', default_backend: 'claude-code', start_template: 'claude' },
          // missing path (and not _unmanaged)
          { project_id: 'no-path', label: 'X', path: '', default_backend: 'claude-code', start_template: 'claude' },
          // bad backend
          { project_id: 'bad-backend', label: 'Y', path: '/tmp/y', default_backend: 'something-else', start_template: 'claude' },
          // bad template
          { project_id: 'bad-template', label: 'Z', path: '/tmp/z', default_backend: 'claude-code', start_template: 'random' },
          // missing label
          { project_id: 'no-label', label: '', path: '/tmp/q', default_backend: 'claude-code', start_template: 'claude' },
          // duplicate id (second occurrence dropped)
          { project_id: 'ok', label: 'Dup', path: '/tmp/dup', default_backend: 'claude-code', start_template: 'claude' },
        ],
      }),
      'utf8',
    )
    const list = await loadProjectAllowlist({ projectsFile: file })
    expect(list).toHaveLength(1)
    expect(list[0].project_id).toBe('ok')
  })

  it('returns empty list when file is missing (no throw)', async () => {
    const list = await loadProjectAllowlist({ projectsFile: path.join(tmp, 'does-not-exist.json') })
    expect(list).toEqual([])
  })

  it('returns empty list when file is not valid JSON', async () => {
    const file = path.join(tmp, 'projects.broken.json')
    await writeFile(file, 'not json at all', 'utf8')
    const list = await loadProjectAllowlist({ projectsFile: file })
    expect(list).toEqual([])
  })
})
