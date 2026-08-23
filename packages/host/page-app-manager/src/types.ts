/**
 * Shared types of the Host page-app manager: the projection the Settings tab
 * reads, the health model, and the install-source vocabulary. Types only — no
 * runtime code — so source parsing, validation, and the service can share one
 * contract without import cycles.
 * @module @deepseek-ai/dsh-page-app-manager/types
 */

import type { ActiveProfileIdentity } from '@deepseek-ai/dsh-app-boot'
import type {
  PageAppJournalPhase, PageAppPageFields, PageAppRegistrySource, PageAppSourceKind,
} from '@deepseek-ai/dsh-page-app-profile'

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
  readonly runtimeState?: string
  /** One-line failure summary when the row is unhealthy. */
  readonly lastError?: string
}

/** In-flight mutation visibility projected from the durable journal. */
export interface PageAppOperationView {
  /** Durable journal phase (`prepared`/`staged`/`committing`). */
  readonly phase: PageAppJournalPhase
}

/** Startup or rollback recovery visibility. */
export interface PageAppRecoveryView {
  /** Actionable recovery message. */
  readonly message: string
}

/** Immutable projection of the whole managed set for one profile. */
export interface PageAppManagerSnapshot {
  /** The immutable active-profile identity. */
  readonly profile: ActiveProfileIdentity
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
