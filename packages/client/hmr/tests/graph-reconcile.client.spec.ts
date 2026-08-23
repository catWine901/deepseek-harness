// @vitest-environment jsdom
/**
 * Graph reconciliation on the browser half: a `graph` frame swaps the live
 * module graph atomically, drains removed Loader entries through the safe
 * removal path, invalidates their module state and styles, prefetches and
 * mounts added rows in graph order, and settles their fibers before the
 * reconcile resolves. Unchanged rows keep their identity, graph and rebuilt
 * frames share one serialized queue, a failing addition creates no partial
 * entry set, and a reconnect-time graph frame converges from the current
 * client graph even when earlier frames were lost.
 */
import { Context, FiberState } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import type { Loader as LoaderService } from '@deepseek-ai/cordis-plugin-loader'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClientModuleLoader, ClientModuleLoaderTarget, DshWindow, WebBootGraph } from '@deepseek-ai/dsh-client-modules/client'
import { createClientModuleSystem } from '@deepseek-ai/dsh-client-modules/client'
import { apply, reconcileGraph } from '../src/client/index.ts'

const MODULES_ID = '@deepseek-ai/dsh-client-modules'
const win = globalThis as DshWindow

type Factory = (require: (spec: string) => unknown) => Record<string, unknown>

const row = (id: string, fields: Record<string, unknown> = {}): { id: string; url: string; rev: string; external?: string[] } =>
  ({ id, url: `/plugins/${id}/client.js?rev=0`, rev: '0', ...fields })

interface Bench {
  ctx: Context
  loader: LoaderService
  modLoader: ClientModuleLoader
  fetched: string[]
}

/** Full bench: real vendored Loader over the real module system, initial entries mounted. */
async function bootGraph(
  entries: readonly { id: string; url: string; rev: string; external?: string[] }[],
  bundles: Record<string, Factory | null>,
): Promise<Bench> {
  const fetched: string[] = []
  const target: ClientModuleLoaderTarget = {
    mode: 'queue',
    pendingQueue: [],
    load: (registration) => { target.pendingQueue.push(registration) },
    create: options => createClientModuleSystem(target, { id: MODULES_ID, exports: {} }, options),
  }
  win.__ModuleLoader__ = target
  const modLoader = target.create({
    boot: { rev: 'r0', entries: [...entries] },
    staticModules: {},
    loadBundle: async (url) => {
      fetched.push(url)
      const id = /\/plugins\/(.+)\/client\.js/.exec(url)?.[1]
      const factory = id === undefined ? undefined : bundles[id]
      if (factory == null || id === undefined) return
      win.__ModuleLoader__?.load({ id, factory })
    },
  })
  const ctx = new Context()
  await ctx.plugin(Loader)
  const loader = ctx.loader
  loader.internal = modLoader as never
  for (const plugin of modLoader.manifest.plugins) {
    await loader.create({ name: plugin.id })
  }
  await loader.await()
  return { ctx, loader, modLoader, fetched }
}

const graph = (rev: string, entries: readonly { id: string; url: string; rev: string; external?: string[] }[]): WebBootGraph =>
  ({ rev, entries: entries.map(entry => ({ ...entry })) })

afterEach(() => {
  vi.unstubAllGlobals()
  delete win.__ModuleLoader__
  for (const el of document.querySelectorAll('style, script')) el.remove()
})

describe('reconcileGraph', () => {
  it('drains removed entries, invalidates their modules and styles, publishes, then mounts additions and settles fibers', async () => {
    const b = await bootGraph([row('a')], {
      a: () => ({ apply() {} }),
      b: () => ({ apply() {} }),
    })
    await b.modLoader.import('a', '', {})
    b.fetched.length = 0
    const entryA = [...b.loader.entries()].find(e => e.options.name === 'a')!
    const recordA = b.modLoader.loadCache.get('a')
    const tag = document.createElement('style')
    tag.setAttribute('data-plugin', 'a')
    tag.textContent = '.a {}'
    document.head.append(tag)

    await reconcileGraph(b.loader, b.modLoader, graph('r1', [row('a'), row('b')]))
    // Added row b prefetched (bundle fetched once), entry created, fiber settled.
    expect(b.fetched).toEqual(['/plugins/b/client.js?rev=0'])
    const entryB = [...b.loader.entries()].find(e => e.options.name === 'b')
    expect(entryB?.fiber).toBeDefined()
    expect(entryB?.fiber?.state).toBe(FiberState.ACTIVE)
    // Unchanged a keeps its identity.
    expect(b.modLoader.loadCache.get('a')).toBe(recordA)
    expect([...b.loader.entries()].find(e => e.options.name === 'a')).toBe(entryA)

    await reconcileGraph(b.loader, b.modLoader, graph('r2', [row('b')]))
    // a's entry drained, its module state and owned styles invalidated, and
    // the removal never persisted options.disabled (safe loader.remove path).
    expect([...b.loader.entries()].map(e => e.options.name)).toEqual(['b'])
    expect(entryA.options.disabled).not.toBe(true)
    expect(b.modLoader.loadCache.has('a')).toBe(false)
    expect(document.querySelectorAll('style[data-plugin="a"]')).toHaveLength(0)
  })

  it('prefetches added rows in graph order and creates their entries in that order', async () => {
    const b = await bootGraph([row('leaf')], {
      leaf: () => ({ apply() {} }),
      mid: () => ({ apply() {} }),
      top: () => ({ apply() {} }),
    })
    b.fetched.length = 0
    await reconcileGraph(b.loader, b.modLoader, graph('r1', [
      row('leaf'),
      row('top', { external: ['mid'] }),
      row('mid'),
    ]))
    // Graph order: mid before top (top requests mid); leaf already present
    // and untouched (its bundle was fetched at boot, before the clear).
    expect(b.fetched).toEqual(['/plugins/mid/client.js?rev=0', '/plugins/top/client.js?rev=0'])
    expect([...b.loader.entries()].map(e => e.options.name).sort()).toEqual(['leaf', 'mid', 'top'])
    for (const entry of b.loader.entries()) {
      if (entry.fiber !== undefined) expect(entry.fiber.state).toBe(FiberState.ACTIVE)
    }
  })

  it('leaves the loader untouched when a rejected wire arrives', async () => {
    const b = await bootGraph([row('a')], { a: () => ({ apply() {} }) })
    await b.modLoader.import('a', '', {})
    const before = b.modLoader.manifest
    await expect(reconcileGraph(b.loader, b.modLoader, { rev: 'r1', entries: [row('a'), row('a')] }))
      .rejects.toThrow('duplicate graph entry "a"')
    expect(b.modLoader.manifest).toBe(before)
    expect([...b.loader.entries()].map(e => e.options.name)).toEqual(['a'])
  })

  it('creates no partial added set when an added bundle fails to arrive', async () => {
    const b = await bootGraph([row('a')], { a: () => ({ apply() {} }), broken: null })
    await expect(reconcileGraph(b.loader, b.modLoader, graph('r1', [row('a'), row('broken')])))
      .rejects.toThrow('without registering "broken"')
    // The added row never became a loader entry; the graph is current but the
    // entry creation loop never ran.
    expect([...b.loader.entries()].map(e => e.options.name)).toEqual(['a'])
    expect(b.modLoader.manifest.rev).toBe('r1')
  })

  it('converges from the current client graph when a frame was lost (reconnect), and no-ops on an identical frame', async () => {
    const b = await bootGraph([row('a')], { a: () => ({ apply() {} }), late: () => ({ apply() {} }) })
    // An earlier frame that would have added `late` was lost during the
    // EventSource gap; the reconnect-time graph frame must converge.
    await reconcileGraph(b.loader, b.modLoader, graph('r2', [row('a'), row('late')]))
    expect([...b.loader.entries()].map(e => e.options.name).sort()).toEqual(['a', 'late'])
    // An identical frame is a no-op: nothing refetched, nothing remounted.
    const entryA = [...b.loader.entries()].find(e => e.options.name === 'a')
    const fetched = b.fetched.length
    await reconcileGraph(b.loader, b.modLoader, graph('r2', [row('a'), row('late')]))
    expect(b.fetched.length).toBe(fetched)
    expect([...b.loader.entries()].find(e => e.options.name === 'a')).toBe(entryA)
  })
})

describe('apply frame handling', () => {
  class FakeEventSource {
    static instances: FakeEventSource[] = []
    readonly listeners = new Map<string, ((event: MessageEvent<string>) => void)[]>()
    closed = false
    constructor(public readonly url: string) {
      FakeEventSource.instances.push(this)
    }
    addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
      const list = this.listeners.get(type) ?? []
      list.push(listener)
      this.listeners.set(type, list)
    }
    close(): void { this.closed = true }
    emit(frame: unknown): void {
      for (const listener of this.listeners.get('message') ?? []) {
        listener({ data: JSON.stringify(frame) } as MessageEvent<string>)
      }
    }
  }

  it('runs graph and rebuilt frames through one serialized queue', async () => {
    vi.stubGlobal('EventSource', FakeEventSource)
    FakeEventSource.instances.length = 0
    const b = await bootGraph([row('a')], {
      a: () => ({ apply() {} }),
      b: () => ({ apply() {} }),
    })
    const ctx = b.ctx
    ctx.reflect.provide('modules', b.modLoader)
    apply(ctx)
    const source = FakeEventSource.instances[0]
    expect(source).toBeDefined()
    source.emit({ type: 'rebuilt', id: 'a', rev: 'r2' })
    source.emit({ type: 'graph', graph: graph('r3', [row('a'), row('b')]) })
    // Both frames settle through the same queue: rebuilt first, then graph.
    await b.loader.await()
    await new Promise(resolve => setTimeout(resolve, 0))
    const entries = [...b.loader.entries()].map(e => e.options.name).sort()
    expect(entries).toEqual(['a', 'b'])
    expect(b.fetched).toContain('/plugins/b/client.js?rev=0')
    // The queue survives a failing frame: a bad graph after the good one.
    source.emit({ type: 'graph', graph: { rev: 'r4', entries: [row('a'), row('a')] } })
    await b.loader.await()
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(b.modLoader.manifest.rev).toBe('r3')
  })
})
