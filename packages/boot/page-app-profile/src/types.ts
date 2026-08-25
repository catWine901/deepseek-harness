/**
 * Host-safe page-app profile types. This module carries types only — no
 * runtime code — so the schema, path, serialization, journal, and lock
 * modules can share one contract without import cycles.
 * @module @deepseek-ai/dsh-page-app-profile/types
 */

/** How a managed package's source spec was stated at install time. */
export type PageAppSourceKind = 'registry' | 'file' | 'link' | 'tarball' | 'git'

/** Owner kinds that may hold the shared profile mutation lock. */
export type PageAppLockOwnerKind = 'manager' | 'plugin-cli'

/** Durable phases of one page-app transaction journal. */
export type PageAppJournalPhase = 'prepared' | 'staged' | 'committing'

/** Redacted source record persisted in the registry; never carries credentials. */
export interface PageAppRegistrySource {
  readonly kind: PageAppSourceKind
  readonly display: string
}

/** The manifest page fields every registry row echoes for its installed page. */
export interface PageAppPageFields {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly defaultOrder: number
  readonly rootEntryId: string
}

/** One owned page-app registry row (registry schema v1). */
export interface PageAppRegistryEntry {
  readonly packageName: string
  readonly source: PageAppRegistrySource
  readonly resolvedVersion: string
  readonly page: PageAppPageFields
  readonly order: number
  readonly enabled: boolean
  readonly hidden: boolean
  readonly installedAt: string
  readonly updatedAt: string
}

/** The sole ownership authority for one profile; schemaVersion is always 1. */
export interface PageAppRegistryV1 {
  readonly schemaVersion: 1
  readonly revision: number
  readonly entries: readonly PageAppRegistryEntry[]
}

/** A parsed `dsh.workspace` manifest block joined with its owning package name. */
export interface PageAppManifest {
  readonly packageName: string
  readonly schemaVersion: 1
  readonly id: string
  readonly name: string
  readonly description: string
  readonly defaultOrder: number
  readonly rootEntryId: string
}

/** Exact profile-scoped file locations of the page-app manager. */
export interface PageAppProfilePaths {
  readonly directory: string
  readonly registry: string
  readonly runtimeLayer: string
  readonly journal: string
  readonly operationKey: string
}

/** Identity of one shared profile mutation lock holder. */
export interface PageAppLockOwner {
  readonly kind: PageAppLockOwnerKind
  readonly token: string
}

/** Durable content of the `operation.lock` file (lock schema v1). */
export interface PageAppLockPayloadV1 {
  readonly schemaVersion: 1
  readonly ownerKind: PageAppLockOwnerKind
  readonly ownerToken: string
  readonly pid: number
  readonly acquiredAt: string
}

/** One serializable Loader entry option row inside a validated Managed Root. */
export interface PageAppRuntimeEntry {
  readonly id: string
  readonly name?: string
  /**
   * Required services the entry's fiber waits for, declared verbatim in the
   * layer (the wrapper row carries `workbenchRuntime`). Opaque to the
   * renderer, which only serializes it; structurally compatible with the
   * Loader's `Inject` surface.
   */
  readonly inject?: unknown
  readonly config?: Readonly<Record<string, unknown>>
  /** Nested Loader group structure the root carries; validated recursively. */
  readonly insert?: readonly PageAppRuntimeEntry[]
}

/**
 * A statically valid Managed Root ready for layer serialization: the
 * composed top-level Loader entry tree of one managed package, treated as a
 * single lifecycle unit by the manager.
 */
export interface ValidatedManagedRoot {
  readonly packageName: string
  readonly pageId: string
  readonly rootEntryId: string
  readonly enabled: boolean
  readonly entries: readonly PageAppRuntimeEntry[]
}

/** Before-state of one owned file recorded in a transaction journal. */
export interface PageAppJournalFileState {
  readonly present: boolean
  readonly sha256?: string
}

/** Durable transaction journal (journal schema v1). */
export interface PageAppJournalV1 {
  readonly schemaVersion: 1
  readonly phase: PageAppJournalPhase
  readonly lockOwnerToken: string
  readonly files: Readonly<Record<string, PageAppJournalFileState>>
}
