/**
 * Host manager projection: the registry is the sole ownership source, health
 * derives from current dependency/version/runtime facts, and unrelated Loader
 * rows or Plugin Inventory entries never create rows. Corrupt registry and
 * in-flight journal states surface through recovery/operation views.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ProfileRuntime } from '@deepseek-ai/dsh-app-boot'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PageAppManager } from '../src/index.ts'

const PKG = '@fixture/managed-workspace'
const ROOT_ID = 'workspace.managed'

let dir: string

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dsh-page-app-manager-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

interface LoaderRow {
  id: string
  name: string
  fiberState?: number
  config?: Record<string, unknown>
  inject?: readonly string[]
  insert?: readonly unknown[]
}

function writeManagerDir(registry: unknown): void {
  mkdirSync(join(dir, '.workspace-manager'), { recursive: true })
  writeFileSync(join(dir, '.workspace-manager', 'registry.json'), JSON.stringify(registry))
}

/** Stage the installed manager package that owns the wrapper module. */
function writeManagerPackage(): void {
  const pkgDir = join(dir, 'node_modules', '@deepseek-ai', 'dsh-page-app-manager')
  mkdirSync(pkgDir, { recursive: true })
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh-page-app-manager', version: '0.1.1-rc.2' }))
}

/** One fake loader entry: the manager reads options.id/name/inject/insert/config and fiber.state. */
function loaderEntry(row: LoaderRow): { options: Record<string, unknown>; fiber: { state?: number } | undefined } {
  return {
    options: {
      id: row.id,
      name: row.name,
      ...row.inject === undefined ? {} : { inject: row.inject },
      ...row.insert === undefined ? {} : { insert: row.insert },
      ...row.config === undefined ? {} : { config: row.config },
    },
    fiber: row.fiberState === undefined ? undefined : { state: row.fiberState },
  }
}

/** The exact Feature Runtime Wrapper row the manager derives for the fixture row. */
function wrapperRowOf(overrides: Record<string, unknown> = {}): {
  id: string
  name: string
  inject: readonly string[]
  config: Record<string, unknown>
  insert: readonly unknown[]
} {
  return {
    id: 'page-app.wrapper.workspace.managed',
    name: '@deepseek-ai/dsh-page-app-manager/wrapper',
    inject: ['workbenchRuntime'],
    config: {
      packageName: PKG,
      pageId: 'workspace.managed',
      rootEntryId: ROOT_ID,
      contractVersion: 1,
    },
    insert: [{ id: ROOT_ID, name: `${PKG}/client` }],
    ...overrides,
  }
}

function writeRegistryRow(overrides: Record<string, unknown> = {}): unknown {
  return {
    schemaVersion: 1,
    revision: 3,
    entries: [{
      packageName: PKG,
      source: { kind: 'registry', display: PKG },
      resolvedVersion: '1.0.0',
      page: { id: 'workspace.managed', name: 'Managed', description: 'd', defaultOrder: 100, rootEntryId: ROOT_ID },
      order: 100,
      enabled: true,
      hidden: false,
      installedAt: '2026-08-01T00:00:00.000Z',
      updatedAt: '2026-08-01T00:00:00.000Z',
      ...overrides,
    }],
  }
}

function writeInstalledPackage(version = '1.0.0', insertRows: unknown[] = [
  { id: ROOT_ID, name: `${PKG}/client` },
  { id: 'fixture-client-row', name: PKG },
]): void {
  const pkgDir = join(dir, 'node_modules', ...PKG.split('/'))
  mkdirSync(join(pkgDir, 'lib'), { recursive: true })
  writeFileSync(join(pkgDir, 'cordis.patch.yml'), JSON.stringify([{ insert: insertRows }]))
  writeFileSync(join(pkgDir, 'lib', 'client.js'), 'module.exports = {}\n')
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
    name: PKG,
    version,
    exports: { './client': './lib/client.js' },
    dsh: {
      bundle: { patch: './cordis.patch.yml' },
      workspace: {
        schemaVersion: 1, id: 'workspace.managed', name: 'Managed', description: 'd', defaultOrder: 100, rootEntryId: ROOT_ID,
      },
      client: { platform: 'web' },
    },
  }))
}

function buildManager(options: { registry?: unknown; loaderRows?: LoaderRow[]; journal?: unknown }): {
  ctx: Context
  manager: PageAppManager
} {
  if (options.registry !== undefined) writeManagerDir(options.registry)
  if (options.journal !== undefined) {
    mkdirSync(join(dir, '.workspace-manager'), { recursive: true })
    writeFileSync(join(dir, '.workspace-manager', 'transaction.json'), JSON.stringify(options.journal))
  }
  const ctx = new Context()
  const runtime = new ProfileRuntime(ctx, {
    identity: { name: 'fixture-profile', directory: dir },
    compose: patches => patches,
    initialManagerPatches: [],
  })
  ctx.reflect.provide('loader', {
    *entries(): Generator<{ options: Record<string, unknown>; fiber: { state?: number } | undefined }> {
      for (const row of options.loaderRows ?? []) yield loaderEntry(row)
    },
  })
  const manager = new PageAppManager(ctx, { profileRuntime: runtime, config: { settlementTimeoutMs: 60_000 } })
  return { ctx, manager }
}

describe('manager snapshot', () => {
  it('projects an empty set when no registry has been published', () => {
    const { manager } = buildManager({})
    const snapshot = manager.snapshot()
    expect(snapshot.profile).toEqual({ name: 'fixture-profile', directory: dir })
    expect(snapshot.revision).toBe(0)
    expect(snapshot.entries).toEqual([])
    expect(snapshot.operation).toBeNull()
    expect(snapshot.recovery).toBeNull()
  })

  it('treats the registry as the sole ownership source: unrelated Loader rows never create entries', () => {
    writeInstalledPackage()
    const { manager } = buildManager({
      registry: writeRegistryRow(),
      loaderRows: [
        { id: 'unrelated-1', name: '@deepseek-ai/dsh-client-ui-layout', fiberState: 2 },
        { id: 'unrelated-2', name: '@deepseek-ai/dsh-client-connection', fiberState: 2 },
      ],
    })
    const snapshot = manager.snapshot()
    expect(snapshot.entries).toHaveLength(1)
    expect(snapshot.entries[0]?.packageName).toBe(PKG)
  })

  it('derives ready when the installed package and the active hash-matching wrapper row match the committed row', () => {
    writeInstalledPackage()
    writeManagerPackage()
    const { manager } = buildManager({
      registry: writeRegistryRow(),
      loaderRows: [{ ...wrapperRowOf(), fiberState: 2 }],
    })
    expect(manager.snapshot().entries[0]?.health).toBe('ready')
  })

  it('derives disabled for a row that is not enabled', () => {
    const { manager } = buildManager({ registry: writeRegistryRow({ enabled: false }) })
    expect(manager.snapshot().entries[0]?.health).toBe('disabled')
  })

  it('derives missing-dependency when the package is not installed', () => {
    const { manager } = buildManager({ registry: writeRegistryRow() })
    expect(manager.snapshot().entries[0]?.health).toBe('missing-dependency')
  })

  it('derives version-drift when the installed version differs from the committed one', () => {
    writeInstalledPackage('2.0.0')
    const { manager } = buildManager({ registry: writeRegistryRow() })
    expect(manager.snapshot().entries[0]?.health).toBe('version-drift')
  })

  it('derives invalid-manifest when the installed package violates the contract', () => {
    writeInstalledPackage('1.0.0', [{ id: 'wrong-root', name: `${PKG}/client` }])
    const { manager } = buildManager({ registry: writeRegistryRow() })
    expect(manager.snapshot().entries[0]?.health).toBe('invalid-manifest')
  })

  it('derives activation-failed when the wrapper row is absent or fiberless', () => {
    writeInstalledPackage()
    writeManagerPackage()
    const { manager } = buildManager({
      registry: writeRegistryRow(),
      loaderRows: [{ id: 'some-other-id', name: `${PKG}/client`, fiberState: 2 }],
    })
    expect(manager.snapshot().entries[0]?.health).toBe('activation-failed')
  })

  it('derives externally-overridden when a user patch changes the wrapper row', () => {
    writeInstalledPackage()
    writeManagerPackage()
    const { manager } = buildManager({
      registry: writeRegistryRow(),
      loaderRows: [{ ...wrapperRowOf(), config: { enabled: false }, fiberState: 2 }],
    })
    expect(manager.snapshot().entries[0]?.health).toBe('externally-overridden')
  })

  it('exposes a recovery view when the registry is corrupt', () => {
    const { manager } = buildManager({ registry: { schemaVersion: 99 } })
    const snapshot = manager.snapshot()
    expect(snapshot.entries).toEqual([])
    expect(snapshot.recovery?.message).toMatch(/registry is corrupt/)
  })

  it('exposes the durable journal phase as the in-flight operation', () => {
    writeInstalledPackage()
    const { manager } = buildManager({
      registry: writeRegistryRow(),
      journal: { schemaVersion: 1, phase: 'staged', lockOwnerToken: 'token-1', files: {} },
    })
    expect(manager.snapshot().operation).toEqual({ state: 'installing', phase: 'staged' })
  })

  it('projects installing for a prepared journal and active for committing', () => {
    writeInstalledPackage()
    const installing = buildManager({
      registry: writeRegistryRow(),
      journal: { schemaVersion: 1, phase: 'prepared', lockOwnerToken: 'token-1', files: {} },
    })
    expect(installing.manager.snapshot().operation).toEqual({ state: 'installing', phase: 'prepared' })

    const active = buildManager({
      registry: writeRegistryRow(),
      journal: { schemaVersion: 1, phase: 'committing', lockOwnerToken: 'token-1', files: {} },
    })
    expect(active.manager.snapshot().operation).toEqual({ state: 'active', phase: 'committing' })
  })

  it('projects recovery-required when recovery is visible', () => {
    const { manager } = buildManager({ registry: { schemaVersion: 99 } })
    const snapshot = manager.snapshot()
    expect(snapshot.recovery).not.toBeNull()
    expect(snapshot.operation).toEqual({ state: 'recovery-required' })
  })

  it('maps runtime fiber states to semantic labels (pending/loading/active/failed/unloading)', () => {
    const labels: ReadonlyArray<readonly [number, string]> = [
      [0, 'pending'],   // PENDING
      [1, 'loading'],   // LOADING
      [2, 'active'],    // ACTIVE
      [3, 'failed'],    // FAILED
      [5, 'unloading'], // UNLOADING
    ]
    for (const [fiberState, label] of labels) {
      writeInstalledPackage()
      writeManagerPackage()
      const { manager } = buildManager({
        registry: writeRegistryRow(),
        loaderRows: [{ ...wrapperRowOf(), fiberState }],
      })
      expect(manager.snapshot().entries[0]?.runtimeState).toBe(label)
    }
  })

  it('maps a disposed managed root to failed until the next generation', () => {
    writeInstalledPackage()
    writeManagerPackage()
    const disposed = buildManager({
      registry: writeRegistryRow(),
      loaderRows: [{ ...wrapperRowOf(), fiberState: 4 }],
    })
    expect(disposed.manager.snapshot().entries[0]?.runtimeState).toBe('failed')
    // The next generation remounts the root with a fresh fiber; the label
    // follows the new fiber instead of the terminal disposed state.
    const next = buildManager({
      registry: writeRegistryRow(),
      loaderRows: [{ ...wrapperRowOf(), fiberState: 2 }],
    })
    expect(next.manager.snapshot().entries[0]?.runtimeState).toBe('active')
  })

  it('derives missing-manager when the wrapper module is unresolvable', () => {
    // The feature is installed and statically valid, but the manager package
    // that owns the wrapper module is not installed in the profile.
    writeInstalledPackage()
    const { manager } = buildManager({ registry: writeRegistryRow(), loaderRows: [] })
    expect(manager.snapshot().entries[0]?.health).toBe('missing-manager')
  })

  it('health projects ready only when the wrapper row is active and hash-matching', () => {
    writeInstalledPackage()
    writeManagerPackage()
    const wrapper = wrapperRowOf()
    const active = buildManager({
      registry: writeRegistryRow(),
      loaderRows: [{ ...wrapper, fiberState: 2 }],
    })
    expect(active.manager.snapshot().entries[0]?.health).toBe('ready')

    // A wrapper row whose effective options differ from the derived row (a
    // user patch rewrote its config) is externally overridden, not ready.
    const overridden = buildManager({
      registry: writeRegistryRow(),
      loaderRows: [{
        ...wrapper,
        config: { ...wrapper.config, packageName: '@fixture/other' },
        fiberState: 2,
      }],
    })
    expect(overridden.manager.snapshot().entries[0]?.health).toBe('externally-overridden')

    // A wrapper row that is mounted but still pending is not ready.
    const pending = buildManager({
      registry: writeRegistryRow(),
      loaderRows: [{ ...wrapper, fiberState: 0 }],
    })
    expect(pending.manager.snapshot().entries[0]?.health).toBe('activation-failed')
  })
})
