/** Verify that the active pnpm binary matches the repository version pin. */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isEntry } from './release/process.ts'

/** Read the active pnpm version; injectable so mismatch behavior stays keyless. */
export type ReadPnpmVersion = () => string

function readActivePnpmVersion(): string {
  const command = process.platform === 'win32' ? 'cmd.exe' : 'pnpm'
  const args = process.platform === 'win32' ? ['/d', '/s', '/c', 'pnpm --version'] : ['--version']
  return execFileSync(command, args, { encoding: 'utf8' }).trim()
}

/**
 * Compare `pnpm --version` with the root packageManager declaration.
 * @param root - repository root containing package.json.
 * @param readVersion - active-version reader, overridden by focused tests.
 * @returns the matching pnpm version.
 */
export function verifyPnpmVersion(
  root: string,
  readVersion: ReadPnpmVersion = readActivePnpmVersion,
): string {
  const manifest: unknown = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('package.json must contain a JSON object')
  }
  const packageManager = (manifest as Record<string, unknown>).packageManager
  if (typeof packageManager !== 'string') throw new Error('package.json must declare packageManager as pnpm@<version>')
  const match = /^pnpm@(?<version>[^\s]+)$/u.exec(packageManager)
  if (match?.groups?.version === undefined) {
    throw new Error(`package.json packageManager must be pnpm@<version>, got ${JSON.stringify(packageManager)}`)
  }
  const declared = match.groups.version
  const actual = readVersion().trim()
  if (actual !== declared) {
    throw new Error(`pnpm version mismatch: packageManager declares ${declared}, pnpm --version reported ${actual}`)
  }
  return actual
}

if (isEntry(import.meta.url)) {
  const version = verifyPnpmVersion(process.cwd())
  console.log(`pnpm version ${version} matches packageManager`)
}
