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
import { cleanup } from '@testing-library/react'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { apply, inject, NS } from '../src/client/index.ts'
import { PageAppSettingsTab, type PageAppSettingsTabInjected } from '../src/client/PageAppSettingsTab.tsx'
import { parsePageAppInstallSourceClient } from '../src/client/source.ts'

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
