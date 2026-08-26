/**
 * Fixture spec: the example Feature package must be a valid contract-v1
 * workspace package, register its surface through the Workbench Contract
 * entry (never through the client context's slot ledger), and stay Cordis-free
 * in source and in every declared dependency (the Strict-Mode source/
 * dependency boundaries).
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { parsePageAppManifest } from '@deepseek-ai/dsh-page-app-profile'
import { verifyPageAppSourceBoundary } from '../../../../scripts/verify-page-app-source-boundary.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-page-app-fixture'
/** Repository root (this spec lives at packages/examples/page-app-fixture/tests/). */
const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../../')
const FIXTURE_DIR = 'packages/examples/page-app-fixture'
/** The client half whose contract shape this spec pins. */
const CLIENT_SOURCE_PATH = join(REPOSITORY_ROOT, FIXTURE_DIR, 'src/client/index.tsx')

function readFixturePackage(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(REPOSITORY_ROOT, FIXTURE_DIR, 'package.json'), 'utf8')) as Record<string, unknown>
}

describe('page-app fixture', () => {
  it('parses as a valid contract-v1 workspace package', () => {
    const manifest = parsePageAppManifest(PACKAGE_NAME, readFixturePackage())
    expect(manifest.schemaVersion).toBe(1)
    expect(manifest.rootEntryId).toBe('dsh-page-app-fixture-root')
    expect(manifest.id).toBe('dsh-page-app-fixture')
  })

  it('fixture registers its surface through the Workbench Contract (no ctx.slots call)', () => {
    const clientSource = readFileSync(CLIENT_SOURCE_PATH, 'utf8')
    // The fixture never reaches the client slot ledger through the context:
    // `ctx.slots` must not appear anywhere in the fixture source.
    expect(clientSource).not.toContain('ctx.slots')
    // The surface contribution goes through the Workbench Contract's single
    // entry, consumed from the injected WorkbenchContext face.
    expect(clientSource).toContain('registerWorkspaceSurface')
    expect(clientSource).toMatch(/workbench\.surfaces\.registerWorkspaceSurface/)
  })

  it('fixture source contains no cordis import and declares no cordis dependency', () => {
    // Source boundary: static imports, re-exports, require, and dynamic
    // import() of cordis / @deepseek-ai/cordis are all violations.
    const boundary = verifyPageAppSourceBoundary(REPOSITORY_ROOT, FIXTURE_DIR)
    expect(boundary.failures).toEqual([])
    // Dependency boundary: no dependency section may name cordis.
    const pkg = readFixturePackage()
    for (const section of ['dependencies', 'peerDependencies', 'devDependencies', 'optionalDependencies'] as const) {
      const value = pkg[section]
      if (typeof value !== 'object' || value === null) continue
      const names = Object.keys(value)
      expect(names).not.toContain('cordis')
      expect(names).not.toContain('@deepseek-ai/cordis')
    }
  })
})
