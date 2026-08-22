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

/**
 * Assert one root's entry tree is declarative and portable: every Loader
 * `name` must be a built-in or bare package/subpath specifier, never a
 * relative or absolute filesystem location. Nested group structure is
 * walked recursively.
 * @param entries - the root's serializable Loader entry tree.
 */
function assertBareLoaderNames(entries: readonly PageAppRuntimeEntry[]): void {
  for (const entry of entries) {
    if (entry.name !== undefined && RELATIVE_NAME.test(entry.name)) {
      throw new Error(`page-app layer: relative Loader name ${JSON.stringify(entry.name)} is not serializable`)
    }
    if (entry.insert !== undefined) assertBareLoaderNames(entry.insert)
  }
}

/**
 * Render the deterministic runtime layer for one profile: one `insert` patch
 * per enabled Managed Root, in input order. Key order inside every mapping is
 * normalized (`sortKeys`), so equivalent input always yields byte-identical
 * YAML, and input objects are only ever read. The rendered document is
 * scanned for any `!!js` marker and rejected if found, because the layer is
 * loaded by the Loader dialect that would otherwise evaluate it.
 * @param entries - every validated Managed Root of the profile.
 * @returns the exact runtime-layer YAML document (trailing newline included).
 */
export function renderPageAppRuntimeLayer(entries: readonly ValidatedManagedRoot[]): string {
  const enabled = entries.filter(root => root.enabled)
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
