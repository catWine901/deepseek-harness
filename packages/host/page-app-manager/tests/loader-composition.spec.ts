/**
 * The runtime composition seam the M2 rollback rests on: `ProfileRuntime`
 * recomposition over a real booted Loader tree. A failed candidate generation
 * leaves the prior committed tree active (Include's transactional update), a
 * restore returns to a prior composition and audits its active roots, and an
 * activation audit failure rejects the apply while the failed generation is
 * never acknowledged (the prior layer stays the acknowledged one). These are
 * the last-known-good contracts `PageAppLifecycle.rollback` awaits through
 * `restoreManagerLayer` before converging files.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import {
  boot,
  canonicalManagedRootHash,
  composeProfilePatches,
  loadOptionalPatches,
  PROFILE_PATCH_FILENAME,
  ProfileRuntime,
  readManagerLayerPatches,
  type ActiveProfileIdentity,
  type ExpectedManagedRoot,
  type ProfileRuntimeApplyRequest,
} from '@deepseek-ai/dsh-app-boot'

const NAME = 'dsh-loader-composition-test'

const NOOP_PLUGIN = 'export const name = "noop"\nexport function apply() {}\n'

const MANAGER_PLUGIN = [
  'export const name = "manager-plugin"',
  'export function apply(ctx, config = {}) {',
  '  if (config.fail) throw new Error("candidate generation failed to apply")',
  '}',
  '',
].join('\n')

const PENDING_PLUGIN = 'export const inject = ["neverProvided"]\nexport function apply() {}\n'

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    // Cleanup is best-effort; the OS temp dir is the fallback.
    void import('node:fs/promises').then(({ rm }) => rm(dir, { recursive: true, force: true })).catch(() => {})
  }
})

/** Boot a real Loader tree with a launcher-provided ProfileRuntime (like profile boot wires it). */
async function bootRuntimeTree(): Promise<{ ctx: Context; runtime: ProfileRuntime; dir: string; managerLayerPath: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-loader-composition-'))
  dirs.push(dir)
  writeFileSync(join(dir, 'noop.mjs'), NOOP_PLUGIN)
  writeFileSync(join(dir, 'manager.mjs'), MANAGER_PLUGIN)
  writeFileSync(join(dir, 'pending.mjs'), PENDING_PLUGIN)
  writeFileSync(join(dir, 'cordis.yml'), '- id: base\n  name: ./noop.mjs\n')
  mkdirSync(join(dir, '.workspace-manager'), { recursive: true })
  const identity: ActiveProfileIdentity = { name: 'demo', directory: dir }
  let runtime: ProfileRuntime | undefined
  const ctx = await boot(NAME, join(dir, 'cordis.yml'), undefined, (hostCtx) => {
    runtime = new ProfileRuntime(hostCtx, {
      identity,
      compose: managerPatches => composeProfilePatches({
        bundlePatches: [],
        managerPatches,
        profilePatches: loadOptionalPatches(NAME, join(dir, PROFILE_PATCH_FILENAME)) ?? [],
        homePatches: [],
        overlays: [],
      }),
      initialManagerPatches: readManagerLayerPatches(NAME, dir),
    })
  })
  if (runtime === undefined) throw new Error('boot did not construct the profile runtime')
  return { ctx, runtime, dir, managerLayerPath: join(dir, '.workspace-manager', 'runtime-layer.yml') }
}

/** A layer mounting one manager-plugin root plus the expected hash of its derived row. */
function singleRootLayer(rootId: string, value: number | { fail: true }): { layer: string; expected: ExpectedManagedRoot } {
  const layer = [
    '- insert:',
    `    - id: ${rootId}`,
    '      name: ./manager.mjs',
    '      config:',
    typeof value === 'number' ? `        value: ${value}` : '        fail: true',
    '',
  ].join('\n')
  return {
    layer,
    expected: {
      packageName: '@acme/page',
      pageId: 'page-id',
      rootEntryId: rootId,
      hash: canonicalManagedRootHash({ id: rootId, name: './manager.mjs', config: value }),
    },
  }
}

function applyRequest(layer: string, expectedRoots: readonly ExpectedManagedRoot[], revision = 1): ProfileRuntimeApplyRequest {
  return { registryRevision: revision, runtimeLayer: layer, expectedRoots }
}

function entryOptions(ctx: Context, id: string): unknown {
  return [...ctx.loader.entries()].find(entry => entry.options.id === id)?.options
}

describe('manager layer composition (the M2 rollback seam)', () => {
  it('applyManagerLayer failure rolls back to the prior committed tree', async () => {
    const { ctx, runtime, managerLayerPath } = await bootRuntimeTree()
    try {
      const first = singleRootLayer('page', 1)
      writeFileSync(managerLayerPath, first.layer)
      await runtime.applyManagerLayer(applyRequest(first.layer, [first.expected]))
      expect(entryOptions(ctx, 'page')).toEqual({ id: 'page', name: './manager.mjs', config: { value: 1 } })

      const failing = singleRootLayer('page', { fail: true })
      writeFileSync(managerLayerPath, failing.layer)
      await expect(runtime.applyManagerLayer(applyRequest(failing.layer, [failing.expected])))
        .rejects.toThrow(/failed to apply/)
      // The prior committed tree is still the live one.
      expect(entryOptions(ctx, 'page')).toEqual({ id: 'page', name: './manager.mjs', config: { value: 1 } })

      // The next generation still applies.
      const next = singleRootLayer('page', 3)
      writeFileSync(managerLayerPath, next.layer)
      await runtime.applyManagerLayer(applyRequest(next.layer, [next.expected]))
      expect(entryOptions(ctx, 'page')).toEqual({ id: 'page', name: './manager.mjs', config: { value: 3 } })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('restoreManagerLayer restores the prior composition and audits active roots', async () => {
    const { ctx, runtime, managerLayerPath } = await bootRuntimeTree()
    try {
      const first = singleRootLayer('page', 1)
      writeFileSync(managerLayerPath, first.layer)
      await runtime.applyManagerLayer(applyRequest(first.layer, [first.expected]))

      const second = singleRootLayer('page', 2)
      writeFileSync(managerLayerPath, second.layer)
      await runtime.applyManagerLayer(applyRequest(second.layer, [second.expected]))
      expect(entryOptions(ctx, 'page')).toEqual({ id: 'page', name: './manager.mjs', config: { value: 2 } })

      // Restore the first generation; the audit confirms the root is active.
      writeFileSync(managerLayerPath, first.layer)
      const restored = await runtime.restoreManagerLayer(applyRequest(first.layer, [first.expected], 3))
      expect(restored.generation).toBe(3)
      expect(restored.activeRoots).toEqual(['page'])
      expect(entryOptions(ctx, 'page')).toEqual({ id: 'page', name: './manager.mjs', config: { value: 1 } })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('an activation audit failure rejects the apply and keeps the prior layer', async () => {
    const { ctx, runtime, managerLayerPath } = await bootRuntimeTree()
    try {
      const first = singleRootLayer('page', 1)
      writeFileSync(managerLayerPath, first.layer)
      await runtime.applyManagerLayer(applyRequest(first.layer, [first.expected]))

      // A root that stays pending on an injected service fails the audit.
      const pendingLayer = '- insert:\n    - id: waiting\n      name: ./pending.mjs\n'
      writeFileSync(managerLayerPath, pendingLayer)
      const expected: ExpectedManagedRoot = {
        packageName: '@acme/p',
        pageId: 'pid',
        rootEntryId: 'waiting',
        hash: canonicalManagedRootHash({ id: 'waiting', name: './pending.mjs' }),
      }
      await expect(runtime.applyManagerLayer(applyRequest(pendingLayer, [expected], 2)))
        .rejects.toThrow(/root activation audit failed/)
      // The failed generation was never acknowledged: restoring the prior layer
      // returns generation 2 (only the two successful generations counted) and
      // the prior composition.
      writeFileSync(managerLayerPath, first.layer)
      const restored = await runtime.restoreManagerLayer(applyRequest(first.layer, [first.expected], 2))
      expect(restored.generation).toBe(2)
      expect(restored.activeRoots).toEqual(['page'])
      expect(entryOptions(ctx, 'page')).toEqual({ id: 'page', name: './manager.mjs', config: { value: 1 } })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
