/**
 * Deterministic runtime-layer serialization for validated Managed Roots. The
 * layer is a derived, never-authoritative file: it contains only enabled
 * roots as `insert` patches, is byte-identical for equivalent input, and
 * refuses to carry `!!js` expressions or relative Loader module names.
 * @module @deepseek-ai/dsh-page-app-profile/layer
 */

import { dump } from 'js-yaml'
import type { PageAppRuntimeEntry, ValidatedManagedRoot } from './types.ts'

/** A Loader module name that points at a filesystem location, never a bare package specifier. */
const RELATIVE_NAME = /^(\.\.?[\\/]|[\\/]|[A-Za-z]:[\\/]|file:|link:)/

/** A Loader module name carrying a `scheme:` prefix. */
const SCHEME_NAME = /^[a-zA-Z][a-zA-Z0-9+.-]*:/

/**
 * The one Loader builtin scheme the managed layer may carry. The Loader
 * resolves `cordis:<name>` against its runtime builtins (`cordis:group` in
 * the shipped composition); every other scheme names a URL or external
 * resolver and is not a built-in or bare package/subpath specifier.
 */
const LOADER_BUILTIN_SCHEME = 'cordis'

/**
 * A valid bare package/subpath specifier: unscoped or scoped, no empty
 * segments, and no `.` or `..` path segment anywhere (every segment may still
 * contain dots, so dotted names like `pkg.v2` stay legal).
 */
const BARE_SPECIFIER =
  /^(?:@(?!\.{1,2}(?:\/|$))[a-zA-Z0-9._~-]+\/)?(?!\.{1,2}(?:\/|$))[a-zA-Z0-9._~-]+(?:\/(?!\.{1,2}(?:\/|$))[a-zA-Z0-9._~-]+)*$/

/** A valid Loader builtin name after `cordis:`: a single filename-safe token. */
const BUILTIN_NAME = /^[A-Za-z0-9._-]+$/

/**
 * Assert one root's entry tree is declarative and portable: every Loader
 * `name` must be a built-in (`cordis:` plus a valid builtin name) or a valid
 * bare package/subpath specifier (scoped or unscoped, no empty segments, no
 * query/fragment/whitespace), never a relative or absolute filesystem
 * location, a URL, or a foreign scheme. Nested group structure is walked
 * recursively.
 * @param entries - the root's serializable Loader entry tree.
 */
function assertBareLoaderNames(entries: readonly PageAppRuntimeEntry[]): void {
  for (const entry of entries) {
    if (entry.name !== undefined) {
      const name = entry.name
      if (RELATIVE_NAME.test(name)) {
        throw new Error(`page-app layer: relative Loader name ${JSON.stringify(name)} is not serializable`)
      }
      const scheme = SCHEME_NAME.exec(name)?.[0]?.slice(0, -1)
      if (scheme !== undefined) {
        if (scheme !== LOADER_BUILTIN_SCHEME) {
          throw new Error(`page-app layer: Loader name ${JSON.stringify(name)} uses non-builtin scheme ${JSON.stringify(scheme)}`)
        }
        if (!BUILTIN_NAME.test(name.slice(scheme.length + 1))) {
          throw new Error(`page-app layer: Loader name ${JSON.stringify(name)} has an invalid builtin name`)
        }
      } else if (!BARE_SPECIFIER.test(name)) {
        throw new Error(`page-app layer: Loader name ${JSON.stringify(name)} is not a bare package/subpath specifier`)
      }
    }
    if (entry.insert !== undefined) assertBareLoaderNames(entry.insert)
  }
}

/** Stable total order over enabled roots: package name, then root entry id. */
function compareRoots(a: ValidatedManagedRoot, b: ValidatedManagedRoot): number {
  return a.packageName < b.packageName ? -1
    : a.packageName > b.packageName ? 1
      : a.rootEntryId < b.rootEntryId ? -1
        : a.rootEntryId > b.rootEntryId ? 1
          : 0
}

/**
 * Render the deterministic runtime layer for one profile: one `insert` patch
 * per enabled Managed Root. Enabled roots are sorted by package name (then
 * root entry id) on a copy, so equivalent input in any caller order yields
 * byte-identical YAML, and input objects are only ever read. Key order inside
 * every mapping is normalized (`sortKeys`). The rendered document is scanned
 * for any `!!js` marker and rejected if found, because the layer is loaded by
 * the Loader dialect that would otherwise evaluate it.
 * @param entries - every validated Managed Root of the profile.
 * @returns the exact runtime-layer YAML document (trailing newline included).
 */
export function renderPageAppRuntimeLayer(entries: readonly ValidatedManagedRoot[]): string {
  const enabled = entries.filter(root => root.enabled).sort(compareRoots)
  for (const root of enabled) {
    assertBareLoaderNames(root.entries)
  }
  const patches = enabled.map(root => ({ insert: root.entries }))
  const rendered = dump(patches, { noRefs: true, sortKeys: true })
  if (rendered.includes('!!js')) {
    throw new Error('page-app layer: refused to serialize a !!js expression')
  }
  return rendered
}
