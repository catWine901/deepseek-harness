/**
 * @vitest-environment jsdom
 *
 * Load-engine account: what `load` answers its caller (that answer is what the
 * run orchestration reports to the host), Plugin Run convergence against live
 * state, per-Plugin serialization, the three-step teardown, and each failing stage.
 *
 * The runner is mounted under a REAL Loader entry named
 * `@deepseek-ai/dsh-cordis-client-runner`, exactly as the web composition
 * mounts it: dynamic package fibers are created as children of that entry's
 * fiber, which is what makes every contribution inherit the runner package's
 * Loader entry — the source of the immutable ownerPackage provenance — while
 * activation gating, the disposal cascade, and the failure stages stay real.
 */
/* oxlint-disable typescript/no-unsafe-assignment -- Vitest asymmetric matchers are typed as any. */

import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { describe, expect, it, vi } from 'vitest'
import type {
  CordisDynamicPackageId, CordisDynamicPluginId, CordisDynamicPluginRunId,
} from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionId } from '@deepseek-ai/dsh-client-connection/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { DYNAMIC_CLIENT_REDIRECTS } from '../src/client/evaluator.ts'
import { DynamicCordisPackageRunner } from '../src/client/runtime.ts'
import type { DynamicCordisClientHalf, DynamicCordisRenderFailure } from '../src/client/runtime.ts'

const PLUGIN = 'dyn-1' as CordisDynamicPluginId
const PACKAGE = 'pkg-1' as CordisDynamicPackageId
const RUN = 'run-1' as CordisDynamicPluginRunId
const AGENT = 's-1' as SessionId

/** The runner package's Loader entry name — the exact ownerPackage of its contributions. */
const RUNNER_ENTRY = '@deepseek-ai/dsh-cordis-client-runner'

function runId(value: number): CordisDynamicPluginRunId {
  return `run-${value}` as CordisDynamicPluginRunId
}

/** One browser half as the host hands it over. */
function half(overrides: Partial<DynamicCordisClientHalf> = {}): DynamicCordisClientHalf {
  return {
    pluginId: PLUGIN,
    packageId: PACKAGE,
    pluginRunId: RUN,
    agentId: AGENT,
    name: 'demo',
    code: 'return { apply(ctx) {} }',
    ...overrides,
  }
}

/** A package that seats one component in `root`, so a crash has something to name. */
const CONTRIBUTOR = `return {
  inject: ['slots'],
  apply(ctx) { ctx.slots.register({ name: 'root' }, () => null) },
}`

interface Bench {
  ctx: Context
  slots: SlotRegistry
  runner: DynamicCordisPackageRunner
  invoke: ReturnType<typeof vi.fn>
  /** Render failures the runner sent upstream, in order. */
  reported: {
    agentId: SessionId
    pluginId: CordisDynamicPluginId
    pluginRunId: CordisDynamicPluginRunId
    failure: DynamicCordisRenderFailure
  }[]
  /**
   * Report one entry crash the way the renderer's boundary does: the runner
   * subscribed through the supervision seam, and this calls what it registered.
   */
  crash: (slot: string, entry: unknown, error: unknown, abdicated?: boolean) => void
  /** Whether the runner released its subscription. */
  watching: () => boolean
  settle: () => Promise<void>
}

async function boot(): Promise<Bench> {
  const ctx = new Context()
  await ctx.plugin(Loader)
  await ctx.plugin(SlotRegistry)
  const factories = new Map<string, () => unknown>()

  const realLoader = ctx.loader as unknown as {
    internal: unknown
    create(options: { name: string }): Promise<string>
  }
  realLoader.internal = {
    import: async (name: string) => {
      const factory = factories.get(name)
      if (factory === undefined) throw new Error(`no factory for ${name}`)
      return factory()
    },
  }
  // The runner executes dynamic packages as child fibers of its OWN Loader
  // entry: that is what makes every contribution inherit the
  // @deepseek-ai/dsh-cordis-client-runner provenance. The bench therefore
  // mounts the actual runner under a real entry of that exact name.
  let runnerCtx: Context | undefined
  factories.set(RUNNER_ENTRY, () => ({
    name: 'cordis-client-runner',
    inject: ['slots'],
    apply: (pluginCtx: Context) => { runnerCtx = pluginCtx },
  }))
  await realLoader.create({ name: RUNNER_ENTRY })
  if (runnerCtx === undefined) throw new Error('the runner Loader entry never applied')

  const invoke = vi.fn(() => Promise.resolve(null))
  const reported: Bench['reported'] = []
  // The crash seam is stood in so a test can report an entry failure without a
  // React render, exactly as the renderer's boundary would; registrations still
  // go through the real service, so the entries are real.
  type EntryErrorListener = (slot: string, entry: unknown, error: unknown, info: { abdicated: boolean }) => void
  let listener: EntryErrorListener | undefined
  const runner = new DynamicCordisPackageRunner({
    ctx: runnerCtx,
    slots: {
      onEntryError: (fn: EntryErrorListener) => {
        listener = fn
        return () => { listener = undefined }
      },
    } as unknown as SlotRegistry,
    invoke,
    reportGuardFailure: () => {},
    reportRenderFailure: (agentId, pluginId, pluginRunId, failure) => {
      reported.push({ agentId, pluginId, pluginRunId, failure })
    },
  })
  return {
    ctx,
    slots: ctx.slots,
    runner,
    invoke,
    reported,
    crash: (slot, entry, error, abdicated = true) => {
      if (listener === undefined) throw new Error('the runner is not watching the crash seam')
      listener(slot, entry, error, { abdicated })
    },
    watching: () => listener !== undefined,
    settle: async () => { await new Promise((resolve) => { setTimeout(resolve, 0) }) },
  }
}

describe('load', () => {
  it('executes a browser half under the runner Loader entry, then answers active', async () => {
    const bench = await boot()
    await expect(bench.runner.load(half())).resolves.toEqual({ ok: true, pluginRunId: RUN })
    expect(bench.runner.isLoaded(PLUGIN)).toBe(true)
    expect(bench.runner.getSnapshot()).toEqual([
      { pluginId: PLUGIN, packageId: PACKAGE, pluginRunId: RUN, name: 'demo', slots: [], styleCount: 0 },
    ])
  })

  it('projects the contributions the package made', async () => {
    const bench = await boot()
    await bench.runner.load(half({
      code: `return {
        inject: ['slots'],
        apply(ctx) {
          styles.insert('.x {}')
          ctx.slots.register({ name: 'root' }, () => null)
        },
      }`,
    }))
    expect(bench.runner.getSnapshot()).toEqual([
      { pluginId: PLUGIN, packageId: PACKAGE, pluginRunId: RUN, name: 'demo', slots: ['root'], styleCount: 1 },
    ])
  })

  it('answers from live state when the revision is already loaded here', async () => {
    const bench = await boot()
    await bench.runner.load(half())
    // A replayed run must not look unacknowledged, and must not reload.
    await expect(bench.runner.load(half())).resolves.toEqual({ ok: true, pluginRunId: RUN })
    expect(bench.runner.isLoaded(PLUGIN)).toBe(true)
  })

  it('replays the parked services a live package still waits for', async () => {
    const bench = await boot()
    const parked = half({ code: "return { inject: ['absent'], apply() {} }" })
    await expect(bench.runner.load(parked)).resolves.toEqual({ ok: true, pluginRunId: RUN, waitingFor: ['absent'] })
    await expect(bench.runner.load(parked)).resolves.toEqual({ ok: true, pluginRunId: RUN, waitingFor: ['absent'] })
  })

  it('replaces a live load when a newer revision arrives, disposing the old contribution', async () => {
    const bench = await boot()
    const contributor = (run: CordisDynamicPluginRunId) => half({
      pluginRunId: run,
      code: `return {
        inject: ['slots'],
        apply(ctx) { ctx.slots.register({ name: 'root' }, () => null) },
      }`,
    })
    await bench.runner.load(contributor(RUN))
    expect(bench.slots.entries('root')).toHaveLength(1)
    await expect(bench.runner.load(contributor(runId(2)))).resolves.toEqual({ ok: true, pluginRunId: runId(2) })
    // The previous activation's fiber (and its contribution) was torn down:
    // 'root' is single, so a surviving old entry would shadow alongside.
    expect(bench.slots.entries('root')).toHaveLength(1)
    expect(bench.runner.getSnapshot()[0]?.pluginRunId).toBe(runId(2))
  })

  it('loads the function form, which declares no services', async () => {
    const bench = await boot()
    await expect(bench.runner.load(half({ code: 'return (ctx) => { globalThis.__dynFnForm = true }' })))
      .resolves.toEqual({ ok: true, pluginRunId: RUN })
    expect((globalThis as { __dynFnForm?: boolean }).__dynFnForm).toBe(true)
    delete (globalThis as { __dynFnForm?: boolean }).__dynFnForm
  })

  it('serializes operations of one package id', async () => {
    const bench = await boot()
    const first = bench.runner.load(half())
    const second = bench.runner.load(half({ pluginRunId: runId(2) }))
    await expect(first).resolves.toEqual({ ok: true, pluginRunId: RUN })
    await expect(second).resolves.toEqual({ ok: true, pluginRunId: runId(2) })
    expect(bench.runner.getSnapshot()[0]?.pluginRunId).toBe(runId(2))
  })

  it('keeps the queue usable after a failed operation', async () => {
    const bench = await boot()
    // A package whose apply throws settles as a classified failure, not a
    // rejection; the per-package queue must still serve the next load.
    await bench.runner.load(half({ code: 'return { apply() { throw new Error("boom") } }' }))
    await expect(bench.runner.load(half())).resolves.toEqual({ ok: true, pluginRunId: RUN })
  })
})

describe('failure stages', () => {
  it('classifies a closure that will not evaluate, and leaves no styles behind', async () => {
    const bench = await boot()
    await expect(bench.runner.load(half({ code: 'styles.insert(".leak {}"); return 42' }))).resolves.toEqual({
      ok: false,
      cause: 'evaluate',
      message: expect.stringContaining('must `return` a plugin') as string,
      stack: expect.any(String),
      error: expect.any(Error),
    })
    const leaked = [...document.querySelectorAll('style[data-dyn="dyn-1"]')]
      .filter(tag => tag.textContent === '.leak {}')
    expect(leaked).toHaveLength(0)
  })

  it('classifies an apply that throws, and tears the fiber down', async () => {
    const bench = await boot()
    await expect(bench.runner.load(half({
      code: 'return { apply() { styles.insert(".boom {}"); throw new Error("apply exploded") } }',
    }))).resolves.toEqual({
      ok: false,
      cause: 'activate',
      message: 'apply exploded',
      stack: expect.any(String),
      error: expect.any(Error),
    })
    // Teardown ran: the fiber is gone and its styles are disposed.
    expect(bench.runner.isLoaded(PLUGIN)).toBe(false)
    const leaked = [...document.querySelectorAll('style[data-dyn="dyn-1"]')]
      .filter(tag => tag.textContent === '.boom {}')
    expect(leaked).toHaveLength(0)
  })

  it('stringifies a closure that rejects with a non-Error value', async () => {
    const bench = await boot()
    await expect(bench.runner.load(half({ code: 'throw "raw rejection"' })))
      .resolves.toEqual({ ok: false, cause: 'evaluate', message: 'raw rejection', error: 'raw rejection' })
  })

  it('mirrors a loaded package runtime error to the console without unloading it', async () => {
    const bench = await boot()
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    await bench.runner.load(half({
      code: 'return { apply: (ctx) => { ctx.on("t/ping", () => console.error("after load")) } }',
    }))
    ;(bench.ctx.emit as (type: string) => void)('t/ping')
    const mirrored = logged.mock.calls.filter(call => String(call[0]).includes('logged an error'))
    logged.mockRestore()
    expect(mirrored).toHaveLength(1)
    expect(bench.runner.isLoaded(PLUGIN)).toBe(true)
  })
})

describe('retract', () => {
  it('unloads at the named revision', async () => {
    const bench = await boot()
    await bench.runner.load(half({ code: CONTRIBUTOR }))
    expect(bench.slots.entries('root')).toHaveLength(1)
    bench.runner.retract(PLUGIN, RUN)
    await bench.settle()
    // The fiber (and with it the contribution) is disposed.
    expect(bench.slots.entries('root')).toHaveLength(0)
    expect(bench.runner.isLoaded(PLUGIN)).toBe(false)
  })

  it('ignores a retract of a superseded revision', async () => {
    const bench = await boot()
    await bench.runner.load(half({ pluginRunId: runId(3) }))
    bench.runner.retract(PLUGIN, runId(2))
    await bench.settle()
    expect(bench.runner.isLoaded(PLUGIN)).toBe(true)
  })

  it('ignores a retract of a package this page never loaded', async () => {
    const bench = await boot()
    bench.runner.retract(PLUGIN, RUN)
    await bench.settle()
    expect(bench.runner.isLoaded(PLUGIN)).toBe(false)
  })
})

describe('observation and disposal', () => {
  it('notifies subscribers and re-derives the snapshot after each convergence', async () => {
    const bench = await boot()
    let notified = 0
    const unsubscribe = bench.runner.subscribe(() => { notified++ })
    const empty = bench.runner.getSnapshot()
    expect(bench.runner.getSnapshot()).toBe(empty) // stable between mutations
    await bench.runner.load(half())
    expect(notified).toBe(1)
    expect(bench.runner.getSnapshot()).not.toBe(empty)
    unsubscribe()
    bench.runner.retract(PLUGIN, RUN)
    await bench.settle()
    expect(notified).toBe(1)
  })

  it('unloads every live package on disposal', async () => {
    const bench = await boot()
    await bench.runner.load(half({ code: CONTRIBUTOR }))
    await bench.runner.dispose()
    expect(bench.runner.getSnapshot()).toEqual([])
    expect(bench.slots.entries('root')).toHaveLength(0)
  })

  it('routes host.call through the invoke seam it was given', async () => {
    const bench = await boot()
    await bench.runner.load(half({ code: 'return { apply: () => host.call("ping", 1) }' }))
    expect(bench.invoke).toHaveBeenCalledWith(PLUGIN, RUN, 'ping', 1)
  })
})

describe('render failures', () => {
  it('reports a crash of an entry it seated, under the session the run was for', async () => {
    const bench = await boot()
    await bench.runner.load(half({ code: CONTRIBUTOR }))
    const [entry] = bench.slots.entries('root')
    bench.crash('root', entry, new Error('Cannot read properties of undefined'))
    expect(bench.reported).toEqual([{
      agentId: AGENT,
      pluginId: PLUGIN,
      pluginRunId: RUN,
      failure: {
        slot: 'root',
        message: 'your entry in slot "root" crashed while React rendered it: Cannot read properties of undefined',
        stack: expect.any(String),
        abdicated: true,
      },
    }])
  })

  it('carries the retirement bit as the seam reported it', async () => {
    const bench = await boot()
    await bench.runner.load(half({ code: CONTRIBUTOR }))
    const [entry] = bench.slots.entries('root')
    // A chain crash keeps its cell: the package's UI is broken, not gone, and the
    // author needs to be able to tell those apart.
    bench.crash('root', entry, new Error('boom'), false)
    expect(bench.reported[0]?.failure.abdicated).toBe(false)
  })

  it('ignores a crash of an entry no dynamic package seated', async () => {
    const bench = await boot()
    await bench.runner.load(half({ code: CONTRIBUTOR }))
    // Factory UI crashing is not this runner's business, and neither is an entry
    // whose component cannot even be indexed by identity.
    bench.crash('root', { component: () => null }, new Error('boom'))
    bench.crash('root', { component: 'not-a-component' }, new Error('boom'))
    bench.crash('root', { component: null }, new Error('boom'))
    expect(bench.reported).toEqual([])
  })

  it('seats a package that registers an unindexable component without claiming it', async () => {
    const bench = await boot()
    // A component that is not an object has no identity to key ownership on; the
    // registration still stands, and a crash on it simply goes unattributed.
    await expect(bench.runner.load(half({
      code: `return {
        inject: ['slots'],
        apply(ctx) {
          ctx.slots.register({ name: 'root' }, 'not-a-component')
          ctx.slots.register({ name: 'root' }, null)
        },
      }`,
    }))).resolves.toEqual({ ok: true, pluginRunId: RUN })
    for (const entry of bench.slots.entries('root')) bench.crash('root', entry, new Error('boom'))
    expect(bench.reported).toEqual([])
  })

  it('appends the redirect a bare crash text is missing, and never twice', async () => {
    const bench = await boot()
    await bench.runner.load(half({ code: CONTRIBUTOR }))
    const [entry] = bench.slots.entries('root')
    // Reaching the global around the closure trap (window.setInterval) crashes
    // with the engine's own text, which teaches nothing on its own.
    bench.crash('root', entry, new TypeError('window.setInterval is not a function'))
    const bare = bench.reported[0]?.failure.message ?? ''
    expect(bare).toMatch(/is not a function\n/)
    const timerRedirect = DYNAMIC_CLIENT_REDIRECTS.setInterval
    if (timerRedirect === undefined) throw new Error('setInterval redirect is missing')
    expect(bare).toContain(timerRedirect)
    // The trap's own error already carries that sentence: appending it again
    // would make the model read the same paragraph twice.
    bench.crash('root', entry, new Error(
      `setInterval is not available in a dynamic client half — ${timerRedirect}`,
    ))
    const trapped = bench.reported[1]?.failure.message ?? ''
    expect(trapped.indexOf(timerRedirect)).toBe(trapped.lastIndexOf(timerRedirect))
  })

  it('stops watching the seam when the engine is disposed', async () => {
    const bench = await boot()
    await bench.runner.load(half({ code: CONTRIBUTOR }))
    expect(bench.watching()).toBe(true)
    await bench.runner.dispose()
    expect(bench.watching()).toBe(false)
  })

  it('publishes the crash on the live set\'s own notification channel', async () => {
    const bench = await boot()
    await bench.runner.load(half({ code: CONTRIBUTOR }))
    let notified = 0
    let alsoNotified = 0
    const unsubscribe = bench.runner.subscribe(() => { notified++ })
    const unobserve = bench.runner.renderFailures.subscribe(() => { alsoNotified++ })
    const empty = bench.runner.renderFailures.getSnapshot()
    expect(bench.runner.renderFailures.getSnapshot()).toBe(empty) // stable between mutations
    const [entry] = bench.slots.entries('root')
    bench.crash('root', entry, new Error('boom'), false)
    // A surface already subscribed for load changes learns about a crash too: one
    // channel, two derived snapshots — and the observable's own subscribe is that
    // same channel, so a surface may take either handle.
    expect(notified).toBe(1)
    expect(alsoNotified).toBe(1)
    const published = bench.runner.renderFailures.getSnapshot().get(PLUGIN)
    expect(published?.slot).toBe('root')
    expect(published?.abdicated).toBe(false)
    expect(published?.message).toMatch(/boom/)
    unsubscribe()
    unobserve()
  })

  it('keeps only the latest crash per package', async () => {
    const bench = await boot()
    await bench.runner.load(half({ code: CONTRIBUTOR }))
    const [entry] = bench.slots.entries('root')
    bench.crash('root', entry, new Error('first'))
    bench.crash('root', entry, new Error('second'))
    expect(bench.runner.renderFailures.getSnapshot().size).toBe(1)
    expect(bench.runner.renderFailures.getSnapshot().get(PLUGIN)?.message).toMatch(/second/)
  })

  it('clears the crash when the package is retracted', async () => {
    const bench = await boot()
    await bench.runner.load(half({ code: CONTRIBUTOR }))
    const [entry] = bench.slots.entries('root')
    bench.crash('root', entry, new Error('boom'))
    bench.runner.retract(PLUGIN, RUN)
    await bench.settle()
    // A row must never show a failure of something that no longer renders here.
    expect(bench.runner.renderFailures.getSnapshot().size).toBe(0)
  })

  it('clears the crash when the package loads again', async () => {
    const bench = await boot()
    await bench.runner.load(half({ code: CONTRIBUTOR }))
    const [entry] = bench.slots.entries('root')
    bench.crash('root', entry, new Error('boom'))
    expect(bench.runner.renderFailures.getSnapshot().size).toBe(1)
    await bench.runner.load(half({ code: CONTRIBUTOR, pluginRunId: runId(2) }))
    expect(bench.runner.renderFailures.getSnapshot().size).toBe(0)
  })

  it('keeps the crash when a replayed run loads nothing', async () => {
    const bench = await boot()
    await bench.runner.load(half({ code: CONTRIBUTOR }))
    const [entry] = bench.slots.entries('root')
    bench.crash('root', entry, new Error('boom'))
    // Same revision: nothing was re-run, so the failure the page is showing is
    // still true of what is mounted.
    await bench.runner.load(half({ code: CONTRIBUTOR }))
    expect(bench.runner.renderFailures.getSnapshot().size).toBe(1)
  })
})

describe('owner package provenance', () => {
  it('attributes a contribution to the runner package Loader entry, exactly', async () => {
    const bench = await boot()
    await bench.runner.load(half({ code: CONTRIBUTOR }))
    const [entry] = bench.slots.entries('root')
    // The half declares name 'demo'; the derivation reads the real caller
    // fiber's Loader entry — the runner package entry the package executes under.
    expect(entry?.ownerPackage).toBe(RUNNER_ENTRY)
  })

  it('cannot be forged by a dynamically evaluated package at the registration boundary', async () => {
    const bench = await boot()
    await bench.runner.load(half({
      code: `return {
        inject: ['slots'],
        apply(ctx) {
          ctx.slots.register(
            { name: 'root', ownerPackage: '@deepseek-ai/dsh-client-ui-layout' },
            () => null,
          )
        },
      }`,
    }))
    const [entry] = bench.slots.entries('root')
    // The forged option key is never read; the derived runner-package
    // provenance stands — a dynamic package cannot impersonate another package.
    expect(entry?.ownerPackage).toBe(RUNNER_ENTRY)
    expect(entry?.ownerPackage).not.toBe('@deepseek-ai/dsh-client-ui-layout')
  })

  it('cannot be mutated after registration through the dynamic facade', async () => {
    const bench = await boot()
    await bench.runner.load(half({
      code: `return {
        inject: ['slots'],
        apply(ctx) {
          ctx.slots.register({ name: 'root' }, () => null)
          const entry = ctx.slots.entries('root')[0]
          entry.ownerPackage = '@deepseek-ai/dsh-client-ui-layout'
        },
      }`,
    }))
    const [entry] = bench.slots.entries('root')
    // Post-registration write through the real facade: the stored entry is
    // runtime-immutable, so the assignment cannot stick (or throw).
    expect(entry?.ownerPackage).toBe(RUNNER_ENTRY)
  })

  it('cannot extend the live entries array through the dynamic facade', async () => {
    const bench = await boot()
    await bench.runner.load(half({
      code: `return {
        inject: ['slots'],
        apply(ctx) {
          ctx.slots.register({ name: 'root' }, () => null)
          const entries = ctx.slots.entries('root')
          entries.push({ component: () => null, options: {} })
          entries[0] = { component: () => null, options: {} }
        },
      }`,
    }))
    // The live array is frozen; a forged entry can neither be appended nor
    // replace the real one — the ledger still holds exactly the contribution.
    expect(bench.slots.entries('root')).toHaveLength(1)
    expect(bench.slots.entries('root')[0]?.ownerPackage).toBe(RUNNER_ENTRY)
  })
})
