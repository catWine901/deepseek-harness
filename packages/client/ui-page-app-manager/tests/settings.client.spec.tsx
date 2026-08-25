// @vitest-environment jsdom
/**
 * Workspace Apps settings tab (Settings → Plugins → Workspace): the manager
 * registers a localized `workspace-apps` tab after the read-only `all` tab;
 * rows (disabled/hidden/unhealthy/recovery-required) stay listed even when
 * the rail hides them; the add flow classifies one source field locally and
 * rejects ambiguous relative paths and credentials; mutations delegate to the
 * controller (which owns the Host round-trip).
 */
import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { apply, inject, NS } from '../src/client/index.ts'
import { PageAppSettingsTab, type PageAppSettingsTabInjected, type PageAppSettingsTabProps } from '../src/client/PageAppSettingsTab.tsx'
import type { PageAppClientSnapshot } from '../src/client/controller.ts'
import type { PageAppOperationView } from '@deepseek-ai/dsh-page-app-manager/types'
import { zh } from '../src/client/locales.ts'
import { MutableObservable } from '../src/client/stores.ts'
import { parsePageAppInstallSourceClient } from '../src/client/source.ts'
import { deferred } from './fake-page-app.client.ts'

usePinnedBrowserLanguages('zh-CN')
afterEach(cleanup)

/** The controller's slot-ledger seam needs the runtime slots/changed event. */
async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  class RemoteService extends Service {
    constructor(serviceCtx: Context) {
      super(serviceCtx, 'remote')
    }
  }
  new RemoteService(ctx)
  return { ctx, slots: ctx.get('slots') as SlotRegistry, locale }
}

/** The Plugins section owner declares the tab seat (a list slot); the shell
 *  owns 'root', so the seat hangs off the shell-declared builtin seat. */
function declare(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'page-app.shell.builtin',
    children: { 'settings.plugins.tab': { kind: 'list', scope: 'root' } },
  } as never, () => null)
}

describe('ui-page-app-manager settings tab apply', () => {
  it('registers a localized workspace-apps tab after the read-only all tab', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    // The shell declares the builtin seat; the Plugins section then declares
    // the tab seat under it, which activates the manager's tab registration.
    declare(b.slots)
    await vi.waitFor(() => { expect(b.slots.entries('settings.plugins.tab')).toHaveLength(1) })
    const entry = b.slots.entries('settings.plugins.tab')[0]!
    expect(entry.component).toBe(PageAppSettingsTab)
    expect(entry.options).toMatchObject({ id: 'workspace-apps', order: 20 })
    expect(entry.locale).toBe(NS)
    expect(resolveSlotLabel(entry.options.label)).toBe('工作区应用')
    await fiber.dispose()
  })

  it('exposes the controller observable and Host-delegating mutations', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    declare(b.slots)
    await vi.waitFor(() => { expect(b.slots.entries('settings.plugins.tab')).toHaveLength(1) })
    const injected = (b.slots.entries('settings.plugins.tab')[0]!.inject as unknown as () => PageAppSettingsTabInjected)()
    expect(injected.hooks.pageApp).toBeTypeOf('object')
    expect(injected.install).toBeTypeOf('function')
    expect(injected.setEnabled).toBeTypeOf('function')
    expect(injected.setHidden).toBeTypeOf('function')
    expect(injected.uninstall).toBeTypeOf('function')
    expect(injected.recover).toBeTypeOf('function')
    await fiber.dispose()
  })

  it('keeps the tab registered when the shell seat is absent (Settings and shell are independent surfaces)', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    // Only the settings tab seat declared — no 'root' shell — the tab still
    // registers because it waits on its own slot declaration.
    declare(b.slots)
    await vi.waitFor(() => { expect(b.slots.entries('settings.plugins.tab')).toHaveLength(1) })
    await fiber.dispose()
  })
})


/** A controller-like snapshot with one managed row (for busy non-install actions). */
function snapshotWithRow(): PageAppClientSnapshot {
  return {
    registry: {
      profile: { name: 'p', directory: 'd' },
      revision: 1,
      entries: [{
        packageName: '@scope/a', page: { id: 'page-a', name: 'A', description: '', defaultOrder: 1, rootEntryId: 'r' },
        order: 1, enabled: true, hidden: false, installedAt: '', updatedAt: '',
        source: { kind: 'registry', display: 'x' }, resolvedVersion: '1.0.0', health: 'ready',
      }],
      operation: null,
      recovery: null,
    },
    eligible: new Map(),
    activePageId: null,
    visitedPageIds: [],
    activation: null,
    failedPageIds: [],
  }
}

/** One snapshot carrying the given projected operation view. */
function snapshotWithOperation(operation: PageAppOperationView): PageAppClientSnapshot {
  const snapshot = snapshotWithRow()
  return { ...snapshot, registry: { ...snapshot.registry!, operation } }
}

/** Render the tab against stub injections and the zh dictionary (zh-CN pinned). */
function renderTab(over: Partial<PageAppSettingsTabInjected> = {}, snapshot: PageAppClientSnapshot = snapshotWithRow()) {
  const store = new MutableObservable(snapshot)
  const install = vi.fn<PageAppSettingsTabInjected['install']>(() => Promise.resolve())
  const setEnabled = vi.fn<PageAppSettingsTabInjected['setEnabled']>(() => Promise.resolve())
  const setHidden = vi.fn<PageAppSettingsTabInjected['setHidden']>(() => Promise.resolve())
  const uninstall = vi.fn<PageAppSettingsTabInjected['uninstall']>(() => Promise.resolve())
  const recover = vi.fn<PageAppSettingsTabInjected['recover']>(() => Promise.resolve())
  const cancelInstall = vi.fn<PageAppSettingsTabInjected['cancelInstall']>(() => {})
  const t = ((key: string) => (zh as Record<string, string>)[key] ?? key) as PageAppSettingsTabProps['t']
  const props: PageAppSettingsTabProps = {
    usePageApp: (sel: (s: PageAppClientSnapshot) => unknown) => sel(useSyncExternalStore(store.subscribe, store.getSnapshot)),
    t,
    install,
    setEnabled,
    setHidden,
    uninstall,
    recover,
    cancelInstall,
    ...over,
  } as PageAppSettingsTabProps
  const utils = render(<PageAppSettingsTab {...props} />)
  return { store, install, setEnabled, setHidden, uninstall, recover, cancelInstall, ...utils }
}

describe('Settings install cancellation (M1.2, D9)', () => {
  it('cancel button aborts the in-flight install and clears the busy state', async () => {
    const gate = deferred<undefined>()
    const install = vi.fn<PageAppSettingsTabInjected['install']>(() => gate.promise)
    const cancelInstall = vi.fn()
    const utils = renderTab({ install, cancelInstall })
    // Idle: no cancel action.
    expect(utils.queryByRole('button', { name: '取消安装' })).toBeNull()
    // Start an install: the submit row flips to the busy label and the cancel
    // button appears while the install is in flight.
    fireEvent.change(utils.getByRole('textbox'), { target: { value: '@example/script-workspace' } })
    fireEvent.click(utils.getByRole('button', { name: '安装' }))
    expect(install).toHaveBeenCalled()
    expect(utils.getByRole('button', { name: '正在安装…' })).toBeTruthy()
    const cancel = utils.getByRole('button', { name: '取消安装' })
    act(() => { fireEvent.click(cancel) })
    expect(cancelInstall).toHaveBeenCalledTimes(1)
    // The in-flight promise rejects with the abort reason; the busy state
    // clears and the cancel action disappears (flush the rejection microtask).
    await act(async () => {
      gate.reject(new DOMException('The operation was aborted', 'AbortError'))
      await Promise.resolve()
    })
    expect(utils.queryByRole('button', { name: '取消安装' })).toBeNull()
    expect(utils.getByRole('button', { name: '安装' })).toBeTruthy()
    // A cancelled install shows no error row.
    expect(utils.queryByRole('alert')).toBeNull()
  })

  it('cancel button is absent when no install is running', () => {
    const utils = renderTab()
    expect(utils.queryByRole('button', { name: '取消安装' })).toBeNull()
    // A NON-install busy action (row mutation) does not surface the install
    // cancel: the action is install-specific, not generic busy.
    fireEvent.click(utils.getByRole('button', { name: '停用' }))
    expect(utils.queryByRole('button', { name: '取消安装' })).toBeNull()
    expect(utils.getByRole('button', { name: '停用' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '停用' }).getAttribute('disabled')).not.toBeNull()
  })
})

describe('client-side install-source classification', () => {
  it('classifies bare and npm-prefixed registry specs', () => {
    expect(parsePageAppInstallSourceClient('@example/script-workspace')).toMatchObject({
      kind: 'registry', spec: '@example/script-workspace', display: { kind: 'registry', display: '@example/script-workspace' },
    })
    expect(parsePageAppInstallSourceClient('npm:@example/script-workspace')).toMatchObject({ kind: 'registry' })
  })

  it('classifies git specs', () => {
    expect(parsePageAppInstallSourceClient('github:foo/script-workspace#main')).toMatchObject({ kind: 'git' })
    expect(parsePageAppInstallSourceClient('git+https://example.com/foo.git#v1')).toMatchObject({ kind: 'git' })
  })

  it('classifies picker-backed absolute local paths and tarballs', () => {
    expect(parsePageAppInstallSourceClient('D:\\plugins\\script-workspace')).toMatchObject({ kind: 'file' })
    expect(parsePageAppInstallSourceClient('D:\\packages\\script-workspace.tgz')).toMatchObject({ kind: 'tarball' })
    expect(parsePageAppInstallSourceClient('file:D:\\plugins\\script-workspace')).toMatchObject({ kind: 'file' })
    expect(parsePageAppInstallSourceClient('link:D:\\plugins\\script-workspace')).toMatchObject({ kind: 'link' })
  })

  it('rejects ambiguous relative filesystem specs and credentials', () => {
    expect(() => parsePageAppInstallSourceClient('relative/path/pkg')).toThrow(/ambiguous relative filesystem/)
    expect(() => parsePageAppInstallSourceClient('https://user:pass@example.com/foo.git')).toThrow(/credentials/)
    expect(() => parsePageAppInstallSourceClient('')).toThrow(/empty/)
  })
})

describe('projected operation state rendering (M8-client)', () => {
  it('renders the projected operation state label from the snapshot', () => {
    // A journaled install projects `installing`; the durable journal phase is
    // never the user-facing state.
    const installing = renderTab({}, snapshotWithOperation({ state: 'installing', phase: 'prepared' }))
    expect(installing.container.textContent).toContain('正在变更：安装中')
    expect(installing.container.textContent).not.toContain('prepared')

    // A recovery-visible/no-journal operation carries no phase: the state
    // label renders and `undefined` never leaks into the copy.
    const recovering = renderTab({}, snapshotWithOperation({ state: 'recovery-required' }))
    expect(recovering.container.textContent).toContain('需要恢复')
    expect(recovering.container.textContent).not.toContain('undefined')
  })
})
