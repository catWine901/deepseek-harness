// @vitest-environment jsdom
// Page-app shell apply wiring: the manager owns exactly one 'root' contribution
// declaring both child seats (builtin DSH + keyed surface), and the shell
// still registers when the generated remote namespace is absent (the built-in
// DSH seat must never depend on remote readiness — spec §3).
import { Context, Service } from '@deepseek-ai/cordis'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PageAppActivationRequestedEvent } from '@deepseek-ai/dsh-page-app-manager/types'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import type { SlotRendererHost } from '@deepseek-ai/dsh-client-ui-slots'
import { apply, PageAppShell, type PageAppShellInjected, inject } from '@deepseek-ai/dsh-client-ui-page-app-manager/client'
import type { PageAppManagerRemoteMethods, PageAppRemoteEvents } from '../src/client/contracts.ts'
import { FakeRemote, fakeEntry } from './fake-page-app.client.ts'

beforeEach(() => {
  vi.unstubAllEnvs()
  document.head.querySelectorAll('meta[name="theme-color"]').forEach((node) => { node.remove() })
})

async function bench() {
  const ctx = new Context()
  const slotsFiber = ctx.plugin(SlotRegistry)
  await slotsFiber.await()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  // The controller's seam reads the runtime's slots/changed event; the remote
  // namespace is deliberately absent in this bench to prove the built-in seat
  // does not block on it.
  return { ctx, slots: ctx.get('slots') as SlotRegistry }
}

/** Bench with a programmable remote namespace so activation events can be emitted. */
async function benchWithRemote(): Promise<{ ctx: Context; slots: SlotRegistry; remote: FakeRemote }> {
  const ctx = new Context()
  const slotsFiber = ctx.plugin(SlotRegistry)
  await slotsFiber.await()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  const remote = new FakeRemote()
  // The generated api-remotes plugin owns both the carrier and the nested
  // namespace on one provider fiber: dereferencing the traceable carrier then
  // trips Cordis' missing-inject trap, while a dotted
  // ctx.get('remote.pageAppManager') resolves it from the store.
  const remoteFiber = ctx.plugin((providerCtx: Context) => {
    class RemoteService extends Service {
      private readonly serviceCtx: Context
      constructor(serviceCtx: Context) {
        super(serviceCtx, 'remote')
        this.serviceCtx = serviceCtx
      }
      // The generated carrier owns the event subscription seam and forwards
      // through the dotted service name (a property dereference on the
      // traceable carrier throws without inject).
      public $on(event: string, listener: (value: never) => void): () => void {
        const namespace = this.serviceCtx.get('remote.pageAppManager') as PageAppManagerRemoteMethods & PageAppRemoteEvents
        return namespace.$on(event as never, listener as never)
      }
      public async $mount(): Promise<() => Promise<void>> {
        return async () => {}
      }
    }
    new RemoteService(providerCtx)
    providerCtx.reflect.provide('remote.pageAppManager', remote)
  })
  await remoteFiber.await()
  return { ctx, slots: ctx.get('slots') as SlotRegistry, remote }
}

/** A pending activation event fixture. A non-initiating client instance only
 *  starts the graph-convergence tracking wait (never the acknowledgement), so
 *  the residual-interval assertion covers exactly one wait per event. */
function activationEvent(over: Partial<PageAppActivationRequestedEvent> = {}): PageAppActivationRequestedEvent {
  return {
    transactionId: 'tx-1',
    clientInstanceId: 'client-other',
    packageName: '@scope/app',
    pageId: 'page-a',
    graphRevision: 'layer-9',
    ...over,
  }
}

describe('ui-page-app-manager client apply', () => {
  it('declares its service dependencies', () => {
    // slots (registration) and locale (tab copy) are required; remote/modules
    // are read defensively.
    expect(inject).toEqual(['slots', 'locale'])
  })

  it('registers exactly one root contribution declaring both child seats', async () => {
    const { ctx, slots } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(slots.entries('root')).toHaveLength(1)
    expect(slots.entries('root')[0]!.component).toBe(PageAppShell)
    expect(slots.spec('page-app.shell.builtin')).toEqual({ kind: 'single', scope: 'root' })
    expect(slots.spec('page-app.shell.surface')).toEqual({ kind: 'keyed', scope: 'root' })
    await fiber.dispose()
    expect(slots.entries('root')).toHaveLength(0)
  })

  it('keeps the public rc2 Native root and contributes settings without claiming its legacy seat', async () => {
    vi.stubEnv('DSH_CLIENT_PAGE_APP_MANAGER_LEGACY_RC2', 'true')
    const { ctx, slots } = await benchWithRemote()
    const NativeRoot = (): null => null
    const disposeNative = slots.register({ name: 'root' }, NativeRoot)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(slots.entries('root')).toHaveLength(1)
    expect(slots.entries('root')[0]!.component).toBe(NativeRoot)
    await fiber.dispose()
    expect(slots.entries('root')).toHaveLength(1)
    disposeNative()
  })

  it('hands the controller observable and select action through the inject face', async () => {
    const { ctx, slots } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const injected = (slots.entries('root')[0]!.inject as unknown as () => PageAppShellInjected)()
    expect(injected.hooks.pageApp).toBeTypeOf('object')
    expect(injected.hooks.pageApp.getSnapshot()).toBeTypeOf('object')
    expect(injected.select).toBeTypeOf('function')
    // The observable is the controller's stable snapshot source.
    const controllerOwned = injected.hooks.pageApp as unknown
    expect(controllerOwned).not.toBeNull()
    await fiber.dispose()
  })

  it('degrades to an empty projection without the remote namespace (built-in seat unblocked)', async () => {
    const { ctx, slots } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const injected = (slots.entries('root')[0]!.inject as unknown as () => PageAppShellInjected)()
    const snapshot = injected.hooks.pageApp.getSnapshot()
    // No remote: the degraded stub lists an empty registry, nothing is
    // eligible, and DSH is the fallback surface.
    expect(snapshot.registry?.entries.length).toBe(0)
    expect(snapshot.eligible.size).toBe(0)
    expect(snapshot.activePageId).toBeNull()
    await fiber.dispose()
  })

  it('mounts with the real remote namespace provided through Cordis', async () => {
    const { ctx, slots, remote } = await benchWithRemote()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    // The nested namespace resolved through Cordis' dotted service name (a
    // carrier property dereference throws without inject): the controller's
    // event subscriptions land on the real namespace, so a pending activation
    // surfaces in the snapshot — the degraded stub never emits.
    const injected = (slots.entries('root')[0]!.inject as unknown as () => PageAppShellInjected)()
    remote.emitActivation(activationEvent())
    const view = injected.hooks.pageApp.getSnapshot().activation
    expect(view).not.toBeNull()
    expect(view?.transactionId).toBe('tx-1')
    await fiber.dispose()
  })

  it('subscribes to slot entry errors and disposes the subscription with the fiber', async () => {
    const { ctx, slots } = await bench()
    // The renderer host face is the sanctioned report path for entry crashes;
    // the host resolves the standard session/workspace kits lazily.
    ctx.provide('sessions', { list: () => [], currentProvideInfo: () => undefined } as never)
    ctx.provide('workspaces', { list: () => [] } as never)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    let host: SlotRendererHost | undefined
    slots.install({ renderRoot: (h: SlotRendererHost) => { host = h; return null } })
    slots.renderSlot('root', {})
    const injected = (slots.entries('root')[0]!.inject as unknown as () => PageAppShellInjected)()
    const observable = injected.hooks.pageApp
    const crashedA = fakeEntry('page-a', '@scope/a')
    host!.reportEntryError('page-app.shell.surface', crashedA, new Error('boom'), { abdicate: true })
    expect(observable.getSnapshot().failedPageIds).toEqual(['page-a'])
    // The subscription dies with the fiber: a later report no longer reaches
    // the controller (the observable reference stays valid after teardown).
    await fiber.dispose()
    const crashedB = fakeEntry('page-b', '@scope/b')
    host!.reportEntryError('page-app.shell.surface', crashedB, new Error('boom'), { abdicate: true })
    expect(observable.getSnapshot().failedPageIds).toEqual(['page-a'])
  })

  it('controller starts with the registration and stops with the fiber', async () => {
    const { ctx, slots } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    // The shell owns one controller instance per apply (no registry rows yet,
    // so no remote calls surfaced beyond the initial list failure).
    await fiber.dispose()
    expect(slots.entries('root')).toHaveLength(0)
  })

  it('clears the graph-wait interval on controller disposal', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    try {
      const { ctx, remote } = await benchWithRemote()
      // The client graph manifest is provided and differs from the pending
      // activation's revision, so the convergence wait starts an interval.
      ctx.provide('modules', { manifest: { rev: 'layer-0' } })
      const mount = async () => {
        const fiber = ctx.plugin({ inject: [...inject], apply })
        await fiber.await()
        return fiber
      }
      // First mount (StrictMode setup): the pending activation starts the wait.
      let fiber = await mount()
      remote.emitActivation(activationEvent())
      expect(vi.getTimerCount()).toBeGreaterThan(0)
      // Normal stop: the interval dies with the controller, never the 30s cap.
      await fiber.dispose()
      expect(vi.getTimerCount()).toBe(0)
      // StrictMode double-run (setup → cleanup → setup → cleanup): the remount
      // starts a fresh wait and its cleanup leaves zero residual intervals.
      fiber = await mount()
      remote.emitActivation(activationEvent())
      expect(vi.getTimerCount()).toBeGreaterThan(0)
      await fiber.dispose()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
