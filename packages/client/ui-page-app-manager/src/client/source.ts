/**
 * Client-side install-source classifier (spec §24): one source field in the
 * Settings add-flow becomes a typed {@link PageAppInstallSource} the
 * controller hands to the generated Remote. Mirrors the Host grammar (bare
 * registry names, `npm:`, git forms, picker-backed absolute `file:`/`link:`/
 * tarball paths) with client-safe checks — no `node:path`, no credentials
 * accepted. The Host re-validates on its side; this only classifies for
 * display and transport.
 * @module @deepseek-ai/dsh-client-ui-page-app-manager/client/source
 */

import type { PageAppInstallSource, PageAppSourceKind } from '@deepseek-ai/dsh-page-app-manager/types'

/** Tarball file-name suffixes pnpm can install from a local archive. */
const TARBALL_PATTERN = /\.(?:tgz|tar\.gz)$/i

/** Scoped or plain bare package-name grammar (no version, path, or drive part). */
const BARE_PACKAGE_PATTERN = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/

/** Git specifier forms accepted in v1 (pnpm git source semantics). */
const GIT_PATTERN = /^(?:github:|git\+|git@|https?:\/\/.*\.git(?:[#?]|$))/

/** Scheme-prefixed registry specifier (`npm:pkg` is pnpm's explicit form). */
const NPM_SPEC_PATTERN = /^npm:/

/** Windows drive-letter absolute path (`C:\...` or `C:/...`). */
const WINDOWS_ABS_PATTERN = /^[a-zA-Z]:[\\/]/

/** POSIX absolute path. */
const POSIX_ABS_PATTERN = /^[/\\]/

/** Credential-bearing URLs are never accepted (spec §7). */
const CREDENTIAL_PATTERN = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/@\s]+@/

/** Whether the spec is an absolute filesystem path (Windows or POSIX). */
function isAbsolute(spec: string): boolean {
  return WINDOWS_ABS_PATTERN.test(spec) || POSIX_ABS_PATTERN.test(spec)
}

/**
 * Classify an untyped install spec into a source kind. Picker-backed local
 * sources arrive as absolute paths; typed registry/Git specs carry their own
 * grammar; anything that looks like a relative filesystem spec is rejected.
 * @param spec - the raw install spec.
 * @returns the classified kind.
 * @throws {Error} for an empty spec or an ambiguous relative filesystem spec.
 */
function classify(spec: string): PageAppSourceKind {
  if (/^file:/i.test(spec)) return 'file'
  if (/^link:/i.test(spec)) return 'link'
  if (NPM_SPEC_PATTERN.test(spec)) return 'registry'
  if (GIT_PATTERN.test(spec)) return 'git'
  if (isAbsolute(spec)) return TARBALL_PATTERN.test(spec) ? 'tarball' : 'file'
  if (BARE_PACKAGE_PATTERN.test(spec)) return 'registry'
  throw new Error(
    `page-app install source: "${spec}" is an ambiguous relative filesystem spec — `
    + 'local directory, file:, link:, and tarball sources must come from the picker as absolute paths',
  )
}

/** Validate one spec against its kind (mirrors the Host grammar). */
function validateKindSpec(kind: PageAppSourceKind, spec: string): void {
  switch (kind) {
    case 'registry': {
      const bare = NPM_SPEC_PATTERN.test(spec) ? spec.slice('npm:'.length) : spec
      if (!BARE_PACKAGE_PATTERN.test(bare)) {
        throw new Error(`page-app install source: "${spec}" is not a bare package name (registry specs cannot carry paths or aliases)`)
      }
      return
    }
    case 'git':
      if (!GIT_PATTERN.test(spec)) {
        throw new Error(`page-app install source: "${spec}" is not a supported git specifier (github:, git+https:, git@, or a .git URL)`)
      }
      return
    case 'file':
    case 'link':
    case 'tarball': {
      const pathPart = spec.replace(/^(?:file|link):/i, '')
      if (!isAbsolute(pathPart)) {
        throw new Error(`page-app install source: "${spec}" must be an absolute path (picker-backed local source)`)
      }
      if (kind === 'tarball' && !TARBALL_PATTERN.test(pathPart)) {
        throw new Error(`page-app install source: "${spec}" is not a tarball path (.tgz or .tar.gz)`)
      }
      return
    }
  }
}

/** Redacted display for the persisted source record. */
function display(kind: PageAppSourceKind, spec: string): { kind: PageAppSourceKind; display: string } {
  switch (kind) {
    case 'registry':
      return { kind, display: spec.replace(/^npm:/, '') }
    case 'file':
      return { kind, display: spec.replace(/^file:/i, '') }
    case 'link':
      return { kind, display: spec.replace(/^link:/i, '') }
    case 'git':
    case 'tarball':
      return { kind, display: spec }
  }
}

/**
 * Parse one install source spec into a typed, redacted source record.
 * @param spec - the raw specifier from the Settings add-flow.
 * @returns the immutable validated install source.
 * @throws {Error} for credential-bearing URLs, empty specs, kind mismatches,
 * or ambiguous relative filesystem specs.
 */
export function parsePageAppInstallSourceClient(spec: string): PageAppInstallSource {
  const trimmed = spec.trim()
  if (trimmed === '') throw new Error('page-app install source: spec is empty')
  if (CREDENTIAL_PATTERN.test(trimmed)) {
    throw new Error(`page-app install source: "${trimmed}" carries credentials and is rejected`)
  }
  const kind = classify(trimmed)
  validateKindSpec(kind, trimmed)
  return Object.freeze({ kind, spec: trimmed, display: display(kind, trimmed) })
}
