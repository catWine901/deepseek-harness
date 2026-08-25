/**
 * Fixture skeleton spec: the example Feature package must be a valid
 * contract-v1 workspace package whose source and declared dependencies stay
 * Cordis-free (the Strict-Mode source/dependency boundaries).
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

function readFixturePackage(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(REPOSITORY_ROOT, FIXTURE_DIR, 'package.json'), 'utf8')) as Record<string, unknown>
}

describe('page-app fixture skeleton', () => {
  it('parses as a valid contract-v1 workspace package', () => {
    const manifest = parsePageAppManifest(PACKAGE_NAME, readFixturePackage())
    expect(manifest.schemaVersion).toBe(1)
    expect(manifest.rootEntryId).toBe('dsh-page-app-fixture-root')
    expect(manifest.id).toBe('dsh-page-app-fixture')
  })

  it('stays Cordis-free in source (source boundary)', () => {
    const result = verifyPageAppSourceBoundary(REPOSITORY_ROOT, FIXTURE_DIR)
    expect(result.failures).toEqual([])
  })

  it('declares no Cordis dependency', () => {
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
