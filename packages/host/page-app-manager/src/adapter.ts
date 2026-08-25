/**
 * Cordis Compatibility Adapter — the sole runtime-import location for
 * `@deepseek-ai/cordis`, `@deepseek-ai/cordis-plugin-loader`, and
 * `@deepseek-ai/cordis-plugin-include` inside Manager product code. Every
 * Workbench concern that reads Cordis state (managed-root hashing, include
 * patch composition and parsing, Loader row lookup, fiber projection) is
 * delegated here, so a Cordis API change lands in one file. The adapter spec
 * pins each delegation against the vendored Cordis surface it wraps, and the
 * import gate keeps the rest of `src/` Cordis-free at runtime — only a
 * type-only `Context` import may leave the adapter.
 * @module @deepseek-ai/dsh-page-app-manager/adapter
 */

import { canonicalManagedRootHash } from '@deepseek-ai/dsh-app-boot'
import { applyEntryPatches, entryListSchema, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { load } from 'js-yaml'

export type { EntryOptions }

/** The Loader row surface the manager reads (the real Loader `Entry` satisfies it). */
export interface LoaderRow {
  readonly options: EntryOptions
  readonly fiber?: { readonly state: number } | undefined
}

/** The Loader surface the manager reads (the real Loader service satisfies it). */
export interface LoaderLike {
  entries(): Iterable<LoaderRow>
}

/**
 * Stable hash of one managed root row. Workbench concern: expected-root hashes
 * (registry audit, row health `hashMatches`); Cordis mechanism:
 * `canonicalManagedRootHash` — the canonical YAML rendering the runtime audits
 * against, so a derived row and the Loader's effective options of the same
 * content hash identically.
 * @param row - the entry row to hash.
 * @returns the hex SHA-256 digest of the canonical rendering.
 */
export function managedRootHash(row: EntryOptions): string {
  return canonicalManagedRootHash(row)
}

/**
 * Compose one patch list over an empty root. Workbench concern: the bundle
 * patch composition the manager validates and health-checks; Cordis mechanism:
 * Include's `applyEntryPatches` — the exact patch semantics a mounted include
 * layer applies, so a dump can never drift from what boots. The input list is
 * cloned first and never mutated: a later patch may reconfigure an
 * earlier-inserted row, which would otherwise bake values into the caller's
 * parsed data.
 * @param patches - the patch list to apply, in order (undefined composes an empty root).
 * @param warn - sink for skipped-patch diagnostics (a skipped target rejects validation).
 * @returns a detached entry list with every applicable patch applied.
 */
export function composePatchRows(patches: PatchOptions[] | undefined, warn?: (message: string) => void): EntryOptions[] {
  return applyEntryPatches([], structuredClone(patches), warn ?? (() => {}))
}

/**
 * Parse one loader-patch document in the include's entry-list dialect.
 * Workbench concern: the bundle `cordis.patch.yml` parse; Cordis mechanism:
 * Include's `entryListSchema` — the same `!!js` YAML dialect the include
 * mounts, so the manager's parse can never drift from what boots.
 * @param content - the patch document text.
 * @returns the parsed document (a top-level array is the patch list).
 */
export function parseEntryList(content: string): unknown {
  return load(content, { schema: entryListSchema })
}

/**
 * Find one Loader row by its root entry id. Workbench concern: the runtime
 * facts behind a row's health (`activation-failed` / `externally-overridden`);
 * Cordis mechanism: `Loader.entries()` — the flattened tree iteration, so rows
 * in nested subtrees are found exactly as the projection reads them.
 * @param loader - the Loader service (or any surface exposing `entries()`).
 * @param rootEntryId - the managed root entry id to find.
 * @returns the loader row, or undefined when no entry carries the id.
 */
export function findLoaderRow(loader: LoaderLike, rootEntryId: string): LoaderRow | undefined {
  for (const entry of loader.entries()) {
    if (entry.options.id === rootEntryId) return entry
  }
  return undefined
}

/**
 * Project the numeric fiber state of one loader row. Workbench concern: the
 * `runtimeState` health surface; Cordis mechanism: `Entry.fiber.state` — the
 * FiberState value (`PENDING`/`LOADING`/`ACTIVE`/`FAILED`/`DISPOSED`/
 * `UNLOADING`), undefined when the row has no fiber yet.
 * @param loaderRow - the loader row to project.
 * @returns the numeric FiberState, or undefined.
 */
export function fiberStateOf(loaderRow: LoaderRow | undefined): number | undefined {
  return loaderRow?.fiber?.state
}
