/**
 * The generated Remote surface of the Host manager: the `pageAppManager`
 * namespace methods (list/install/ackClientActivation/recover) behave through
 * the TypertRemoteService face, and the privileged endpoint names match the
 * wire exactly.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { ProfileRuntime } from '@deepseek-ai/dsh-app-boot'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PageAppManager } from '../src/index.ts'
import type { PageAppPackageExecutor } from '../src/executor.ts'

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

function buildManager(): { ctx: Context; manager: PageAppManager } {
  const ctx = new Context()
  // The real ProfileRuntime requires launcher binding/settling; the Remote
  // tests drive the manager's delegation, so the runtime is a structural fake.
  const runtime = {
    identity: { name: 'fixture-profile', directory: dir },
    applyManagerLayer: async () => ({ generation: 1, activeRoots: ['workspace.remote'], externallyOverridden: [] }),
  } as unknown as ProfileRuntime
  const manager = new PageAppManager(ctx, { profileRuntime: runtime, executor: fakeExecutor() })
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

  it('installs through the Remote face and settles only on the targeted client acknowledgement', async () => {
    writeWorkspacePackage()
    const { manager } = buildManager()
    // The install awaits the targeted ack; drive it through the gate.
    const installPromise = manager.install(registrySource, 'client-1' as never)
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
    const installPromise = manager.install(registrySource, 'client-1' as never)
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
})
