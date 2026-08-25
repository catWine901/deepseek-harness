/**
 * Strict-Mode source-boundary gate (design D2 / brief §45): a Workspace Apps
 * Feature must never import Cordis in source and must never declare a Cordis
 * dependency, because the Manager's Adapter absorbs Cordis changes for it.
 * The gate scans one declared Feature scope — static imports, `export … from`
 * re-exports, `require`, and dynamic `import()` of `cordis` or
 * `@deepseek-ai/cordis`, plus every package.json dependency section — and
 * ignores everything outside that scope, so non-Feature packages sharing the
 * repository are never inspected.
 *
 * Import scanning covers whole source files (code extensions only), tolerating
 * whitespace and newlines between a statement's tokens, so multiline static
 * imports, re-exports, dynamic imports, and require calls are caught. Comments
 * are stripped first: commented-out imports are dead text and never flag, and
 * prose in documentation files is never scanned. The forms are anchored to
 * statement/expression positions, so ordinary prose cannot flag.
 *
 * Honest limit (design D2): the scan proves nothing about an arbitrary
 * prebuilt third-party artifact whose sources are unavailable; it bounds the
 * official Feature repositories where source is present.
 * @module scripts/verify-page-app-source-boundary
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { extname, join, relative, resolve, sep } from 'node:path'
import { parseArgs } from 'node:util'

/** The package names a Strict-Mode Feature must never touch (G-8). */
const FORBIDDEN_SPECIFIERS = ['cordis', '@deepseek-ai/cordis'] as const

/** Default scan scope: the real Cordis-free Feature fixture. */
const DEFAULT_SCOPE = 'packages/examples/page-app-fixture'

/** Directories that are not Feature sources (install and build outputs). */
const IGNORED_DIRECTORIES = new Set(['node_modules', 'lib', 'dist', '.git'])

/** Dependency sections of a package.json a Feature must keep Cordis-free. */
const DEPENDENCY_SECTIONS = ['dependencies', 'peerDependencies', 'devDependencies', 'optionalDependencies'] as const

/** Source file extensions the import scan applies to (prose files are never scanned). */
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'])

/**
 * The forbidden-specifier reference forms, each matching over the WHOLE file
 * so tokens may be separated by whitespace including newlines. `import` and
 * `export … from` are statements, so they anchor at a statement boundary; the
 * clause span between the keyword and `from` may cross lines but never a
 * quote or semicolon (a `;` ends the statement, so a preceding import cannot
 * reach a later `from 'cordis'`). `require` and `import()` are expressions,
 * so they anchor only against a preceding word character or dot (member calls
 * like `foo.require(` are not the module require). Each form captures the
 * forbidden specifier as group 1.
 */
const FORBIDDEN_REFERENCE_FORMS = [
  // side-effect import 'cordis'
  /(?:^|[\n;{}])\s*import\s+['"](cordis|@deepseek-ai\/cordis)['"]/gm,
  // static import / re-export: import|export <clause> from 'cordis'
  /(?:^|[\n;{}])\s*(?:import|export)\s+(?:type\s+)?[^'"`;]*?from\s+['"](cordis|@deepseek-ai\/cordis)['"]/gm,
  // dynamic import('cordis')
  /(?:^|[^\w.])\s*import\s*\(\s*['"](cordis|@deepseek-ai\/cordis)['"]\s*,?\s*\)/gm,
  // require('cordis')
  /(?:^|[^\w.])\s*require\s*\(\s*['"](cordis|@deepseek-ai\/cordis)['"]\s*,?\s*\)/gm,
] as const

/** The boundary result: one diagnostic per offending source file or manifest. */
export interface PageAppSourceBoundaryResult {
  readonly failures: readonly string[]
}

/**
 * Scan one Feature scope for Cordis source imports and direct dependencies.
 * Only files under the declared scope are read; packages outside it are never
 * inspected, so unrelated repository code cannot fail the gate.
 * @param repositoryRoot - absolute repository root (resolution anchor).
 * @param scope - repository-relative Feature scope (directory or package.json),
 * defaulting to the page-app fixture.
 * @returns one `scope-relative-path:line?` diagnostic per violation.
 */
export function verifyPageAppSourceBoundary(
  repositoryRoot: string,
  scope: string = DEFAULT_SCOPE,
): PageAppSourceBoundaryResult {
  const absoluteScope = resolve(repositoryRoot, scope)
  const failures: string[] = []
  if (statSync(absoluteScope, { throwIfNoEntry: false })?.isDirectory() !== true) {
    return { failures: [`scope ${scope} is not a directory`] }
  }
  scanDirectory(repositoryRoot, absoluteScope, failures)
  return { failures }
}

function scanDirectory(repositoryRoot: string, directory: string, failures: string[]): void {
  const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name))
  for (const entry of entries) {
    const absolute = join(directory, entry.name)
    if (entry.isDirectory()) {
      if (IGNORED_DIRECTORIES.has(entry.name)) continue
      scanDirectory(repositoryRoot, absolute, failures)
      continue
    }
    if (!entry.isFile()) continue
    const relativePath = relative(repositoryRoot, absolute).split(sep).join('/')
    if (entry.name === 'package.json') {
      scanPackageManifest(relativePath, absolute, failures)
      continue
    }
    scanSourceFile(relativePath, absolute, failures)
  }
}

/**
 * Replace comments with blanks so a commented-out import is dead text, never
 * a violation. Line and column positions are preserved: block-comment
 * characters become spaces and newlines stay, so diagnostics keep real lines.
 * @param source - the raw source file content.
 * @returns the source with line and block comments blanked out.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, block => block.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, '')
}

function scanSourceFile(relativePath: string, absolute: string, failures: string[]): void {
  if (!SOURCE_EXTENSIONS.has(extname(absolute))) return
  let source: string
  try {
    source = readFileSync(absolute, 'utf8')
  } catch {
    // An unreadable file is not a source-import violation; the package build
    // and install paths surface unreadable files with their own diagnostics.
    return
  }
  const code = stripComments(source)
  for (const form of FORBIDDEN_REFERENCE_FORMS) {
    for (const match of code.matchAll(form)) {
      const specifier = match[1]
      if (specifier === undefined) continue
      const line = code.slice(0, match.index).split('\n').length
      failures.push(`${relativePath}:${line}: Feature source imports ${specifier}`)
    }
  }
}

function scanPackageManifest(relativePath: string, absolute: string, failures: string[]): void {
  let manifest: Record<string, unknown>
  try {
    manifest = JSON.parse(readFileSync(absolute, 'utf8')) as Record<string, unknown>
  } catch {
    return
  }
  for (const section of DEPENDENCY_SECTIONS) {
    const value = manifest[section]
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    for (const specifier of FORBIDDEN_SPECIFIERS) {
      if (Object.hasOwn(value, specifier)) {
        failures.push(`${relativePath}: declares a direct ${specifier} dependency (${section})`)
      }
    }
  }
}

if (import.meta.main) {
  const repositoryRoot = resolve(import.meta.dirname, '..')
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: { scope: { type: 'string' } },
  })
  const scope = values.scope ?? DEFAULT_SCOPE
  const result = verifyPageAppSourceBoundary(repositoryRoot, scope)
  if (result.failures.length > 0) {
    console.error(`verify-page-app-source-boundary: ${scope} violates Strict Mode (Cordis imports and direct dependencies are forbidden in Feature sources):`)
    for (const failure of result.failures) console.error(`  ${failure}`)
    process.exitCode = 1
  } else {
    console.log(`verify-page-app-source-boundary: ${scope} is Cordis-free.`)
  }
}
