/**
 * Manifest and source parsing for page-app packages. `parsePageAppManifest`
 * reads the strict `dsh.workspace` v1 block from a parsed package.json;
 * `assertPageAppSourceNoCredentials` rejects install source specs that embed
 * credentials in a URL, and `parsePageAppSourceDisplay` derives the redacted
 * display the registry may persist.
 * @module @deepseek-ai/dsh-page-app-profile/manifest
 */

import { z } from 'zod'
import type { PageAppManifest, PageAppRegistrySource, PageAppSourceKind } from './types.ts'

/**
 * Parse `value` with `schema`, throwing one labeled Error whose message names
 * the failing path. Parsers across this package share this helper so every
 * durable boundary fails loud with a stable, greppable diagnostic.
 * @param schema - the strict zod schema to parse with.
 * @param value - unvalidated input from a durable or caller boundary.
 * @param label - diagnostic prefix naming the boundary (`page-app registry`).
 * @returns the validated value.
 */
export function parseStrict<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value)
  if (!result.success) {
    const issue = result.error.issues[0]
    const where = issue === undefined ? '(root)' : `${issue.path.join('.') || '(root)'}: ${issue.message}`
    throw new Error(`${label}: ${where}`)
  }
  return result.data
}

const workspaceSchema = z.object({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  defaultOrder: z.number().int(),
  rootEntryId: z.string().min(1),
}).strict().readonly()

const packageManifestSchema = z.object({
  dsh: z.object({
    workspace: workspaceSchema,
  }),
})

/**
 * Parse the `dsh.workspace` v1 block out of a parsed package.json. Sibling
 * `dsh` keys (`bundle`, `client`) are allowed; the workspace block itself is
 * strict and every text field must be non-empty.
 * @param packageName - the owning package name, joined into the result.
 * @param value - a parsed package.json (unknown at the durable boundary).
 * @returns the immutable parsed manifest.
 */
export function parsePageAppManifest(packageName: string, value: unknown): PageAppManifest {
  const parsed = parseStrict(packageManifestSchema, value, 'page-app manifest')
  return Object.freeze({
    packageName,
    schemaVersion: parsed.dsh.workspace.schemaVersion,
    id: parsed.dsh.workspace.id,
    name: parsed.dsh.workspace.name,
    description: parsed.dsh.workspace.description,
    defaultOrder: parsed.dsh.workspace.defaultOrder,
    rootEntryId: parsed.dsh.workspace.rootEntryId,
  })
}

/**
 * The one opaque-token grammar every lock owner token, lock payload, and
 * journal owner token must satisfy. Tokens are interpolated into claim and
 * quarantine file names, so separators and traversal would escape the manager
 * directory; the grammar is exactly the filename-safe set with no path
 * structure and no pure-dot names (`.`/`..` read as path pseudo-segments).
 * Callers generate opaque tokens (UUID-style); anything else is rejected at
 * every boundary that would persist or path-build with it.
 */
export const PAGE_APP_TOKEN_PATTERN = /^(?!\.{1,2}$)[A-Za-z0-9._~-]+$/

/**
 * Reject an opaque owner token that is not filename-safe. Tokens name claim
 * and quarantine files, so separators, traversal, and whitespace must fail
 * closed before any path is built or any payload is persisted.
 * @param token - the owner token to validate.
 */
export function assertSafeOpaqueToken(token: string): void {
  if (!PAGE_APP_TOKEN_PATTERN.test(token)) {
    throw new Error(`page-app: unsafe opaque owner token ${JSON.stringify(token)}`)
  }
}

/** A spec that parses as a `scheme:` URL, or null when it is not URL-shaped. */
function urlShape(spec: string): URL | null {
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(spec)) return null
  try {
    return new URL(spec)
  } catch {
    // Not a parseable URL; no credentials can be extracted, so treat as plain.
    return null
  }
}

/**
 * Reject an install source spec that embeds credentials in a URL. A URL whose
 * userinfo carries a username or password is refused outright, because
 * credentials must never be persisted; local paths and scp-style git specs
 * carry no URL credentials and pass through. Any absolute URL form — with or
 * without the `//` host separator — is inspected; only specs that actually
 * parse as URLs are checked, so package specs like `npm:pkg` and Windows
 * paths like `C:\dev\pkg` are never misclassified.
 * @param spec - the exact install source spec.
 */
export function assertPageAppSourceNoCredentials(spec: string): void {
  const url = urlShape(spec)
  if (url !== null && (url.username !== '' || url.password !== '')) {
    throw new Error('page-app manifest: source spec embeds credentials in a URL and is rejected')
  }
}

/**
 * Derive the registry-persisted source record from an install source spec.
 * The display is always redacted: URL userinfo is stripped so the persisted
 * record can never carry credentials even if a spec bypassed the validation
 * step. Only URL-shaped specs are rewritten (host-form URLs are canonicalized
 * and any userinfo is removed); local paths and scp-style git specs pass
 * through unchanged.
 * @param kind - the source kind the manager validated.
 * @param spec - the exact install source spec.
 * @returns the immutable redacted source record.
 */
export function parsePageAppSourceDisplay(kind: PageAppSourceKind, spec: string): PageAppRegistrySource {
  const url = urlShape(spec)
  let display = spec
  if (url !== null) {
    const hasUserinfo = url.username !== '' || url.password !== ''
    const hostForm = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(spec)
    if (hasUserinfo || hostForm) {
      url.username = ''
      url.password = ''
      display = url.toString()
    }
  }
  return Object.freeze({ kind, display })
}
