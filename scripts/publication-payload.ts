/** Publication payload policy shared by static manifests and packed tarballs. */

import { execFileSync } from 'node:child_process'

/** A tarball member reader supplied by the archive boundary or a focused test. */
export type TarballMemberReader = (member: string) => string | Buffer

/** Select tarball members whose contents are meaningful to scan. */
export type TarballMemberFilter = (member: string) => boolean

const WINDOWS_ABSOLUTE_PATH = /(?:^|[^A-Za-z0-9])(?<path>[A-Za-z]:[\\/](?:[^\\/\s"'`]+[\\/])?)/m
const POSIX_ABSOLUTE_PATH = /\/(?:Users|home)\//

/**
 * Whether a package manifest exports generated Host-for-Client metadata.
 * @param manifest - parsed package manifest to inspect.
 * @returns whether the canonical `./remote` export pair is present.
 */
export function hasTypertRemoteNavigation(manifest: unknown): boolean {
  if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) return false
  const exportsField = (manifest as Record<string, unknown>).exports
  if (exportsField === null || typeof exportsField !== 'object' || Array.isArray(exportsField)) return false
  const remote = (exportsField as Record<string, unknown>)['./remote']
  if (remote === null || typeof remote !== 'object' || Array.isArray(remote)) return false
  const entry = remote as Record<string, unknown>
  return entry.types === './lib/typert.remote-client.d.ts'
    && entry.default === './lib/typert.remote-client.js'
}

/** Normalize a package manifest path or npm tarball member to its payload-relative path. */
function payloadPath(file: string): string {
  const normalized = file.replaceAll('\\', '/').replace(/^\.\/+/, '').replace(/\/+$/, '')
  return normalized.startsWith('package/') ? normalized.slice('package/'.length) : normalized
}

/**
 * Whether a package payload path exposes source or map intermediates. Maps
 * serve editor navigation during development, where a workspace consumer
 * resolves their source through the package link; a published map resolves
 * nothing, so no payload publishes one.
 * @param file - manifest path or tarball member to classify.
 * @returns whether publishing this path is forbidden.
 */
export function isForbiddenPublicationFile(file: string): boolean {
  const normalized = payloadPath(file)
  return normalized === 'src'
    || normalized.startsWith('src/')
    || normalized.endsWith('.d.ts.map')
    || normalized.endsWith('.js.map')
}

/**
 * Reject source and map members in a packed npm tarball.
 * @param files - tarball members to validate.
 * @param context - tarball identity named in the failure.
 */
export function validateTarballPayload(files: readonly string[], context: string): void {
  for (const file of files) {
    if (!isForbiddenPublicationFile(file)) continue
    const normalized = payloadPath(file)
    if (normalized === 'src' || normalized.startsWith('src/')) {
      throw new Error(`${context} publishes source file ${file}`)
    }
    throw new Error(`${context} publishes source map ${file}`)
  }
}

/**
 * Reject archive members whose contents embed a developer-machine absolute
 * path. The scan reports only the root prefix so release logs do not copy the
 * rest of a local path.
 * @param files - tarball members to inspect.
 * @param readMember - reader returning one member's bytes.
 * @param context - tarball identity named in the failure.
 */
export function validateTarballPayloadContent(
  files: readonly string[],
  readMember: TarballMemberReader,
  context: string,
): void {
  for (const file of files) {
    const content = readMember(file).toString()
    const windows = WINDOWS_ABSOLUTE_PATH.exec(content)?.groups?.path
    const absolutePath = windows ?? POSIX_ABSOLUTE_PATH.exec(content)?.[0]
    if (absolutePath !== undefined) {
      throw new Error(`${context} member ${file} contains absolute path ${absolutePath}`)
    }
  }
}

/**
 * Read and scan the selected members of a packed npm tarball.
 * @param tarballPath - absolute path to the packed tarball.
 * @param memberFilter - selects files to read; directory entries should be excluded.
 */
export function scanTarballContent(tarballPath: string, memberFilter: TarballMemberFilter): void {
  const files = execFileSync('tar', ['-tzf', tarballPath], { encoding: 'utf8' })
    .split(/\r?\n/u)
    .filter(file => file !== '' && memberFilter(file))
  validateTarballPayloadContent(
    files,
    member => execFileSync('tar', ['-xOzf', tarballPath, member]),
    tarballPath,
  )
}
