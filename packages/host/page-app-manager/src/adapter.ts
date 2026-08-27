/**
 * Cordis Compatibility Adapter — the audited ordinary Cordis boundary inside
 * Manager product code. Include is a runtime import; Cordis Context and Loader
 * entry shapes are type-only, while the live Loader service is obtained
 * structurally from the Host context. Every Workbench concern that reads
 * Cordis state (managed-root hashing, include patch composition and parsing,
 * Loader row lookup, fiber projection) is delegated here, so an API change
 * lands in one file. The explicitly named legacy rc.2 bridge is the only other
 * audited framework boundary. The adapter spec pins each delegation against
 * its vendored surface and keeps the rest of `src/` Cordis-free at runtime.
 * @module @deepseek-ai/dsh-page-app-manager/adapter
 */

import { canonicalManagedRootHash } from '@deepseek-ai/dsh-app-boot/profile-runtime-bridge'
import { applyEntryPatches, entryListSchema, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import type { Context } from '@deepseek-ai/cordis'
import { load } from 'js-yaml'
import type { PageAppRuntimeStateLabel } from './types.ts'

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

/** The Loader surface the Feature Runtime Wrapper mounts children through. */
export interface LoaderCreateLike {
  create(options: EntryOptions): Promise<string>
  remove(id: string): Promise<void>
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

/** The `FiberState` member values; Cordis's const enum has no runtime object (mirrored like app-boot). */
const FIBER_STATE_PENDING = 0
const FIBER_STATE_LOADING = 1
const FIBER_STATE_ACTIVE = 2
const FIBER_STATE_FAILED = 3
const FIBER_STATE_DISPOSED = 4
const FIBER_STATE_UNLOADING = 5

/**
 * Whether one projected fiber state is ACTIVE. Workbench concern: the `ready`
 * health requires the mounted wrapper row to be active, not merely present;
 * Cordis mechanism: `FiberState.ACTIVE` — the const enum has no runtime
 * object, so the numeric value is mirrored here exactly as app-boot mirrors it.
 * @param state - the projected numeric fiber state.
 * @returns true only for the ACTIVE state.
 */
export function isActiveFiberState(state: number | undefined): boolean {
  return state === FIBER_STATE_ACTIVE
}

/**
 * Project one projected fiber state to its semantic label. Workbench concern:
 * the `runtimeState` health surface; Cordis mechanism: the `FiberState` enum —
 * a const enum with no runtime object, so the member values are mirrored here
 * member-by-member, never reverse-looked-up; `DISPOSED` (a terminal state)
 * collapses into `failed` until the next generation remounts the root.
 * @param state - the projected numeric fiber state.
 * @returns the semantic label, or undefined for an unknown or absent state.
 */
export function fiberStateLabelOf(state: number | undefined): PageAppRuntimeStateLabel | undefined {
  switch (state) {
    case FIBER_STATE_PENDING: return 'pending'
    case FIBER_STATE_LOADING: return 'loading'
    case FIBER_STATE_ACTIVE: return 'active'
    case FIBER_STATE_FAILED: return 'failed'
    case FIBER_STATE_DISPOSED: return 'failed'
    case FIBER_STATE_UNLOADING: return 'unloading'
    default: return undefined
  }
}

/**
 * Read the already-composed feature rows of one wrapper entry. Workbench
 * concern: the Feature Runtime Wrapper mounting its `insert` children — the
 * rows the runtime layer nested under the wrapper parent row; Cordis
 * mechanism: the loader `Entry` carrying the layer's full options (including
 * `insert`) on `ctx.fiber.entry`, so the wrapper mounts exactly what the
 * manager staged.
 * @param ctx - the wrapper plugin's context (its fiber owns the loader entry).
 * @returns the mounted child rows, or undefined when the entry carries none.
 */
export function wrapperChildrenOf(ctx: Context): EntryOptions[] | undefined {
  const entry = (ctx.fiber as unknown as { entry?: { options?: { insert?: EntryOptions[] } } }).entry
  const children = entry?.options?.insert
  return Array.isArray(children) && children.length > 0 ? children : undefined
}

/**
 * Mount one wrapper entry's feature rows as Loader entries. Workbench concern:
 * the Feature Runtime Wrapper parent mounting its already-composed children so
 * each keeps its own Loader entry and fiber; Cordis mechanism: `Loader.create`
 * — the loader service the wrapper's context inherits — with each child row
 * created as an independent entry. The returned disposer removes every mounted
 * child in reverse mount order.
 * @param ctx - the wrapper plugin's context (inherits the Loader service).
 * @param children - the feature rows to mount.
 * @returns a disposer that removes the mounted children.
 * @throws {Error} when the Loader service is unavailable.
 */
export async function mountWrapperChildren(ctx: Context, children: readonly EntryOptions[]): Promise<() => Promise<void>> {
  const loader = ctx.get('loader') as LoaderCreateLike | undefined
  if (loader === undefined) {
    throw new Error('page-app wrapper: the Loader service is unavailable to mount feature rows')
  }
  const mounted: string[] = []
  for (const child of children) {
    mounted.push(await loader.create({ ...child }))
  }
  return async () => {
    for (const id of mounted.splice(0).reverse()) {
      await loader.remove(id)
    }
  }
}
