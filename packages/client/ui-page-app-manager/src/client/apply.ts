/**
 * Workspace App shell registration: the manager owns the built-in `root` seat
 * and declares both child seats — the built-in DSH seat (`page-app.shell.
 * builtin`) and the keyed managed-surface seat (`page-app.shell.surface`).
 * The controller is constructed with the real generated `pageAppManager`
 * remote namespace, a slots-seam over the runtime ledger, a per-controller
 * opaque `crypto.randomUUID()` client instance, and an HMR graph-convergence
 * wait. The built-in seat never depends on remote readiness: without the
 * remote namespace the shell still registers (the controller degrades to a
 * read-only empty projection and DSH stays mounted), so composition ordering
 * cannot block the Original DSH Surface.
 * @module @deepseek-ai/dsh-client-ui-page-app-manager/client/apply
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: pulls the settings slot declarations ('settings.plugins.tab')
// into this program. Cross-plugin collaboration goes through the slot ledger.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
// Type-only: pulls ctx.locale into this program.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {
  PageAppClientInstanceId, PageAppInstallSource, PageAppManagerSnapshot,
} from '@deepseek-ai/dsh-page-app-manager/types'
import pageAppManagerRemote from '@deepseek-ai/dsh-page-app-manager/remote'
import { PageAppController, type PageAppControllerDeps } from './controller.ts'
import { PAGE_APP_SURFACE_SLOT } from './contracts.ts'
import type {
  PageAppManagerRemoteMethods, PageAppRemoteEvents, PageAppRemoteResult, PageAppSlotsSeam,
} from './contracts.ts'
import { PageAppShell, type PageAppShellInjected } from './PageAppShell.tsx'
import { PageAppSettingsTab, type PageAppSettingsTabInjected } from './PageAppSettingsTab.tsx'
import { parsePageAppInstallSourceClient } from './source.ts'
import { en, zh, type PageAppSettingsKey } from './locales.ts'
import { WorkbenchClientBridgeService } from './workbench.ts'

/** Dictionary namespace owned by this plugin (Workspace Apps settings copy). */
export const NS = 'settings.pageApp'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Workspace Apps settings tab copy. */
    'settings.pageApp': PageAppSettingsKey
  }
}

/** Empty remote projection when the generated namespace is not mounted yet. */
const EMPTY_SNAPSHOT: PageAppManagerSnapshot = Object.freeze({
  profile: Object.freeze({ name: '', directory: '' }),
  revision: 0,
  entries: Object.freeze([]),
  operation: null,
  recovery: null,
})

/** One-page result envelope for the degraded remote stub. */
const ok = <T>(value: T): PageAppRemoteResult<T> => ({ ok: true as const, value })

/** Degraded remote: read-only empty projection, no events, no mutations. */
function stubRemote(): PageAppManagerRemoteMethods & PageAppRemoteEvents {
  const never = (): Promise<PageAppRemoteResult<never>> => Promise.resolve(ok(undefined as never))
  return {
    list: () => Promise.resolve(ok(EMPTY_SNAPSHOT)),
    installPackage: (_source: PageAppInstallSource, _clientInstanceId: PageAppClientInstanceId, _signal: AbortSignal) => never(),
    setEnabled: (_pageId: string, _enabled: boolean, _signal: AbortSignal) => never(),
    setHidden: (_pageId: string, _hidden: boolean) => never(),
    reorder: (_pageIds: readonly string[]) => never(),
    uninstall: (_pageId: string, _signal: AbortSignal) => never(),
    ackClientActivation: () => never(),
    recover: () => never(),
    $on: () => () => {},
  }
}

/** Build the real remote face when the generated namespace is mounted. */
function buildRemote(ctx: ClientContext): PageAppManagerRemoteMethods & PageAppRemoteEvents | null {
  // The carrier is retained only for the event subscription; the namespace
  // resolves through the dotted service name (a property dereference on the
  // traceable carrier throws without inject).
  const remote = ctx.get('remote')
  const namespace = ctx.get('remote.pageAppManager') as PageAppManagerRemoteMethods | undefined
  if (namespace === undefined || remote === undefined) return null
  return {
    ...namespace,
    // The flat generated method surface already matches the controller seam;
    // only the event subscription lives on the carrier (TypertClientRemote).
    $on: (event, listener) => remote.$on(event as never, listener as never),
  }
}

/** The controller's slot-ledger seam over the runtime SlotRegistry. */
function buildSlotsSeam(ctx: ClientContext): PageAppSlotsSeam {
  const slots = ctx.slots as {
    entries(key: string): readonly StoredEntry[]
    subscribe(key: string, fn: () => void): () => void
  }
  return {
    entries: key => slots.entries(key),
    subscribe: (key, fn) => slots.subscribe(key, fn),
    // The runtime emits `slots/changed` on every ledger mutation (its
    // SlotCore onMutate forwarding), which is the same signal the controller
    // rebuilds on.
    onMutate: fn => ctx.on('slots/changed', fn),
  }
}

/**
 * Wait for the client graph to converge to a new revision (HMR reconcile) and
 * cancel every pending wait idempotently. The 30-second cap is a convergence
 * timeout, not a cleanup path: the controller disposes the intervals with its
 * own stop, so a stopped controller never leaks timers (React 18 StrictMode
 * cleanup symmetry).
 */
function buildGraphWait(ctx: ClientContext): {
  wait: (graphRevision: string) => Promise<void>
  cancel: () => void
} {
  const modules = ctx.get('modules') as { manifest: { rev: string } } | undefined
  const timers = new Set<ReturnType<typeof setInterval>>()
  return {
    wait: (graphRevision: string) => new Promise<void>((resolve) => {
      if (modules === undefined || modules.manifest.rev === graphRevision) {
        resolve()
        return
      }
      const baseline = modules.manifest.rev
      const started = Date.now()
      const timer = setInterval(() => {
        if (modules.manifest.rev !== baseline || modules.manifest.rev === graphRevision || Date.now() - started > 30_000) {
          clearInterval(timer)
          timers.delete(timer)
          resolve()
        }
      }, 100)
      timers.add(timer)
    }),
    cancel: () => {
      for (const timer of timers) clearInterval(timer)
      timers.clear()
    },
  }
}

/** Build the controller, degrading gracefully when the remote is not mounted. */
function createController(ctx: ClientContext): PageAppController {
  const remote = buildRemote(ctx)
  const graphWait = buildGraphWait(ctx)
  const deps: PageAppControllerDeps = {
    remote: remote ?? stubRemote(),
    slots: buildSlotsSeam(ctx),
    clientInstanceId: crypto.randomUUID() as PageAppClientInstanceId,
    awaitGraphRevision: graphWait.wait,
    cancelGraphWait: graphWait.cancel,
  }
  return new PageAppController(deps)
}

/** The shell's inject face: the controller observable plus the recovery actions. */
function shellInjected(controller: PageAppController): PageAppShellInjected {
  return {
    hooks: { pageApp: controller.observable },
    select: (pageId) => { controller.select(pageId) },
    // The failure surface's uninstall runs the same flow as Settings (no
    // cancellation UI on the shell; a fresh signal keeps the call valid).
    uninstall: (pageId) => { void controller.uninstall(pageId, new AbortController().signal) },
  }
}

/** The Settings tab's inject face: the controller observable plus mutations. */
function settingsInjected(controller: PageAppController): PageAppSettingsTabInjected {
  return {
    hooks: { pageApp: controller.observable },
    install: (source, signal) => controller.install(parsePageAppInstallSourceClient(source), signal),
    setEnabled: (pageId, enabled, signal) => controller.setEnabled(pageId, enabled, signal),
    setHidden: (pageId, hidden) => controller.setHidden(pageId, hidden),
    uninstall: (pageId, signal) => controller.uninstall(pageId, signal),
    recover: () => controller.recover(),
    cancelInstall: () => { controller.cancelInstall() },
  }
}

/** Required services: the slot registry and the locale face (remote/modules are read defensively). */
export const inject = ['slots', 'locale']

// The public rc.2 shell predates the priority-1/child-seat handoff. Its
// extracted manager build contributes Settings only so Native DSH keeps the
// sole root registration. Remove with the pinned rc.2 compatibility build.
function isLegacyRc2Client(): boolean {
  return process.env.DSH_CLIENT_PAGE_APP_MANAGER_LEGACY_RC2 === 'true'
}

/**
 * Register the Workspace App shell into the built-in `root` seat and declare
 * both child seats, and contribute the Workspace Apps tab to Settings →
 * Plugins (spec §21/§22). The controller starts with the registration and
 * stops with its fiber; the built-in DSH seat mounts immediately regardless of
 * remote readiness (spec §3 guarantees the permanent fallback surface). The
 * Settings tab and the shell share one controller, so state and mutations
 * stay consistent across both surfaces.
 * @param ctx - client root context.
 */
export async function apply(ctx: ClientContext): Promise<void> {
  // Public rc.2's static api-remotes roster predates this manager. Its generic
  // gateway already exposes the public contribution seam, so the extracted
  // client mounts only its own generated descriptor before reading the service.
  let disposeLegacyRemote: (() => Promise<void>) | undefined
  if (isLegacyRc2Client()) {
    const remote = ctx.get('remote')
    if (remote === undefined) throw new Error('legacy rc2 manager client requires the Remote gateway')
    disposeLegacyRemote = await remote.$mount(pageAppManagerRemote)
  }
  // The manager owns the service provider; Cordis binds each getter access to
  // the Feature caller, so a Feature receives the narrow workbench contract
  // instead of the raw slot ledger.
  new WorkbenchClientBridgeService(ctx)
  const controller = createController(ctx)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-page-app-manager: dictionaries')
  ctx.effect(() => {
    const stopController = controller.start()
    const disposers = [
      // One entry-error subscription per fiber: an abdicating managed surface
      // is recorded on the controller (the shell swaps in the failure face);
      // root crashes are NOT recorded here — the priority-1 fallback owns the
      // root cell and renders Native DSH.
      ctx.slots.onEntryError((key, entry) => {
        if (key === PAGE_APP_SURFACE_SLOT && entry.options.key !== undefined) {
          controller.recordEntryError(entry.options.key)
        }
      }),
      ...(isLegacyRc2Client() ? [] : [ctx.slots.register({
        name: 'root',
        children: {
          'page-app.shell.builtin': { kind: 'single', scope: 'root' },
          'page-app.shell.surface': { kind: 'keyed', scope: 'root' },
        },
        locale: NS,
        inject: () => shellInjected(controller),
      }, PageAppShell)]),
      // The Workspace tab registers after the read-only `all` tab (order 10).
      ctx.slots.inject('settings.plugins.tab', () => ctx.slots.register({
        name: 'settings.plugins.tab',
        id: 'workspace-apps',
        order: 20,
        label: () => (ctx.locale.bind(NS)('tab')),
        locale: NS,
        inject: () => settingsInjected(controller),
      }, PageAppSettingsTab)),
    ]
    return async () => {
      for (const dispose of disposers.reverse()) dispose()
      stopController()
      await disposeLegacyRemote?.()
    }
  }, 'ui-page-app-manager: shell + seats + settings tab')
}
