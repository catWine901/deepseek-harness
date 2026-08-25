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
import { afterEach, describe, expect, it, vi } from 'vitest'
import { load } from 'js-yaml'
import { Context, FiberState, symbols } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import {
  boot,
  canonicalManagedRootHash,
  composeEntries,
  composeProfilePatches,
  deriveSafeRuntimeLayer,
  loadOptionalPatches,
  prepareManagerRuntimeLayer,
  PROFILE_PATCH_FILENAME,
  PROFILE_RUNTIME_SERVICE,
  ProfileRuntime,
  readManagerLayerPatches,
  watchUserPatches,
  type ActiveProfileIdentity,
  type ExpectedManagedRoot,
  type ProfileRuntimeApplyRequest,
} from '../src/index.ts'
// Module-internal capability: reachable only from this package's own sources
// (the package entry surface deliberately does not re-export it).
import { profileRuntimeControl } from '../src/profile-runtime.ts'

const NAME = 'dsh-test-bin'
const NOOP_PLUGIN = 'export const name = "noop"\nexport function apply() {}\n'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'dsh-profile-runtime-'))

const fsState = vi.hoisted(() => ({
  // Pauses the first fs/promises read of the runtime layer after arming —
  // the staged-file verification read inside applyManagerLayer — so the test
  // can swap the staged file before the apply composes the generation.
  armPauseOnLayerVerifyRead: false,
  releaseLayerVerifyRead: () => {},
  layerVerifyReadReached: () => {},
}))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const readFile = (async (path: unknown, ...rest: unknown[]) => {
    const file = String(path)
    if (file.includes('runtime-layer.yml') && fsState.armPauseOnLayerVerifyRead) {
      fsState.armPauseOnLayerVerifyRead = false
      const content = String(await (actual.readFile as (p: unknown, ...a: unknown[]) => Promise<unknown>)(path, ...rest))
      fsState.layerVerifyReadReached()
      await new Promise<void>((resolveGate) => { fsState.releaseLayerVerifyRead = resolveGate })
      return content
    }
    return (actual.readFile as (p: unknown, ...a: unknown[]) => Promise<unknown>)(path, ...rest)
  }) as typeof actual.readFile
  return { ...actual, readFile }
})

afterEach(() => {
  fsState.armPauseOnLayerVerifyRead = false
  fsState.releaseLayerVerifyRead = () => {}
  fsState.layerVerifyReadReached = () => {}
})

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
  /** Trigger one user-watcher recomposition through the serialized path. */
  recompose: () => Promise<void>
}

/**
 * Boot a real Loader tree with a launcher-provided ProfileRuntime whose
 * compose closure interleaves the given manager patches with an optional
 * profile patch file (`cordis.patch.yml`), exactly like profile boot wires it.
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
      compose: managerPatches => composeProfilePatches({
        bundlePatches: [],
        managerPatches,
        profilePatches: loadOptionalPatches(NAME, join(dir, PROFILE_PATCH_FILENAME)) ?? [],
        homePatches: [],
        overlays: [],
      }),
      // At boot no manager layer exists yet; the acknowledged snapshot is
      // empty until the first apply/restore audit promotes one.
      initialManagerPatches: readManagerLayerPatches(NAME, dir),
    })
  })
  if (runtime === undefined) throw new Error('boot did not construct the profile runtime')
  const control = profileRuntimeControl(runtime)
  if (control === undefined) throw new Error('boot did not expose the profile runtime control')
  return {
    ctx,
    runtime,
    dir,
    managerLayerPath: join(dir, '.workspace-manager', 'runtime-layer.yml'),
    recompose: () => control.recompose(),
  }
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
        compose: managerPatches => composeProfilePatches({
          bundlePatches: [],
          managerPatches,
          profilePatches: [],
          homePatches: [],
          overlays: [],
        }),
        initialManagerPatches: [],
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
        compose: managerPatches => composeProfilePatches({
          bundlePatches: [],
          managerPatches,
          profilePatches: [],
          homePatches: [],
          overlays: [],
        }),
        initialManagerPatches: [],
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
    const { ctx, runtime, recompose, managerLayerPath } = await bootRuntimeTree()
    try {
      const { layer, expected } = singleRootLayer('page', 1)
      writeFileSync(managerLayerPath, layer)
      const request = applyRequest(layer, [expected])
      const [result] = await Promise.all([
        runtime.applyManagerLayer(request),
        recompose(),
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
        initialManagerPatches: [],
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
      initialManagerPatches: [],
    })
    const control = profileRuntimeControl(runtime)
    if (control === undefined) throw new Error('profile runtime control is unavailable')
    try {
      await ctx.loader.create({
        name: 'cordis:include',
        config: { path: pathToFileURL(join(dir, 'cordis.yml')).href },
      })
      await ctx.loader.await()
      const include = [...ctx.loader.entries()].find(entry => entry.options.name === 'cordis:include')
      if (include === undefined) throw new Error('booted tree has no include entry')
      control.bindRootInclude(include)
      await expect(runtime.applyManagerLayer({ registryRevision: 0, runtimeLayer: '[]\n', expectedRoots: [] }))
        .rejects.toThrow(/before the initial tree has settled/i)
      await expect(runtime.restoreManagerLayer({ registryRevision: 0, runtimeLayer: '[]\n', expectedRoots: [] }))
        .rejects.toThrow(/before the initial tree has settled/i)
      await control.markSettled()
      // Once settled, the gates pass and the call proceeds to the staging
      // verification (no layer file was staged here).
      await expect(runtime.applyManagerLayer({ registryRevision: 0, runtimeLayer: '[]\n', expectedRoots: [] }))
        .rejects.toThrow(/does not match the apply request/i)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('acknowledged manager layer snapshot', () => {
  it('keeps the acknowledged manager layer when a new layer is staged but not applied', async () => {
    const { ctx, runtime, recompose, managerLayerPath } = await bootRuntimeTree()
    try {
      const first = singleRootLayer('page', 1)
      writeFileSync(managerLayerPath, first.layer)
      await runtime.applyManagerLayer(applyRequest(first.layer, [first.expected]))
      expect([...ctx.loader.entries()].some(entry => entry.options.id === 'page')).toBe(true)

      // The manager stages a newer layer (a new root) but has not acknowledged
      // it; a user watcher generation must keep the acknowledged composition
      // instead of mounting the staged bytes early.
      const second = singleRootLayer('page2', 1)
      writeFileSync(managerLayerPath, second.layer)
      await recompose()
      expect([...ctx.loader.entries()].some(entry => entry.options.id === 'page')).toBe(true)
      expect([...ctx.loader.entries()].some(entry => entry.options.id === 'page2')).toBe(false)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('applies the request layer even when the staged file is swapped after verification', async () => {
    const { ctx, runtime, recompose, managerLayerPath } = await bootRuntimeTree()
    try {
      const first = singleRootLayer('page-a', 1)
      writeFileSync(managerLayerPath, first.layer)
      // Pause right after the staged-file verification read, swap the file to
      // a different layer, then release: the apply must still compose the
      // request content and never apply or acknowledge the swapped bytes.
      fsState.armPauseOnLayerVerifyRead = true
      const reached = new Promise<void>((resolve) => { fsState.layerVerifyReadReached = resolve })
      const applying = runtime.applyManagerLayer(applyRequest(first.layer, [first.expected]))
      await reached
      const second = singleRootLayer('page-b', 2)
      writeFileSync(managerLayerPath, second.layer)
      fsState.releaseLayerVerifyRead()
      const result = await applying
      expect(result.activeRoots).toEqual(['page-a'])
      expect([...ctx.loader.entries()].some(entry => entry.options.id === 'page-a')).toBe(true)
      expect([...ctx.loader.entries()].some(entry => entry.options.id === 'page-b')).toBe(false)
      // The acknowledged snapshot is the request's layer: a later watcher
      // generation composes it, not the swapped bytes.
      await recompose()
      expect([...ctx.loader.entries()].some(entry => entry.options.id === 'page-a')).toBe(true)
      expect([...ctx.loader.entries()].some(entry => entry.options.id === 'page-b')).toBe(false)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('ProfileRuntime manager-facing surface', () => {
  it('exposes an immutable identity that consumers cannot replace', async () => {
    const { ctx, runtime, dir } = await bootRuntimeTree()
    try {
      expect(() => {
        (runtime as unknown as { identity: ActiveProfileIdentity }).identity = { name: 'evil', directory: tmp() }
      }).toThrow()
      expect(runtime.identity).toEqual({ name: 'demo', directory: dir })
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('does not expose launcher controls on the injected service', async () => {
    const { ctx, runtime } = await bootRuntimeTree()
    try {
      const surface = runtime as unknown as Record<string, unknown>
      expect(surface.bindRootInclude).toBeUndefined()
      expect(surface.markSettled).toBeUndefined()
      expect(surface.recompose).toBeUndefined()
      // The manager-facing surface still exposes the acknowledged apply API.
      expect(typeof runtime.applyManagerLayer).toBe('function')
      expect(typeof runtime.restoreManagerLayer).toBe('function')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('keeps the launcher control able to bind, settle, and trigger the watcher path', async () => {
    // boot() already bound and settled through the control; the watcher path
    // must still apply an acknowledged generation through it.
    const { ctx, runtime, recompose, managerLayerPath } = await bootRuntimeTree()
    try {
      const control = profileRuntimeControl(runtime)
      expect(control).toBeDefined()
      const first = singleRootLayer('page', 1)
      writeFileSync(managerLayerPath, first.layer)
      await runtime.applyManagerLayer(applyRequest(first.layer, [first.expected]))
      await recompose()
      expect([...ctx.loader.entries()].some(entry => entry.options.id === 'page')).toBe(true)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('ProfileRuntime runtime privacy', () => {
  const LAUNCHER_STATE_NAMES = [
    'identityState', 'compose', 'managerPatches', 'entry', 'settled', 'generation', 'queue',
    'recoveryError', 'omittedRoots',
  ] as const

  it('holds launcher state off the raw instance and the real ctx.get proxy', async () => {
    const { ctx, runtime } = await bootRuntimeTree()
    try {
      const viaProxy: unknown = ctx.get(PROFILE_RUNTIME_SERVICE)
      expect(viaProxy).toBeDefined()
      for (const candidate of [runtime, viaProxy]) {
        const names = Object.getOwnPropertyNames(candidate)
        for (const launcherName of LAUNCHER_STATE_NAMES) {
          expect(names, `${launcherName} on ${candidate === runtime ? 'raw' : 'proxy'}`).not.toContain(launcherName)
        }
        // Only the Cordis service base fields remain as own string properties.
        expect(names.sort()).toEqual(['ctx', 'name'])
      }
      // No launcher control symbol is discoverable on the instance: every own
      // symbol belongs to Cordis's traceability machinery.
      for (const candidate of [runtime, viaProxy]) {
        const symbols = Object.getOwnPropertySymbols(candidate)
        for (const symbol of symbols) {
          expect(String(symbol.description)).toMatch(/^cordis\./)
        }
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('overwriting enumerated own state through the real ctx.get proxy cannot alter identity or launcher state', async () => {
    const { ctx, runtime, recompose, managerLayerPath, dir } = await bootRuntimeTree()
    try {
      const first = singleRootLayer('page', 1)
      writeFileSync(managerLayerPath, first.layer)
      await runtime.applyManagerLayer(applyRequest(first.layer, [first.expected]))
      expect([...ctx.loader.entries()].some(entry => entry.options.id === 'page')).toBe(true)

      const viaProxy = ctx.get(PROFILE_RUNTIME_SERVICE) as unknown as Record<string, unknown>
      viaProxy.identityState = { name: 'evil', directory: tmp() }
      viaProxy.settled = false
      viaProxy.entry = 'hacked'
      viaProxy.managerPatches = [{ insert: [{ id: 'evil-row', name: './noop.mjs' }] }]
      viaProxy.generation = 999
      viaProxy.queue = 'hacked'

      expect(runtime.identity).toEqual({ name: 'demo', directory: dir })
      await recompose()
      expect([...ctx.loader.entries()].some(entry => entry.options.id === 'page')).toBe(true)
      expect([...ctx.loader.entries()].some(entry => entry.options.id === 'evil-row')).toBe(false)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('exposes no launcher control accessor on the package entry surface', async () => {
    const appBoot = await import('../src/index.ts')
    expect((appBoot as Record<string, unknown>).profileRuntimeControl).toBeUndefined()
  })
})

describe('ProfileRuntime nested traceable proxies', () => {
  it('resolves the registered state through an intentionally nested traceable proxy', async () => {
    const { ctx, runtime, dir } = await bootRuntimeTree()
    try {
      // The manager gateway nests a second traceable layer: reading a
      // traceable value through a traceable proxy re-wraps it (Cordis does not
      // deduplicate), so registering the one-layer ctx.get value as a service
      // and reading it back through ctx.get produces the same nested pair.
      const oneLayer: unknown = ctx.get(PROFILE_RUNTIME_SERVICE)
      const disposeNested = ctx.provide('profileRuntime.nested', oneLayer)
      try {
        const nested = ctx.get('profileRuntime.nested') as ProfileRuntime
        expect((nested as unknown as Record<symbol, unknown>)[symbols.original]).not.toBe(runtime)
        // The public getter resolves the original registered identity.
        expect(nested.identity).toEqual({ name: 'demo', directory: dir })
        // The launcher-only control resolves the same registered state.
        expect(profileRuntimeControl(nested)).toBeDefined()
      } finally {
        disposeNested()
      }
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('stops the unwrap on a non-object or cyclic symbols.original chain', async () => {
    const { ctx } = await bootRuntimeTree()
    try {
      const oneLayer: unknown = ctx.get(PROFILE_RUNTIME_SERVICE)
      const withOriginal = (original: unknown): unknown => new Proxy(oneLayer as object, {
        get: (target, prop, receiver) => {
          if (prop === symbols.original) return original
          return Reflect.get(target, prop, receiver) as unknown
        },
      })
      // A primitive or null escape hatch is a dead end, not a redirect.
      expect(() => (withOriginal(42) as ProfileRuntime).identity).toThrow(/state is unavailable/)
      expect(() => (withOriginal(null) as ProfileRuntime).identity).toThrow(/state is unavailable/)
      expect(profileRuntimeControl(withOriginal(42) as ProfileRuntime)).toBeUndefined()
      // A self-referential escape hatch must stop instead of looping.
      const cyclicHolder: { proxy?: unknown } = {}
      cyclicHolder.proxy = new Proxy(oneLayer as object, {
        get: (target, prop, receiver) => {
          if (prop === symbols.original) return cyclicHolder.proxy
          return Reflect.get(target, prop, receiver) as unknown
        },
      })
      const cyclic: unknown = cyclicHolder.proxy
      expect(() => (cyclic as ProfileRuntime).identity).toThrow(/state is unavailable/)
      expect(profileRuntimeControl(cyclic as ProfileRuntime)).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('ProfileRuntime proxy poisoning and watcher surface', () => {
  it('does not trust a writable symbols.original on a raw instance', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'noop.mjs'), NOOP_PLUGIN)
    writeFileSync(join(dir, 'cordis.yml'), '- id: base\n  name: ./noop.mjs\n')
    mkdirSync(join(dir, '.workspace-manager'), { recursive: true })
    let runtime: ProfileRuntime | undefined
    const ctx = await boot(NAME, join(dir, 'cordis.yml'), undefined, (hostCtx) => {
      runtime = new ProfileRuntime(hostCtx, {
        identity: { name: 'demo', directory: dir },
        compose: managerPatches => composeProfilePatches({
          bundlePatches: [],
          managerPatches,
          profilePatches: [],
          homePatches: [],
          overlays: [],
        }),
        initialManagerPatches: [],
      })
    })
    if (runtime === undefined) throw new Error('boot did not construct the profile runtime')
    const attackerDir = tmp()
    const attackerCtx = new Context()
    try {
      // A second registered runtime used as the poisoned alias.
      const attacker = new ProfileRuntime(attackerCtx, {
        identity: { name: 'attacker', directory: attackerDir },
        compose: () => [],
        initialManagerPatches: [],
      })
      // A consumer can read the global `symbols.original` key from the public
      // cordis export and write it onto the RAW victim instance; the victim's
      // identity, state, and behavior must stay bound to the victim.
      ;(runtime as unknown as Record<symbol, unknown>)[symbols.original] = attacker
      expect(runtime.identity).toEqual({ name: 'demo', directory: dir })

      // The traceable proxy cannot be poisoned the same way: its set trap
      // refuses `symbols.original` outright (the assignment throws in strict
      // mode), so the proxy keeps unwrapping to the real target.
      const viaProxy: unknown = ctx.get(PROFILE_RUNTIME_SERVICE)
      expect(() => {
        ;(viaProxy as Record<symbol, unknown>)[symbols.original] = attacker
      }).toThrow()
      expect((viaProxy as Record<symbol, unknown>)[symbols.original]).not.toBe(attacker)
    } finally {
      await ctx.fiber.dispose()
      await attackerCtx.fiber.dispose()
    }
  })

  it('cannot route a user-patch watcher to the runtime through the public watchUserPatches API', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'noop.mjs'), NOOP_PLUGIN)
    writeFileSync(join(dir, 'cordis.yml'), '- id: base\n  name: ./noop.mjs\n')
    mkdirSync(join(dir, '.workspace-manager'), { recursive: true })
    const patchFile = join(dir, PROFILE_PATCH_FILENAME)
    writeFileSync(patchFile, '[]\n')
    let runtime: ProfileRuntime | undefined
    const ctx = await boot(NAME, join(dir, 'cordis.yml'), undefined, (hostCtx) => {
      runtime = new ProfileRuntime(hostCtx, {
        identity: { name: 'demo', directory: dir },
        compose: managerPatches => composeProfilePatches({
          bundlePatches: [],
          managerPatches,
          profilePatches: loadOptionalPatches(NAME, patchFile) ?? [],
          homePatches: [],
          overlays: [],
        }),
        initialManagerPatches: [],
      })
    })
    if (runtime === undefined) throw new Error('boot did not construct the profile runtime')
    try {
      // A fake HMR captures the registered config callback deterministically
      // (no chokidar timing), so invoking the callback simulates one refresh.
      let captured: (() => Promise<void>) | undefined
      ctx.provide('hmr', {
        registerConfig: async (_filename: string, callback: () => Promise<void>) => {
          captured = callback
          return async () => {}
        },
      })
      const { layer, expected } = singleRootLayer('page', 1)
      writeFileSync(join(dir, '.workspace-manager', 'runtime-layer.yml'), layer)
      await runtime.applyManagerLayer(applyRequest(layer, [expected]))

      const trigger = join(dir, 'consumer-trigger.yml')
      writeFileSync(trigger, '[]\n')
      // @ts-expect-error the public watcher API has no runtime-routing option
      await watchUserPatches(ctx, { binName: NAME, filename: trigger, runtime })
      expect(captured).toBeDefined()
      await captured!()

      // A public watcher must not have recomposed the runtime: the root
      // include's patch list must not contain the acknowledged manager layer.
      const include = [...ctx.loader.entries()].find(entry => entry.options.name === 'cordis:include')
      const config = include?.options.config as { patches?: Array<Record<string, unknown>> } | undefined
      const patches = config?.patches ?? []
      expect(patches.some(patch => JSON.stringify(patch).includes('page'))).toBe(false)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

interface WatcherBoot {
  bootPromise: Promise<Context>
  runtime: ProfileRuntime
  rootCtx: Context
  dir: string
  managerLayerPath: string
  /** Resolves when the gated loader.create (timer or HMR) is held and pending. */
  createReached: Promise<void>
  /** Release the held loader.create. */
  releaseCreate: () => void
  /** Resolves when the fake HMR's registerConfig has been called. */
  configReached: Promise<void>
  /** Release the held registerConfig. */
  releaseConfig: () => void
  /** Config callbacks the fake HMR registered, in call order (only successes). */
  capturedConfigs: (() => Promise<void>)[]
  /** Watcher disposer invocations, each recording its registration index in call order. */
  disposerCalls: number[]
  /** Read after boot settles: whether the root fiber was active when a fail-inactive create threw. */
  treeWasActiveAtFailure: () => boolean
}

/** One per-name loader.create gate behavior. */
interface GateSpec {
  mode: 'pass' | 'hold' | 'fail' | 'fail-inactive' | 'create-noop'
  /** Local plugin file the create-noop gate mounts instead of the requested package. */
  file?: string
}

/**
 * Boot a real tree whose launcher runtime carries one watcher path, with the
 * timer/HMR `loader.create` calls deterministically holdable or failable from
 * this test's own realm (the prepare hook patches the shared loader instance)
 * and an optional fake HMR/timer service. Resolves once boot's prepare has
 * run (the runtime and root context exist); boot itself may still be settling.
 */
async function bootWatcherTree(options: {
  /** Loader.create name the gate intercepts ('pass' disables interception). */
  gateName: string
  gateMode: GateSpec['mode']
  /** Additional per-create-name gates; win over gateName/gateMode. */
  gates?: Record<string, GateSpec>
  fakeHmr?: 'ok' | 'hold' | 'fail' | 'fail-second' | 'fail-third' | 'inactive-second' | 'dispose-on-resolve' | 'dispose-after-second'
  fakeTimer?: boolean
  /** Returned watcher disposers throw when invoked (rollback cleanup failure). */
  disposerThrows?: boolean
  /** Number of launcher watcher paths; defaults to 1. */
  watchCount?: number
}): Promise<WatcherBoot> {
  const dir = tmp()
  writeFileSync(join(dir, 'noop.mjs'), NOOP_PLUGIN)
  writeFileSync(join(dir, 'noop2.mjs'), NOOP_PLUGIN)
  writeFileSync(join(dir, 'cordis.yml'), '- id: base\n  name: ./noop.mjs\n')
  mkdirSync(join(dir, '.workspace-manager'), { recursive: true })
  let releaseCreate!: () => void
  let createReachedResolve!: () => void
  const createReached = new Promise<void>((resolve) => { createReachedResolve = resolve })
  let releaseConfig!: () => void
  let configReachedResolve!: () => void
  const configReached = new Promise<void>((resolve) => { configReachedResolve = resolve })
  let readyResolve!: () => void
  const ready = new Promise<void>((resolve) => { readyResolve = resolve })
  const watchCount = options.watchCount ?? 1
  const capturedConfigs: (() => Promise<void>)[] = []
  const disposerCalls: number[] = []
  let treeWasActiveAtFailure = false
  let runtime: ProfileRuntime | undefined
  let rootCtx: Context | undefined
  const bootPromise = boot(NAME, join(dir, 'cordis.yml'), undefined, (hostCtx) => {
    rootCtx = hostCtx
    // Hold, fail, or redirect the runtime's timer/HMR loader.create
    // deterministically. The loader is already installed when prepare runs,
    // and the patched instance is the same one the runtime later calls
    // through ctx.get.
    const realCreate = hostCtx.loader.create.bind(hostCtx.loader)
    hostCtx.loader.create = async (entryOptions) => {
      const gate = options.gates?.[entryOptions.name]
        ?? (entryOptions.name === options.gateName ? { mode: options.gateMode } : undefined)
      if (gate === undefined || gate.mode === 'pass') return realCreate(entryOptions)
      if (gate.mode === 'fail') throw new Error('pinned watcher setup failure')
      if (gate.mode === 'fail-inactive') {
        treeWasActiveAtFailure = hostCtx.fiber.state === FiberState.ACTIVE
        throw Object.assign(new Error('cannot create effect on inactive context'), { code: 'INACTIVE_EFFECT' })
      }
      if (gate.mode === 'create-noop') {
        // Mount a local plugin file instead of the requested package: the
        // entry genuinely exists in the loader tree, so rollback disposal is
        // observable, without resolving the unbuilt vendor timer/HMR libs.
        return realCreate({ ...entryOptions, name: gate.file ?? './noop.mjs' })
      }
      createReachedResolve()
      await new Promise<void>((resolve) => { releaseCreate = resolve })
      return realCreate(entryOptions)
    }
    if (options.fakeHmr !== undefined) {
      hostCtx.provide('hmr', {
        registerConfig: async (_filename: string, callback: () => Promise<void>) => {
          configReachedResolve()
          const index = capturedConfigs.length
          if (options.fakeHmr === 'fail') throw new Error('pinned registration failure')
          if (options.fakeHmr === 'fail-second' && index >= 1) throw new Error('pinned registration failure')
          if (options.fakeHmr === 'fail-third' && index >= 2) throw new Error('pinned registration failure')
          if (options.fakeHmr === 'inactive-second' && index >= 1) {
            throw Object.assign(new Error('cannot create effect on inactive context'), { code: 'INACTIVE_EFFECT' })
          }
          if (options.fakeHmr === 'dispose-on-resolve') {
            // The app exits exactly as asked immediately before this
            // registration resolves; the tree is really gone by the time the
            // runtime's await lands.
            await hostCtx.fiber.dispose()
          }
          capturedConfigs.push(callback)
          if (options.fakeHmr === 'dispose-after-second' && index >= 1) {
            // The app exits exactly as asked after the final registration
            // resolved; every owned watcher must be rolled back.
            await hostCtx.fiber.dispose()
          } else if (options.fakeHmr === 'hold') {
            await new Promise<void>((resolve) => { releaseConfig = resolve })
          }
          return async () => {
            disposerCalls.push(index)
            if (options.disposerThrows) throw new Error('rollback disposer failure')
          }
        },
      })
    }
    if (options.fakeTimer) hostCtx.provide('timer', {})
    runtime = new ProfileRuntime(hostCtx, {
      identity: { name: 'demo', directory: dir },
      compose: managerPatches => composeProfilePatches({
        bundlePatches: [],
        managerPatches,
        profilePatches: [],
        homePatches: [],
        overlays: [],
      }),
      initialManagerPatches: [],
      watchPatches: Array.from({ length: watchCount }, (_, index) => ({
        binName: NAME,
        filename: join(dir, index === 0 ? PROFILE_PATCH_FILENAME : `home-${index}.patch.yml`),
      })),
    })
    readyResolve()
  })
  await ready
  if (runtime === undefined || rootCtx === undefined) throw new Error('boot did not construct the profile runtime')
  return {
    bootPromise,
    runtime,
    rootCtx,
    dir,
    managerLayerPath: join(dir, '.workspace-manager', 'runtime-layer.yml'),
    createReached,
    releaseCreate: () => { releaseCreate() },
    configReached,
    releaseConfig: () => { releaseConfig() },
    capturedConfigs,
    disposerCalls,
    treeWasActiveAtFailure: () => treeWasActiveAtFailure,
  }
}

describe('ProfileRuntime watcher setup and the settled gate', () => {
  it('keeps the mutation gate closed while watcher registration is pending', async () => {
    const tree = await bootWatcherTree({ gateName: 'pass', gateMode: 'pass', fakeHmr: 'hold' })
    const { bootPromise, runtime, rootCtx, managerLayerPath, configReached, releaseConfig } = tree
    try {
      // Stage the layer before boot so a gate breach would fully apply.
      const { layer, expected } = singleRootLayer('page', 1)
      writeFileSync(managerLayerPath, layer)
      await configReached // watcher registration is now pending inside boot
      // A concurrent manager apply must reject as not settled.
      await expect(runtime.applyManagerLayer(applyRequest(layer, [expected])))
        .rejects.toThrow(/before the initial tree has settled/i)
      releaseConfig() // only now does the gate open
      const ctx = await bootPromise
      // The pending apply never mutated the tree nor advanced the generation.
      expect([...ctx.loader.entries()].some(entry => entry.options.id === 'page')).toBe(false)
      // With every registration finished the gate opens: a real apply works.
      const result = await runtime.applyManagerLayer(applyRequest(layer, [expected]))
      expect(result.generation).toBe(1)
      expect(result.activeRoots).toEqual(['page'])
    } finally {
      await rootCtx.fiber.dispose()
    }
  })

  it('keeps the gate closed and fails boot loud when watcher registration fails on a live tree', async () => {
    const tree = await bootWatcherTree({ gateName: 'pass', gateMode: 'pass', fakeHmr: 'fail' })
    const { bootPromise, runtime, rootCtx } = tree
    try {
      await expect(bootPromise).rejects.toThrow(/pinned registration failure/)
      // The setup failure left settled false: an apply still rejects as not
      // settled instead of mutating through an already-opened gate.
      await expect(runtime.applyManagerLayer({ registryRevision: 0, runtimeLayer: '[]\n', expectedRoots: [] }))
        .rejects.toThrow(/before the initial tree has settled/i)
    } finally {
      if (rootCtx.get('loader') !== undefined) await rootCtx.fiber.dispose()
    }
  })

  it('does not turn a requested disposal during timer creation into a boot failure', async () => {
    const tree = await bootWatcherTree({
      gateName: '@deepseek-ai/cordis-plugin-timer',
      gateMode: 'hold',
    })
    const { bootPromise, runtime, rootCtx, createReached, releaseCreate } = tree
    await createReached // the timer create is held pending
    await rootCtx.fiber.dispose() // the app exits exactly as asked mid-setup
    releaseCreate() // the create now lands on the disposing tree
    const ctx = await bootPromise // the exit is not a watch failure
    expect(ctx.get('loader')).toBeUndefined()
    // The gate never opened for a tree that exited while settling.
    await expect(runtime.applyManagerLayer({ registryRevision: 0, runtimeLayer: '[]\n', expectedRoots: [] }))
      .rejects.toThrow(/before the initial tree has settled/i)
  })

  it('does not turn a requested disposal during HMR creation into a boot failure', async () => {
    const tree = await bootWatcherTree({
      gateName: '@deepseek-ai/cordis-plugin-hmr',
      gateMode: 'hold',
      fakeTimer: true, // skip timer creation so the HMR create is the held one
    })
    const { bootPromise, runtime, rootCtx, createReached, releaseCreate } = tree
    await createReached // the HMR create is held pending
    await rootCtx.fiber.dispose()
    releaseCreate()
    const ctx = await bootPromise
    expect(ctx.get('loader')).toBeUndefined()
    await expect(runtime.applyManagerLayer({ registryRevision: 0, runtimeLayer: '[]\n', expectedRoots: [] }))
      .rejects.toThrow(/before the initial tree has settled/i)
  })

  it('fails boot loud when watcher setup errors on a still-active tree', async () => {
    const tree = await bootWatcherTree({
      gateName: '@deepseek-ai/cordis-plugin-timer',
      gateMode: 'fail',
    })
    const { bootPromise, rootCtx } = tree
    try {
      await expect(bootPromise).rejects.toThrow(/pinned watcher setup failure/)
    } finally {
      if (rootCtx.get('loader') !== undefined) await rootCtx.fiber.dispose()
    }
  })

  it('rolls back earlier watchers and fails boot loud when an INACTIVE_EFFECT registration lands on a live tree', async () => {
    const tree = await bootWatcherTree({
      gateName: 'pass',
      gateMode: 'pass',
      fakeHmr: 'inactive-second',
      watchCount: 2,
    })
    const { bootPromise, runtime, rootCtx, capturedConfigs, disposerCalls } = tree
    try {
      // The second registration fails with INACTIVE_EFFECT while the tree is
      // still live: that is a real setup failure, so boot fails loud, the
      // first watcher's disposer is rolled back, and the mutation gate never
      // opens (a partial watcher set is never settled).
      await expect(bootPromise).rejects.toThrow(/cannot create effect on inactive context/)
      expect(capturedConfigs.length).toBe(1)
      expect(disposerCalls).toEqual([0])
      await expect(runtime.applyManagerLayer({ registryRevision: 0, runtimeLayer: '[]\n', expectedRoots: [] }))
        .rejects.toThrow(/before the initial tree has settled/i)
    } finally {
      if (rootCtx.get('loader') !== undefined) await rootCtx.fiber.dispose()
    }
  })

  it('calls earlier watcher disposers in reverse when a later registration fails on a live tree', async () => {
    const tree = await bootWatcherTree({
      gateName: 'pass',
      gateMode: 'pass',
      fakeHmr: 'fail-third',
      watchCount: 3,
    })
    const { bootPromise, rootCtx, capturedConfigs, disposerCalls } = tree
    try {
      await expect(bootPromise).rejects.toThrow(/pinned registration failure/)
      // The first two registrations succeeded; the third failed, so rollback
      // disposed exactly the two owned watchers, newest first.
      expect(capturedConfigs.length).toBe(2)
      expect(disposerCalls).toEqual([1, 0])
    } finally {
      if (rootCtx.get('loader') !== undefined) await rootCtx.fiber.dispose()
    }
  })

  it('keeps the original setup failure when a rollback disposer throws', async () => {
    const tree = await bootWatcherTree({
      gateName: 'pass',
      gateMode: 'pass',
      fakeHmr: 'fail-second',
      disposerThrows: true,
      watchCount: 2,
    })
    const { bootPromise, rootCtx, disposerCalls } = tree
    try {
      // The first watcher registered; the second failed. Rollback invokes the
      // first disposer, which throws — but a cleanup failure must not hide
      // the original setup failure.
      await expect(bootPromise).rejects.toThrow(/pinned registration failure/)
      expect(disposerCalls).toEqual([0])
    } finally {
      if (rootCtx.get('loader') !== undefined) await rootCtx.fiber.dispose()
    }
  })

  it('rolls back registered watcher disposers in reverse when the tree exits mid-setup', async () => {
    const tree = await bootWatcherTree({
      gateName: 'pass',
      gateMode: 'pass',
      fakeHmr: 'dispose-after-second',
      watchCount: 2,
    })
    const { bootPromise, runtime, disposerCalls } = tree
    // The app exits exactly as asked inside the second registration: boot
    // must resolve, the owned watchers must be rolled back in reverse order,
    // and the mutation gate must never open for the exited tree.
    const ctx = await bootPromise
    expect(ctx.get('loader')).toBeUndefined()
    expect(disposerCalls).toEqual([1, 0])
    await expect(runtime.applyManagerLayer({ registryRevision: 0, runtimeLayer: '[]\n', expectedRoots: [] }))
      .rejects.toThrow(/before the initial tree has settled/i)
  })

  it('disposes a timer entry this setup created when the HMR create fails later', async () => {
    const tree = await bootWatcherTree({
      gateName: 'pass',
      gateMode: 'pass',
      gates: {
        '@deepseek-ai/cordis-plugin-timer': { mode: 'create-noop', file: './noop.mjs' },
        '@deepseek-ai/cordis-plugin-hmr': { mode: 'fail' },
      },
    })
    const { bootPromise, rootCtx } = tree
    const removed: string[] = []
    rootCtx.loader.context.on('loader/partial-dispose', (entry) => { removed.push(entry.options.name) })
    try {
      await expect(bootPromise).rejects.toThrow(/pinned watcher setup failure/)
      // Only explicit loader removal emits loader/partial-dispose (boot's own
      // teardown does not), so the recorded entry proves the timer entry this
      // setup created was disposed during rollback.
      expect(removed).toEqual(['./noop.mjs'])
    } finally {
      if (rootCtx.get('loader') !== undefined) await rootCtx.fiber.dispose()
    }
  })

  it('disposes this setup\'s timer and HMR entries in reverse when the later HMR check aborts', async () => {
    const tree = await bootWatcherTree({
      gateName: 'pass',
      gateMode: 'pass',
      gates: {
        '@deepseek-ai/cordis-plugin-timer': { mode: 'create-noop', file: './noop.mjs' },
        '@deepseek-ai/cordis-plugin-hmr': { mode: 'create-noop', file: './noop2.mjs' },
      },
    })
    const { bootPromise, rootCtx } = tree
    const removed: string[] = []
    rootCtx.loader.context.on('loader/partial-dispose', (entry) => { removed.push(entry.options.name) })
    try {
      // Both entries mounted (neither provides HMR), so setup aborts at the
      // HMR availability check; rollback removes the HMR entry before the
      // timer entry — reverse creation order.
      await expect(bootPromise).rejects.toThrow(/the HMR service is unavailable for user-patch watching/)
      expect(removed).toEqual(['./noop2.mjs', './noop.mjs'])
    } finally {
      if (rootCtx.get('loader') !== undefined) await rootCtx.fiber.dispose()
    }
  })

  it('fails boot loud when an INACTIVE_EFFECT timer create lands on a live tree', async () => {
    const tree = await bootWatcherTree({
      gateName: '@deepseek-ai/cordis-plugin-timer',
      gateMode: 'fail-inactive',
    })
    const { bootPromise, runtime, rootCtx, treeWasActiveAtFailure } = tree
    try {
      // The tree never exited — an INACTIVE_EFFECT create on a live tree is a
      // real watcher-setup failure, so boot must fail loud instead of
      // resolving into a half-initialized runtime with the gate closed.
      await expect(bootPromise).rejects.toThrow(/cannot create effect on inactive context/)
      expect(treeWasActiveAtFailure()).toBe(true)
      await expect(runtime.applyManagerLayer({ registryRevision: 0, runtimeLayer: '[]\n', expectedRoots: [] }))
        .rejects.toThrow(/before the initial tree has settled/i)
    } finally {
      if (rootCtx.get('loader') !== undefined) await rootCtx.fiber.dispose()
    }
  })

  it('fails boot loud when an INACTIVE_EFFECT HMR create lands on a live tree', async () => {
    const tree = await bootWatcherTree({
      gateName: '@deepseek-ai/cordis-plugin-hmr',
      gateMode: 'fail-inactive',
      fakeTimer: true, // skip timer creation so the HMR create is the failing one
    })
    const { bootPromise, runtime, rootCtx, treeWasActiveAtFailure } = tree
    try {
      await expect(bootPromise).rejects.toThrow(/cannot create effect on inactive context/)
      expect(treeWasActiveAtFailure()).toBe(true)
      await expect(runtime.applyManagerLayer({ registryRevision: 0, runtimeLayer: '[]\n', expectedRoots: [] }))
        .rejects.toThrow(/before the initial tree has settled/i)
    } finally {
      if (rootCtx.get('loader') !== undefined) await rootCtx.fiber.dispose()
    }
  })

  it('retains the registered watchers and opens the gate on a fully successful setup', async () => {
    const tree = await bootWatcherTree({ gateName: 'pass', gateMode: 'pass', fakeHmr: 'ok', watchCount: 2 })
    const { bootPromise, runtime, rootCtx, capturedConfigs, disposerCalls, managerLayerPath } = tree
    try {
      await bootPromise
      // Both watchers stayed registered and none was rolled back, and the
      // mutation gate opened: a manager apply composes a generation.
      expect(capturedConfigs.length).toBe(2)
      expect(disposerCalls).toEqual([])
      const { layer, expected } = singleRootLayer('page', 1)
      writeFileSync(managerLayerPath, layer)
      const result = await runtime.applyManagerLayer(applyRequest(layer, [expected]))
      expect(result.generation).toBe(1)
      expect(result.activeRoots).toEqual(['page'])
    } finally {
      if (rootCtx.get('loader') !== undefined) await rootCtx.fiber.dispose()
    }
  })

  it('keeps the gate closed when the tree exits right before the final registration resolves', async () => {
    const tree = await bootWatcherTree({
      gateName: 'pass',
      gateMode: 'pass',
      fakeHmr: 'dispose-on-resolve',
    })
    const { bootPromise, runtime, disposerCalls } = tree
    // The real tree is disposed inside the final registerConfig call, so by
    // the time the await lands the exit already happened; the final liveness
    // recheck must keep the gate closed instead of settling an exited tree,
    // and the owned watcher disposer is rolled back.
    const ctx = await bootPromise
    expect(ctx.get('loader')).toBeUndefined()
    expect(disposerCalls).toEqual([0])
    await expect(runtime.applyManagerLayer({ registryRevision: 0, runtimeLayer: '[]\n', expectedRoots: [] }))
      .rejects.toThrow(/before the initial tree has settled/i)
  })
})

describe('M7 managed-root wrapper derivation', () => {
  const MANAGER_DIR = '.workspace-manager'

  /** Stage one installed feature package with a workspace manifest and bundle patch. */
  function stageFeaturePackage(
    profileDir: string,
    name = '@acme/page',
    version = '1.0.0',
    rootEntryId = 'fixture-root',
    pageId = 'fixture-page',
  ): void {
    const dir = join(profileDir, 'node_modules', ...name.split('/'))
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name,
      version,
      dsh: {
        workspace: {
          schemaVersion: 1, id: pageId, name: 'Fixture Page', description: 'fixture page app', defaultOrder: 0, rootEntryId,
        },
        bundle: { patch: './cordis.patch.yml' },
      },
    }, null, 2))
    writeFileSync(join(dir, 'cordis.patch.yml'), [
      '- insert:',
      `    - id: ${rootEntryId}`,
      "      name: '@acme/fixture-client'",
      '      config:',
      '        marker: fixture',
      '',
    ].join('\n'))
  }

  /** Stage the installed manager package that owns the wrapper module. */
  function stageManagerPackage(profileDir: string): void {
    const dir = join(profileDir, 'node_modules', '@deepseek-ai', 'dsh-page-app-manager')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: '@deepseek-ai/dsh-page-app-manager',
      version: '0.1.1-rc.2',
    }))
  }

  /** A valid registry v1 document with one enabled row for the fixture page. */
  function writeRegistry(profileDir: string): void {
    mkdirSync(join(profileDir, MANAGER_DIR), { recursive: true })
    writeFileSync(join(profileDir, MANAGER_DIR, 'registry.json'), JSON.stringify({
      schemaVersion: 1,
      revision: 1,
      entries: [{
        packageName: '@acme/page',
        source: { kind: 'registry', display: 'https://registry.example/fixture' },
        resolvedVersion: '1.0.0',
        page: { id: 'fixture-page', name: 'Fixture Page', description: 'fixture page app', defaultOrder: 0, rootEntryId: 'fixture-root' },
        order: 0,
        enabled: true,
        hidden: false,
        installedAt: '2026-08-22T00:00:00.000Z',
        updatedAt: '2026-08-22T00:00:00.000Z',
      }],
    }, null, 2))
  }

  /** The exact wrapper parent row the derivation must produce for the fixture page. */
  function expectedWrapperRow(): unknown {
    return {
      id: 'page-app.wrapper.fixture-page',
      name: '@deepseek-ai/dsh-page-app-manager/wrapper',
      inject: ['workbenchRuntime'],
      config: {
        packageName: '@acme/page',
        pageId: 'fixture-page',
        rootEntryId: 'fixture-root',
        contractVersion: 1,
      },
      insert: [
        { id: 'fixture-root', name: '@acme/fixture-client', config: { marker: 'fixture' } },
      ],
    }
  }

  it('derives wrapper root rows that inject workbenchRuntime and mount feature rows as children', async () => {
    const profile = tmp()
    stageFeaturePackage(profile)
    stageManagerPackage(profile)
    writeRegistry(profile)

    const derived = await deriveSafeRuntimeLayer('t', profile)
    expect(derived.recoveryError).toBeUndefined()
    expect(derived.omitted).toEqual([])
    // The renderer normalizes key order (`sortKeys`), so the serialized row
    // lists config before id/inject/insert/name.
    expect(derived.layer).toBe([
      '- insert:',
      '    - config:',
      '        contractVersion: 1',
      "        packageName: '@acme/page'",
      '        pageId: fixture-page',
      '        rootEntryId: fixture-root',
      '      id: page-app.wrapper.fixture-page',
      '      inject:',
      '        - workbenchRuntime',
      '      insert:',
      '        - config:',
      '            marker: fixture',
      '          id: fixture-root',
      "          name: '@acme/fixture-client'",
      "      name: '@deepseek-ai/dsh-page-app-manager/wrapper'",
      '',
    ].join('\n'))
    const parsed = load(derived.layer) as Array<{ insert: unknown[] }>
    expect(parsed).toHaveLength(1)
    expect(parsed[0]?.insert).toEqual([expectedWrapperRow()])
  })

  it('omits a root whose wrapper module cannot resolve from the profile (missing-manager health)', async () => {
    const profile = tmp()
    // The feature is installed and statically valid, but the manager package
    // that owns the wrapper module is not installed in the profile.
    stageFeaturePackage(profile)
    writeRegistry(profile)

    const derived = await deriveSafeRuntimeLayer('t', profile)
    expect(derived.recoveryError).toBeUndefined()
    expect(derived.omitted).toEqual([{ rootEntryId: 'fixture-root', reason: 'missing-manager' }])
    expect(derived.layer).toBe('[]\n')
  })

  it('boots with zero managed roots after a manager uninstall with a surviving registry (boot-after-uninstall)', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'noop.mjs'), NOOP_PLUGIN)
    writeFileSync(join(dir, 'cordis.yml'), '- id: base\n  name: ./noop.mjs\n')
    stageFeaturePackage(dir)
    // The registry survives the manager uninstall; the manager package is gone.
    writeRegistry(dir)

    const startup = await prepareManagerRuntimeLayer(NAME, dir)
    expect(startup.recoveryError).toBeUndefined()
    expect(startup.omitted).toEqual([{ rootEntryId: 'fixture-root', reason: 'missing-manager' }])

    let runtime: ProfileRuntime | undefined
    const ctx = await boot(NAME, join(dir, 'cordis.yml'), undefined, (hostCtx) => {
      runtime = new ProfileRuntime(hostCtx, {
        identity: { name: 'demo', directory: dir },
        compose: managerPatches => composeProfilePatches({
          bundlePatches: [],
          managerPatches,
          profilePatches: [],
          homePatches: [],
          overlays: [],
        }),
        initialManagerPatches: readManagerLayerPatches(NAME, dir),
      })
    })
    try {
      if (runtime === undefined) throw new Error('boot did not construct the profile runtime')
      const rows = [...ctx.loader.entries()]
      // No managed root (wrapper or feature row) mounted; boot survived the
      // manager uninstall with the registry still owned.
      expect(rows.some(entry => entry.options.id === 'page-app.wrapper.fixture-page')).toBe(false)
      expect(rows.some(entry => entry.options.id === 'fixture-root')).toBe(false)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('layer serializes the wrapper form deterministically', async () => {
    const first = tmp()
    stageFeaturePackage(first)
    stageManagerPackage(first)
    writeRegistry(first)
    const second = tmp()
    stageFeaturePackage(second)
    stageManagerPackage(second)
    writeRegistry(second)

    const derivedFirst = await deriveSafeRuntimeLayer('t', first)
    const derivedSecond = await deriveSafeRuntimeLayer('t', second)
    expect(derivedFirst.layer).toBe(derivedSecond.layer)
    expect(derivedFirst.layer).toContain('page-app.wrapper.fixture-page')
    // Deriving twice from the same profile is byte-identical.
    const again = await deriveSafeRuntimeLayer('t', first)
    expect(again.layer).toBe(derivedFirst.layer)
    expect(again.omitted).toEqual(derivedFirst.omitted)
  })
})
