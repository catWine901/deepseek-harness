/**
 * Cordis Compatibility Adapter: Manager product code touches Cordis only
 * through `src/adapter.ts` or the explicit removable rc2 bootstrap. These
 * tests pin each adapter delegation against
 * the vendored Cordis surface it wraps — canonical managed-root hash, Include
 * patch composition, Loader row lookup, fiber-state projection — and pin the
 * import gate that keeps every other Manager product file Cordis-free at
 * runtime (only a type-only `Context` import may leave the adapter).
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { canonicalManagedRootHash } from '@deepseek-ai/dsh-app-boot'
import { applyEntryPatches } from '@deepseek-ai/cordis-plugin-include'
import {
  composePatchRows,
  fiberStateOf,
  findLoaderRow,
  managedRootHash,
  type LoaderLike,
  type LoaderRow,
} from '../src/adapter.ts'

const ROOT_ID = 'workspace.managed'
const ROOT_ROW = { id: ROOT_ID, name: '@fixture/managed-workspace/client', config: { value: 1 } }

// --- Cordis import gate ----------------------------------------------------

/** Every Cordis package whose runtime surface must live behind the adapter. */
const FORBIDDEN_SPECIFIERS = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/cordis-plugin-loader',
  '@deepseek-ai/cordis-plugin-include',
] as const

/** Auditable framework-boundary files allowed to runtime-import Cordis. */
const ADAPTER_FILES = new Set(['src/adapter.ts', 'src/legacy-rc2-compat.ts'])

function isForbidden(specifier: string): boolean {
  return (FORBIDDEN_SPECIFIERS as readonly string[]).includes(specifier)
}

/** Whether an import clause is the one permitted exception (type-only Context). */
function isPermittedContextTypeImport(specifier: string, clause: ts.ImportClause | undefined): boolean {
  if (specifier !== '@deepseek-ai/cordis') return false
  if (clause === undefined || clause.name !== undefined) return false
  const bindings = clause.namedBindings
  if (bindings === undefined || !ts.isNamedImports(bindings) || bindings.elements.length === 0) return false
  // A value import with any non-type element loads the module at runtime.
  if (clause.phaseModifier !== ts.SyntaxKind.TypeKeyword && bindings.elements.some(element => !element.isTypeOnly)) return false
  return bindings.elements.every(element => element.name.text === 'Context')
}

/** Whether an export clause is the one permitted exception (type-only Context). */
function isPermittedContextExport(specifier: string, clause: ts.NamedExportBindings | undefined): boolean {
  if (specifier !== '@deepseek-ai/cordis') return false
  if (clause === undefined || !ts.isNamedExports(clause) || clause.elements.length === 0) return false
  return clause.elements.every(element => element.name.text === 'Context')
}

/**
 * Collect every Cordis runtime import outside `src/adapter.ts` across the
 * given product files. Imports are classified on the parsed AST — import kind,
 * inline `type` specifiers, side-effect imports, re-exports, dynamic
 * `import()`, `require()`, and import-equals — so a rewritten or multiline
 * form is caught exactly like the canonical one, never by a source-line match.
 * @param files - product files (repository-relative path + source text).
 * @returns one human-readable violation per offending import, sorted.
 */
function collectCordisImportViolations(files: ReadonlyArray<{ file: string; content: string }>): string[] {
  const violations: string[] = []
  for (const { file, content } of files) {
    if (ADAPTER_FILES.has(file)) continue
    const source = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node)) {
        const specifier = node.moduleSpecifier
        if (ts.isStringLiteral(specifier) && isForbidden(specifier.text)
          && !isPermittedContextTypeImport(specifier.text, node.importClause)) {
          violations.push(`${file}: ${node.importClause === undefined ? 'side-effect import' : 'import'} of ${specifier.text}`)
        }
      } else if (ts.isExportDeclaration(node)) {
        const specifier = node.moduleSpecifier
        if (specifier !== undefined && ts.isStringLiteral(specifier) && isForbidden(specifier.text)
          && !(node.isTypeOnly && isPermittedContextExport(specifier.text, node.exportClause))) {
          violations.push(`${file}: re-export of ${specifier.text}`)
        }
      } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
        const specifier = node.moduleReference.expression
        if (ts.isStringLiteral(specifier) && isForbidden(specifier.text)) {
          violations.push(`${file}: import-equals of ${specifier.text}`)
        }
      } else if (ts.isCallExpression(node)) {
        const argument = node.arguments[0]
        if (ts.isIdentifier(node.expression) && node.expression.text === 'require' && argument !== undefined
          && ts.isStringLiteral(argument) && isForbidden(argument.text)) {
          violations.push(`${file}: require(${argument.text})`)
        } else if (node.expression.kind === ts.SyntaxKind.ImportKeyword && argument !== undefined
          && ts.isStringLiteral(argument) && isForbidden(argument.text)) {
          violations.push(`${file}: dynamic import(${argument.text})`)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  return violations.sort()
}

/** Every Manager product file, repository-relative, as text. */
function managerProductFiles(): Array<{ file: string; content: string }> {
  return readdirSync(join(import.meta.dirname, '..', 'src'), { recursive: true })
    .filter((entry): entry is string => typeof entry === 'string')
    .filter(entry => entry.endsWith('.ts'))
    .sort()
    .map(entry => ({
      file: `src/${entry.replaceAll('\\', '/')}`,
      content: readFileSync(join(import.meta.dirname, '..', 'src', entry), 'utf8'),
    }))
}

const probe = (content: string): string[] =>
  collectCordisImportViolations([{ file: 'src/probe.ts', content }])

describe('managedRootHash', () => {
  it('matches the canonical managed-root hash', () => {
    expect(managedRootHash(ROOT_ROW)).toBe(canonicalManagedRootHash(ROOT_ROW))
  })

  it('is key-order-insensitive exactly like the canonical hash', () => {
    const reordered = { config: { value: 1 }, name: '@fixture/managed-workspace/client', id: ROOT_ID }
    expect(managedRootHash(reordered)).toBe(managedRootHash(ROOT_ROW))
  })
})

describe('composePatchRows', () => {
  it('composes patches exactly as Include mounts a layer', () => {
    const patches = [
      { insert: [{ id: ROOT_ID, name: '@fixture/p/client', config: { value: 1 } }] },
      { id: ROOT_ID, config: { value: 2, extra: true } },
    ]
    const warnings: string[] = []
    expect(composePatchRows(patches, (message) => { warnings.push(message) }))
      .toEqual(applyEntryPatches([], structuredClone(patches), () => {}))
    expect(warnings).toEqual([])
  })

  it('reports skipped patches through the warn sink exactly like Include', () => {
    const patches = [
      { insert: [{ id: ROOT_ID, name: '@fixture/p/client' }] },
      { id: 'ghost-target', config: { x: 1 } },
    ]
    const warnings: string[] = []
    const composed = composePatchRows(patches, (message) => { warnings.push(message) })
    expect(composed).toEqual([{ id: ROOT_ID, name: '@fixture/p/client' }])
    expect(warnings.length).toBeGreaterThan(0)
  })

  it('never mutates the input patch list (a later patch may reconfigure an earlier-inserted row)', () => {
    const patches = [
      { insert: [{ id: ROOT_ID, name: '@fixture/p/client', config: { value: 1 } }] },
      { id: ROOT_ID, config: { value: 2 } },
    ]
    const snapshot = structuredClone(patches)
    composePatchRows(patches)
    expect(patches).toEqual(snapshot)
  })

  it('composes an empty patch list to an empty root', () => {
    expect(composePatchRows(undefined)).toEqual([])
  })
})

describe('findLoaderRow', () => {
  it('finds the loader row by rootEntryId through loader.entries()', () => {
    const target: LoaderRow = { options: ROOT_ROW, fiber: { state: 2 } }
    const other: LoaderRow = { options: { id: 'unrelated', name: '@fixture/other' } }
    const loader: LoaderLike = { entries: () => [other, target] }
    expect(findLoaderRow(loader, ROOT_ID)).toBe(target)
  })

  it('returns undefined when no loader row carries the rootEntryId', () => {
    const loader: LoaderLike = { entries: () => [{ options: { id: 'unrelated', name: '@fixture/other' } }] }
    expect(findLoaderRow(loader, ROOT_ID)).toBeUndefined()
  })
})

describe('fiberStateOf', () => {
  it('projects the numeric fiber state of a loader row', () => {
    expect(fiberStateOf({ options: ROOT_ROW, fiber: { state: 2 } })).toBe(2)
  })

  it('returns undefined for a row without a fiber', () => {
    expect(fiberStateOf({ options: ROOT_ROW })).toBeUndefined()
  })

  it('returns undefined for an absent row', () => {
    expect(fiberStateOf(undefined)).toBeUndefined()
  })
})

describe('Cordis import gate', () => {
  it('keeps every Manager product file Cordis-free outside audited framework boundaries', () => {
    expect(collectCordisImportViolations(managerProductFiles())).toEqual([])
  })

  it('flags runtime imports of each Cordis package in every parsed form', () => {
    expect(probe("import { applyEntryPatches } from '@deepseek-ai/cordis-plugin-include'\n")).toHaveLength(1)
    expect(probe("import { Context } from '@deepseek-ai/cordis'\n")).toHaveLength(1)
    expect(probe("import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'\n")).toHaveLength(1)
    expect(probe("import '@deepseek-ai/cordis-plugin-include'\n")).toHaveLength(1)
    expect(probe("import('@deepseek-ai/cordis')\n")).toHaveLength(1)
    expect(probe("require('@deepseek-ai/cordis-plugin-loader')\n")).toHaveLength(1)
    expect(probe("export * from '@deepseek-ai/cordis'\n")).toHaveLength(1)
    expect(probe("export { Context } from '@deepseek-ai/cordis'\n")).toHaveLength(1)
    expect(probe("import {\n  applyEntryPatches,\n} from '@deepseek-ai/cordis-plugin-include'\n")).toHaveLength(1)
  })

  it('allows only the type-only Context import outside the adapter', () => {
    expect(probe("import type { Context } from '@deepseek-ai/cordis'\n")).toEqual([])
    expect(probe("import { type Context } from '@deepseek-ai/cordis'\n")).toEqual([])
    expect(probe("import { z } from 'zod'\n")).toEqual([])
    // Any other Cordis surface — even type-only — must go through the adapter.
    expect(probe("import type { FiberState } from '@deepseek-ai/cordis'\n")).toHaveLength(1)
    expect(probe("import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'\n")).toHaveLength(1)
    expect(probe("import { type Context, type FiberState } from '@deepseek-ai/cordis'\n")).toHaveLength(1)
  })
})
