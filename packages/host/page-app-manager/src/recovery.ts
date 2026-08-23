/**
 * Startup transaction recovery: decide a durable journal's fate without
 * guessing. The registry file is the commit marker — the transaction publishes
 * it only at the commit boundary, so its state against the journal's recorded
 * before-state decides the outcome:
 *
 * - registry changed and the journal reached `committing` → the commit
 *   completed; finish it by removing the journal (complete-commit).
 * - registry unchanged → no commit happened; restore every recorded
 *   before-state (backups), run the inverse/convergence pnpm path, and remove
 *   the journal (restore-before-state).
 * - registry changed at any earlier phase, or the registry is unreadable, or
 *   both recorded sides changed in a way the phase cannot explain → fail
 *   closed with recovery-required (never guess).
 *
 * The dead-owner lock takeover lives in the profile core
 * (`recoverOrphanedPageAppLock`); this module runs after it, inside the
 * manager's recovery operation.
 * @module @deepseek-ai/dsh-page-app-manager/recovery
 */

import { createHash } from 'node:crypto'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  readPageAppJournal,
  removePageAppJournal,
  resolvePageAppProfilePaths,
} from '@deepseek-ai/dsh-page-app-profile'
import type { PageAppPackageExecutor } from './executor.ts'

/** The recovery decision for one profile. */
export type PageAppRecoveryAction = 'none' | 'commit-completed' | 'restored' | 'recovery-required'

/** Outcome of one recovery attempt. */
export interface PageAppRecoveryOutcome {
  readonly action: PageAppRecoveryAction
  /** Actionable message when the outcome is not silent. */
  readonly message?: string
}

/** Manager-relative owned files (mirrors the transaction journal list). */
const OWNED_RELATIVE_FILES = ['registry.json', 'runtime-layer.yml', '../package.json', '../pnpm-lock.yaml'] as const

/** Absolute path of one manager-relative owned file inside the profile. */
function absoluteOf(profileDir: string, relative: string): string {
  const paths = resolvePageAppProfilePaths(profileDir)
  return relative === 'registry.json' || relative === 'runtime-layer.yml'
    ? join(paths.directory, relative)
    : join(profileDir, relative.replace(/^\.\.\//, ''))
}

async function sha256Of(path: string): Promise<string | undefined> {
  try {
    return createHash('sha256').update(await readFile(path, 'utf8')).digest('hex')
  } catch {
    return undefined
  }
}

/**
 * Recover one profile's unfinished transaction. Runs after orphan-lock
 * takeover and inside the manager profile lock.
 * @param profileDir - absolute profile directory.
 * @param executor - the pnpm seam used for inverse/convergence operations.
 * @returns the recovery decision.
 */
export async function recoverPageAppTransaction(
  profileDir: string,
  executor: PageAppPackageExecutor,
): Promise<PageAppRecoveryOutcome> {
  const journal = await readPageAppJournal(profileDir)
  if (journal === null) return { action: 'none' }
  const before = journal.files['registry.json']
  if (before === undefined) {
    return {
      action: 'recovery-required',
      message: 'page-app recovery: the journal records no registry file; operator review required',
    }
  }
  const current = await sha256Of(absoluteOf(profileDir, 'registry.json'))
  if (current === undefined && before.present) {
    return {
      action: 'recovery-required',
      message: 'page-app recovery: the registry file is unreadable and the journal cannot be decided',
    }
  }
  const registryChanged = before.present ? current !== before.sha256 : current !== undefined
  if (registryChanged) {
    if (journal.phase !== 'committing') {
      return {
        action: 'recovery-required',
        message: `page-app recovery: the registry changed at journal phase "${journal.phase}" — an external writer or a torn commit; operator review required`,
      }
    }
    // The commit published the registry; finishing is removing the journal.
    await removePageAppJournal(profileDir)
    return { action: 'commit-completed' }
  }
  // No commit: restore every recorded before-state, converge, and clear.
  try {
    for (const [relative, state] of Object.entries(journal.files)) {
      const absolute = absoluteOf(profileDir, relative)
      if (state.present) {
        const backup = `${absolute}.backup`
        try {
          const content = await readFile(backup, 'utf8')
          await writeFile(absolute, content)
        } catch (error) {
          return {
            action: 'recovery-required',
            message: `page-app recovery: failed to restore ${relative} (${String(error)}); journal retained`,
          }
        }
      } else {
        await rm(absolute, { force: true })
      }
    }
    const converge = await executor.run(['install'], { cwd: profileDir, signal: new AbortController().signal })
    if (converge.exitCode !== 0) {
      return {
        action: 'recovery-required',
        message: `page-app recovery: pnpm install convergence failed (${converge.stderr.trim()}); journal retained`,
      }
    }
    await removePageAppJournal(profileDir)
    return { action: 'restored' }
  } catch (error) {
    return {
      action: 'recovery-required',
      message: `page-app recovery: restore failed (${String(error)}); journal retained`,
    }
  }
}

/** The owned-file list is exported for the recovery-table tests. */
export const RECOVERY_OWNED_FILES: readonly string[] = OWNED_RELATIVE_FILES
