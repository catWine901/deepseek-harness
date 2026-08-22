/**
 * The shared profile mutation lock. The manager and `dsh plugin` both acquire
 * the same `operation.lock` (`wx`-created, 0600, inside the 0700 manager
 * directory) before invoking pnpm or mutating owned files, so the two
 * mutation paths cannot race. The payload records schema version, owner kind,
 * pid, opaque owner token, and acquisition timestamp; startup recovery uses
 * the token to distinguish a dead transaction owner from live contention.
 * @module @deepseek-ai/dsh-page-app-profile/lock
 */

import { lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { z } from 'zod'
import { parseStrict } from './manifest.ts'
import { resolvePageAppProfilePaths } from './paths.ts'
import { readPageAppJournal } from './journal.ts'
import type { PageAppLockOwner, PageAppLockPayloadV1 } from './types.ts'

const lockPayloadSchema = z.object({
  schemaVersion: z.literal(1),
  ownerKind: z.enum(['manager', 'plugin-cli']),
  ownerToken: z.string().min(1),
  pid: z.number().int().positive(),
  acquiredAt: z.string().min(1),
}).strict().readonly()

/** Retry cadence for a contended lock. */
const LOCK_RETRY_INITIAL_MS = 20
const LOCK_RETRY_MAX_MS = 250
/**
 * How long a contender waits for release. The holder may legitimately run a
 * long pnpm operation, so this is sized for pnpm, not file work; recovery of
 * a dead owner is an explicit startup step, never an implicit wait shortcut.
 */
const LOCK_WAIT_DEADLINE_MS = 15 * 60_000

/** Whether an exclusive create found an existing lock. */
async function isLockContention(error: unknown, lockPath: string): Promise<boolean> {
  const code = (error as NodeJS.ErrnoException | null)?.code
  if (code === 'EEXIST') return true
  if (code !== 'EPERM') return false
  try {
    await lstat(lockPath)
    return true
  } catch {
    // Keep the original EPERM authoritative when lock existence is unproven.
    return false
  }
}

/**
 * Hold the shared profile mutation lock around one operation. The lock file
 * is created with exclusive create (`wx`) and 0600 mode inside a 0700 manager
 * directory; contenders back off and wait until the holder releases, so two
 * mutations of one profile serialize. A stale lock is never removed here —
 * startup recovery is the explicit path for a dead owner.
 * @param profileDir - absolute profile directory.
 * @param owner - the locking identity; its opaque token is recorded in the payload.
 * @param operation - the mutation to run while holding the lock.
 * @returns the operation's result; the lock releases on both outcomes.
 */
export async function withPageAppProfileLock<T>(
  profileDir: string,
  owner: PageAppLockOwner,
  operation: () => Promise<T>,
): Promise<T> {
  const paths = resolvePageAppProfilePaths(profileDir)
  await mkdir(paths.directory, { recursive: true, mode: 0o700 })
  const payload = JSON.stringify({
    schemaVersion: 1,
    ownerKind: owner.kind,
    ownerToken: owner.token,
    pid: process.pid,
    acquiredAt: new Date().toISOString(),
  }, null, 2)
  const deadline = Date.now() + LOCK_WAIT_DEADLINE_MS
  let delay = LOCK_RETRY_INITIAL_MS
  for (;;) {
    try {
      await writeFile(paths.operationKey, payload, { mode: 0o600, flag: 'wx' })
      break
    } catch (error) {
      if (!await isLockContention(error, paths.operationKey)) throw error
    }
    if (Date.now() >= deadline) {
      throw new Error(`page-app lock: timed out waiting for the operation lock at ${paths.operationKey}`)
    }
    await new Promise(resolve => setTimeout(resolve, delay))
    delay = Math.min(delay * 2, LOCK_RETRY_MAX_MS)
  }
  try {
    return await operation()
  } finally {
    await rm(paths.operationKey, { force: true })
  }
}

/**
 * Classify a pid's liveness: `true` when the process exists, `false` when it
 * deterministically does not, and `'indeterminate'` when the probe answer is
 * neither. Indeterminate liveness never authorizes lock removal.
 * @param pid - the pid recorded in a lock payload.
 * @returns the liveness classification.
 */
function processLiveness(pid: number): boolean | 'indeterminate' {
  if (!Number.isInteger(pid) || pid <= 0) return 'indeterminate'
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ESRCH') return false
    if (code === 'EPERM') return true
    return 'indeterminate'
  }
}

/**
 * Atomically move a dead lock to its token-specific quarantine name. Only one
 * of several simultaneous recoverers can rename the single source; the rest
 * observe the source already gone and return, which is the single-winner gate
 * that pairs with the fresh `wx` acquisition the caller must win afterwards.
 * @param operationKey - the lock file path.
 * @param token - the lock payload's owner token naming the quarantine file.
 */
async function quarantineLock(operationKey: string, token: string): Promise<void> {
  const quarantine = `${operationKey}.${token}.quarantine`
  try {
    await rename(operationKey, quarantine)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return // another recoverer already renamed it
    if (code === 'EEXIST' || (process.platform === 'win32' && code === 'EPERM')) {
      await rm(quarantine, { force: true })
      await rename(operationKey, quarantine)
      return
    }
    throw error
  }
}

/**
 * Startup recovery for an orphaned operation lock. A dead `manager` lock
 * whose token matches the active journal is atomically renamed to a
 * token-specific quarantine name; a dead `manager` lock without a journal is
 * safe to remove because the transaction protocol forbids all mutations
 * before journal publication and removes the journal only after commit. Every
 * other case fails closed for operator repair: a live pid, a mismatched
 * token, an unreadable payload, indeterminate liveness, or a dead `plugin-cli`
 * lock without a journal (generic pnpm may have stopped mid-mutation). The
 * caller must win a fresh exclusive lock acquisition before running recovery.
 * @param profileDir - absolute profile directory.
 */
export async function recoverOrphanedPageAppLock(profileDir: string): Promise<void> {
  const paths = resolvePageAppProfilePaths(profileDir)
  let raw: string
  try {
    raw = await readFile(paths.operationKey, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
    throw error
  }
  let payload: PageAppLockPayloadV1
  try {
    payload = parseStrict(lockPayloadSchema, JSON.parse(raw), 'page-app lock')
  } catch (error) {
    throw new Error(`page-app lock: unreadable payload at ${paths.operationKey}; operator repair required: ${String(error)}`)
  }
  const liveness = processLiveness(payload.pid)
  if (liveness === true) {
    throw new Error(`page-app lock: owner process ${payload.pid} is still alive at ${paths.operationKey}`)
  }
  if (liveness === 'indeterminate') {
    throw new Error(`page-app lock: cannot determine liveness of pid ${payload.pid} at ${paths.operationKey}`)
  }
  const journal = await readPageAppJournal(profileDir)
  if (journal !== null) {
    if (journal.lockOwnerToken !== payload.ownerToken) {
      throw new Error('page-app lock: journal owner token does not match the lock; operator repair required')
    }
    await quarantineLock(paths.operationKey, payload.ownerToken)
    return
  }
  if (payload.ownerKind === 'plugin-cli') {
    throw new Error('page-app lock: dead plugin-cli lock without a journal; operator repair required (pnpm may have stopped mid-mutation)')
  }
  await rm(paths.operationKey, { force: true })
}
