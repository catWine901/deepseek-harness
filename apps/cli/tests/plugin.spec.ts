/**
 * M4 — `dsh plugin` shared-lock serialization and `dsh.workspace` classification.
 *
 * The plugin command is a thin pnpm forwarder that must serialize with page-app
 * manager transactions on the same profile (the shared `operation.lock`,
 * ownerKind `plugin-cli`) and must never promote a package declaring
 * `dsh.workspace` into `dsh.profile.bundles`. The manager owns workspace
 * packages; the CLI only installs them and points the user at
 * Plugins → Workspace Apps (no adoption).
 *
 * These specs run a deterministic fake `pnpm` (a PATH-shadowing executable
 * that logs its invocations and optionally simulates `add` manifest writes),
 * so the lock contention and the reconciliation behavior are exercised without
 * a network registry.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runPlugin } from '../src/plugin.ts'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'dsh-plugin-spec-'))

/** One fake pnpm invocation recorded in the shared log. */
interface PnpmCall {
  readonly start: number
  readonly end: number
  readonly argv: readonly string[]
}

/** Parse the fake pnpm log into per-invocation records. */
function readPnpmLog(logFile: string): PnpmCall[] {
  if (!existsSync(logFile)) return []
  const calls: PnpmCall[] = []
  let current: { start: number; argv: readonly string[] } | undefined
  for (const line of readFileSync(logFile, 'utf8').split(/\r?\n/)) {
    if (line === '') continue
    const match = /^(start|end) (\d+)( .*)?$/.exec(line)
    if (match === null) throw new Error('malformed fake pnpm log line: ' + JSON.stringify(line))
    const [, tag, time, rest] = match
    if (tag === 'start') {
      if (current !== undefined) throw new Error('nested fake pnpm invocation in log')
      if (rest === undefined) throw new Error('fake pnpm start line carries no argv')
      current = { start: Number(time), argv: JSON.parse(rest) as string[] }
    } else {
      if (current === undefined) throw new Error('fake pnpm end without start in log')
      calls.push({ start: current.start, end: Number(time), argv: current.argv })
      current = undefined
    }
  }
  if (current !== undefined) throw new Error('unterminated fake pnpm invocation in log')
  return calls
}

/** A profile manifest narrowed to the fields reconciliation reads and writes. */
interface ProfileManifestView {
  dependencies?: Record<string, string>
  dsh?: { profile?: { bundles?: string[] } }
}

function readProfileManifestView(profileDir: string): ProfileManifestView {
  return JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as ProfileManifestView
}

/** Create a pre-initialized profile (init is skipped when package.json exists). */
function makeProfile(home: string, name: string, bundles: readonly string[]): string {
  const profileDir = join(home, 'profiles', name)
  mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
  writeFileSync(join(profileDir, 'package.json'), JSON.stringify({
    name: 'dsh-profile-' + name,
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: [...bundles] } },
  }, undefined, 2) + '\n')
  writeFileSync(join(profileDir, 'cordis.patch.yml'), '[]\n')
  return profileDir
}

/** Hand-place an `installed` dependency where profile resolution finds it. */
function installPackage(profileDir: string, packageName: string, manifest: Record<string, unknown>): void {
  const dir = join(profileDir, 'node_modules', packageName)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest, undefined, 2) + '\n')
  if (typeof (manifest.dsh as { bundle?: { patch?: unknown } } | undefined)?.bundle?.patch === 'string') {
    writeFileSync(join(dir, 'cordis.patch.yml'), '[]\n')
  }
}

/**
 * Write a fake `pnpm` executable that shadows PATH: it logs every invocation
 * (start/end + argv), busy-waits for a configurable window, and can simulate
 * `add` by writing the declared dependencies into the profile manifest.
 */
function writeFakePnpm(binDir: string): void {
  mkdirSync(binDir, { recursive: true })
  const script = [
    'const { appendFileSync, readFileSync, writeFileSync } = require("node:fs")',
    'const argv = process.argv.slice(2)',
    'const log = process.env.FAKE_PNPM_LOG',
    'if (log) appendFileSync(log, "start " + Date.now() + " " + JSON.stringify(argv) + "\\n")',
    'const workMs = Number(process.env.FAKE_PNPM_WORK_MS ?? 0)',
    'if (Number.isFinite(workMs) && workMs > 0) {',
    '  const until = Date.now() + workMs',
    '  while (Date.now() < until) { /* keep the child busy so the parent spawn stays blocked */ }',
    '}',
    'const manifest = process.env.FAKE_PNPM_MANIFEST',
    'const adds = process.env.FAKE_PNPM_ADDS',
    'if (manifest && adds && argv[0] === "add") {',
    '  const pkg = JSON.parse(readFileSync(manifest, "utf8"))',
    '  for (const [name, spec] of JSON.parse(adds)) {',
    '    pkg.dependencies = { ...(pkg.dependencies ?? {}), [name]: spec }',
    '  }',
    '  writeFileSync(manifest, JSON.stringify(pkg, null, 2) + "\\n")',
    '}',
    'if (log) appendFileSync(log, "end " + Date.now() + "\\n")',
    'process.exit(Number(process.env.FAKE_PNPM_EXIT_CODE ?? 0))',
    '',
  ].join('\n')
  writeFileSync(join(binDir, 'fake-pnpm.cjs'), script)
  writeFileSync(join(binDir, 'pnpm.cmd'), '@echo off\r\nnode "%~dp0fake-pnpm.cjs" %*\r\n')
  writeFileSync(join(binDir, 'pnpm'), '#!/bin/sh\nexec node "$(dirname "$0")/fake-pnpm.cjs" "$@"\n', { mode: 0o755 })
}

/** The workspace manifest block the manager's own packages declare (contract v1). */
const workspaceManifest = {
  schemaVersion: 1,
  id: 'fake-workspace',
  name: 'Fake Workspace',
  description: 'fixture',
  defaultOrder: 0,
  rootEntryId: 'fake-workspace-root',
}

describe('dsh plugin shared lock and dsh.workspace classification', () => {
  let home: string
  let fakeBin: string
  let pnpmLog: string

  afterEach(() => {
    vi.unstubAllEnvs()
    rmSync(home, { recursive: true, force: true })
  })

  /** Set up one fixture: a fake pnpm shadows PATH; DSH_HOME points at a fresh home. */
  function setUpProfileFixture(): void {
    home = tmp()
    vi.stubEnv('DSH_HOME', home)
    fakeBin = join(home, 'fake-bin')
    writeFakePnpm(fakeBin)
    vi.stubEnv('PATH', fakeBin + delimiter + (process.env.PATH ?? ''))
    pnpmLog = join(home, 'pnpm.log')
    vi.stubEnv('FAKE_PNPM_LOG', pnpmLog)
  }

  it('serializes dsh plugin and manager mutations on the same profile via the shared lock', async () => {
    setUpProfileFixture()
    const profileDir = makeProfile(home, 'lock', [])
    vi.stubEnv('FAKE_PNPM_WORK_MS', '80')
    const { withPageAppProfileLock } = await import('@deepseek-ai/dsh-page-app-profile')

    // (a) a manager transaction holds the shared lock: the CLI must wait and
    // run no pnpm until the manager releases.
    let resolveManagerExit!: (code: number) => void
    const managerExit = new Promise<number>((resolve) => { resolveManagerExit = resolve })
    await withPageAppProfileLock(profileDir, { kind: 'manager', token: 'manager-token-1' }, async () => {
      void Promise.resolve(runPlugin('lock', ['root'])).then(resolveManagerExit)
      await new Promise(resolve => setTimeout(resolve, 150))
      expect(readPnpmLog(pnpmLog)).toEqual([])
    })
    expect(await managerExit).toBe(0)
    expect(readPnpmLog(pnpmLog)).toHaveLength(1)

    // (b) two CLI invocations contend for the same lock: their pnpm calls
    // never overlap.
    const first = Promise.resolve(runPlugin('lock', ['root']))
    const second = Promise.resolve(runPlugin('lock', ['root']))
    await expect(first).resolves.toBe(0)
    await expect(second).resolves.toBe(0)
    const calls = readPnpmLog(pnpmLog)
    expect(calls).toHaveLength(3)
    for (const call of calls) expect(call.start).toBeLessThan(call.end)
    for (let i = 1; i < calls.length; i++) {
      expect(calls[i - 1]!.end).toBeLessThanOrEqual(calls[i]!.start)
    }
  }, 30_000)

  it('never promotes a dsh.workspace dependency into dsh.profile.bundles and prints the Workspace Apps diagnostic', async () => {
    setUpProfileFixture()
    const profileDir = makeProfile(home, 'ws', [])
    installPackage(profileDir, 'fake-workspace-pkg', {
      name: 'fake-workspace-pkg',
      version: '1.0.0',
      dsh: { workspace: workspaceManifest, bundle: { patch: './cordis.patch.yml' } },
    })
    vi.stubEnv('FAKE_PNPM_MANIFEST', join(profileDir, 'package.json'))
    vi.stubEnv('FAKE_PNPM_ADDS', JSON.stringify([['fake-workspace-pkg', 'file:./fake-workspace-pkg']]))
    const stderr: string[] = []
    const write = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk))
      return true
    })
    try {
      expect(await runPlugin('ws', ['add', 'fake-workspace-pkg'])).toBe(0)
    } finally {
      write.mockRestore()
    }
    const manifest = readProfileManifestView(profileDir)
    expect(manifest.dependencies?.['fake-workspace-pkg']).toBe('file:./fake-workspace-pkg')
    expect(manifest.dsh?.profile?.bundles).not.toContain('fake-workspace-pkg')
    const stderrText = stderr.join('')
    expect(stderrText).toContain('fake-workspace-pkg declares dsh.workspace')
    expect(stderrText).toContain('manage it in Plugins → Workspace Apps, not as a profile layer')
  })

  it('leaves ordinary plugins with unchanged reconciliation behavior', async () => {
    setUpProfileFixture()
    const profileDir = makeProfile(home, 'plain', ['@deepseek-ai/dsh-base'])
    installPackage(profileDir, 'fake-bundle-pkg', {
      name: 'fake-bundle-pkg',
      version: '1.0.0',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    })
    installPackage(profileDir, 'fake-plain-lib', { name: 'fake-plain-lib', version: '1.0.0' })
    vi.stubEnv('FAKE_PNPM_MANIFEST', join(profileDir, 'package.json'))
    vi.stubEnv('FAKE_PNPM_ADDS', JSON.stringify([
      ['fake-bundle-pkg', 'file:./fake-bundle-pkg'],
      ['fake-plain-lib', 'file:./fake-plain-lib'],
    ]))
    const stderr: string[] = []
    const write = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk))
      return true
    })
    try {
      expect(await runPlugin('plain', ['add', 'fake-bundle-pkg', 'fake-plain-lib'])).toBe(0)
    } finally {
      write.mockRestore()
    }
    const manifest = readProfileManifestView(profileDir)
    expect(manifest.dsh?.profile?.bundles).toEqual(['@deepseek-ai/dsh-base', 'fake-bundle-pkg'])
    expect(manifest.dsh?.profile?.bundles).not.toContain('fake-plain-lib')
    const stderrText = stderr.join('')
    expect(stderrText).toContain('fake-plain-lib declares no dsh.bundle')
    expect(stderrText).not.toContain('declares dsh.workspace')
  })

  it('does not add an external page-app dependency to the manager registry (no adoption)', async () => {
    setUpProfileFixture()
    const profileDir = makeProfile(home, 'adopt', [])
    installPackage(profileDir, 'fake-workspace-pkg', {
      name: 'fake-workspace-pkg',
      version: '1.0.0',
      dsh: { workspace: workspaceManifest, bundle: { patch: './cordis.patch.yml' } },
    })
    vi.stubEnv('FAKE_PNPM_MANIFEST', join(profileDir, 'package.json'))
    vi.stubEnv('FAKE_PNPM_ADDS', JSON.stringify([['fake-workspace-pkg', 'file:./fake-workspace-pkg']]))
    expect(await runPlugin('adopt', ['add', 'fake-workspace-pkg'])).toBe(0)
    // The CLI installs the dependency but never touches the manager registry.
    expect(existsSync(join(profileDir, '.workspace-manager', 'registry.json'))).toBe(false)
  })

  it('anchors relative path specs before pnpm (existing behavior pinned)', async () => {
    setUpProfileFixture()
    const profileDir = makeProfile(home, 'anchor', [])
    expect(existsSync(profileDir)).toBe(true) // pre-initialized: runPlugin skips init
    const checkout = mkdtempSync(join(home, 'checkout-'))
    writeFileSync(join(checkout, 'package.json'), JSON.stringify({ name: 'anchor-checkout', version: '1.0.0' }))
    const previous = process.cwd()
    process.chdir(checkout)
    try {
      expect(await runPlugin('anchor', ['add', '.'])).toBe(0)
    } finally {
      process.chdir(previous)
    }
    const calls = readPnpmLog(pnpmLog)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.argv[0]).toBe('add')
    expect(calls[0]!.argv[1]).toBe(resolve(checkout))
  })
})
