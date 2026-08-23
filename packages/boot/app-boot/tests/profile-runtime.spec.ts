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
  PROFILE_RUNTIME_SERVICE,
  ProfileRuntime,
  readManagerLayerPatches,
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
      control.markSettled()
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
