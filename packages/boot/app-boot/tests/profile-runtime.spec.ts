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
import { Context, FiberState, symbols } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import {
  boot,
  canonicalManagedRootHash,
  composeEntries,
  composeProfilePatches,
  loadOptionalPatches,
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
  gateMode: 'pass' | 'hold' | 'fail' | 'fail-inactive'
  fakeHmr?: 'ok' | 'hold' | 'fail' | 'inactive-second' | 'dispose-on-resolve'
  fakeTimer?: boolean
  /** Number of launcher watcher paths; defaults to 1. */
  watchCount?: number
}): Promise<WatcherBoot> {
  const dir = tmp()
  writeFileSync(join(dir, 'noop.mjs'), NOOP_PLUGIN)
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
  let runtime: ProfileRuntime | undefined
  let rootCtx: Context | undefined
  const gate = { mode: options.gateMode, targetName: options.gateName }
  const bootPromise = boot(NAME, join(dir, 'cordis.yml'), undefined, (hostCtx) => {
    rootCtx = hostCtx
    // Hold or fail the runtime's timer/HMR loader.create deterministically.
    // The loader is already installed when prepare runs, and the patched
    // instance is the same one the runtime later calls through ctx.get.
    const realCreate = hostCtx.loader.create.bind(hostCtx.loader)
    hostCtx.loader.create = async (entryOptions) => {
      if (gate.mode === 'pass' || entryOptions.name !== gate.targetName) {
        return realCreate(entryOptions)
      }
      if (gate.mode === 'fail') {
        gate.mode = 'pass'
        throw new Error('pinned watcher setup failure')
      }
      if (gate.mode === 'fail-inactive') {
        gate.mode = 'pass'
        throw Object.assign(new Error('cannot create effect on inactive context'), { code: 'INACTIVE_EFFECT' })
      }
      gate.mode = 'pass'
      createReachedResolve()
      await new Promise<void>((resolve) => { releaseCreate = resolve })
      return realCreate(entryOptions)
    }
    if (options.fakeHmr !== undefined) {
      hostCtx.provide('hmr', {
        registerConfig: async (_filename: string, callback: () => Promise<void>) => {
          configReachedResolve()
          if (options.fakeHmr === 'fail') throw new Error('pinned registration failure')
          if (options.fakeHmr === 'inactive-second' && capturedConfigs.length >= 1) {
            throw Object.assign(new Error('cannot create effect on inactive context'), { code: 'INACTIVE_EFFECT' })
          }
          if (options.fakeHmr === 'dispose-on-resolve') {
            // The app exits exactly as asked immediately before this
            // registration resolves; the tree is really gone by the time the
            // runtime's await lands.
            await hostCtx.fiber.dispose()
          } else if (options.fakeHmr === 'hold') {
            await new Promise<void>((resolve) => { releaseConfig = resolve })
          }
          capturedConfigs.push(callback)
          return async () => {}
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

  it('does not treat a partial watcher registration (INACTIVE_EFFECT) as settled', async () => {
    const tree = await bootWatcherTree({
      gateName: 'pass',
      gateMode: 'pass',
      fakeHmr: 'inactive-second',
      watchCount: 2,
    })
    const { bootPromise, runtime, rootCtx, capturedConfigs, managerLayerPath } = tree
    try {
      // The first watcher path registers; the second fails with INACTIVE_EFFECT
      // while the tree still looks live. Setup is partial — one watcher is
      // missing — so the mutation gate must stay closed and no manager apply
      // may be accepted or treated as settled.
      const { layer, expected } = singleRootLayer('page', 1)
      writeFileSync(managerLayerPath, layer)
      const ctx = await bootPromise
      expect(capturedConfigs.length).toBe(1)
      expect(rootCtx.get('loader')).toBeDefined()
      await expect(runtime.applyManagerLayer(applyRequest(layer, [expected])))
        .rejects.toThrow(/before the initial tree has settled/i)
      expect([...ctx.loader.entries()].some(entry => entry.options.id === 'page')).toBe(false)
    } finally {
      if (rootCtx.get('loader') !== undefined) await rootCtx.fiber.dispose()
    }
  })

  it('does not escalate an INACTIVE_EFFECT timer create into a boot failure', async () => {
    const tree = await bootWatcherTree({
      gateName: '@deepseek-ai/cordis-plugin-timer',
      gateMode: 'fail-inactive',
    })
    const { bootPromise, runtime, rootCtx } = tree
    try {
      // The timer create fails with INACTIVE_EFFECT while the tree still looks
      // live: the exit is in flight but has not visibly flipped, so boot must
      // not fail, and the gate must not open.
      const ctx = await bootPromise
      expect(rootCtx.fiber.state).toBe(FiberState.ACTIVE)
      expect(ctx.get('loader')).toBeDefined()
      await expect(runtime.applyManagerLayer({ registryRevision: 0, runtimeLayer: '[]\n', expectedRoots: [] }))
        .rejects.toThrow(/before the initial tree has settled/i)
    } finally {
      if (rootCtx.get('loader') !== undefined) await rootCtx.fiber.dispose()
    }
  })

  it('does not escalate an INACTIVE_EFFECT HMR create into a boot failure', async () => {
    const tree = await bootWatcherTree({
      gateName: '@deepseek-ai/cordis-plugin-hmr',
      gateMode: 'fail-inactive',
      fakeTimer: true, // skip timer creation so the HMR create is the failing one
    })
    const { bootPromise, runtime, rootCtx } = tree
    try {
      const ctx = await bootPromise
      expect(rootCtx.fiber.state).toBe(FiberState.ACTIVE)
      expect(ctx.get('loader')).toBeDefined()
      await expect(runtime.applyManagerLayer({ registryRevision: 0, runtimeLayer: '[]\n', expectedRoots: [] }))
        .rejects.toThrow(/before the initial tree has settled/i)
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
    const { bootPromise, runtime } = tree
    // The real tree is disposed inside the final registerConfig call, so by
    // the time the await lands the exit already happened; the final liveness
    // recheck must keep the gate closed instead of settling an exited tree.
    const ctx = await bootPromise
    expect(ctx.get('loader')).toBeUndefined()
    await expect(runtime.applyManagerLayer({ registryRevision: 0, runtimeLayer: '[]\n', expectedRoots: [] }))
      .rejects.toThrow(/before the initial tree has settled/i)
  })
})
