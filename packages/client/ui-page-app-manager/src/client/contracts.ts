/**
 * Client-side contracts of the page-app controller: the structural seam the
 * controller consumes from the generated `pageAppManager` remote namespace and
 * the slot ledger. Client-safe — no Host package imports.
 * @module @deepseek-ai/dsh-client-ui-page-app-manager/client/contracts
 */

import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  PageAppActivationRequestedEvent, PageAppClientInstanceId, PageAppInstallSource,
  PageAppManagerSnapshot, PageAppTransactionId,
} from '@deepseek-ai/dsh-page-app-manager/types'

/** The Remote result envelope the generated namespace returns. */
export type PageAppRemoteResult<T> = {
  readonly ok: true
  readonly value: T
} | {
  readonly ok: false
  readonly error: { readonly code: string; readonly message: string }
}

/** The generated `pageAppManager` namespace methods the controller calls. */
export interface PageAppManagerRemoteMethods {
  list(): Promise<PageAppRemoteResult<PageAppManagerSnapshot>>
  installPackage(
    source: PageAppInstallSource,
    clientInstanceId: PageAppClientInstanceId,
    signal: AbortSignal,
  ): Promise<PageAppRemoteResult<number>>
  setEnabled(pageId: string, enabled: boolean, signal: AbortSignal): Promise<PageAppRemoteResult<number>>
  setHidden(pageId: string, hidden: boolean): Promise<PageAppRemoteResult<number>>
  reorder(pageIds: readonly string[]): Promise<PageAppRemoteResult<number>>
  uninstall(pageId: string, signal: AbortSignal): Promise<PageAppRemoteResult<number>>
  ackClientActivation(
    transactionId: PageAppTransactionId,
    clientInstanceId: PageAppClientInstanceId,
    packageName: string,
    pageId: string,
    graphRevision: string,
  ): Promise<PageAppRemoteResult<{ accepted: boolean; reason?: string }>>
  recover(): Promise<PageAppRemoteResult<{ action: string; message?: string }>>
}

/** The forwarded lifecycle events the controller subscribes to. */
export interface PageAppRemoteEvents {
  $on(event: 'page-app-manager/changed', listener: (revision: number) => void): () => void
  $on(event: 'page-app-manager/activation-requested', listener: (request: PageAppActivationRequestedEvent) => void): () => void
}

/** The slot ledger surface the controller projects eligible contributions from. */
export interface PageAppSlotsSeam {
  /** Live entries of one slot key. */
  entries(key: string): readonly StoredEntry[]
  /** Subscribe to one slot key's registration changes. */
  subscribe(key: string, fn: () => void): () => void
  /** Observe every slot mutation (any key). */
  onMutate(fn: (key: string) => void): () => void
}

/**
 * The renderable view of one pending targeted activation (spec §7.2): the
 * shell/Settings show which package and page are activating and whether the
 * client graph already converged to the announced revision.
 */
export interface PageAppActivationView {
  /** The transaction the activation belongs to. */
  readonly transactionId: PageAppTransactionId
  /** The installed package name. */
  readonly packageName: string
  /** The managed page id. */
  readonly pageId: string
  /** The graph revision the client must have converged to. */
  readonly graphRevision: string
  /** Whether this client graph already converged to the announced revision. */
  readonly converged: boolean
}

/** The surface slot key managed packages contribute into (spec §6.1). */
export const PAGE_APP_SURFACE_SLOT = 'page-app.shell.surface'

/** The built-in DSH page id (shell-owned fallback surface; never a registry row). */
export const PAGE_APP_DSH_PAGE = 'dsh'

/** Owner share of the built-in DSH seat (the shell supplies nothing). */
export interface PageAppBuiltinOwner {
  /** Marker field: builtin owner props are intentionally empty. */
  children?: never
}

/** Owner share of one managed surface (the shell supplies nothing). */
export interface PageAppSurfaceOwner {
  /** Marker field: surface owner props are intentionally empty. */
  children?: never
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * The built-in Original DSH seat: the one permanent system surface that
     * the shell mounts unconditionally and hides (never unmounts) while a
     * managed surface is active. OCCUPIED by ui-layout's AppFrame.
     */
    'page-app.shell.builtin': { kind: 'single'; scope: 'root'; owner: PageAppBuiltinOwner }
    /**
     * One full-page managed surface per keyed page id. OCCUPIED by managed
     * packages after runtime activation; the closed authorization projection
     * (spec §7) keeps unrelated contributions invisible.
     */
    'page-app.shell.surface': { kind: 'keyed'; scope: 'root'; owner: PageAppSurfaceOwner; key: string }
  }
}
