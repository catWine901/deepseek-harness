/**
 * Install-source parsing: classify one specifier the Settings add-flow accepts
 * into a validated pnpm source plus a redacted persisted display. Registry and
 * Git specs may be typed; local directory, `file:`, `link:`, and tarball
 * sources must come from the picker as absolute paths. Ambiguous relative
 * filesystem specs are rejected rather than resolved against Host cwd (spec
 * §10.1), and credential-bearing URLs are rejected (spec §7 / SR-07).
 * @module @deepseek-ai/dsh-page-app-manager/source
 */

import { isAbsolute } from 'node:path'
import {
  assertPageAppSourceNoCredentials,
  parsePageAppSourceDisplay,
  type PageAppSourceKind,
} from '@deepseek-ai/dsh-page-app-profile'
import type { PageAppInstallSource } from './types.ts'

/** Tarball file-name suffixes pnpm can install from a local archive. */
const TARBALL_PATTERN = /\.(?:tgz|tar\.gz)$/i

/** Scoped or plain bare package-name grammar (no version, path, or drive part). */
const BARE_PACKAGE_PATTERN = /^(?:@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/

/** Git specifier forms accepted in v1 (pnpm git source semantics). */
const GIT_PATTERN = /^(?:github:|git\+|git@|https?:\/\/.*\.git(?:[#?]|$))/

/** Scheme-prefixed registry specifier (`npm:pkg` is pnpm's explicit form). */
const NPM_SPEC_PATTERN = /^npm:/

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
  // Windows drive-letter absolute paths are caught by node:path.isAbsolute;
  // a bare package name (optionally scoped) is a registry spec.
  if (BARE_PACKAGE_PATTERN.test(spec)) return 'registry'
  throw new Error(
    `page-app install source: "${spec}" is an ambiguous relative filesystem spec — `
    + 'local directory, file:, link:, and tarball sources must come from the picker as absolute paths',
  )
}

/**
 * Validate one spec against its kind. Registry specs must stay bare package
 * names (with an optional npm: prefix); Git specs must match the accepted git
 * grammar; local kinds (file/link/tarball) must be absolute after any
 * `file:`/`link:` prefix is stripped.
 * @param kind - the classified or caller-typed kind.
 * @param spec - the spec to validate.
 * @throws {Error} when the spec does not satisfy the kind's grammar.
 */
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

/**
 * Parse one install source spec into a validated, redacted source record.
 * Registry and Git specs may be typed explicitly by the caller; local kinds
 * are always validated as absolute picker-backed paths.
 * @param spec - the raw specifier from the Settings add-flow.
 * @param kind - optional explicit kind; when omitted the spec is classified.
 * @returns the immutable validated install source.
 * @throws {Error} for credential-bearing URLs, empty specs, kind mismatches,
 * or ambiguous relative filesystem specs.
 */
export function parsePageAppInstallSource(spec: string, kind?: PageAppSourceKind): PageAppInstallSource {
  assertPageAppSourceNoCredentials(spec)
  const trimmed = spec.trim()
  if (trimmed === '') throw new Error('page-app install source: spec is empty')
  const resolvedKind = kind ?? classify(trimmed)
  validateKindSpec(resolvedKind, trimmed)
  return Object.freeze({
    kind: resolvedKind,
    spec: trimmed,
    display: parsePageAppSourceDisplay(resolvedKind, trimmed),
  })
}
