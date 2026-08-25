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
import type { ProfileRuntime, ProfileRuntimeApplyRequest } from '@deepseek-ai/dsh-app-boot'
import type { PageAppRegistryV1 } from '@deepseek-ai/dsh-page-app-profile'
import { PageAppLifecycle, PageAppBuildPermissionError } from '../src/transaction.ts'
import { createPnpmExecutor, PageAppCommandAbortedError, type PageAppPackageExecutor } from '../src/executor.ts'
import { parsePageAppInstallSource } from '../src/source.ts'
import type { PageAppInstallSource } from '../src/types.ts'

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
    restoreManagerLayer: async () => ({ generation: 1, activeRoots: ['workspace.valid'], externallyOverridden: [] }),
  }
  return { runtime: runtime as unknown as ProfileRuntime, applySpy }
}

function lifecycle(executor: PageAppPackageExecutor, runtime: ProfileRuntime = fakeRuntime().runtime): PageAppLifecycle {
  return new PageAppLifecycle({
    profileDir: dir,
    executor,
    runtime,
    pnpmWorkspaceFile: workspaceYaml,
    settlementTimeoutMs: 60_000,
    clientGraphRev: () => 'graph-rev-1',
  })
}

const REGISTRY_SOURCE: PageAppInstallSource = { kind: 'registry', spec: PKG, display: { kind: 'registry', display: PKG } }

/** Drive one install to completion by acknowledging through the targeted activation gate. */
async function installWithAck(
  lc: PageAppLifecycle,
  clientInstanceId: string,
  source: PageAppInstallSource = REGISTRY_SOURCE,
): Promise<number> {
  const promise = lc.install(source, clientInstanceId as never, new AbortController().signal)
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
    type SpawnOptions = { cwd: string; cancelSignal: AbortSignal; reject: false }
    const spawn = vi.fn(async (file: string, args: readonly string[], _options: SpawnOptions) => {
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

  it('resolves a local link: install by the post-add direct dependency key (the package name), not the raw spec', async () => {
    writeWorkspacePackage()
    const linkSpec = `link:${join(dir, 'source', 'page-app-fixture')}`
    const source = parsePageAppInstallSource(linkSpec, 'link')
    const executor: PageAppPackageExecutor = {
      run: async (args) => {
        if (args[0] === 'add' && args[1] !== undefined) {
          // pnpm keys node_modules and the profile manifest by the package's
          // OWN name; the link spec becomes the dependency VALUE.
          const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
          manifest.dependencies[PKG] = linkSpec
          writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
        }
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    }
    const lc = lifecycle(executor)
    const revision = await installWithAck(lc, 'client-1', source)
    expect(revision).toBe(1)
    const entry = readRegistryFile()?.entries[0]
    expect(entry?.packageName).toBe(PKG)
    expect(entry?.source).toEqual(source.display)
    expect(entry?.resolvedVersion).toBe('1.0.0')
  })

  it('rejects a non-registry install whose pnpm add produced no direct dependency change', async () => {
    writeWorkspacePackage()
    const linkSpec = `link:${join(dir, 'source', 'page-app-fixture')}`
    const source = parsePageAppInstallSource(linkSpec, 'link')
    // A successful add that leaves the profile manifest untouched yields zero
    // candidates; the install must fail loud instead of guessing a key.
    const executor: PageAppPackageExecutor = {
      run: async () => ({ exitCode: 0, stdout: '', stderr: '' }),
    }
    const lc = lifecycle(executor)
    await expect(lc.install(source, 'client-1' as never, new AbortController().signal))
      .rejects.toThrow(/produced no direct profile dependency change .*exactly one added or changed dependency key/)
  })

  it('rejects a non-registry install whose pnpm add changed multiple direct dependencies', async () => {
    writeWorkspacePackage()
    const linkSpec = `link:${join(dir, 'source', 'page-app-fixture')}`
    const source = parsePageAppInstallSource(linkSpec, 'link')
    const executor: PageAppPackageExecutor = {
      run: async (args) => {
        if (args[0] === 'add' && args[1] !== undefined) {
          const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
          manifest.dependencies['@fixture/other-workspace'] = 'link:C:\\other'
          manifest.dependencies[PKG] = linkSpec
          writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
        }
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    }
    const lc = lifecycle(executor)
    // Deterministic ambiguity error: both candidate keys are named, sorted.
    await expect(lc.install(source, 'client-1' as never, new AbortController().signal))
      .rejects.toThrow(/changed 2 direct profile dependencies \(@fixture\/other-workspace, @fixture\/valid-workspace\)/)
  })

  it('claims an already-present registry dependency when pnpm add leaves the manifest unchanged (no-delta reinstall)', async () => {
    writeWorkspacePackage()
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'fixture-profile',
      private: true,
      dependencies: { [PKG]: '1.0.0' },
    }))
    const { executor } = fakeExecutor() // add rewrites the same spec — no delta
    const lc = lifecycle(executor)
    const revision = await installWithAck(lc, 'client-1')
    expect(revision).toBe(1)
    expect(readRegistryFile()?.entries[0]?.packageName).toBe(PKG)
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

  it('runs the dependency admission after pnpm staging but before any ownership mutation', async () => {
    // The installed package declares a direct Cordis dependency: pnpm staging
    // succeeds (the dependency lands in node_modules), then the dependency
    // boundary rejects it before any registry or ownership change.
    writeWorkspacePackage()
    const pkgDir = join(dir, 'node_modules', ...PKG.split('/'))
    const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> }
    pkg.dependencies = { cordis: '^4.0.1' }
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify(pkg))
    const { executor, calls } = fakeExecutor()
    const { runtime, applySpy } = fakeRuntime()
    const lc = lifecycle(executor, runtime)
    await expect(lc.install(
      { kind: 'registry', spec: PKG, display: { kind: 'registry', display: PKG } },
      'client-1' as never,
      new AbortController().signal,
    )).rejects.toThrow(/declares a direct cordis dependency/)
    // pnpm add ran (staging happened) and the rollback converged node_modules.
    expect(calls.map(call => call.args[0])).toContain('add')
    expect(calls.map(call => call.args[0])).toContain('install')
    // The rejection preceded every ownership mutation: no registry write, no
    // runtime apply. The journal is retained (design D8 removes it only after
    // commit), so the failed install projects recovery-required until the
    // operator runs recover().
    expect(readRegistryFile()).toBeNull()
    expect(applySpy).not.toHaveBeenCalled()
    expect(() => readFileSync(join(dir, '.workspace-manager', 'transaction.json'), 'utf8')).not.toThrow()
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

describe('M1.1 cancellation, graph revision, and lifecycle abort', () => {
  it('carries the host client-graph revision (not the layer document) in the activation request', async () => {
    writeWorkspacePackage()
    const { executor } = fakeExecutor()
    const lc = new PageAppLifecycle({
      profileDir: dir,
      executor,
      runtime: fakeRuntime().runtime,
      pnpmWorkspaceFile: workspaceYaml,
      settlementTimeoutMs: 60_000,
      clientGraphRev: () => 'graph-rev-42',
    })
    const promise = lc.install(
      { kind: 'registry', spec: PKG, display: { kind: 'registry', display: PKG } },
      'client-1' as never,
      new AbortController().signal,
    )
    let revision: number | undefined
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const request = lc.activation.pendingRequest
      if (request !== undefined) {
        expect(request.graphRevision).toBe('graph-rev-42')
        expect(request.graphRevision).not.toMatch(/insert|registry|runtime-layer/)
        const ack = lc.activation.acknowledge(
          request.transactionId, 'client-1' as never, request.packageName, request.pageId, request.graphRevision,
        )
        expect(ack.accepted).toBe(true)
        revision = await promise
        break
      }
      await new Promise(resolve => setTimeout(resolve, 1))
    }
    expect(revision).toBe(1)
  })

  it('refuses a stale acknowledgement whose graph revision does not match the request', async () => {
    writeWorkspacePackage()
    const lc = lifecycle(fakeExecutor().executor)
    const promise = lc.install(
      { kind: 'registry', spec: PKG, display: { kind: 'registry', display: PKG } },
      'client-1' as never,
      new AbortController().signal,
    )
    let revision: number | undefined
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const request = lc.activation.pendingRequest
      if (request !== undefined) {
        expect(lc.activation.acknowledge(
          request.transactionId, 'client-1' as never, request.packageName, request.pageId, 'unrelated-rev',
        )).toMatchObject({ accepted: false, reason: 'wrong-target' })
        const ack = lc.activation.acknowledge(
          request.transactionId, 'client-1' as never, request.packageName, request.pageId, request.graphRevision,
        )
        expect(ack.accepted).toBe(true)
        revision = await promise
        break
      }
      await new Promise(resolve => setTimeout(resolve, 1))
    }
    expect(revision).toBe(1)
  })

  it('aborts pnpm and the settlement wait when the passed signal aborts', async () => {
    writeWorkspacePackage()
    const calls: { args: readonly string[]; aborted: boolean }[] = []
    const executor: PageAppPackageExecutor = {
      run: async (args, options) => {
        calls.push({ args, aborted: options.signal.aborted })
        if (options.signal.aborted) throw new PageAppCommandAbortedError()
        // Simulate pnpm's real effect: `add` lands the dependency in the profile manifest.
        if (args[0] === 'add' && args[1] !== undefined) {
          const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
          manifest.dependencies[args[1]] = '1.0.0'
          writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
        }
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    }
    const lc = lifecycle(executor)
    // Phase 1: a pre-aborted signal cancels pnpm before the command runs.
    const controller = new AbortController()
    controller.abort()
    await expect(lc.install(
      { kind: 'registry', spec: PKG, display: { kind: 'registry', display: PKG } },
      'client-1' as never,
      controller.signal,
    )).rejects.toBeInstanceOf(PageAppCommandAbortedError)
    expect(calls.some(call => call.args[0] === 'add' && call.aborted)).toBe(true)
    // Phase 1 rolled back; clear its retained journal so phase 2 starts clean.
    rmSync(join(dir, '.workspace-manager', 'transaction.json'), { force: true })
    // Phase 2: aborting while the activation gate waits rejects the wait.
    const waitController = new AbortController()
    const install = lc.install(
      { kind: 'registry', spec: PKG, display: { kind: 'registry', display: PKG } },
      'client-2' as never,
      waitController.signal,
    )
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (lc.activation.pendingRequest !== undefined) break
      await new Promise(resolve => setTimeout(resolve, 1))
    }
    expect(lc.activation.pending).toBe(true)
    waitController.abort()
    await expect(install).rejects.toThrow(/settlement wait aborted/)
  })

  it('aborts the in-flight transaction when the lifecycle disposes (manager fiber gone)', async () => {
    writeWorkspacePackage()
    const lc = lifecycle(fakeExecutor().executor)
    const promise = lc.install(
      { kind: 'registry', spec: PKG, display: { kind: 'registry', display: PKG } },
      'client-1' as never,
      new AbortController().signal,
    )
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (lc.activation.pendingRequest !== undefined) break
      await new Promise(resolve => setTimeout(resolve, 1))
    }
    expect(lc.activation.pending).toBe(true)
    lc.dispose()
    await expect(promise).rejects.toThrow(/settlement wait aborted/)
    expect(readRegistryFile()).toBeNull()
    // The disposed lifecycle refuses any further mutation.
    await expect(lc.install(
      { kind: 'registry', spec: PKG, display: { kind: 'registry', display: PKG } },
      'client-2' as never,
      new AbortController().signal,
    )).rejects.toThrow(/disposed/)
  })
})

describe('M2 rollback live-tree restoration, journal guard, and expected-root hashes', () => {
  const runtimeWithRestore = (restore: ProfileRuntime['restoreManagerLayer']): ProfileRuntime => ({
    identity: { name: 'fixture-profile', directory: dir },
    applyManagerLayer: async () => ({ generation: 1, activeRoots: ['workspace.valid'], externallyOverridden: [] }),
    restoreManagerLayer: restore,
  }) as unknown as ProfileRuntime

  it('publish failure rolls back the live Include tree via restoreManagerLayer and awaits its audit', async () => {
    writeWorkspacePackage()
    const { executor } = fakeExecutor()
    const restoreSpy = vi.fn(async (_request: ProfileRuntimeApplyRequest) => ({ generation: 1, activeRoots: [], externallyOverridden: [] }))
    const lc = lifecycle(executor, runtimeWithRestore(restoreSpy))
    const promise = lc.install(
      { kind: 'registry', spec: PKG, display: { kind: 'registry', display: PKG } },
      'client-1' as never,
      new AbortController().signal,
    )
    // Acknowledge as the client, then replace the registry path with a
    // directory so the publish (registry write) fails after the layer applied.
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const request = lc.activation.pendingRequest
      if (request !== undefined) {
        const ack = lc.activation.acknowledge(
          request.transactionId, 'client-1' as never, request.packageName, request.pageId, request.graphRevision,
        )
        if (ack.accepted) {
          rmSync(join(dir, '.workspace-manager', 'registry.json'), { force: true })
          mkdirSync(join(dir, '.workspace-manager', 'registry.json'))
          break
        }
      }
      await new Promise(resolve => setTimeout(resolve, 1))
    }
    await expect(promise).rejects.toThrow(/recovery-required|rollback/)
    // Rollback restored the prior live tree through the acknowledged runtime
    // and awaited its audit; the fresh profile had no prior layer or registry.
    expect(restoreSpy).toHaveBeenCalledTimes(1)
    const request = restoreSpy.mock.calls[0]?.[0] as ProfileRuntimeApplyRequest
    expect(request.registryRevision).toBe(0)
    expect(request.runtimeLayer).toBe('[]\n')
    expect(request.expectedRoots).toEqual([])
    // The file restore hit the same registry write error, so the journal stays.
    expect(() => readFileSync(join(dir, '.workspace-manager', 'transaction.json'), 'utf8')).not.toThrow()
  })

  it('pnpm remove failure on uninstall restores the layer that still contains the root', async () => {
    writeWorkspacePackage()
    // The profile manifest records the previously-installed package.
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'fixture-profile',
      private: true,
      dependencies: { [PKG]: '1.0.0' },
    }))
    const beforeLayer = [
      '- insert:',
      '    - id: workspace.valid',
      "      name: '@fixture/valid-workspace/client'",
      '',
    ].join('\n')
    writeRegistry([registryRow()])
    writeFileSync(join(dir, '.workspace-manager', 'runtime-layer.yml'), beforeLayer)
    const executor: PageAppPackageExecutor = {
      run: async (args) => {
        if (args[0] === 'remove') return { exitCode: 1, stdout: '', stderr: 'pnpm remove failed: boom' }
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    }
    const restoreSpy = vi.fn(async (_request: ProfileRuntimeApplyRequest) => ({ generation: 1, activeRoots: ['workspace.valid'], externallyOverridden: [] }))
    const lc = lifecycle(executor, runtimeWithRestore(restoreSpy))
    await expect(lc.uninstall('workspace.valid', new AbortController().signal)).rejects.toThrow(/pnpm remove failed/)
    // The uninstall rollback restored the layer that still contains the root.
    expect(restoreSpy).toHaveBeenCalledTimes(1)
    const request = restoreSpy.mock.calls[0]?.[0] as ProfileRuntimeApplyRequest
    expect(request.runtimeLayer).toBe(beforeLayer)
    expect(request.expectedRoots).toHaveLength(1)
    expect(request.expectedRoots[0]).toMatchObject({
      packageName: PKG,
      pageId: 'workspace.valid',
      rootEntryId: 'page-app.wrapper.workspace.valid',
    })
    expect(request.expectedRoots[0]?.hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('refuses to start a new transaction while a journal exists (recovery-required)', async () => {
    writeWorkspacePackage()
    const journalPath = join(dir, '.workspace-manager', 'transaction.json')
    writeFileSync(journalPath, JSON.stringify({
      schemaVersion: 1,
      phase: 'prepared',
      lockOwnerToken: 'token-other',
      files: {
        'registry.json': { present: false },
        'runtime-layer.yml': { present: false },
        '../package.json': { present: true, sha256: 'a'.repeat(64) },
        '../pnpm-lock.yaml': { present: false },
      },
    }))
    const lc = lifecycle(fakeExecutor().executor)
    await expect(lc.install(
      { kind: 'registry', spec: PKG, display: { kind: 'registry', display: PKG } },
      'client-1' as never,
      new AbortController().signal,
    )).rejects.toThrow(/a journal exists; run recover\(\) first \(recovery-required\)/)
    // The crashed transaction's journal was not overwritten.
    expect(JSON.parse(readFileSync(journalPath, 'utf8'))).toMatchObject({ lockOwnerToken: 'token-other' })
  })

  it('sends real expected root hashes in the apply request (never empty)', async () => {
    writeWorkspacePackage()
    const { executor } = fakeExecutor()
    const applySpy = vi.fn(async (_request: ProfileRuntimeApplyRequest) => ({ generation: 1, activeRoots: ['workspace.valid'], externallyOverridden: [] }))
    const runtime = {
      identity: { name: 'fixture-profile', directory: dir },
      applyManagerLayer: applySpy,
    } as unknown as ProfileRuntime
    const lc = lifecycle(executor, runtime)
    const revision = await installWithAck(lc, 'client-1')
    expect(revision).toBe(1)
    const request = applySpy.mock.calls[0]?.[0] as ProfileRuntimeApplyRequest
    expect(request.expectedRoots).toHaveLength(1)
    expect(request.expectedRoots[0]).toMatchObject({
      packageName: PKG,
      pageId: 'workspace.valid',
      rootEntryId: 'page-app.wrapper.workspace.valid',
    })
    expect(request.expectedRoots[0]?.hash).toMatch(/^[0-9a-f]{64}$/)
    expect(request.expectedRoots[0]?.hash).not.toBe('')
  })
})
