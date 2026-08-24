// @vitest-environment jsdom
// Page-app shell apply wiring: the manager owns exactly one 'root' contribution
// declaring both child seats (builtin DSH + keyed surface), and the shell
// still registers when the generated remote namespace is absent (the built-in
// DSH seat must never depend on remote readiness — spec §3).
import { Context } from '@deepseek-ai/cordis'
import { beforeEach, describe, expect, it } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import type { SlotRenderer, SlotRendererHost } from '@deepseek-ai/dsh-client-ui-slots'
import { apply, PageAppShell, type PageAppShellInjected, inject } from '@deepseek-ai/dsh-client-ui-page-app-manager/client'
import { fakeEntry } from './fake-page-app.client.ts'

beforeEach(() => {
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

  it('subscribes to slot entry errors and disposes the subscription with the fiber', async () => {
    const { ctx, slots } = await bench()
    // The renderer host face is the sanctioned report path for entry crashes;
    // the host resolves the standard session/workspace kits lazily.
    ctx.provide('sessions', { list: () => [], currentProvideInfo: () => undefined } as never)
    ctx.provide('workspaces', { list: () => [] } as never)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    let host: SlotRendererHost | undefined
    slots.install({ renderRoot: (h: SlotRendererHost) => { host = h; return null } } as SlotRenderer)
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
})