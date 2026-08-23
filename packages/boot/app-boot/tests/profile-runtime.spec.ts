/**
 * The launcher-owned profile runtime of `dsh-app-boot`: the layer-precedence
 * composition, the canonical root hash, the manager-layer file reader, and
 * the acknowledged live-recomposition contract (`applyManagerLayer` /
 * `restoreManagerLayer` / `recompose`) against a real booted Loader tree.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import {
  boot,
  canonicalManagedRootHash,
  composeEntries,
  composeProfilePatches,
  loadOptionalPatches,
  PROFILE_PATCH_FILENAME,
  ProfileRuntime,
  readManagerLayerPatches,
  type ActiveProfileIdentity,
  type ExpectedManagedRoot,
  type ProfileRuntimeApplyRequest,
} from '../src/index.ts'

const NAME = 'dsh-test-bin'
const NOOP_PLUGIN = 'export const name = "noop"\nexport function apply() {}\n'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'dsh-profile-runtime-'))

describe('composeProfilePatches layer order', () => {
  it('composes conflicting rows with precedence bundles → manager layer → profile patch → home patch → overlays/telemetry', () => {
    const generation = composeProfilePatches({
      bundlePatches: [
        {
          insert: [
            { id: 'row', name: '@acme/plugin', config: { value: 'bundle', marker: 'bundle' } },
            { id: 'telemetry', name: '@acme/telemetry' },
          ],
        },
      ],
      managerPatches: [{ id: 'row', config: { value: 'manager' } }],
      profilePatches: [{ id: 'row', config: { value: 'profile' } }],
      homePatches: [{ id: 'row', config: { value: 'home' } }],
      overlays: [
        { id: 'row', config: { value: 'overlay' } },
        // The telemetry switch rides the highest-precedence overlay list.
        { id: 'telemetry', disabled: true },
      ],
    })
    expect(composeEntries([generation])).toEqual([
      { id: 'row', name: '@acme/plugin', config: { value: 'overlay' } },
      { id: 'telemetry', name: '@acme/telemetry', disabled: true },
    ])
  })

  it('lets the profile and home layers reach a row the manager layer inserted', () => {
    const generation = composeProfilePatches({
      bundlePatches: [],
      managerPatches: [{ insert: [{ id: 'managed', name: '@acme/m', config: { value: 'derived' } }] }],
      profilePatches: [{ id: 'managed', config: { value: 'profile' } }],
      homePatches: [{ id: 'managed', config: { value: 'home' } }],
      overlays: [],
    })
    expect(composeEntries([generation])).toEqual([{ id: 'managed', name: '@acme/m', config: { value: 'home' } }])
  })

  it('returns a fresh structured clone per generation so mounted insert rows cannot leak', () => {
    const inputs = {
      bundlePatches: [],
      managerPatches: [{ insert: [{ id: 'x', name: '@acme/x', config: { value: 1 } }] }],
      profilePatches: [],
      homePatches: [],
      overlays: [],
    }
    const first = composeProfilePatches(inputs)
    const second = composeProfilePatches(inputs)
    const insert = first[0] as { insert: Array<{ config: { value: number } }> }
    insert.insert[0]!.config.value = 99
    expect(second).toEqual([{ insert: [{ id: 'x', name: '@acme/x', config: { value: 1 } }] }])
  })
})

describe('canonicalManagedRootHash', () => {
  it('is stable across key order and changes when config, name, or disabled changes', () => {
    const baseline = canonicalManagedRootHash({ id: 'root', name: '@acme/p', config: { value: 1 } })
    expect(canonicalManagedRootHash({ config: { value: 1 }, name: '@acme/p', id: 'root' })).toBe(baseline)
    expect(canonicalManagedRootHash({ id: 'root', name: '@acme/p', config: { value: 2 } })).not.toBe(baseline)
    expect(canonicalManagedRootHash({ id: 'root', name: '@acme/other', config: { value: 1 } })).not.toBe(baseline)
    expect(canonicalManagedRootHash({ id: 'root', name: '@acme/p', disabled: true })).not.toBe(baseline)
  })
})

describe('readManagerLayerPatches', () => {
  it('returns an empty list when the layer is absent', () => {
    expect(readManagerLayerPatches(NAME, tmp())).toEqual([])
  })

  it('parses a valid layer and fails loud on a corrupt one', () => {
    const dir = tmp()
    mkdirSync(join(dir, '.workspace-manager'), { recursive: true })
    const layerPath = join(dir, '.workspace-manager', 'runtime-layer.yml')
    writeFileSync(layerPath, "- insert:\n    - id: root\n      name: '@acme/p'\n")
    expect(readManagerLayerPatches(NAME, dir)).toEqual([{ insert: [{ id: 'root', name: '@acme/p' }] }])
    writeFileSync(layerPath, 'invalid: [unclosed\n')
    expect(() => readManagerLayerPatches(NAME, dir)).toThrow()
  })
})

interface RuntimeTree {
  ctx: Context
  runtime: ProfileRuntime
  dir: string
  managerLayerPath: string
}

/**
 * Boot a real Loader tree with a launcher-provided ProfileRuntime whose
 * compose closure reads the current manager layer plus an optional profile
 * patch file (`cordis.patch.yml`), exactly like profile boot wires it.
 */
async function bootRuntimeTree(): Promise<RuntimeTree> {
  const dir = tmp()
  writeFileSync(join(dir, 'noop.mjs'), NOOP_PLUGIN)
  writeFileSync(join(dir, 'cordis.yml'), '- id: base\n  name: ./noop.mjs\n')
  mkdirSync(join(dir, '.workspace-manager'), { recursive: true })
  const identity: ActiveProfileIdentity = { name: 'demo', directory: dir }
  let runtime: ProfileRuntime | undefined
  const ctx = await boot(NAME, join(dir, 'cordis.yml'), undefined, (hostCtx) => {
    runtime = new ProfileRuntime(hostCtx, {
      identity,
      compose: () => composeProfilePatches({
        bundlePatches: [],
        managerPatches: readManagerLayerPatches(NAME, dir),
        profilePatches: loadOptionalPatches(NAME, join(dir, PROFILE_PATCH_FILENAME)) ?? [],
        homePatches: [],
        overlays: [],
      }),
    })
  })
  if (runtime === undefined) throw new Error('boot did not construct the profile runtime')
  return { ctx, runtime, dir, managerLayerPath: join(dir, '.workspace-manager', 'runtime-layer.yml') }
}

/** A layer mounting one noop root plus the expected hash of its derived row. */
function singleRootLayer(rootId: string, value: number): { layer: string; expected: ExpectedManagedRoot } {
  const layer = [
    '- insert:',
    `    - id: ${rootId}`,
    '      name: ./noop.mjs',
    '      config:',
    `        value: ${value}`,
    '',
  ].join('\n')
  return {
    layer,
    expected: {
      packageName: '@acme/page',
      pageId: 'page-id',
      rootEntryId: rootId,
      hash: canonicalManagedRootHash({ id: rootId, name: './noop.mjs', config: { value } }),
    },
  }
}

function applyRequest(layer: string, expectedRoots: readonly ExpectedManagedRoot[], revision = 1): ProfileRuntimeApplyRequest {
  return { registryRevision: revision, runtimeLayer: layer, expectedRoots }
}

function entryOptions(ctx: Context, id: string): unknown {
  return [...ctx.loader.entries()].find(entry => entry.options.id === id)?.options
}

describe('ProfileRuntime live recomposition', () => {
  it('resolves only after the Include update and root activation audit succeed', async () => {
    const { ctx, runtime, managerLayerPath } = await bootRuntimeTree()
    try {
      const { layer, expected } = singleRootLayer('page', 1)
      writeFileSync(managerLayerPath, layer)
      const result = await runtime.applyManagerLayer(applyRequest(layer, [expected]))
      expect(result.generation).toBe(1)
      expect(result.activeRoots).toEqual(['page'])
      expect(result.externallyOverridden).toEqual([])
      // The acknowledged generation is a settled tree, not a filesystem guess:
      // the row is active at resolve time.
      const row = [...ctx.loader.entries()].find(entry => entry.options.id === 'page')
      expect(row?.fiber).toBeDefined()
      expect(entryOptions(ctx, 'page')).toEqual({ id: 'page', name: './noop.mjs', config: { value: 1 } })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects an activation failure and acknowledges no generation', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'noop.mjs'), NOOP_PLUGIN)
    writeFileSync(join(dir, 'failing.mjs'), 'export function apply() { throw new Error("pinned activation failure") }\n')
    writeFileSync(join(dir, 'cordis.yml'), '- id: base\n  name: ./noop.mjs\n')
    mkdirSync(join(dir, '.workspace-manager'), { recursive: true })
    let runtime: ProfileRuntime | undefined
    const ctx = await boot(NAME, join(dir, 'cordis.yml'), undefined, (hostCtx) => {
      runtime = new ProfileRuntime(hostCtx, {
        identity: { name: 'demo', directory: dir },
        compose: () => composeProfilePatches({
          bundlePatches: [],
          managerPatches: readManagerLayerPatches(NAME, dir),
          profilePatches: [],
          homePatches: [],
          overlays: [],
        }),
      })
    })
    if (runtime === undefined) throw new Error('boot did not construct the profile runtime')
    try {
      const layer = '- insert:\n    - id: broken\n      name: ./failing.mjs\n'
      writeFileSync(join(dir, '.workspace-manager', 'runtime-layer.yml'), layer)
      const expected: ExpectedManagedRoot = {
        packageName: '@acme/p',
        pageId: 'pid',
        rootEntryId: 'broken',
        hash: canonicalManagedRootHash({ id: 'broken', name: './failing.mjs' }),
      }
      await expect(runtime.applyManagerLayer(applyRequest(layer, [expected])))
        .rejects.toThrow(/failed to apply loader entry broken/)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects when an expected root stays pending on an injected service', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'noop.mjs'), NOOP_PLUGIN)
    writeFileSync(join(dir, 'pending.mjs'), 'export const inject = ["neverProvided"]\nexport function apply() {}\n')
    writeFileSync(join(dir, 'cordis.yml'), '- id: base\n  name: ./noop.mjs\n')
    mkdirSync(join(dir, '.workspace-manager'), { recursive: true })
    let runtime: ProfileRuntime | undefined
    const ctx = await boot(NAME, join(dir, 'cordis.yml'), undefined, (hostCtx) => {
      runtime = new ProfileRuntime(hostCtx, {
        identity: { name: 'demo', directory: dir },
        compose: () => composeProfilePatches({
          bundlePatches: [],
          managerPatches: readManagerLayerPatches(NAME, dir),
          profilePatches: [],
          homePatches: [],
          overlays: [],
        }),
      })
    })
    if (runtime === undefined) throw new Error('boot did not construct the profile runtime')
    try {
      const layer = '- insert:\n    - id: waiting\n      name: ./pending.mjs\n'
      writeFileSync(join(dir, '.workspace-manager', 'runtime-layer.yml'), layer)
      const expected: ExpectedManagedRoot = {
        packageName: '@acme/p',
        pageId: 'pid',
        rootEntryId: 'waiting',
        hash: canonicalManagedRootHash({ id: 'waiting', name: './pending.mjs' }),
      }
      await expect(runtime.applyManagerLayer(applyRequest(layer, [expected])))
        .rejects.toThrow(/root activation audit failed/)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('reports an effective user override by root id/hash after a user patch generation', async () => {
    const { ctx, runtime, managerLayerPath, dir } = await bootRuntimeTree()
    try {
      const { layer, expected } = singleRootLayer('page', 1)
      writeFileSync(managerLayerPath, layer)
      const first = await runtime.applyManagerLayer(applyRequest(layer, [expected]))
      expect(first.externallyOverridden).toEqual([])

      // The user patch layer disables the manager root; the next acknowledged
      // generation reports the override instead of failing or rewriting it.
      writeFileSync(join(dir, PROFILE_PATCH_FILENAME), '- id: page\n  disabled: true\n')
      const second = await runtime.applyManagerLayer(applyRequest(layer, [expected]))
      expect(second.generation).toBe(2)
      expect(second.activeRoots).toEqual([])
      expect(second.externallyOverridden).toEqual(['page'])
      const row = [...ctx.loader.entries()].find(entry => entry.options.id === 'page')
      expect(row?.disabled).toBe(true)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('restores a prior layer through the same acknowledged path', async () => {
    const { ctx, runtime, managerLayerPath } = await bootRuntimeTree()
    try {
      const first = singleRootLayer('page', 1)
      writeFileSync(managerLayerPath, first.layer)
      await runtime.applyManagerLayer(applyRequest(first.layer, [first.expected]))

      const second = singleRootLayer('page', 2)
      writeFileSync(managerLayerPath, second.layer)
      await runtime.applyManagerLayer(applyRequest(second.layer, [second.expected], 2))

      writeFileSync(managerLayerPath, first.layer)
      const restored = await runtime.restoreManagerLayer(applyRequest(first.layer, [first.expected], 3))
      expect(restored.generation).toBe(3)
      expect(restored.activeRoots).toEqual(['page'])
      expect(entryOptions(ctx, 'page')).toEqual({ id: 'page', name: './noop.mjs', config: { value: 1 } })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('serializes manager and watcher generations through one queue', async () => {
    const { ctx, runtime, managerLayerPath } = await bootRuntimeTree()
    try {
      const { layer, expected } = singleRootLayer('page', 1)
      writeFileSync(managerLayerPath, layer)
      const request = applyRequest(layer, [expected])
      const [result] = await Promise.all([
        runtime.applyManagerLayer(request),
        runtime.recompose(),
      ])
      expect(result.generation).toBe(1)
      expect(result.activeRoots).toEqual(['page'])
      expect(entryOptions(ctx, 'page')).toEqual({ id: 'page', name: './noop.mjs', config: { value: 1 } })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects when the staged layer does not match the apply request', async () => {
    const { ctx, runtime, managerLayerPath } = await bootRuntimeTree()
    try {
      writeFileSync(managerLayerPath, '- insert:\n    - id: other\n      name: ./noop.mjs\n')
      await expect(runtime.applyManagerLayer(applyRequest('- insert:\n    - id: page\n      name: ./noop.mjs\n', [])))
        .rejects.toThrow(/does not match the apply request/i)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('rejects when the manager layer was never staged', async () => {
    const { ctx, runtime } = await bootRuntimeTree()
    try {
      await expect(runtime.applyManagerLayer(applyRequest('[]\n', [])))
        .rejects.toThrow(/does not match the apply request/i)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('ProfileRuntime mutation gates', () => {
  it('fails loudly before the root Include is bound', async () => {
    const ctx = new Context()
    try {
      const runtime = new ProfileRuntime(ctx, {
        identity: { name: 'demo', directory: tmp() },
        compose: () => [],
      })
      await expect(runtime.applyManagerLayer({ registryRevision: 0, runtimeLayer: '[]\n', expectedRoots: [] }))
        .rejects.toThrow(/before the root Include is bound/i)
      await expect(runtime.restoreManagerLayer({ registryRevision: 0, runtimeLayer: '[]\n', expectedRoots: [] }))
        .rejects.toThrow(/before the root Include is bound/i)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('cannot mutate until the initial tree has settled, even when the Include is bound', async () => {
    // The manager plugin may inject the service during boot but cannot mutate
    // until boot() marks the initial tree settled. Staged directly: bind the
    // runtime to a real mounted Include without the settled mark.
    const dir = tmp()
    writeFileSync(join(dir, 'noop.mjs'), NOOP_PLUGIN)
    writeFileSync(join(dir, 'cordis.yml'), '- id: noop\n  name: ./noop.mjs\n')
    const ctx = new Context()
    ctx.baseUrl = pathToFileURL(`${dir}/`).href
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const runtime = new ProfileRuntime(ctx, {
      identity: { name: 'demo', directory: dir },
      compose: () => [],
    })
    try {
      await ctx.loader.create({
        name: 'cordis:include',
        config: { path: pathToFileURL(join(dir, 'cordis.yml')).href },
      })
      await ctx.loader.await()
      const include = [...ctx.loader.entries()].find(entry => entry.options.name === 'cordis:include')
      if (include === undefined) throw new Error('booted tree has no include entry')
      runtime.bindRootInclude(include)
      await expect(runtime.applyManagerLayer({ registryRevision: 0, runtimeLayer: '[]\n', expectedRoots: [] }))
        .rejects.toThrow(/before the initial tree has settled/i)
      await expect(runtime.restoreManagerLayer({ registryRevision: 0, runtimeLayer: '[]\n', expectedRoots: [] }))
        .rejects.toThrow(/before the initial tree has settled/i)
      runtime.markSettled()
      // Once settled, the gates pass and the call proceeds to the staging
      // verification (no layer file was staged here).
      await expect(runtime.applyManagerLayer({ registryRevision: 0, runtimeLayer: '[]\n', expectedRoots: [] }))
        .rejects.toThrow(/does not match the apply request/i)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
