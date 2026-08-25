/**
 * Shared types of the Host page-app manager: the projection the Settings tab
 * reads, the health model, and the install-source vocabulary. Types only — no
 * runtime code. This subpath is the CLIENT-safe face of the manager (the
 * generated `typert.remote-client` references it), so the wire vocabulary is
 * defined here structurally and never imports Host-only packages; the host
 * side's page-app-profile types are structurally compatible.
 * @module @deepseek-ai/dsh-page-app-manager/types
 */
import type { Branded } from '@deepseek-ai/dsh-brand'

/** How a managed package's source spec was stated at install time (wire copy). */
export type PageAppSourceKind = 'registry' | 'file' | 'link' | 'tarball' | 'git'

/** Plugin configuration of the Host page-app manager (validated by the zod `Config` in `index.ts`). */
export interface PageAppManagerConfig {
  /** Host cap on the client activation acknowledgement wait, in milliseconds. */
  readonly settlementTimeoutMs?: number
}

/** Redacted source record persisted in the registry (wire copy; never carries credentials). */
export interface PageAppRegistrySource {
  readonly kind: PageAppSourceKind
  readonly display: string
}

/** The manifest page fields every registry row echoes for its installed page (wire copy). */
export interface PageAppPageFields {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly defaultOrder: number
  readonly rootEntryId: string
}

/** The immutable active-profile identity as the manager projects it (wire copy of `ActiveProfileIdentity`). */
export interface PageAppProfileIdentity {
  readonly name: string
  readonly directory: string
}

/** Durable phases of one page-app transaction journal (wire copy). */
export type PageAppJournalPhase = 'prepared' | 'staged' | 'committing'

/**
 * Projected operational state of one profile's managed set — the closed union
 * every operation view state belongs to. The Host projection derives it from
 * the durable journal phase and registry recovery facts only (no persisted
 * operation-kind field): prepared/staged → `installing`, committing → `active`,
 * a visible recovery → `recovery-required`. `removing`/`install-failed`/
 * `remove-failed` stay members of the union but current facts never produce
 * them, so a view outside the union is a projection bug.
 */
export type PageAppOperationState =
  | 'installing'
  | 'active'
  | 'removing'
  | 'install-failed'
  | 'remove-failed'
  | 'recovery-required'

/** Semantic label of one managed root's Cordis fiber state (closed union; the terminal `DISPOSED` collapses into `failed`). */
export type PageAppRuntimeStateLabel =
  | 'pending'
  | 'loading'
  | 'active'
  | 'failed'
  | 'unloading'

/**
 * Derived operational health of one managed row. Manager lifecycle state and
 * Cordis runtime state are separate dimensions (spec §18); this view combines
 * them for display while the underlying data model keeps them distinct.
 */
export type PageAppHealth =
  | 'ready'
  | 'disabled'
  | 'missing-dependency'
  | 'version-drift'
  | 'invalid-manifest'
  | 'missing-manager'
  | 'activation-failed'
  | 'externally-overridden'
  | 'recovery-required'

/** One registry row joined with its derived health, as Settings reads it. */
export interface PageAppView {
  readonly packageName: string
  readonly source: PageAppRegistrySource
  readonly resolvedVersion: string
  readonly page: PageAppPageFields
  readonly order: number
  readonly enabled: boolean
  readonly hidden: boolean
  readonly installedAt: string
  readonly updatedAt: string
  readonly health: PageAppHealth
  /** Loader fiber state label of the managed root, when the row maps to one. */
  readonly runtimeState?: PageAppRuntimeStateLabel
  /** One-line failure summary when the row is unhealthy. */
  readonly lastError?: string
}

/** In-flight mutation visibility projected from the durable journal and registry recovery facts. */
export interface PageAppOperationView {
  /** Projected operational state (closed `PageAppOperationState` union). */
  readonly state: PageAppOperationState
  /** Durable journal phase, present when a journal explains the state. */
  readonly phase?: PageAppJournalPhase
}

/** Startup or rollback recovery visibility. */
export interface PageAppRecoveryView {
  /** Actionable recovery message. */
  readonly message: string
}

/** Immutable projection of the whole managed set for one profile. */
export interface PageAppManagerSnapshot {
  /** The immutable active-profile identity. */
  readonly profile: PageAppProfileIdentity
  /** Registry revision (0 when no registry has been published). */
  readonly revision: number
  /** Managed rows in registry order; the registry is the sole ownership source. */
  readonly entries: readonly PageAppView[]
  /** Present while a journaled mutation is in flight. */
  readonly operation: PageAppOperationView | null
  /** Present when startup or rollback needs operator recovery. */
  readonly recovery: PageAppRecoveryView | null
}

/** One validated install-source spec, ready for pnpm. */
export interface PageAppInstallSource {
  /** The classified source kind. */
  readonly kind: PageAppSourceKind
  /** The exact validated spec handed to pnpm. */
  readonly spec: string
  /** Redacted source record the registry may persist. */
  readonly display: PageAppRegistrySource
}

/** Payload of the `page-app-manager/activation-requested` event. */
export interface PageAppActivationRequestedEvent {
  /** The transaction id the client acknowledgement must carry. */
  readonly transactionId: string
  /** The opaque initiating client instance allowed to acknowledge. */
  readonly clientInstanceId: string
  /** The installed package name. */
  readonly packageName: string
  /** The managed page id. */
  readonly pageId: string
  /** The graph revision the client must have converged to. */
  readonly graphRevision: string
}

/** Branded transaction id (journal-visible identity of one mutation). */
export type PageAppTransactionId = Branded<'PageAppTransactionId'>

/** Branded opaque client-instance id (stable `crypto.randomUUID()` of the controller). */
export type PageAppClientInstanceId = Branded<'PageAppClientInstanceId'>

/** One pending activation the manager announces before staging. */
export interface ClientActivationRequest {
  /** The transaction this activation belongs to. */
  readonly transactionId: PageAppTransactionId
  /** The opaque initiating client instance that may acknowledge. */
  readonly clientInstanceId: PageAppClientInstanceId
  /** The installed package name. */
  readonly packageName: string
  /** The managed page id. */
  readonly pageId: string
  /** The graph revision the client must have converged to. */
  readonly graphRevision: string
}

/** Outcome of one acknowledgement attempt. */
export interface ActivationAcknowledgement {
  /** Whether this attempt settled the transaction. */
  readonly accepted: boolean
  /** Machine-readable refusal code when not accepted. */
  readonly reason?: 'stale' | 'wrong-client' | 'wrong-target' | 'already-settled'
}

declare module '@deepseek-ai/cordis' {
  interface Events {
    /**
     * The manager committed a registry change (install/enable/disable/hide/
     * reorder/uninstall published a new revision). Consumers re-read the
     * snapshot.
     * @param revision - the newly committed registry revision.
     * @mode emit
     */
    'page-app-manager/changed'(revision: number): void
    /**
     * An install staged its runtime layer and now waits for the targeted
     * client instance to acknowledge the activation.
     * @param request - transaction, client instance, package, page, and graph revision.
     * @mode emit
     */
    'page-app-manager/activation-requested'(request: PageAppActivationRequestedEvent): void
  }
}
