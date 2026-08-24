/**
 * Strict-Mode source-boundary gate spec: the gate flags a Feature whose source
 * imports Cordis or whose manifest declares a Cordis dependency, passes the
 * clean fixture, and never inspects packages outside the declared scope.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { verifyPageAppSourceBoundary } from './verify-page-app-source-boundary.ts'

/** Repository root (this spec lives at scripts/verify-page-app-source-boundary.spec.ts). */
const REPOSITORY_ROOT = fileURLToPath(new URL('..', import.meta.url))

const roots: string[] = []

/** Build a temp repository root carrying the given files. */
function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-page-app-source-boundary-'))
  roots.push(root)
  for (const [relative, content] of Object.entries(files)) {
    const path = join(root, relative)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
  }
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('verifyPageAppSourceBoundary', () => {
  it('flags a fixture source importing cordis', () => {
    const root = fixture({
      'feature/src/index.ts': "import { Context } from 'cordis'\n",
    })
    const result = verifyPageAppSourceBoundary(root, 'feature')
    expect(result.failures.some(failure => failure.includes('src/index.ts'))).toBe(true)
  })

  it('flags a multiline static import of cordis', () => {
    const root = fixture({
      'feature/src/index.ts': "import {\n  type Context,\n} from 'cordis'\n",
    })
    const result = verifyPageAppSourceBoundary(root, 'feature')
    expect(result.failures.some(failure => failure.includes('src/index.ts'))).toBe(true)
  })

  it('flags a re-export of cordis', () => {
    const root = fixture({
      'feature/src/index.ts': "export { Context } from 'cordis'\n",
    })
    const result = verifyPageAppSourceBoundary(root, 'feature')
    expect(result.failures.some(failure => failure.includes('src/index.ts'))).toBe(true)
  })

  it('flags a multiline dynamic import of cordis', () => {
    const root = fixture({
      'feature/src/index.ts': "const mod = import(\n  'cordis',\n)\n",
    })
    const result = verifyPageAppSourceBoundary(root, 'feature')
    expect(result.failures.some(failure => failure.includes('src/index.ts'))).toBe(true)
  })

  it('flags a multiline require of cordis', () => {
    const root = fixture({
      'feature/src/index.ts': "const mod = require(\n  'cordis',\n)\n",
    })
    const result = verifyPageAppSourceBoundary(root, 'feature')
    expect(result.failures.some(failure => failure.includes('src/index.ts'))).toBe(true)
  })

  it('does not flag a commented-out import (dead prose)', () => {
    const root = fixture({
      'feature/src/index.ts': "// import { Context } from 'cordis'\n",
    })
    const result = verifyPageAppSourceBoundary(root, 'feature')
    expect(result.failures).toEqual([])
  })

  it('does not flag a multiline import of a non-forbidden specifier', () => {
    const root = fixture({
      'feature/src/index.ts': "import {\n  type Context,\n} from './local-module'\n",
    })
    const result = verifyPageAppSourceBoundary(root, 'feature')
    expect(result.failures).toEqual([])
  })

  it('flags a fixture package declaring a cordis dependency', () => {
    const root = fixture({
      'feature/package.json': JSON.stringify({ name: 'feature', dependencies: { cordis: '^4.0.1' } }),
    })
    const result = verifyPageAppSourceBoundary(root, 'feature')
    expect(result.failures.some(failure => failure.includes('package.json'))).toBe(true)
  })

  it('passes the clean fixture', () => {
    const result = verifyPageAppSourceBoundary(REPOSITORY_ROOT, 'packages/examples/page-app-fixture')
    expect(result.failures).toEqual([])
  })

  it('ignores non-feature packages outside the declared scope', () => {
    const root = fixture({
      'feature/src/index.ts': 'export const clean = 1\n',
      'other/src/index.ts': "import { Context } from 'cordis'\n",
    })
    const result = verifyPageAppSourceBoundary(root, 'feature')
    expect(result.failures).toEqual([])
  })
})
