/**
 * Durable transaction journal schema v1 for page-app mutations. Every
 * mutation writes a journal plus 0600 private backup files before touching
 * owned state; the journal records the shared lock's owner token, the current
 * phase (prepared -> staged -> committing), and before-file integrity hashes,
 * so startup recovery can complete, restore, or conflict without guessing.
 * @module @deepseek-ai/dsh-page-app-profile/journal
 */

import { createHash } from 'node:crypto'
import { readFile, realpath, rm } from 'node:fs/promises'
import { dirname, isAbsolute, resolve, sep } from 'node:path'
import { z } from 'zod'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { PAGE_APP_TOKEN_PATTERN, parseStrict } from './manifest.ts'
import { resolvePageAppProfilePaths } from './paths.ts'
import type { PageAppJournalFileState, PageAppJournalPhase, PageAppJournalV1 } from './types.ts'

const journalFileStateSchema = z.discriminatedUnion('present', [
  z.object({ present: z.literal(false) }).strict().readonly(),
  z.object({ present: z.literal(true), sha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict().readonly(),
])

const journalSchema = z.object({
  schemaVersion: z.literal(1),
  phase: z.enum(['prepared', 'staged', 'committing']),
  lockOwnerToken: z.string().regex(PAGE_APP_TOKEN_PATTERN),
  files: z.record(z.string().min(1), journalFileStateSchema).readonly(),
}).strict().readonly()

/**
 * Parse and validate journal schema v1. Unknown versions, unknown phases,
 * unknown keys, and malformed file states are rejected; v1 fails closed and
 * never reads a newer format.
 * @param value - unvalidated journal content from the durable boundary.
 * @returns the immutable parsed journal.
 */
export function parsePageAppJournal(value: unknown): PageAppJournalV1 {
  return parseStrict(journalSchema, value, 'page-app journal')
}

/**
 * Resolve one journal-owned relative path and prove it stays inside the
 * profile. Paths are manager-directory-relative (for example
 * `registry.json`, or `../package.json` for the profile manifest), must not
 * be absolute, and after normalization must not escape the profile
 * directory — otherwise a crafted name could read or back up arbitrary files
 * outside the profile.
 * @param profileDir - absolute profile directory.
 * @param relative - the caller-supplied manager-relative path.
 * @returns the absolute, contained path.
 */
function resolveJournalOwnedPath(profileDir: string, relative: string): string {
  if (relative === '') {
    throw new Error('page-app journal: empty path is not a manager-relative path')
  }
  if (isAbsolute(relative) || /^[A-Za-z]:[\\/]/.test(relative)) {
    throw new Error(`page-app journal: ${JSON.stringify(relative)} is an absolute path, not a manager-relative path`)
  }
  const managerDirectory = resolve(resolvePageAppProfilePaths(profileDir).directory)
  const containment = resolve(profileDir)
  const resolved = resolve(managerDirectory, relative)
  if (resolved !== containment && !resolved.startsWith(`${containment}${sep}`)) {
    throw new Error(`page-app journal: ${JSON.stringify(relative)} escapes the profile directory`)
  }
  return resolved
}

/**
 * Prove that `resolved` (already lexically contained) does not escape the
 * profile through symlinks. The canonical profile root is compared against
 * the realpath of the deepest existing ancestor of the target, so a symlinked
 * directory or source file pointing outside is rejected before anything is
 * read or backed up.
 * @param profileDir - absolute profile directory (may itself be a symlink).
 * @param resolved - the lexically contained absolute target path.
 * @param relative - the caller-supplied path used in diagnostics.
 */
async function ensureRealpathContained(profileDir: string, resolved: string, relative: string): Promise<void> {
  let root: string
  try {
    root = await realpath(profileDir)
  } catch {
    root = resolve(profileDir)
  }
  let probe = resolved
  for (;;) {
    let real: string
    try {
      real = await realpath(probe)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        const parent = dirname(probe)
        if (parent === probe) throw error
        probe = parent
        continue
      }
      throw error
    }
    if (real !== root && !real.startsWith(`${root}${sep}`)) {
      throw new Error(`page-app journal: ${JSON.stringify(relative)} resolves outside the profile directory`)
    }
    return
  }
}

/**
 * Snapshot the before-state of owned files under the profile: an sha256 hash
 * for every present file plus a 0600 private backup copy, and an absent
 * marker for files that do not exist. Backups and hashes are taken before any
 * mutation and before the journal itself is written. Paths are
 * manager-relative, must stay inside the profile directory lexically, and
 * must not escape it through symlinks.
 * @param profileDir - absolute profile directory.
 * @param relativePaths - manager-relative file paths to snapshot.
 * @returns the frozen file-state record for the journal.
 */
export async function snapshotPageAppJournalFiles(
  profileDir: string,
  relativePaths: readonly string[],
): Promise<Readonly<Record<string, PageAppJournalFileState>>> {
  const files: Record<string, PageAppJournalFileState> = {}
  for (const relative of relativePaths) {
    const absolute = resolveJournalOwnedPath(profileDir, relative)
    await ensureRealpathContained(profileDir, absolute, relative)
    let content: string | null
    try {
      content = await readFile(absolute, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') content = null
      else throw error
    }
    if (content === null) {
      files[relative] = Object.freeze({ present: false })
      continue
    }
    files[relative] = Object.freeze({
      present: true,
      sha256: createHash('sha256').update(content).digest('hex'),
    })
    await writeFileAtomic(`${absolute}.backup`, content, { mode: 0o600, dirMode: 0o700 })
  }
  return Object.freeze(files)
}

/**
 * Advance a journal to its next phase. Only the strictly forward transitions
 * prepared -> staged -> committing are legal; any other transition throws,
 * because recovery interprets the phase order as the durable commit order.
 * @param journal - the current journal.
 * @param phase - the next phase.
 * @returns a new immutable journal at the requested phase.
 */
export function advancePageAppJournalPhase(journal: PageAppJournalV1, phase: PageAppJournalPhase): PageAppJournalV1 {
  const order: Readonly<Record<PageAppJournalPhase, number>> = { prepared: 0, staged: 1, committing: 2 }
  if (order[phase] !== order[journal.phase] + 1) {
    throw new Error(`page-app journal: cannot advance phase ${journal.phase} -> ${phase}`)
  }
  return Object.freeze({ ...journal, phase })
}

/**
 * Validate and atomically write the transaction journal with owner-only
 * permissions. Invalid journals are refused before any file is created.
 * @param profileDir - absolute profile directory.
 * @param journal - the journal value to persist.
 */
export async function writePageAppJournal(profileDir: string, journal: PageAppJournalV1): Promise<void> {
  const validated = parsePageAppJournal(journal)
  const paths = resolvePageAppProfilePaths(profileDir)
  await writeFileAtomic(paths.journal, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
}

/**
 * Read and parse the active transaction journal, or null when no journal
 * exists. A journal that exists but cannot be parsed throws — recovery must
 * fail closed on an unreadable journal.
 * @param profileDir - absolute profile directory.
 * @returns the parsed journal, or null when the file is absent.
 */
export async function readPageAppJournal(profileDir: string): Promise<PageAppJournalV1 | null> {
  const paths = resolvePageAppProfilePaths(profileDir)
  let raw: string
  try {
    raw = await readFile(paths.journal, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  return parsePageAppJournal(JSON.parse(raw))
}

/**
 * Remove the active transaction journal after a committed operation.
 * @param profileDir - absolute profile directory.
 */
export async function removePageAppJournal(profileDir: string): Promise<void> {
  const paths = resolvePageAppProfilePaths(profileDir)
  await rm(paths.journal, { force: true })
}
