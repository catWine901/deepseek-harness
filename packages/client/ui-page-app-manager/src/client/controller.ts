/**
 * React-free page-app controller: one stable observable snapshot over the
 * managed registry, the authorized surface contributions, the active/visited
 * page state, and the pending targeted activation. Mutations delegate to the
 * generated `pageAppManager` remote; the closed authorization projection (spec
 * §7) keeps unrelated, wrong-provenance, duplicate, or mismatched-revision
 * contributions invisible. No React import — the slot renderer binds it
 * through the inject.hooks compartment (Task 11).
 * @module @deepseek-ai/dsh-client-ui-page-app-manager/client/controller
 */

import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  PageAppActivationRequestedEvent, PageAppClientInstanceId, PageAppInstallSource,
  PageAppManagerSnapshot, PageAppTransactionId,
} from '@deepseek-ai/dsh-page-app-manager/types'
import {
  PAGE_APP_DSH_PAGE, PAGE_APP_SURFACE_SLOT,
  type PageAppActivationView, type PageAppManagerRemoteMethods, type PageAppRemoteEvents, type PageAppSlotsSeam,
} from './contracts.ts'
import { MutableObservable, type PageAppObservable } from './stores.ts'

/** The controller's durable projection (stable reference between committed changes). */
export interface PageAppClientSnapshot {
  /**
   * The managed registry, or null before the first successful list (the
   * Settings tab renders the absent-registry error state from this).
   */
  readonly registry: PageAppManagerSnapshot | null
  /** Authorized surface contributions keyed by page id (spec §7 closed projection). */
  readonly eligible: ReadonlyMap<string, StoredEntry>
  /** The active page id, or null when the built-in DSH page is active. */
  readonly activePageId: string | null
  /** Visited page ids in first-visit order (hidden pages are NOT evicted). */
  readonly visitedPageIds: readonly string[]
  /** The pending targeted activation, when one is open. */
  readonly activation: PageAppActivationView | null
  /**
   * Managed surface page ids whose entries abdicated after a crash (slot
   * `reportEntryError` with `abdicate`); the shell renders a manager-owned
   * failure surface for each until a select (retry) or eviction clears it.
   */
  readonly failedPageIds: readonly string[]
}

/** Controller dependencies: remote, slot ledger, identity, and graph convergence. */
export interface PageAppControllerDeps {
  /** The generated `pageAppManager` remote namespace. */
  readonly remote: PageAppManagerRemoteMethods & PageAppRemoteEvents
  /** The slot ledger (surface slot contributions). */
  readonly slots: PageAppSlotsSeam
  /** This controller's opaque client instance (only it may acknowledge). */
  readonly clientInstanceId: PageAppClientInstanceId
  /**
   * Wait for the client graph to converge to a pending activation's revision
   * (wired to the HMR graph reconcile by the shell). Resolves when converged.
   */
  readonly awaitGraphRevision: (graphRevision: string) => Promise<void>
  /**
   * Cancel every pending graph-wait interval immediately. The controller
   * calls this from its stop path; the 30-second convergence cap is not a
   * cleanup mechanism, and repeated cancellation is a no-op.
   */
  readonly cancelGraphWait: () => void
}

/** Unwrap a Remote result or throw its message. */
function unwrap<T>(result: { ok: true; value: T } | { ok: false; error: { code: string; message: string } }): T {
  if (result.ok) return result.value
  throw new Error(`pageAppManager: ${result.error.code}: ${result.error.message}`)
}

/** Whether two eligible projections hold the same (page id, entry) pairs. */
function sameEligible(a: ReadonlyMap<string, StoredEntry>, b: ReadonlyMap<string, StoredEntry>): boolean {
  if (a.size !== b.size) return false
  for (const [key, entry] of a) {
    if (b.get(key) !== entry) return false
  }
  return true
}

/** Whether two snapshots are observably identical (spec §14 stable reference). */
function sameSnapshot(a: PageAppClientSnapshot, b: PageAppClientSnapshot): boolean {
  return a.registry === b.registry
    && a.activePageId === b.activePageId
    && a.activation === b.activation
    && sameEligible(a.eligible, b.eligible)
    && a.visitedPageIds.length === b.visitedPageIds.length
    && a.visitedPageIds.every((id, index) => id === b.visitedPageIds[index])
    && a.failedPageIds.length === b.failedPageIds.length
    && a.failedPageIds.every((id, index) => id === b.failedPageIds[index])
}

/**
 * The React-free controller: exposes one stable {@link PageAppObservable} over
 * the managed set and delegates mutations to the remote.
 */
export class PageAppController {
  /** The stable observable the shell and Settings bind to. */
  public readonly observable: PageAppObservable<PageAppClientSnapshot>

  private readonly state = new MutableObservable<PageAppClientSnapshot>({
    registry: null,
    eligible: new Map(),
    activePageId: null,
    visitedPageIds: [],
    activation: null,
    failedPageIds: [],
  })
  private registry: PageAppManagerSnapshot | null = null
  private activation: PageAppActivationRequestedEvent | null = null
  private convergedRevision: string | null = null
  private cachedActivation: {
    request: PageAppActivationRequestedEvent | null
    converged: boolean
    view: PageAppActivationView | null
  } | null = null
  private readonly visited = new Set<string>()
  private visitedOrder: string[] = []
  private readonly failed = new Set<string>()
  /** The tracked in-flight install controller (Settings cancel targets it). */
  private installAbort: AbortController | null = null
  private activePageId: string | null = PAGE_APP_DSH_PAGE
  private disposed = false
  private readonly disposers: Array<() => void> = []

  /**
   * @param deps - remote, slot ledger, client identity, and graph convergence.
   */
  constructor(private readonly deps: PageAppControllerDeps) {
    this.observable = this.state
  }

  /**
   * Subscribe to the manager events, the slot ledger, and the initial snapshot.
   * @returns the disposer.
   */
  public start(): () => void {
    this.disposers.push(this.deps.remote.$on('page-app-manager/changed', () => {
      // A committed revision settles the pending activation (the manager runs
      // one operation at a time, so no other mutation can commit concurrently).
      this.activation = null
      this.convergedRevision = null
      void this.refresh()
    }))
    this.disposers.push(this.deps.remote.$on('page-app-manager/activation-requested', (request) => {
      this.activation = request
      this.convergedRevision = null
      this.rebuild()
      // Every connected browser reconciles the graph; only the initiating
      // client instance may acknowledge the transaction (spec §10.1 step 8).
      void this.trackConvergence(request)
      if (request.clientInstanceId === this.deps.clientInstanceId) {
        void this.acknowledge(request)
      }
    }))
    this.disposers.push(this.deps.slots.onMutate(() => { this.rebuild() }))
    void this.refresh()
    return () => {
      this.disposed = true
      for (const dispose of this.disposers.splice(0).reverse()) dispose()
      // The graph-wait interval dies with the controller: stop is the only
      // lifecycle path that clears it (idempotent under repeated cleanup).
      this.deps.cancelGraphWait()
    }
  }

  /**
   * Select one page (or null for the built-in DSH page). First visit mounts;
   * later visits reuse the mounted surface.
   * @param pageId - the page id, or null for DSH.
   */
  public select(pageId: string | null): void {
    const id = pageId ?? PAGE_APP_DSH_PAGE
    this.activePageId = id
    if (id !== PAGE_APP_DSH_PAGE && !this.visited.has(id)) {
      this.visited.add(id)
      this.visitedOrder = [...this.visitedOrder, id]
    }
    // Retry = re-select: the failure record clears so the shell remounts.
    this.failed.delete(id)
    this.rebuild()
  }

  /**
   * Install one workspace package (Settings add-flow). The remote receives a
   * per-call AbortController signal linked to the caller's signal; controller
   * disposal and a later cancelInstall() abort the same controller.
   * @param source - the validated install source.
   * @param signal - cancellation.
   */
  public async install(source: PageAppInstallSource, signal: AbortSignal): Promise<void> {
    const ctrl = new AbortController()
    // A new install replaces the previous in-flight one (one at a time).
    this.installAbort?.abort()
    this.installAbort = ctrl
    this.disposers.push(() => { ctrl.abort() })
    const unlink = this.linkAbort(ctrl, signal)
    if (ctrl.signal.aborted) {
      if (this.installAbort === ctrl) this.installAbort = null
      throw ctrl.signal.reason
    }
    try {
      const revision = unwrap(await this.deps.remote.installPackage(source, this.deps.clientInstanceId, ctrl.signal))
      void revision
      await this.refresh()
    } finally {
      if (this.installAbort === ctrl) this.installAbort = null
      unlink()
    }
  }

  /**
   * Enable or disable one managed page.
   * @param pageId - the managed page id.
   * @param enabled - the new enabled state.
   * @param signal - cancellation.
   */
  public async setEnabled(pageId: string, enabled: boolean, signal: AbortSignal): Promise<void> {
    const ctrl = new AbortController()
    this.disposers.push(() => { ctrl.abort() })
    const unlink = this.linkAbort(ctrl, signal)
    if (ctrl.signal.aborted) throw ctrl.signal.reason
    try {
      unwrap(await this.deps.remote.setEnabled(pageId, enabled, ctrl.signal))
      this.rebuild()
      await this.refresh()
    } finally {
      unlink()
    }
  }

  /**
   * Hide or show one managed page (presentation only).
   * @param pageId - the managed page id.
   * @param hidden - the new hidden state.
   */
  public async setHidden(pageId: string, hidden: boolean): Promise<void> {
    unwrap(await this.deps.remote.setHidden(pageId, hidden))
    this.rebuild()
    await this.refresh()
  }

  /**
   * Reorder managed pages.
   * @param pageIds - page ids in the desired order.
   */
  public async reorder(pageIds: readonly string[]): Promise<void> {
    unwrap(await this.deps.remote.reorder(pageIds))
    await this.refresh()
  }

  /**
   * Uninstall one managed page from the current profile.
   * @param pageId - the managed page id.
   * @param signal - cancellation.
   */
  public async uninstall(pageId: string, signal: AbortSignal): Promise<void> {
    const ctrl = new AbortController()
    this.disposers.push(() => { ctrl.abort() })
    const unlink = this.linkAbort(ctrl, signal)
    if (ctrl.signal.aborted) throw ctrl.signal.reason
    try {
      unwrap(await this.deps.remote.uninstall(pageId, ctrl.signal))
      this.evict(pageId)
      await this.refresh()
    } finally {
      unlink()
    }
  }

  /** Run the startup/operator recovery over the profile journal. */
  public async recover(): Promise<void> {
    unwrap(await this.deps.remote.recover())
    await this.refresh()
  }

  /**
   * Cancel the in-flight install (Settings cancel action). Aborts the tracked
   * install controller; the remote call rejects with the abort reason and the
   * Settings busy state clears through the install promise.
   */
  public cancelInstall(): void {
    this.installAbort?.abort()
  }

  /**
   * Record one abdicated managed surface (slot entry crash). The shell swaps
   * the crashed cell for a manager-owned failure surface; a later select
   * (retry) or eviction clears the record.
   * @param pageId - the crashed surface's page id (the keyed slot key).
   */
  public recordEntryError(pageId: string): void {
    if (this.disposed) return
    this.failed.add(pageId)
    this.rebuild()
  }

  /** Re-read the registry from the remote and rebuild the projection. */
  private async refresh(): Promise<void> {
    if (this.disposed) return
    try {
      this.registry = unwrap(await this.deps.remote.list())
    } catch (error) {
      // A failed list keeps the last known registry; the Settings tab shows
      // the error through the snapshot's absent registry.
      this.registry = null
      void error
    }
    this.rebuild()
  }

  /**
   * Link one per-call AbortController to the caller's signal: a pre-aborted
   * signal aborts immediately; a later external abort forwards. The remote
   * receives the per-call signal, so disposal and external cancellation share
   * one abort consumer.
   * @param controller - the per-call controller.
   * @param signal - the caller's cancellation signal.
   * @returns a disposer unlinking the forwarded abort listener.
   */
  private linkAbort(controller: AbortController, signal: AbortSignal): () => void {
    if (signal.aborted) {
      controller.abort()
      return () => {}
    }
    if (signal === controller.signal) return () => {}
    const onAbort = (): void => { controller.abort() }
    signal.addEventListener('abort', onAbort, { once: true })
    return () => { signal.removeEventListener('abort', onAbort) }
  }

  /** Rebuild the snapshot from current registry, activation, and selection state. */
  private rebuild(): void {
    const registry = this.registry
    const eligible = registry === null ? new Map<string, StoredEntry>() : this.authorizedProjection(registry)
    // Disable, uninstall, or registry invalidation evicts the visited page;
    // mere hiding falls the active selection back to DSH without eviction.
    // A transient registry failure (list error) never evicts — only the
    // selection falls back while the last known rows stay visited.
    if (registry !== null) {
      for (const id of [...this.visitedOrder]) {
        const row = registry.entries.find(candidate => candidate.page.id === id)
        if (row === undefined || !row.enabled) this.evict(id)
      }
    }
    if (this.activePageId !== PAGE_APP_DSH_PAGE
      && this.activePageId !== null
      && !this.isSelectable(this.activePageId, registry, eligible)) {
      this.activePageId = PAGE_APP_DSH_PAGE
    }
    const next: PageAppClientSnapshot = {
      registry,
      eligible,
      activePageId: this.activePageId === PAGE_APP_DSH_PAGE ? null : this.activePageId,
      visitedPageIds: [...this.visitedOrder],
      activation: this.activationView(),
      failedPageIds: [...this.failed],
    }
    // Spec §14: the snapshot reference stays put until committed registry or
    // eligible-slot facts change (noise rebuilds keep the previous object).
    if (!sameSnapshot(this.state.getSnapshot(), next)) this.state.set(next)
  }

  /**
   * Whether one page can stay active: a managed row that is present, enabled,
   * not hidden, and currently eligible (spec §10.3/§10.5 fallback rules).
   */
  private isSelectable(pageId: string, registry: PageAppManagerSnapshot | null, eligible: ReadonlyMap<string, StoredEntry>): boolean {
    if (registry === null) return false
    const row = registry.entries.find(candidate => candidate.page.id === pageId)
    if (row === undefined || !row.enabled || row.hidden) return false
    return eligible.has(pageId)
  }

  /**
   * The closed authorization projection (spec §7): a surface contribution is
   * eligible only when the registry owns the row, the row is enabled, the slot
   * key equals the page id, the immutable ownerPackage equals the package
   * name, and any pending activation names the same package, page id, and
   * revision. Rows an open activation does not name exactly, and rows with
   * duplicate matching contributions, are never projected.
   */
  private authorizedProjection(registry: PageAppManagerSnapshot): Map<string, StoredEntry> {
    const entries = this.deps.slots.entries(PAGE_APP_SURFACE_SLOT)
    const map = new Map<string, StoredEntry>()
    for (const row of registry.entries) {
      if (!row.enabled) continue
      const activation = this.activation
      if (activation !== null) {
        const named = activation.packageName === row.packageName
          && activation.pageId === row.page.id
          && this.convergedRevision === activation.graphRevision
        if (!named) continue
      }
      const matches = entries.filter(entry =>
        entry.options.key === row.page.id && entry.ownerPackage === row.packageName)
      // Duplicate contributions are diagnosed but never projected (§7.4).
      if (matches.length !== 1) continue
      const contribution = matches[0]
      if (contribution === undefined) continue
      map.set(row.page.id, contribution)
    }
    return map
  }

  /** The renderable activation view (same reference while the activation facts are unchanged). */
  private activationView(): PageAppActivationView | null {
    const activation = this.activation
    const converged = this.convergedRevision === activation?.graphRevision
    const cached = this.cachedActivation
    if (cached !== null && cached.request === activation && cached.converged === converged) {
      return cached.view
    }
    const view = activation === null
      ? null
      : {
        transactionId: activation.transactionId as PageAppTransactionId,
        packageName: activation.packageName,
        pageId: activation.pageId,
        graphRevision: activation.graphRevision,
        converged,
      }
    this.cachedActivation = { request: activation, converged, view }
    return view
  }

  /** Evict one page from visited (disable/uninstall lifecycle). */
  private evict(pageId: string): void {
    this.visited.delete(pageId)
    this.failed.delete(pageId)
    this.visitedOrder = this.visitedOrder.filter(id => id !== pageId)
    if (this.activePageId === pageId) this.activePageId = PAGE_APP_DSH_PAGE
  }

  /** The initiating client acknowledges after the graph converges. */
  private async acknowledge(request: PageAppActivationRequestedEvent): Promise<void> {
    try {
      await this.deps.awaitGraphRevision(request.graphRevision)
      if (this.disposed) return
      this.convergedRevision = request.graphRevision
      this.rebuild()
      unwrap(await this.deps.remote.ackClientActivation(
        request.transactionId as PageAppTransactionId,
        this.deps.clientInstanceId,
        request.packageName,
        request.pageId,
        request.graphRevision,
      ))
    } catch {
      // A refused or failed acknowledgement is terminal for this client: the
      // host settles the gate itself (rollback on timeout) and the next
      // changed/recovery snapshot surfaces the durable state.
    } finally {
      // After disposal the shell is gone; leave the last visible state alone.
      if (!this.disposed && this.activation?.transactionId === request.transactionId) {
        this.activation = null
        this.convergedRevision = null
        this.rebuild()
      }
    }
  }

  /** Every client tracks graph convergence so the view's `converged` flag is accurate. */
  private async trackConvergence(request: PageAppActivationRequestedEvent): Promise<void> {
    try {
      await this.deps.awaitGraphRevision(request.graphRevision)
      if (this.disposed) return
      this.convergedRevision = request.graphRevision
      this.rebuild()
    } catch {
      // Convergence failure keeps the pending view; the host settles the
      // transaction on its own timeout.
    }
  }
}
