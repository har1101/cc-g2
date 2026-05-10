// Phase 5: bypass regression tests for the policy classifier.
//
// The fixtures in this file enumerate the bypass patterns the design doc
// (v4 §5.1) calls out as "regex-only matching gets bypassed". Adding new
// bypass patterns here is required when fielded — this is the canonical
// list the rest of the team grep's against.

import { describe, it, expect } from 'vitest'
import {
  classify,
  classifyBashCommand,
  classifyBashSegment,
  tokenizeBash,
} from '../server/notification-hub/services/policy-service.mjs'

const HARD_DENY_FIXTURES = [
  // sudo bypass variations
  'sudo apt update',
  '/usr/bin/sudo apt update',
  'command sudo whoami',
  'env SUDO_ASKPASS=/bin/true sudo apt update',
  'builtin sudo apt update',
  // rm targeting filesystem root with all flag spellings
  'rm -rf /',
  'rm -fr /',
  'rm -Rr /',
  'rm -rR /',
  'rm -fR /',
  'rm --recursive --force /',
  'rm -rf /*',
  // production cloud contexts
  'aws s3 rm s3://prod-bucket/ --recursive --include "*"',
  'kubectl --context production delete pod my-pod',
  'kubectl --context=production delete pod my-pod',
  'kubectl --context=prod-east delete pod my-pod',
  'aws --profile prod-east s3 ls',
  'gcloud --project prod-secrets compute instances list',
  // docker prune
  'docker system prune --all --force',
  'docker system prune -a -f',
  // kubectl delete prod namespace
  'kubectl delete namespace prod-east',
  'kubectl delete ns prod-west',
  // segment-OR: hard-deny in any segment wins
  'cat /tmp/x; sudo rm -rf /',
  'echo hi && sudo whoami',
  'echo hi || sudo whoami',
  'echo hi | sudo tee /etc/hosts',
  // secret env prefix
  'PASSWORD=hunter2 deploy.sh',
  'API_KEY=xxx ./run.sh',
  'env DB_PASSWORD=hunter2 psql',
]

const DESTRUCTIVE_FIXTURES = [
  // rm with various recursive flag spellings
  'rm -rf dist',
  'rm -fr ./build',
  'rm -r build',
  'rm -R node_modules',
  'rm -rfv ./tmp',
  'rm --recursive ./tmp',
  // git push variants (incl. global flags before subcommand)
  'git push origin main',
  'git -C /repo push',
  'git -c user.name=foo push',
  'GIT_DIR=/r/.git git push',
  'GIT_WORK_TREE=/w git push',
  // pnpm/yarn/npm publish with mid-flags
  'pnpm --filter pkg publish',
  'pnpm publish --tag latest',
  'npm publish',
  'npm publish --access public',
  'yarn publish --access public',
  // segment-OR: destructive wins in any segment
  'cd /repo && git push',
  'echo hi; rm -rf dist',
  // kubectl apply
  'kubectl apply -f deployment.yaml',
  'kubectl --context staging apply -f /tmp/x.yaml',
  // terraform apply (without auto-approve=false)
  'terraform apply',
  'terraform apply -auto-approve',
  // db drops
  'dropdb production',
  'mysqldump --all-databases > backup.sql',
  // aws s3 rm recursive (non-prod still destructive)
  'aws s3 rm s3://my-bucket/path/ --recursive',
]

const NORMAL_FIXTURES = [
  'npm test',
  'git status',
  'git log -10',
  'git diff main',
  'git pull',
  'rm dist/foo.js', // no recursive flag
  'echo hello',
  'cat README.md',
  'pnpm install',
  'npm run build',
  'ls -la',
  'docker ps',
  'kubectl get pods',
  'aws s3 ls',
  'terraform plan',
  // env prefix that is NOT a secret
  'NODE_ENV=production npm run build',
]

describe('tokenizeBash', () => {
  it('splits a simple argv', () => {
    expect(tokenizeBash('echo hello world')).toEqual([['echo', 'hello', 'world']])
  })
  it('handles single quotes', () => {
    expect(tokenizeBash("echo 'a b c'")).toEqual([['echo', 'a b c']])
  })
  it('handles double quotes', () => {
    expect(tokenizeBash('echo "a b c"')).toEqual([['echo', 'a b c']])
  })
  it('handles backslash escapes', () => {
    expect(tokenizeBash('echo a\\ b')).toEqual([['echo', 'a b']])
  })
  it('splits on ;', () => {
    expect(tokenizeBash('a; b')).toEqual([['a'], ['b']])
  })
  it('splits on && and ||', () => {
    expect(tokenizeBash('a && b || c')).toEqual([['a'], ['b'], ['c']])
  })
  it('splits on |', () => {
    expect(tokenizeBash('a | b')).toEqual([['a'], ['b']])
  })
  it('keeps env var prefix as separate tokens', () => {
    expect(tokenizeBash('FOO=bar cmd a')).toEqual([['FOO=bar', 'cmd', 'a']])
  })
})

describe('policy classifier — HARD_DENY fixtures', () => {
  it.each(HARD_DENY_FIXTURES)('%s → hard_deny', (cmd) => {
    const r = classifyBashCommand(cmd)
    expect(r.tier, `cmd: ${cmd}`).toBe('hard_deny')
  })
})

describe('policy classifier — DESTRUCTIVE fixtures', () => {
  it.each(DESTRUCTIVE_FIXTURES)('%s → destructive', (cmd) => {
    const r = classifyBashCommand(cmd)
    expect(r.tier, `cmd: ${cmd}`).toBe('destructive')
  })
})

describe('policy classifier — NORMAL fixtures', () => {
  it.each(NORMAL_FIXTURES)('%s → normal', (cmd) => {
    const r = classifyBashCommand(cmd)
    expect(r.tier, `cmd: ${cmd}`).toBe('normal')
  })
})

describe('classifyBashSegment direct edge cases', () => {
  it('empty argv → normal', () => {
    expect(classifyBashSegment([])).toEqual({ tier: 'normal' })
  })
  it('env-only segment → normal', () => {
    expect(classifyBashSegment(['FOO=bar'])).toEqual({ tier: 'normal' })
  })
  it('absolute path resolves via basename', () => {
    expect(classifyBashSegment(['/usr/local/bin/sudo', 'whoami']).tier).toBe('hard_deny')
  })
  it('command wrapper unwraps', () => {
    expect(classifyBashSegment(['command', 'sudo', 'whoami']).tier).toBe('hard_deny')
  })
  it('env wrapper unwraps and sees real head', () => {
    expect(classifyBashSegment(['env', 'FOO=bar', 'sudo', 'whoami']).tier).toBe('hard_deny')
  })
  it('env wrapper -i flag still unwraps', () => {
    expect(classifyBashSegment(['env', '-i', 'FOO=bar', 'sudo', 'ls']).tier).toBe('hard_deny')
  })
})

describe('classify (top-level tool dispatch)', () => {
  it('WebFetch → hard_deny:web_access_disabled', () => {
    const r = classify({ tool_name: 'WebFetch', tool_input: { url: 'https://example.com' } })
    expect(r.tier).toBe('hard_deny')
    expect(r.reason).toBe('hard_deny:web_access_disabled')
  })
  it('WebSearch → hard_deny:web_access_disabled', () => {
    const r = classify({ tool_name: 'WebSearch', tool_input: { query: 'foo' } })
    expect(r.tier).toBe('hard_deny')
  })
  it('Edit → normal', () => {
    const r = classify({ tool_name: 'Edit', tool_input: { file_path: '/a' } })
    expect(r.tier).toBe('normal')
  })
  it('Write → normal', () => {
    const r = classify({ tool_name: 'Write', tool_input: { file_path: '/a' } })
    expect(r.tier).toBe('normal')
  })
  it('Bash with destructive command → destructive', () => {
    const r = classify({ tool_name: 'Bash', tool_input: { command: 'rm -rf dist' } })
    expect(r.tier).toBe('destructive')
  })
  it('Bash with sudo → hard_deny', () => {
    const r = classify({ tool_name: 'Bash', tool_input: { command: 'sudo apt update' } })
    expect(r.tier).toBe('hard_deny')
  })
  it('unknown tool → normal', () => {
    const r = classify({ tool_name: 'WeirdTool', tool_input: {} })
    expect(r.tier).toBe('normal')
  })
  it('no tool_input.command falls through gracefully', () => {
    const r = classify({ tool_name: 'Bash', tool_input: {} })
    expect(r.tier).toBe('normal')
  })
})
