import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context, FiberState, type Fiber } from '@deepseek-ai/cordis'
import { profileRuntimeControl } from '@deepseek-ai/dsh-app-boot/profile-runtime-bridge'
import {
  apply,
  awaitLegacyRc2FiberActive,
  disposeLegacyRc2FiberAfterReadyFailure,
  LEGACY_RC2_COMPAT_ENTRY_ID,
  LegacyRc2ProfileRuntime,
  LegacyRc2UpdateCoordinator,
  locateLegacyRc2BundleBoundary,
  prepareLegacyRc2ManagerSnapshot,
  resolveLegacyRc2ProfileIdentity,
} from '../src/legacy-rc2-compat.ts'

const compatRow = { id: LEGACY_RC2_COMPAT_ENTRY_ID, name: '@tingyu9527/dsh-workspace-manager/legacy-rc2-compat' }
const managerRow = { id: 'page-app-manager', name: '@tingyu9527/dsh-workspace-manager' }
const temporaryRoots: string[] = []

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('legacy rc2 profile-runtime compatibility boundary', () => {
  it('locates one final manager bundle by its ordered compat and manager anchor', () => {
    const base = [{ insert: [{ id: 'native', name: '@acme/native' }] }]
    const manager = [{ insert: [compatRow, managerRow] }]
    expect(locateLegacyRc2BundleBoundary(
      [...base, ...manager, { id: 'user', disabled: true }],
      [base, manager],
    )).toEqual({ bundlePatches: [...base, ...manager], suffix: [{ id: 'user', disabled: true }] })
  })

  it('accepts rc2 bundle rows mutated by higher-priority patches but rebuilds from disk layers', () => {
    const base = [{ insert: [{ id: 'native', name: '@acme/native', config: { value: 'bundle' } }] }]
    const manager = [{ insert: [compatRow, managerRow] }]
    const mutatedBase = [{ insert: [{ id: 'native', name: '@acme/native', config: { value: 'user' } }] }]
    expect(locateLegacyRc2BundleBoundary(
      [...mutatedBase, ...manager, { id: 'native', config: { value: 'user' } }],
      [base, manager],
    )).toEqual({
      bundlePatches: [...base, ...manager],
      suffix: [{ id: 'native', config: { value: 'user' } }],
    })
  })

  it('rejects a manager bundle that is not the final actual bundle layer', () => {
    const manager = [{ insert: [compatRow, managerRow] }]
    const later = [{ insert: [{ id: 'later', name: '@acme/later' }] }]
    expect(() => locateLegacyRc2BundleBoundary([...manager, ...later], [manager, later]))
      .toThrow(/final bundle layer/i)
  })

  it('rejects a duplicated or reordered compatibility anchor', () => {
    const reordered = [{ insert: [managerRow, compatRow] }]
    expect(() => locateLegacyRc2BundleBoundary(reordered, [reordered])).toThrow(/ordered anchor/i)
    const manager = [{ insert: [compatRow, managerRow, compatRow] }]
    expect(() => locateLegacyRc2BundleBoundary(manager, [manager])).toThrow(/exactly once/i)
  })

  it('rejects a surviving anchor outside its manifest-proven final-bundle position', () => {
    const base = [{ insert: [{ id: 'native', name: '@acme/native' }] }]
    const manager = [{ insert: [compatRow, managerRow] }]
    expect(() => locateLegacyRc2BundleBoundary([...manager, ...base], [base, manager]))
      .toThrow(/exact final-bundle position/i)
  })

  it('serializes legacy watcher generations and keeps manager patches below user patches', async () => {
    const managerBundle = [{ insert: [compatRow, managerRow] }]
    const coordinator = new LegacyRc2UpdateCoordinator(managerBundle, [{ id: 'managed', config: { value: 'manager' } }])
    const order: string[] = []
    let releaseFirst = (): void => {}
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve })
    const first = { patches: [...managerBundle, { id: 'managed', config: { value: 'user-1' } }] }
    const second = { patches: [...managerBundle, { id: 'managed', config: { value: 'user-2' } }] }
    const firstRun = coordinator.intercept(first, async () => {
      order.push('first-start')
      await firstGate
      order.push('first-end')
    }, () => {})
    const secondRun = coordinator.intercept(second, async () => { order.push('second') }, () => {})
    await Promise.resolve()
    expect(order).toEqual(['first-start'])
    releaseFirst()
    await Promise.all([firstRun, secondRun])
    expect(order).toEqual(['first-start', 'first-end', 'second'])
    expect(first.patches).toEqual([
      ...managerBundle,
      { id: 'managed', config: { value: 'manager' } },
      { id: 'managed', config: { value: 'user-1' } },
    ])
  })

  it('keeps a complete manager operation in the same FIFO and promotes only after success', async () => {
    const managerBundle = [{ insert: [compatRow, managerRow] }]
    const coordinator = new LegacyRc2UpdateCoordinator(managerBundle, [])
    const managerGeneration = { patches: [...managerBundle, { id: 'candidate', name: '@acme/candidate' }] }
    await coordinator.runManager(
      async () => { await coordinator.intercept(managerGeneration, async () => {}, () => {}) },
      [{ id: 'candidate', name: '@acme/candidate' }],
    )
    const watcher = { patches: [...managerBundle, { id: 'candidate', disabled: true }] }
    await coordinator.intercept(watcher, async () => {}, () => {})
    expect(watcher.patches).toEqual([
      ...managerBundle,
      { id: 'candidate', name: '@acme/candidate' },
      { id: 'candidate', disabled: true },
    ])
  })

  it('passes a real bundle removal unchanged but fails loud on a damaged surviving anchor', async () => {
    const managerBundle = [{ insert: [compatRow, managerRow] }]
    const coordinator = new LegacyRc2UpdateCoordinator(managerBundle, [])
    const removed = { patches: [{ insert: [{ id: 'native', name: '@acme/native' }] }] }
    let disposed = false
    await coordinator.intercept(removed, async () => {}, () => { disposed = true })
    expect(disposed).toBe(true)
    expect(removed.patches).toEqual([{ insert: [{ id: 'native', name: '@acme/native' }] }])

    const malformedCoordinator = new LegacyRc2UpdateCoordinator(managerBundle, [])
    const malformed = { patches: [{ insert: [managerRow, compatRow] }] }
    await expect(malformedCoordinator.intercept(malformed, async () => {}, () => {}))
      .rejects.toThrow(/ordered anchor|ordered pair/i)
  })

  it('omits the manager layer and releases the interposer in the generation that disables compat', async () => {
    const managerBundle = [{ insert: [compatRow, managerRow] }]
    const coordinator = new LegacyRc2UpdateCoordinator(managerBundle, [
      { insert: [{ id: 'managed', name: '@acme/managed' }] },
    ])
    const generation = { patches: [
      ...managerBundle,
      { id: LEGACY_RC2_COMPAT_ENTRY_ID, disabled: false },
      { id: LEGACY_RC2_COMPAT_ENTRY_ID, disabled: true },
    ] }
    let disposed = false
    await coordinator.intercept(generation, async () => {}, () => { disposed = true })
    expect(disposed).toBe(true)
    expect(generation.patches).toEqual([
      ...managerBundle,
      { id: LEGACY_RC2_COMPAT_ENTRY_ID, disabled: false },
      { id: LEGACY_RC2_COMPAT_ENTRY_ID, disabled: true },
    ])
  })

  it('keeps the manager layer when a later suffix patch re-enables compat', async () => {
    const managerBundle = [{ insert: [compatRow, managerRow] }]
    const managed = { insert: [{ id: 'managed', name: '@acme/managed' }] }
    const coordinator = new LegacyRc2UpdateCoordinator(managerBundle, [managed])
    const generation = { patches: [
      ...managerBundle,
      { id: LEGACY_RC2_COMPAT_ENTRY_ID, disabled: true },
      { id: LEGACY_RC2_COMPAT_ENTRY_ID, disabled: false },
    ] }
    let disposed = false
    await coordinator.intercept(generation, async () => {}, () => { disposed = true })
    expect(disposed).toBe(false)
    expect(generation.patches).toEqual([
      ...managerBundle,
      managed,
      { id: LEGACY_RC2_COMPAT_ENTRY_ID, disabled: true },
      { id: LEGACY_RC2_COMPAT_ENTRY_ID, disabled: false },
    ])
  })

  it('prepares a non-empty registry before capturing the restart snapshot used by a watcher generation', async () => {
    const profile = mkdtempSync(join(tmpdir(), 'dsh-legacy-rc2-restart-'))
    temporaryRoots.push(profile)
    const feature = join(profile, 'node_modules', '@acme', 'page')
    const manager = join(profile, 'node_modules', '@tingyu9527', 'dsh-workspace-manager')
    mkdirSync(feature, { recursive: true })
    mkdirSync(manager, { recursive: true })
    mkdirSync(join(profile, '.workspace-manager'), { recursive: true })
    writeFileSync(join(manager, 'package.json'), JSON.stringify({
      name: '@tingyu9527/dsh-workspace-manager', version: '1.0.0',
    }))
    writeFileSync(join(feature, 'package.json'), JSON.stringify({
      name: '@acme/page',
      version: '1.0.0',
      dsh: {
        workspace: {
          schemaVersion: 1,
          id: 'fixture-page',
          name: 'Fixture Page',
          description: 'fixture',
          defaultOrder: 0,
          rootEntryId: 'fixture-root',
        },
        bundle: { patch: './cordis.patch.yml' },
      },
    }))
    writeFileSync(join(feature, 'cordis.patch.yml'), [
      '- insert:',
      '    - id: fixture-root',
      "      name: '@acme/feature'",
      '',
    ].join('\n'))
    writeFileSync(join(profile, '.workspace-manager', 'registry.json'), JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      entries: [{
        packageName: '@acme/page',
        source: { kind: 'registry', display: 'https://registry.example/fixture' },
        resolvedVersion: '1.0.0',
        page: {
          id: 'fixture-page',
          name: 'Fixture Page',
          description: 'fixture',
          defaultOrder: 0,
          rootEntryId: 'fixture-root',
        },
        order: 0,
        enabled: true,
        hidden: false,
        installedAt: '2026-08-27T00:00:00.000Z',
        updatedAt: '2026-08-27T00:00:00.000Z',
      }],
    }))
    // A stale pre-restart layer must not become the watcher snapshot.
    writeFileSync(join(profile, '.workspace-manager', 'runtime-layer.yml'), '[]\n')

    const snapshot = await prepareLegacyRc2ManagerSnapshot('legacy-test', profile)
    expect(snapshot.managerPatches).not.toEqual([])
    expect(snapshot.startup.omitted).toEqual([])
    expect(JSON.stringify(snapshot.managerPatches)).toContain('@tingyu9527/dsh-workspace-manager/wrapper')
    const managerBundle = [{ insert: [compatRow, managerRow] }]
    const coordinator = new LegacyRc2UpdateCoordinator(managerBundle, snapshot.managerPatches)
    const watcher = { patches: [...managerBundle, { id: 'user', disabled: true }] }
    await coordinator.intercept(watcher, async () => {}, () => {})
    expect(JSON.stringify(watcher.patches)).toContain('page-app.wrapper.fixture-page')
  })

  it('owns the compatibility runtime with the compatibility fiber', async () => {
    const root = new Context()
    const fiber = await root.plugin((compatCtx) => {
      new LegacyRc2ProfileRuntime(compatCtx, {
        identity: { name: 'web', directory: 'C:/profiles/web' },
        compose: () => [],
        initialManagerPatches: [],
      }, new LegacyRc2UpdateCoordinator([], []), async () => {})
    })
    expect(root.get('profileRuntime')).toBeDefined()
    await fiber.dispose()
    expect(root.get('profileRuntime')).toBeUndefined()
    await root.fiber.dispose()
  })

  it('makes a synchronously provided compatibility runtime activate a real sibling injection', async () => {
    const root = new Context()
    let injected = false
    await root.plugin((providerCtx) => {
      new LegacyRc2ProfileRuntime(providerCtx, {
        identity: { name: 'web', directory: 'C:/profiles/web' },
        compose: () => [],
        initialManagerPatches: [],
      }, new LegacyRc2UpdateCoordinator([], []), async () => {})
    })
    await root.plugin({
      inject: ['profileRuntime'],
      apply: () => { injected = true },
    })
    expect(injected).toBe(true)
    await root.fiber.dispose()
  })

  it('installs prepared snapshot metadata atomically and only once before settlement', async () => {
    const root = new Context()
    let runtime: LegacyRc2ProfileRuntime | undefined
    await root.plugin((ctx) => {
      runtime = new LegacyRc2ProfileRuntime(ctx, {
        identity: { name: 'web', directory: 'C:/profiles/web' },
        compose: () => [],
        initialManagerPatches: [],
      }, new LegacyRc2UpdateCoordinator([], []), async () => {})
    })
    const control = profileRuntimeControl(runtime!)
    expect(control).toBeDefined()
    control!.initializeManagerSnapshot({
      managerPatches: [{ id: 'managed', disabled: true }],
      recoveryError: 'recovered fixture',
      omittedRoots: [{ rootEntryId: 'fixture-root', reason: 'missing-dependency' }],
    })
    expect(runtime!.recoveryError).toBe('recovered fixture')
    expect(runtime!.omittedRoots).toEqual([{ rootEntryId: 'fixture-root', reason: 'missing-dependency' }])
    expect(() => { control!.initializeManagerSnapshot({ managerPatches: [], omittedRoots: [] }) })
      .toThrow(/only once before settlement/i)
    await root.fiber.dispose()
  })

  it('does not cross the post-ready barrier until Cordis marks the provider active', async () => {
    const root = new Context()
    let observedState = -1
    let barrier: Promise<void> = Promise.resolve()
    const fiber = await root.plugin((ctx) => {
      expect(ctx.fiber.state).toBe(1)
      barrier = awaitLegacyRc2FiberActive(ctx).then(() => { observedState = ctx.fiber.state })
    })
    await barrier
    expect(observedState).toBe(2)
    await fiber.dispose()
    await root.fiber.dispose()
  })

  it('passes an already-active fiber without installing a status listener', async () => {
    const root = new Context()
    const fiber = await root.plugin(() => {})
    expect(fiber.state).toBe(FiberState.ACTIVE)
    await expect(awaitLegacyRc2FiberActive(fiber.ctx)).resolves.toBeUndefined()
    await root.fiber.dispose()
  })

  it('rejects failed and timed-out barriers and always removes their listener', async () => {
    const listeners = new Set<(fiber: Fiber) => void>()
    const fakeFiber = { state: FiberState.LOADING } as Fiber
    const fakeContext = {
      fiber: fakeFiber,
      on: (_event: string, listener: (fiber: Fiber) => void) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    } as unknown as Context
    const failed = awaitLegacyRc2FiberActive(fakeContext, 1_000)
    ;(fakeFiber as { state: FiberState }).state = FiberState.FAILED
    for (const listener of listeners) listener(fakeFiber)
    await expect(failed).rejects.toThrow(/exited before becoming active/i)
    expect(listeners).toHaveLength(0)

    ;(fakeFiber as { state: FiberState }).state = FiberState.LOADING
    await expect(awaitLegacyRc2FiberActive(fakeContext, 1)).rejects.toThrow(/within 1ms/i)
    expect(listeners).toHaveLength(0)
  })

  it('still disposes a stuck loading owner after the ACTIVE watchdog expires', async () => {
    const listeners = new Set<(fiber: Fiber) => void>()
    let disposed = false
    const fakeFiber = {
      state: FiberState.LOADING,
      dispose: async () => { disposed = true },
    } as unknown as Fiber
    const fakeContext = {
      fiber: fakeFiber,
      logger: { error: () => {} },
      on: (_event: string, listener: (fiber: Fiber) => void) => {
        listeners.add(listener)
        return () => { listeners.delete(listener) }
      },
    } as unknown as Context
    await disposeLegacyRc2FiberAfterReadyFailure(fakeContext, new Error('stuck init'), 1)
    expect(disposed).toBe(true)
    expect(listeners).toHaveLength(0)
  })

  it('removes an active provided runtime when post-commit recomposition fails', async () => {
    const root = new Context()
    const fiber = await root.plugin((ctx) => {
      new LegacyRc2ProfileRuntime(ctx, {
        identity: { name: 'web', directory: 'C:/profiles/web' },
        compose: () => [],
        initialManagerPatches: [],
      }, new LegacyRc2UpdateCoordinator([], []), async () => {})
    })
    expect(root.get('profileRuntime')).toBeDefined()
    await disposeLegacyRc2FiberAfterReadyFailure(fiber.ctx, new Error('recompose failed'))
    expect(root.get('profileRuntime')).toBeUndefined()
    await root.fiber.dispose()
  })

  it('accepts only the exact DSH home profile root path', () => {
    const home = join('C:', 'dsh-home')
    const dshHomePath = (...segments: string[]): string => join(home, ...segments)
    expect(resolveLegacyRc2ProfileIdentity(
      dshHomePath,
      join(home, 'profiles', 'web', 'cordis.yml'),
    )).toEqual({ name: 'web', directory: join(home, 'profiles', 'web'), homeDirectory: home })
    expect(() => resolveLegacyRc2ProfileIdentity(
      dshHomePath,
      join(home, 'other', 'web', 'cordis.yml'),
    )).toThrow(/DSH_HOME\/profiles/i)
  })

  it('is a structural no-op for a compatible native runtime and fails loud for a bad one', () => {
    const native = {
      identity: Object.freeze({ name: 'web', directory: 'C:/profiles/web' }),
      applyManagerLayer: async () => ({}),
      restoreManagerLayer: async () => ({}),
    }
    const nativeContext = { root: { get: () => native } } as unknown as Context
    expect(() => { apply(nativeContext) }).not.toThrow()
    const mutableContext = {
      root: { get: () => ({ ...native, identity: { name: 'web', directory: 'C:/profiles/web' } }) },
    } as unknown as Context
    expect(() => { apply(mutableContext) }).toThrow(/incompatible structure/i)
    const badContext = { root: { get: () => ({ identity: {} }) } } as unknown as Context
    expect(() => { apply(badContext) }).toThrow(/incompatible structure/i)
  })
})
