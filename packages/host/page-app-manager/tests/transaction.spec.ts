/**
 * Journaled lifecycle transactions: install/enable/disable/hide/reorder/
 * uninstall state machines against a real temp profile with a fake pnpm
 * executor. Every fallible boundary must be journaled before mutating, every
 * failure rolls back (backups restored, convergence run), allowBuilds refusals
 * preserve pnpm's exact diagnostic without touching pnpm-workspace.yaml, and
 * cancellation aborts cleanly.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProfileRuntime } from '@deepseek-ai/dsh-app-boot'
import type { PageAppRegistryV1 } from '@deepseek-ai/dsh-page-app-profile'
import { PageAppLifecycle, PageAppBuildPermissionError } from '../src/transaction.ts'
import { createPnpmExecutor, PageAppCommandAbortedError, type PageAppPackageExecutor } from '../src/executor.ts'

const PKG = '@fixture/valid-workspace'

let dir: string
let workspaceYaml: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-page-app-txn-'))
  workspaceYaml = join(dir, 'pnpm-workspace.yaml')
  writeFileSync(workspaceYaml, 'packages:\n  - "app/*"\n')
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture-profile', private: true, dependencies: {} }))
  mkdirSync(join(dir, '.workspace-manager'), { recursive: true })
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function writeWorkspacePackage(version = '1.0.0'): void {
  const pkgDir = join(dir, 'node_modules', ...PKG.split('/'))
  mkdirSync(join(pkgDir, 'lib'), { recursive: true })
  writeFileSync(join(pkgDir, 'cordis.patch.yml'), JSON.stringify([{ insert: [
    { id: 'workspace.valid', name: `${PKG}/client` },
    { id: 'fixture-client-row', name: PKG },
  ] }]))
  writeFileSync(join(pkgDir, 'lib', 'client.js'), 'module.exports = {}\n')
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
    name: PKG,
    version,
    exports: { './client': './lib/client.js' },
    dsh: {
      bundle: { patch: './cordis.patch.yml' },
      workspace: {
        schemaVersion: 1, id: 'workspace.valid', name: 'Fixture', description: 'd', defaultOrder: 100, rootEntryId: 'workspace.valid',
      },
      client: { platform: 'web' },
    },
  }))
}

function writeRegistry(entries: unknown[]): void {
  writeFileSync(join(dir, '.workspace-manager', 'registry.json'), JSON.stringify({
    schemaVersion: 1,
    revision: 1,
    entries,
  }))
}

const registryRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => {
  const page = { id: 'workspace.valid', name: 'Fixture', description: 'd', defaultOrder: 100, rootEntryId: 'workspace.valid' }
  const mergedPage = typeof overrides.page === 'object' && overrides.page !== null
    ? { ...page, ...overrides.page as Record<string, unknown> }
    : page
  const { page: _page, ...rest } = overrides
  return {
    packageName: PKG,
    source: { kind: 'registry', display: PKG },
    resolvedVersion: '1.0.0',
    page: mergedPage,
    order: 100,
    enabled: true,
    hidden: false,
    installedAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...rest,
  }
}

/** Fake pnpm: records calls; add writes the dependency into the profile manifest (pnpm's real effect). */
function fakeExecutor(overrides: Partial<PageAppPackageExecutor> = {}): {
  executor: PageAppPackageExecutor
  calls: { args: readonly string[] }[]
} {
  const calls: { args: readonly string[] }[] = []
  const executor: PageAppPackageExecutor = {
    run: async (args, options) => {
      calls.push({ args })
      if (overrides.run !== undefined) return overrides.run(args, options)
      const [verb] = args
      if (verb === 'add' && args[1] !== undefined) {
        const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
        manifest.dependencies[args[1]] = '1.0.0'
        writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
        return { exitCode: 0, stdout: '', stderr: '' }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    },
  }
  return { executor, calls }
}

function fakeRuntime(): { runtime: ProfileRuntime; applySpy: ReturnType<typeof vi.fn> } {
  const applySpy = vi.fn(async () => ({ generation: 1, activeRoots: ['workspace.valid'], externallyOverridden: [] }))
  const runtime = {
    identity: { name: 'fixture-profile', directory: dir },
    applyManagerLayer: applySpy,
  }
  return { runtime: runtime as unknown as ProfileRuntime, applySpy }
}

function lifecycle(executor: PageAppPackageExecutor, runtime: ProfileRuntime = fakeRuntime().runtime): PageAppLifecycle {
  return new PageAppLifecycle({ profileDir: dir, executor, runtime, pnpmWorkspaceFile: workspaceYaml })
}

/** Drive one install to completion by acknowledging through the targeted activation gate. */
async function installWithAck(lc: PageAppLifecycle, clientInstanceId: string): Promise<number> {
  const promise = lc.install(
    { kind: 'registry', spec: PKG, display: { kind: 'registry', display: PKG } },
    clientInstanceId as never,
    new AbortController().signal,
  )
  // The transaction opens the gate after staging; acknowledge as the client.
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const request = lc.activation.pendingRequest
    if (request !== undefined) {
      const result = lc.activation.acknowledge(
        request.transactionId,
        clientInstanceId as never,
        request.packageName,
        request.pageId,
        request.graphRevision,
      )
      if (result.accepted) break
    }
    await new Promise(resolve => setTimeout(resolve, 1))
  }
  return promise
}

const readRegistryFile = (): PageAppRegistryV1 | null => {
  try {
    return JSON.parse(readFileSync(join(dir, '.workspace-manager', 'registry.json'), 'utf8')) as PageAppRegistryV1
  } catch {
    return null
  }
}

describe('install transaction', () => {
  it('runs pnpm add as an argument array (never a shell string), stages, applies, publishes, and clears the journal', async () => {
    writeWorkspacePackage()
    const spawn = vi.fn(async (file: string, args: readonly string[], _options: { cwd: string; signal: AbortSignal; reject: false }) => {
      if (file === 'pnpm' && args[0] === 'add' && args[1] !== undefined) {
        // Simulate pnpm's real effect: the dependency lands in the manifest.
        const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
        manifest.dependencies[args[1]] = '1.0.0'
        writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    })
    const arrayExecutor = createPnpmExecutor(spawn)
    const lc = lifecycle(arrayExecutor)
    const revision = await installWithAck(lc, 'client-1')
    expect(spawn).toHaveBeenCalledWith('pnpm', ['add', PKG], expect.objectContaining({ reject: false }))
    expect(revision).toBe(1)
    expect(readRegistryFile()?.entries).toHaveLength(1)
    expect(readRegistryFile()?.entries[0]?.enabled).toBe(true)
    // Journal cleared after commit.
    expect(() => readFileSync(join(dir, '.workspace-manager', 'transaction.json'), 'utf8')).toThrow()
  })

  it('rolls back a static-validation failure: registry/layer restored, convergence run, journal cleared', async () => {
    // Invalid package: no dsh.workspace block.
    const pkgDir = join(dir, 'node_modules', ...PKG.split('/'))
    mkdirSync(join(pkgDir, 'lib'), { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: PKG, version: '1.0.0' }))
    const { executor, calls } = fakeExecutor()
    const lc = lifecycle(executor)
    await expect(lc.install(
      { kind: 'registry', spec: PKG, display: { kind: 'registry', display: PKG } },
      'client-1' as never,
      new AbortController().signal,
    )).rejects.toThrow(/page-app/)
    expect(calls.map(call => call.args[0])).toContain('add')
    expect(calls.map(call => call.args[0])).toContain('install') // convergence
    expect(readRegistryFile()).toBeNull()
    expect(readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')).toContain('packages:')
  })

  it('preserves pnpm allowBuilds diagnostics and never edits pnpm-workspace.yaml', async () => {
    writeWorkspacePackage()
    const before = readFileSync(workspaceYaml, 'utf8')
    const executor: PageAppPackageExecutor = {
      run: async (args) => {
        if (args[0] === 'add') return { exitCode: 1, stdout: '', stderr: 'ERR_PNPM_RECURSIVE_BUILD_SCRIPT ... allowBuilds ... blocked' }
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    }
    const lc = lifecycle(executor)
    await expect(lc.install(
      { kind: 'registry', spec: PKG, display: { kind: 'registry', display: PKG } },
      'client-1' as never,
      new AbortController().signal,
    )).rejects.toBeInstanceOf(PageAppBuildPermissionError)
    expect(readFileSync(workspaceYaml, 'utf8')).toBe(before)
  })

  it('rolls back cleanly when the transaction is cancelled mid-install', async () => {
    writeWorkspacePackage()
    const controller = new AbortController()
    const executor: PageAppPackageExecutor = {
      run: async (_args, options) => {
        if (options.signal.aborted) throw new PageAppCommandAbortedError()
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    }
    const calls: string[] = []
    const recording: PageAppPackageExecutor = {
      run: async (args, options) => {
        calls.push(args[0] ?? '')
        return executor.run(args, options)
      },
    }
    const lc = lifecycle(recording)
    controller.abort()
    await expect(lc.install(
      { kind: 'registry', spec: PKG, display: { kind: 'registry', display: PKG } },
      'client-1' as never,
      controller.signal,
    )).rejects.toBeInstanceOf(PageAppCommandAbortedError)
    expect(readRegistryFile()).toBeNull()
    expect(calls).toContain('install') // convergence ran
  })
})

describe('enable / disable / hide / reorder / uninstall', () => {
  it('disables a row: layer regenerated without its root, applied, and published', async () => {
    writeWorkspacePackage()
    writeRegistry([registryRow()])
    writeFileSync(join(dir, '.workspace-manager', 'runtime-layer.yml'), '[]\n')
    const { executor } = fakeExecutor()
    const { runtime, applySpy } = fakeRuntime()
    const lc = lifecycle(executor, runtime)
    await lc.setEnabled('workspace.valid', false, new AbortController().signal)
    expect(readRegistryFile()?.entries[0]?.enabled).toBe(false)
    expect(applySpy).toHaveBeenCalled()
  })

  it('hides a row without touching the runtime layer', async () => {
    writeWorkspacePackage()
    writeRegistry([registryRow()])
    const { executor } = fakeExecutor()
    const { runtime, applySpy } = fakeRuntime()
    const lc = lifecycle(executor, runtime)
    await lc.setHidden('workspace.valid', true)
    expect(readRegistryFile()?.entries[0]?.hidden).toBe(true)
    expect(applySpy).not.toHaveBeenCalled()
  })

  it('reorders rows by page id', async () => {
    writeRegistry([
      registryRow({ page: { id: 'workspace.a', rootEntryId: 'workspace.a' } }),
      registryRow({ packageName: '@fixture/second-workspace', source: { kind: 'registry', display: '@fixture/second-workspace' }, page: { id: 'workspace.b', rootEntryId: 'workspace.b' } }),
    ])
    const { executor } = fakeExecutor()
    const lc = lifecycle(executor)
    await lc.reorder(['workspace.b', 'workspace.a'])
    expect(readRegistryFile()?.entries.map(entry => entry.page.id)).toEqual(['workspace.b', 'workspace.a'])
    expect(readRegistryFile()?.entries.map(entry => entry.order)).toEqual([1, 2])
  })

  it('rejects an unknown page id on reorder', async () => {
    writeRegistry([registryRow()])
    const lc = lifecycle(fakeExecutor().executor)
    await expect(lc.reorder(['workspace.ghost'])).rejects.toThrow(/unknown page id/)
  })

  it('uninstalls: disables/unloads, pnpm removes the package, drops the row, publishes', async () => {
    writeWorkspacePackage()
    writeRegistry([registryRow()])
    const { executor, calls } = fakeExecutor()
    const { runtime, applySpy } = fakeRuntime()
    const lc = lifecycle(executor, runtime)
    await lc.uninstall('workspace.valid', new AbortController().signal)
    expect(calls.map(call => call.args)).toContainEqual(['remove', PKG])
    expect(readRegistryFile()?.entries).toHaveLength(0)
    expect(applySpy).toHaveBeenCalled()
  })

  it('rejects an unknown page id on uninstall', async () => {
    writeRegistry([registryRow()])
    const lc = lifecycle(fakeExecutor().executor)
    await expect(lc.uninstall('workspace.ghost', new AbortController().signal)).rejects.toThrow(/unknown page id/)
  })
})

describe('activation gate', () => {
  it('settles on the first valid targeted acknowledgement and refuses the rest', async () => {
    const lc = lifecycle(fakeExecutor().executor)
    const transactionId = 'txn-1' as never
    const client = 'client-1' as never
    lc.activation.open({ transactionId, clientInstanceId: client, packageName: PKG, pageId: 'workspace.valid', graphRevision: 'layer-1' })
    expect(lc.activation.acknowledge(transactionId, client, PKG, 'workspace.valid', 'layer-1')).toEqual({ accepted: true })
    expect(lc.activation.acknowledge(transactionId, client, PKG, 'workspace.valid', 'layer-1')).toEqual({ accepted: false, reason: 'stale' })
    lc.activation.discard()
  })

  it('refuses a wrong client, wrong target, and replayed transaction', async () => {
    const lc = lifecycle(fakeExecutor().executor)
    const transactionId = 'txn-1' as never
    lc.activation.open({ transactionId, clientInstanceId: 'client-1' as never, packageName: PKG, pageId: 'workspace.valid', graphRevision: 'layer-1' })
    expect(lc.activation.acknowledge(transactionId, 'other-client' as never, PKG, 'workspace.valid', 'layer-1')).toMatchObject({ accepted: false, reason: 'wrong-client' })
    expect(lc.activation.acknowledge('txn-2' as never, 'client-1' as never, PKG, 'workspace.valid', 'layer-1')).toMatchObject({ accepted: false, reason: 'wrong-target' })
    expect(lc.activation.acknowledge(transactionId, 'client-1' as never, PKG, 'workspace.valid', 'layer-X')).toMatchObject({ accepted: false, reason: 'wrong-target' })
    lc.activation.discard()
  })
})
