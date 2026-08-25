/**
 * The generated Remote surface of the Host manager: the `pageAppManager`
 * namespace methods (list/installPackage/ackClientActivation/recover) behave
 * through the TypertRemoteService face, and the privileged endpoint names
 * match the wire exactly.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { PROFILE_RUNTIME_SERVICE, ProfileRuntime } from '@deepseek-ai/dsh-app-boot'
import { remoteMethods } from '@deepseek-ai/dsh-typert-protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PageAppManager } from '../src/index.ts'
import { PageAppCommandAbortedError, type PageAppPackageExecutor } from '../src/executor.ts'

const PKG = '@fixture/remote-workspace'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-page-app-remote-'))
  mkdirSync(join(dir, '.workspace-manager'), { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture-profile', private: true, dependencies: {} }))
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function writeWorkspacePackage(): void {
  const pkgDir = join(dir, 'node_modules', ...PKG.split('/'))
  mkdirSync(join(pkgDir, 'lib'), { recursive: true })
  writeFileSync(join(pkgDir, 'cordis.patch.yml'), JSON.stringify([{ insert: [
    { id: 'workspace.remote', name: `${PKG}/client` },
    { id: 'fixture-client-row', name: PKG },
  ] }]))
  writeFileSync(join(pkgDir, 'lib', 'client.js'), 'module.exports = {}\n')
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
    name: PKG,
    version: '1.0.0',
    exports: { './client': './lib/client.js' },
    dsh: {
      bundle: { patch: './cordis.patch.yml' },
      workspace: {
        schemaVersion: 1, id: 'workspace.remote', name: 'Remote', description: 'd', defaultOrder: 100, rootEntryId: 'workspace.remote',
      },
      client: { platform: 'web' },
    },
  }))
}

/** Fake pnpm: `add` writes the dependency into the profile manifest (pnpm's real effect). */
function fakeExecutor(): PageAppPackageExecutor {
  return {
    run: async (args) => {
      const [verb] = args
      if (verb === 'add' && args[1] !== undefined) {
        const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
        manifest.dependencies[args[1]] = '1.0.0'
        writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    },
  }
}

function buildManager(config: { settlementTimeoutMs: number } = { settlementTimeoutMs: 60_000 }): {
  ctx: Context
  manager: PageAppManager
} {
  const ctx = new Context()
  // The real ProfileRuntime requires launcher binding/settling; the Remote
  // tests drive the manager's delegation, so the runtime is a structural fake.
  const runtime = {
    identity: { name: 'fixture-profile', directory: dir },
    applyManagerLayer: async () => ({ generation: 1, activeRoots: ['workspace.remote'], externallyOverridden: [] }),
  } as unknown as ProfileRuntime
  // The install activation request carries the Host client-graph rev; a fake
  // ClientModuleRegistry provides the graph the manager reads.
  ctx.reflect.provide('clientModules', { graph: () => ({ rev: 'graph-rev-1' }) })
  const manager = new PageAppManager(ctx, { profileRuntime: runtime, executor: fakeExecutor(), config })
  return { ctx, manager }
}

const registrySource = { kind: 'registry' as const, spec: PKG, display: { kind: 'registry' as const, display: PKG } }

describe('pageAppManager Remote surface', () => {
  it('lists an empty managed set before any install', () => {
    const { manager } = buildManager()
    const snapshot = manager.list()
    expect(snapshot.profile).toEqual({ name: 'fixture-profile', directory: dir })
    expect(snapshot.revision).toBe(0)
    expect(snapshot.entries).toEqual([])
  })

  it('resolves the real profile snapshot through the manager traceable proxy over the runtime traceable proxy', async () => {
    // The production nested-proxy path: apply() stores ctx.get(PROFILE_RUNTIME_SERVICE)
    // (one traceable layer) in the manager, and the gateway invokes the manager
    // through ctx.get('pageAppManager'), whose traceable get re-wraps the stored
    // runtime into a second layer. list() must still resolve the real identity.
    const ctx = new Context()
    try {
      const runtime = new ProfileRuntime(ctx, {
        identity: { name: 'fixture-profile', directory: dir },
        compose: () => [],
        initialManagerPatches: [],
      })
      const viaRuntime: unknown = ctx.get(PROFILE_RUNTIME_SERVICE)
      expect(viaRuntime).not.toBe(runtime)
      const manager = new PageAppManager(ctx, {
        profileRuntime: viaRuntime as ProfileRuntime,
        executor: fakeExecutor(),
        config: { settlementTimeoutMs: 60_000 },
      })
      const viaGateway = ctx.get('pageAppManager') as PageAppManager
      expect(viaGateway).not.toBe(manager)
      const snapshot = viaGateway.list()
      expect(snapshot.profile).toEqual({ name: 'fixture-profile', directory: dir })
      expect(snapshot.revision).toBe(0)
      expect(snapshot.entries).toEqual([])
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('exposes the install Remote under installPackage and never the reserved install spelling', () => {
    // The gateway's namespace service reserves `install` on its prototype; the
    // exported wire surface must carry `installPackage` instead so a fresh
    // generated client can mount the namespace.
    const { manager } = buildManager()
    const exported = remoteMethods(manager).map(marker => marker.exportName ?? marker.method)
    expect(exported).toContain('installPackage')
    expect(exported).not.toContain('install')
  })

  it('installs through the Remote face and settles only on the targeted client acknowledgement', async () => {
    writeWorkspacePackage()
    const { manager } = buildManager()
    // The install awaits the targeted ack; drive it through the gate.
    const installPromise = manager.install(registrySource, 'client-1' as never, new AbortController().signal)
    let revision: number | undefined
    // Poll for the pending activation request, then acknowledge as the client.
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const pending = manager.activation.pendingRequest
      if (pending !== undefined) {
        const ack = manager.ackClientActivation(
          pending.transactionId, 'client-1' as never, pending.packageName, pending.pageId, pending.graphRevision,
        )
        expect(ack.accepted).toBe(true)
        revision = await installPromise
        break
      }
      await new Promise(resolve => setTimeout(resolve, 1))
    }
    expect(revision).toBe(1)
    expect(manager.list().entries).toHaveLength(1)
    expect(manager.list().entries[0]?.packageName).toBe(PKG)
  })

  it('refuses a stale or wrong-target acknowledgement through the Remote face', async () => {
    writeWorkspacePackage()
    const { manager } = buildManager()
    const installPromise = manager.install(registrySource, 'client-1' as never, new AbortController().signal)
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const pending = manager.activation.pendingRequest
      if (pending !== undefined) {
        expect(manager.ackClientActivation('txn-other' as never, 'client-1' as never, pending.packageName, pending.pageId, pending.graphRevision))
          .toMatchObject({ accepted: false })
        expect(manager.ackClientActivation(pending.transactionId, 'other-client' as never, pending.packageName, pending.pageId, pending.graphRevision))
          .toMatchObject({ accepted: false, reason: 'wrong-client' })
        const ack = manager.ackClientActivation(pending.transactionId, 'client-1' as never, pending.packageName, pending.pageId, pending.graphRevision)
        expect(ack.accepted).toBe(true)
        await installPromise
        break
      }
      await new Promise(resolve => setTimeout(resolve, 1))
    }
  })

  it('recovers a committed journal (commit-completed) through the Remote face', async () => {
    // A committed state: the registry file holds the NEW revision while the
    // journal records the OLD before-hash — the commit published, only the
    // journal removal was interrupted.
    const before = JSON.stringify({
      schemaVersion: 1,
      revision: 0,
      entries: [],
    })
    const registry = JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      entries: [{
        packageName: PKG,
        source: { kind: 'registry', display: PKG },
        resolvedVersion: '1.0.0',
        page: { id: 'workspace.remote', name: 'Remote', description: 'd', defaultOrder: 100, rootEntryId: 'workspace.remote' },
        order: 100, enabled: true, hidden: false,
        installedAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-08-01T00:00:00.000Z',
      }],
    })
    writeFileSync(join(dir, '.workspace-manager', 'registry.json'), registry)
    const { createHash } = await import('node:crypto')
    writeFileSync(join(dir, '.workspace-manager', 'transaction.json'), JSON.stringify({
      schemaVersion: 1,
      phase: 'committing',
      lockOwnerToken: 'token-1',
      files: {
        'registry.json': { present: true, sha256: createHash('sha256').update(before).digest('hex') },
        'runtime-layer.yml': { present: false },
        '../package.json': { present: false },
        '../pnpm-lock.yaml': { present: false },
      },
    }))
    const { manager } = buildManager()
    const outcome = await manager.recover()
    expect(outcome.action).toBe('commit-completed')
    expect(manager.list().revision).toBe(1)
  })

  it('propagates an aborted signal through the install Remote call', async () => {
    writeWorkspacePackage()
    const ctx = new Context()
    const runtime = {
      identity: { name: 'fixture-profile', directory: dir },
      applyManagerLayer: async () => ({ generation: 1, activeRoots: ['workspace.remote'], externallyOverridden: [] }),
      restoreManagerLayer: async () => ({ generation: 1, activeRoots: ['workspace.remote'], externallyOverridden: [] }),
    } as unknown as ProfileRuntime
    ctx.reflect.provide('clientModules', { graph: () => ({ rev: 'graph-rev-1' }) })
    const seenAborted: boolean[] = []
    const executor: PageAppPackageExecutor = {
      run: async (_args, options) => {
        seenAborted.push(options.signal.aborted)
        if (options.signal.aborted) throw new PageAppCommandAbortedError()
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    }
    const manager = new PageAppManager(ctx, { profileRuntime: runtime, executor, config: { settlementTimeoutMs: 60_000 } })
    const controller = new AbortController()
    controller.abort()
    await expect(manager.install(registrySource, 'client-1' as never, controller.signal))
      .rejects.toBeInstanceOf(PageAppCommandAbortedError)
    // The Remote signature carried the caller's signal into pnpm.
    expect(seenAborted).toContain(true)
  })

  it('reads the settlement timeout from the plugin config', async () => {
    writeWorkspacePackage()
    const { manager } = buildManager({ settlementTimeoutMs: 60 })
    const installPromise = manager.install(registrySource, 'client-1' as never, new AbortController().signal)
    await expect(installPromise).rejects.toThrow(/settlement wait timed out/)
  })
})
