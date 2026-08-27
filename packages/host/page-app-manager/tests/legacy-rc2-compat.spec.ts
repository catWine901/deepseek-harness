import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  apply,
  LEGACY_RC2_COMPAT_ENTRY_ID,
  LegacyRc2UpdateCoordinator,
  locateLegacyRc2BundleBoundary,
} from '../src/legacy-rc2-compat.ts'

const compatRow = { id: LEGACY_RC2_COMPAT_ENTRY_ID, name: '@tingyu9527/dsh-workspace-manager/legacy-rc2-compat' }
const managerRow = { id: 'page-app-manager', name: '@tingyu9527/dsh-workspace-manager' }

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

  it('is a structural no-op for a compatible native runtime and fails loud for a bad one', () => {
    const native = {
      identity: { name: 'web', directory: 'C:/profiles/web' },
      applyManagerLayer: async () => ({}),
      restoreManagerLayer: async () => ({}),
    }
    const nativeContext = { root: { get: () => native } } as unknown as Context
    expect(() => { apply(nativeContext) }).not.toThrow()
    const badContext = { root: { get: () => ({ identity: {} }) } } as unknown as Context
    expect(() => { apply(badContext) }).toThrow(/incompatible structure/i)
  })
})
