// Test-local programmable fakes for the page-app controller suites: a fake
// `pageAppManager` remote namespace (programmable responses + emitable events),
// a fake slot ledger seam, and snapshot/row/entry fixtures.
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  PageAppActivationRequestedEvent, PageAppClientInstanceId, PageAppInstallSource,
  PageAppManagerSnapshot, PageAppTransactionId, PageAppView,
} from '@deepseek-ai/dsh-page-app-manager/types'
import type {
  PageAppManagerRemoteMethods, PageAppRemoteEvents, PageAppRemoteResult, PageAppSlotsSeam,
} from '../src/client/contracts.ts'

export interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

/** Test-held settlement: the case decides when an awaited step lands. */
export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

export function ok<T>(value: T): PageAppRemoteResult<T> {
  return { ok: true as const, value }
}

export function err<T>(code: string, message: string): PageAppRemoteResult<T> {
  return { ok: false as const, error: { code, message } }
}

/** One minimal registry row with derived health already filled. */
export function fakeRow(over: Partial<PageAppView> & { packageName: string; pageId: string }): PageAppView {
  return {
    source: { kind: 'registry', display: 'example-workspace@1.0.0' },
    resolvedVersion: '1.0.0',
    page: {
      id: over.pageId,
      name: over.pageId,
      description: `page ${over.pageId}`,
      defaultOrder: 1,
      rootEntryId: `root-${over.pageId}`,
    },
    order: 1,
    enabled: true,
    hidden: false,
    installedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    health: 'ready',
    ...over,
  }
}

/** One immutable snapshot with the given rows. */
export function fakeSnapshot(entries: readonly PageAppView[], revision = 1): PageAppManagerSnapshot {
  return {
    profile: { name: 'default', directory: 'C:/profiles/default' },
    revision,
    entries,
    operation: null,
    recovery: null,
  }
}

/** One ledger contribution with the given key/owner (options keyed by slot id). */
export function fakeEntry(key: string, ownerPackage: string | undefined, over: Partial<StoredEntry> = {}): StoredEntry {
  return {
    component: () => null,
    options: Object.freeze({ key }),
    ...(ownerPackage === undefined ? {} : { ownerPackage }),
    ...over,
  }
}

/** A programmable `pageAppManager` remote namespace with event emission. */
export class FakeRemote implements PageAppManagerRemoteMethods, PageAppRemoteEvents {
  /** Chronological Remote method call record: [method, args]. */
  readonly calls: { method: string; args: unknown[] }[] = []

  onList: () => Promise<PageAppRemoteResult<PageAppManagerSnapshot>> = () => Promise.resolve(ok(fakeSnapshot([])))
  onInstall: (source: PageAppInstallSource, clientInstanceId: PageAppClientInstanceId, signal: AbortSignal) =>
  Promise<PageAppRemoteResult<number>> = () => Promise.resolve(ok(2))
  onSetEnabled: (pageId: string, enabled: boolean, signal: AbortSignal) =>
  Promise<PageAppRemoteResult<number>> = () => Promise.resolve(ok(2))
  onSetHidden: (pageId: string, hidden: boolean) => Promise<PageAppRemoteResult<number>> = () => Promise.resolve(ok(2))
  onReorder: (pageIds: readonly string[]) => Promise<PageAppRemoteResult<number>> = () => Promise.resolve(ok(2))
  onUninstall: (pageId: string, signal: AbortSignal) => Promise<PageAppRemoteResult<number>> = () => Promise.resolve(ok(2))
  onAckClientActivation: (
    transactionId: PageAppTransactionId, clientInstanceId: PageAppClientInstanceId,
    packageName: string, pageId: string, graphRevision: string,
  ) => Promise<PageAppRemoteResult<{ accepted: boolean; reason?: string }>> = () => Promise.resolve(ok({ accepted: true }))
  onRecover: () => Promise<PageAppRemoteResult<{ action: string; message?: string }>> =
    () => Promise.resolve(ok({ action: 'none' }))

  private readonly changed = new Set<(revision: number) => void>()
  private readonly activations = new Set<(request: PageAppActivationRequestedEvent) => void>()

  public list(): Promise<PageAppRemoteResult<PageAppManagerSnapshot>> {
    this.calls.push({ method: 'list', args: [] })
    return this.onList()
  }

  public installPackage(
    source: PageAppInstallSource,
    clientInstanceId: PageAppClientInstanceId,
    signal: AbortSignal,
  ): Promise<PageAppRemoteResult<number>> {
    this.calls.push({ method: 'installPackage', args: [source, clientInstanceId, signal] })
    return this.onInstall(source, clientInstanceId, signal)
  }

  public setEnabled(pageId: string, enabled: boolean, signal: AbortSignal): Promise<PageAppRemoteResult<number>> {
    this.calls.push({ method: 'setEnabled', args: [pageId, enabled, signal] })
    return this.onSetEnabled(pageId, enabled, signal)
  }

  public setHidden(pageId: string, hidden: boolean): Promise<PageAppRemoteResult<number>> {
    this.calls.push({ method: 'setHidden', args: [pageId, hidden] })
    return this.onSetHidden(pageId, hidden)
  }

  public reorder(pageIds: readonly string[]): Promise<PageAppRemoteResult<number>> {
    this.calls.push({ method: 'reorder', args: [pageIds] })
    return this.onReorder(pageIds)
  }

  public uninstall(pageId: string, signal: AbortSignal): Promise<PageAppRemoteResult<number>> {
    this.calls.push({ method: 'uninstall', args: [pageId, signal] })
    return this.onUninstall(pageId, signal)
  }

  public ackClientActivation(
    transactionId: PageAppTransactionId, clientInstanceId: PageAppClientInstanceId,
    packageName: string, pageId: string, graphRevision: string,
  ): Promise<PageAppRemoteResult<{ accepted: boolean; reason?: string }>> {
    this.calls.push({ method: 'ackClientActivation', args: [transactionId, clientInstanceId, packageName, pageId, graphRevision] })
    return this.onAckClientActivation(transactionId, clientInstanceId, packageName, pageId, graphRevision)
  }

  public recover(): Promise<PageAppRemoteResult<{ action: string; message?: string }>> {
    this.calls.push({ method: 'recover', args: [] })
    return this.onRecover()
  }

  public $on(event: 'page-app-manager/changed', listener: (revision: number) => void): () => void
  public $on(event: 'page-app-manager/activation-requested', listener: (request: PageAppActivationRequestedEvent) => void): () => void
  public $on(event: string, listener: (value: never) => void): () => void {
    if (event === 'page-app-manager/changed') {
      this.changed.add(listener as (revision: number) => void)
      return () => { this.changed.delete(listener as (revision: number) => void) }
    }
    if (event === 'page-app-manager/activation-requested') {
      this.activations.add(listener as (request: PageAppActivationRequestedEvent) => void)
      return () => { this.activations.delete(listener as (request: PageAppActivationRequestedEvent) => void) }
    }
    return () => {}
  }

  /** Broadcast a committed-revision change. */
  public emitChanged(revision: number): void {
    for (const listener of [...this.changed]) listener(revision)
  }

  /** Broadcast one targeted activation request. */
  public emitActivation(request: PageAppActivationRequestedEvent): void {
    for (const listener of [...this.activations]) listener(request)
  }
}

/** A programmable slot ledger seam (surface-slot entries swapped by the case). */
export class FakeSlots implements PageAppSlotsSeam {
  private current: StoredEntry[] = []
  private readonly mutaters = new Set<(key: string) => void>()

  public entries(key: string): readonly StoredEntry[] {
    return key === 'page-app.shell.surface' ? this.current : []
  }

  public subscribe(key: string, fn: () => void): () => void {
    const wrapper = (mutated: string): void => { if (mutated === key) fn() }
    this.mutaters.add(wrapper)
    return () => { this.mutaters.delete(wrapper) }
  }

  public onMutate(fn: (key: string) => void): () => void {
    this.mutaters.add(fn)
    return () => { this.mutaters.delete(fn) }
  }

  /** Replace the ledger contents and notify listeners. */
  public setEntries(entries: StoredEntry[]): void {
    this.current = entries
    for (const fn of [...this.mutaters]) fn('page-app.shell.surface')
  }
}
