// @vitest-environment jsdom
// Client apply wiring under the terminal register form: ctx.layout provided,
// ONE register() call declares the three child slots + seats the store factory
// + wires the panel actions through the inject hook; teardown cascades
// (service unprovided + declarations gone + registration cleared). Node half
// and the invariant companion ride along — one line exposes the aggregate
// coverage gate still requires exercised.

import { Context } from '@deepseek-ai/cordis'
import { stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply as themeApply, inject as themeInject, ThemeRuntime } from '@deepseek-ai/dsh-client-ui-theme/client'
import { apply, inject, LayoutController } from '@deepseek-ai/dsh-client-ui-layout/client'
import { AppFrame } from '@deepseek-ai/dsh-client-ui-layout/src/client/AppFrame.tsx'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import { apply as nodeApply } from '@deepseek-ai/dsh-client-ui-layout'
import * as invariant from '@deepseek-ai/dsh-client-ui-layout/invariant'

beforeEach(() => {
  document.head.querySelectorAll('meta[name="theme-color"]').forEach((node) => { node.remove() })
})

async function bench() {
  const ctx = new Context()
  const slotsFiber = ctx.plugin(SlotRegistry)
  // Theme registers its Appearance settings row and requires the connection
  // seam for persistence; model this bench as a remote, memory-only browser.
  ctx.provide('locale', new LocaleRuntime(ctx))
  ctx.provide('connection', { api: { settings: {} }, isLoopback: false } as never)
  // ui-theme's Appearance row binds a durable scope through these two.
  ctx.provide('remote', { $on: () => () => {} } as never)
  ctx.provide('settingsScope', { bind: () => stubSettingsScope().scope } as never)
  await ctx.plugin({ inject: themeInject, apply: themeApply }).await()
  await slotsFiber.await()
  return { ctx, slots: ctx.get('slots') as SlotRegistry }
}

/** The page-app shell (manager) owns 'root' and declares the builtin seat. */
function declareBuiltinSeat(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: { 'page-app.shell.builtin': { kind: 'single', scope: 'root' } },
  } as never, () => null)
}

describe('ui-layout client apply', () => {
  it('declares its service dependencies', () => {
    expect(inject).toEqual(['slots', 'theme'])
  })

  it('provides ctx.layout and registers AppFrame into the builtin seat with the four child declarations', async () => {
    const { ctx, slots } = await bench()
    const shell = declareBuiltinSeat(slots)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(ctx.get('layout')).toBeInstanceOf(LayoutController)
    // The inject()+register() pair occupied the builtin seat…
    expect(slots.entries('page-app.shell.builtin')).toHaveLength(1)
    // …and declared the four children in the ledger.
    expect(slots.spec('sidebar')).toEqual({ kind: 'single', scope: 'root' })
    expect(slots.spec('conversation')).toEqual({ kind: 'single', scope: 'session-maybe' })
    expect(slots.spec('details')).toEqual({ kind: 'single', scope: 'session' })
    expect(slots.spec('shell.overlay')).toEqual({ kind: 'list', scope: 'root' })
    shell()
  })

  it('injects no business face and attaches the layout actions', async () => {
    const { ctx, slots } = await bench()
    const shell = declareBuiltinSeat(slots)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const actions = {
      setSidebar: vi.fn(), setDetails: vi.fn(), toggleSidebar: vi.fn(), openDetails: vi.fn(), closeDetails: vi.fn(),
    }
    const injected = (slots.entries('page-app.shell.builtin')[0]!.inject as (actions: never) => object)(actions as never)
    expect(injected).toEqual({})
    const layout = ctx.get('layout') as LayoutController
    layout.toggleSidebar()
    expect(actions.toggleSidebar).toHaveBeenCalledOnce()
    shell()
  })

  it('theme presenter applies the initial snapshot, follows theme/change, and unwinds on dispose', async () => {
    const { ctx } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    // Initial getter application: jsdom has no matchMedia, system resolves light.
    expect(document.documentElement.style.colorScheme).toBe('light')
    expect(document.body.hasAttribute('data-ds-dark-theme')).toBe(false)
    const themeColorMeta = document.head.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    expect(themeColorMeta).not.toBeNull()
    const theme = ctx.get('theme') as ThemeRuntime
    theme.setTheme('dark')
    expect(document.documentElement.style.colorScheme).toBe('dark')
    expect(document.body.hasAttribute('data-ds-dark-theme')).toBe(true)
    expect(document.head.querySelector('meta[name="theme-color"]')).toBe(themeColorMeta)
    await fiber.dispose()
    expect(document.documentElement.style.colorScheme).toBe('')
    expect(document.body.hasAttribute('data-ds-dark-theme')).toBe(false)
    expect(themeColorMeta?.isConnected).toBe(false)
    // Listener is off: further theme changes no longer reach the document.
    theme.setTheme('light')
    theme.setTheme('dark')
    expect(document.documentElement.style.colorScheme).toBe('')
    expect(document.body.hasAttribute('data-ds-dark-theme')).toBe(false)
  })

  it('teardown unwinds the service, the builtin registration, and the child declarations', async () => {
    const { ctx, slots } = await bench()
    const shell = declareBuiltinSeat(slots)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    await fiber.dispose()
    expect(ctx.get('layout')).toBeUndefined()
    expect(slots.entries('page-app.shell.builtin')).toHaveLength(0)
    expect(slots.spec('sidebar')).toBeUndefined()
    // The page-app shell's builtin declaration survives entry teardown.
    expect(slots.spec('page-app.shell.builtin')).toEqual({ kind: 'single', scope: 'root' })
    shell()
  })
})

describe('dual-path root fallback (M3, D5)', () => {
  it('registers AppFrame into root at priority 1 when the builtin seat is absent (no-manager boot)', async () => {
    const { ctx, slots } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    // No manager: the fallback owns the built-in root seat at a strictly worse
    // priority than the manager's default 0, with the same four children.
    expect(slots.entries('root')).toHaveLength(1)
    const fallback = slots.entries('root')[0]!
    expect(fallback.options.priority).toBe(1)
    expect(fallback.component).toBe(AppFrame)
    expect(slots.entries('page-app.shell.builtin')).toHaveLength(0)
    expect(slots.spec('sidebar')).toEqual({ kind: 'single', scope: 'root' })
    expect(slots.spec('conversation')).toEqual({ kind: 'single', scope: 'session-maybe' })
    expect(slots.spec('details')).toEqual({ kind: 'single', scope: 'session' })
    expect(slots.spec('shell.overlay')).toEqual({ kind: 'list', scope: 'root' })
    await fiber.dispose()
    expect(slots.entries('root')).toHaveLength(0)
  })

  it('yields to the builtin path when the manager declares the seat (manager-first load order)', async () => {
    const { ctx, slots } = await bench()
    const shell = declareBuiltinSeat(slots)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    // Manager-first: AppFrame lands in the builtin seat; root holds only the
    // manager's entry — the fallback never takes the cell.
    expect(slots.entries('page-app.shell.builtin')).toHaveLength(1)
    expect(slots.entries('page-app.shell.builtin')[0]!.component).toBe(AppFrame)
    expect(slots.entries('root')).toHaveLength(1)
    expect(slots.entries('root')[0]!.component).not.toBe(AppFrame)
    expect(slots.spec('sidebar')).toEqual({ kind: 'single', scope: 'root' })
    shell()
  })

  it('yields to the builtin path when the manager arrives after ui-layout (layout-first load order)', async () => {
    const { ctx, slots } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(slots.entries('root')).toHaveLength(1)
    expect(slots.entries('root')[0]!.options.priority).toBe(1)
    const shell = declareBuiltinSeat(slots)
    // The fallback collapses its own children declarations before the builtin
    // path re-registers the same four — no duplicate-children throw.
    expect(slots.entries('root')).toHaveLength(1)
    expect(slots.entries('root')[0]!.component).not.toBe(AppFrame)
    expect(slots.entries('page-app.shell.builtin')).toHaveLength(1)
    expect(slots.entries('page-app.shell.builtin')[0]!.component).toBe(AppFrame)
    expect(slots.spec('sidebar')).toEqual({ kind: 'single', scope: 'root' })
    expect(slots.spec('conversation')).toEqual({ kind: 'single', scope: 'session-maybe' })
    expect(slots.spec('details')).toEqual({ kind: 'single', scope: 'session' })
    expect(slots.spec('shell.overlay')).toEqual({ kind: 'list', scope: 'root' })
    shell()
  })

  it('never holds two root occupants (distinct priorities, no same-priority throw)', async () => {
    const { ctx, slots } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    // Observe every root-entries state across the manager arrival: the cell
    // may transiently hold two occupants, always at distinct priorities — the
    // single-seat same-priority throw can never fire.
    const observed: Array<readonly StoredEntry[]> = []
    const off = slots.subscribe('root', () => { observed.push(slots.entries('root')) })
    const shell = declareBuiltinSeat(slots)
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    off()
    for (const entries of observed) {
      const priorities = entries.map(entry => entry.options.priority ?? 0)
      expect(new Set(priorities).size, `priorities ${priorities.join(',')}`).toBe(priorities.length)
    }
    // Settled: a single manager occupant at the default priority.
    expect(slots.entries('root')).toHaveLength(1)
    expect(slots.entries('root')[0]!.options.priority ?? 0).toBe(0)
    shell()
  })

  it('survives a manager HMR reload cycle without duplicate child declarations', async () => {
    const { ctx, slots } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    // Manager generation 1 arrives; the fallback yields to the builtin path.
    const shell1 = declareBuiltinSeat(slots)
    expect(slots.entries('page-app.shell.builtin')).toHaveLength(1)
    // The manager fiber reloads (dispose + redeclare): the fallback re-takes
    // root, then yields again — the four children are declared once per path.
    shell1()
    expect(slots.entries('root')).toHaveLength(1)
    expect(slots.entries('root')[0]!.options.priority).toBe(1)
    expect(slots.entries('page-app.shell.builtin')).toHaveLength(0)
    expect(slots.spec('sidebar')).toEqual({ kind: 'single', scope: 'root' })
    const shell2 = declareBuiltinSeat(slots)
    expect(slots.entries('page-app.shell.builtin')).toHaveLength(1)
    expect(slots.entries('root')).toHaveLength(1)
    expect(slots.entries('root')[0]!.component).not.toBe(AppFrame)
    expect(slots.spec('sidebar')).toEqual({ kind: 'single', scope: 'root' })
    shell2()
  })

  it('survives a StrictMode double-invoke (setup, cleanup, setup) without duplicate registrations', async () => {
    const { ctx, slots } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    await fiber.dispose()
    const fiber2 = ctx.plugin({ inject: [...inject], apply })
    await fiber2.await()
    // setup → cleanup → setup leaves exactly one fallback registration.
    expect(slots.entries('root')).toHaveLength(1)
    expect(slots.entries('root')[0]!.options.priority).toBe(1)
    expect(slots.entries('page-app.shell.builtin')).toHaveLength(0)
    await fiber2.dispose()
  })
})

describe('node half + invariant companion', () => {
  it('node apply is an intentional no-op (loader-managed lifecycle only)', () => {
    nodeApply()
    expect(true).toBe(true) // reaching here without throw is the contract
  })

  it('invariant companion registers under the package name', async () => {
    const register = vi.fn().mockReturnValue(() => {})
    const ctx = { invariants: { register } } as never
    // The /invariant subpath types live in lib/types (build product); assert
    // the API so the call stays typed where lint runs without a build.
    const dispose = await (invariant as { apply: (ctx: never) => Promise<() => void> }).apply(ctx)
    expect(register).toHaveBeenCalledWith('@deepseek-ai/dsh-client-ui-layout', expect.any(Function))
    // The installer is the declared no-op — calling it must not throw.
    expect(() => { (register.mock.calls[0]![1] as (c: never) => void)(undefined as never) }).not.toThrow()
    expect(dispose).toBeTypeOf('function')
  })
})