/**
 * The shared profile mutation lock. The manager and `dsh plugin` both acquire
 * the same `operation.lock` (`wx`-created, 0600, inside the 0700 manager
 * directory) before invoking pnpm or mutating owned files, so the two
 * mutation paths cannot race. The payload records schema version, owner kind,
 * pid, opaque owner token, and acquisition timestamp; startup recovery uses
 * the token to distinguish a dead transaction owner from live contention.
 * @module @deepseek-ai/dsh-page-app-profile/lock
 */

import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { z } from 'zod'
import { assertSafeOpaqueToken, PAGE_APP_TOKEN_PATTERN, parseStrict } from './manifest.ts'
import { resolvePageAppProfilePaths } from './paths.ts'
import { readPageAppJournal } from './journal.ts'
import type { PageAppLockOwner, PageAppLockPayloadV1 } from './types.ts'

const lockPayloadSchema = z.object({
  schemaVersion: z.literal(1),
  ownerKind: z.enum(['manager', 'plugin-cli']),
  ownerToken: z.string().regex(PAGE_APP_TOKEN_PATTERN),
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
  assertSafeOpaqueToken(owner.token)
  const paths = resolvePageAppProfilePaths(profileDir)
  await mkdir(paths.directory, { recursive: true, mode: 0o700 })
  // An existing manager directory keeps whatever mode it was created with, so
  // narrow it to owner-only on POSIX where the mode bit is enforced; Windows
  // ACLs own the equivalent decision and are left untouched.
  if (process.platform !== 'win32') await chmod(paths.directory, 0o700)
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
    // Release only the payload this acquisition wrote: a foreign lock that
    // replaced ours between acquire and release is another holder's file, and
    // removing it would break their serialization. An unreadable or already
    // gone path means there is nothing owned left to remove.
    try {
      const current = await readFile(paths.operationKey, 'utf8')
      const parsed = parseStrict(lockPayloadSchema, JSON.parse(current), 'page-app lock')
      if (parsed.ownerToken === owner.token) await rm(paths.operationKey, { force: true })
    } catch {
      // Lock already released or replaced by an unverifiable payload; keep it.
    }
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
 * Read the recoverer pid recorded in a recovery claim file, or undefined when
 * the claim is absent or unreadable. An unreadable claim fails closed in the
 * caller, never authorizing a takeover.
 * @param claimFile - the claim file path.
 * @returns the claimant pid, or undefined when absent or invalid.
 */
async function readClaimantPid(claimFile: string): Promise<number | undefined> {
  try {
    const raw = await readFile(claimFile, 'utf8')
    const pid = Number(raw.trim())
    return Number.isInteger(pid) && pid > 0 ? pid : undefined
  } catch {
    return undefined
  }
}

/**
 * Atomically acquire the recovery claim for `token` — the single-winner gate
 * of the whole recovery path. The claim is an exclusive `wx`-created file
 * (`<operationKey>.<token>.claim`) recording the recoverer pid: only one
 * recoverer can create it, every loser fails instead of proceeding, and only
 * the claim winner may run recovery. A provably dead claimant's claim is
 * adopted (removed and re-created) so a recoverer that crashed between claim
 * and recovery cannot block recovery forever; a live, indeterminate, or
 * unreadable claim fails closed. The claim stays in place during recovery so
 * a later caller can tell a live claimant from a dead one.
 * @param operationKey - the lock file path naming the claim.
 * @param token - the validated owner token naming the claim.
 */
async function acquireRecoveryClaim(operationKey: string, token: string): Promise<void> {
  const claimFile = `${operationKey}.${token}.claim`
  for (;;) {
    try {
      await writeFile(claimFile, `${process.pid}\n`, { mode: 0o600, flag: 'wx' })
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EEXIST') throw error
      const claimant = await readClaimantPid(claimFile)
      if (claimant === undefined || processLiveness(claimant) !== false) {
        throw new Error('page-app lock: recovery was already claimed by another recoverer')
      }
      await rm(claimFile, { force: true })
    }
  }
}

/**
 * Atomically quarantine a dead lock under a token-specific name. The claim
 * winner from {@link acquireRecoveryClaim} — the only caller that may get
 * here — moves the lock to `<operationKey>.<token>.quarantine`.
 * @param operationKey - the lock file path.
 * @param token - the validated owner token naming the quarantine.
 */
async function quarantineLock(operationKey: string, token: string): Promise<void> {
  const claimFile = `${operationKey}.${token}.claim`
  await acquireRecoveryClaim(operationKey, token)
  try {
    await rename(operationKey, `${operationKey}.${token}.quarantine`)
  } catch (error) {
    await rm(claimFile, { force: true })
    throw error
  }
}
/**
 * Startup recovery for an orphaned operation lock. A dead `manager` lock
 * whose token matches the active journal is quarantined under a token-specific
 * name by exactly one recoverer — the exclusive claim winner; a simultaneous
 * loser fails rather than proceeding. When the lock is already gone but the
 * journal survives, recovery is still owed and the same exclusive claim is
 * taken over atomically (a dead claimant's claim is adopted, a live claimant's
 * fails closed), so exactly one caller proceeds to the fresh `wx` acquisition
 * and runs recovery in every crash state. A dead `manager` lock without a
 * journal is safe to remove because the transaction protocol forbids all
 * mutations before journal publication and removes the journal only after
 * commit. Every other case fails closed for operator repair: a live pid, a
 * mismatched token, an unreadable payload, indeterminate liveness, or any
 * dead `plugin-cli` lock (generic pnpm may have stopped mid-mutation, and
 * token-correlated quarantine recovery is manager-only). The caller must win
 * a fresh exclusive lock acquisition before running recovery.
 * @param profileDir - absolute profile directory.
 */
export async function recoverOrphanedPageAppLock(profileDir: string): Promise<void> {
  const paths = resolvePageAppProfilePaths(profileDir)
  let raw: string
  try {
    raw = await readFile(paths.operationKey, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      // No lock is present. When the journal survives, recovery is owed: a
      // missing lock means a previous recoverer already quarantined it (its
      // claim may be live — fail — or dead — take over and proceed), or the
      // crash happened before any claim existed (claim atomically now). The
      // exclusive claim acquisition is the single-winner gate in every case,
      // so a concurrent caller either wins the claim or fails here.
      const journal = await readPageAppJournal(profileDir)
      if (journal !== null) {
        await acquireRecoveryClaim(paths.operationKey, journal.lockOwnerToken)
      }
      return
    }
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
    if (payload.ownerKind === 'plugin-cli') {
      throw new Error('page-app lock: dead plugin-cli lock with a journal; operator repair required (token-correlated recovery is manager-only)')
    }
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
