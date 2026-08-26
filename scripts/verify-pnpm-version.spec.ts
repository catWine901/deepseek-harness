import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { verifyPnpmVersion } from './verify-pnpm-version.ts'

const roots: string[] = []

function fixtureRoot(version: string): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-pnpm-version-'))
  roots.push(root)
  writeFileSync(join(root, 'package.json'), `${JSON.stringify({ packageManager: `pnpm@${version}` })}\n`)
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('pnpm version gate', () => {
  it.each([
    ['11.7.0', '11.19.0'],
    ['11.19.0', '11.7.0'],
  ])('fails when pnpm --version differs from the declared packageManager (%s vs %s)', (declared, actual) => {
    expect(() => {
      verifyPnpmVersion(fixtureRoot(declared), () => actual)
    }).toThrow(`pnpm version mismatch: packageManager declares ${declared}, pnpm --version reported ${actual}`)
  })

  it('passes when they match', () => {
    expect(verifyPnpmVersion(fixtureRoot('11.7.0'), () => '11.7.0')).toBe('11.7.0')
  })
})
