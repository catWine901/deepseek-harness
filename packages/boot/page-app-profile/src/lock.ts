/**
 * The shared profile mutation lock. The manager and `dsh plugin` both acquire
 * the same `operation.lock` (`wx`-created, 0600, inside the 0700 manager
 * directory) before invoking pnpm or mutating owned files, so the two
 * mutation paths cannot race. The payload records schema version, owner kind,
 * pid, opaque owner token, and acquisition timestamp; startup recovery uses
 * the token to distinguish a dead transaction owner from live contention and
 * arbitrates exactly one winner through an append-only recovery claim chain.
 * @module @deepseek-ai/dsh-page-app-profile/lock
 */

import { chmod, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
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

/**
 * Maximum recovery-claim generations per owner token. Each generation is one
 * recovery attempt, so a longer chain means a crash-takeover loop; beyond the
 * cap recovery fails closed for operator repair.
 */
const RECOVERY_CLAIM_MAX_GENERATIONS = 64
/** Zero-padded width of the generation segment in a claim file name. */
const RECOVERY_CLAIM_INDEX_WIDTH = 4

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
 * One generation of a recovery claim chain. Generation 0 is the legacy
 * fixed-path claim when it exists; every later generation is a `.NNNN` claim.
 */
interface RecoveryClaimEntry {
  readonly index: number
  readonly path: string
  readonly pid: number
}

/** A validated recovery claim chain for one owner token, in generation order. */
interface ScannedRecoveryChain {
  readonly claims: readonly RecoveryClaimEntry[]
}

/**
 * Read a claim's recoverer pid, failing closed when the claim is unreadable or
 * does not contain a legal pid. A half-written claim (created but not yet
 * filled by a concurrent recoverer) therefore rejects instead of authorizing
 * a takeover.
 * @param claimFile - the claim file path.
 * @returns the claimant pid.
 */
async function readRequiredClaimantPid(claimFile: string): Promise<number> {
  const pid = await readClaimantPid(claimFile)
  if (pid === undefined) {
    throw new Error(`page-app lock: recovery claim is unreadable at ${claimFile}; operator repair required`)
  }
  return pid
}

/**
 * Scan and validate the complete recovery claim chain for one token: the
 * legacy fixed-path claim `<operationKey>.<token>.claim` (generation 0 when
 * present) plus every `<operationKey>.<token>.claim.<NNNN>` generation. The
 * scan fails closed on any anomaly — a claim-like file whose suffix is not
 * exactly four digits, a generation index at or beyond the cap, a legacy
 * claim coexisting with generation 0000, a gap or missing start in the
 * generation sequence, or an unreadable/malformed claim — because claims are
 * immutable evidence that a confused or tampered chain must never be
 * auto-repaired around. The empty chain (no claims) is valid.
 *
 * On Windows the filesystem matches names case-insensitively while the scan
 * compares them case-sensitively, so a claim written with a different case
 * would be invisible to the exact match yet still conflict with an exclusive
 * create of the canonical name. The scan therefore also rejects any
 * case-aliased claim name (a name that differs from a canonical claim only by
 * case) on win32: the alias and its canonical form are the same file there,
 * and the canonical-exact chain semantics cannot be preserved around it.
 * @param directory - the manager directory holding the claims.
 * @param operationKeyBasename - `basename(operationKey)`, the claim prefix root.
 * @param token - the validated owner token naming the claim chain.
 * @returns the validated chain in generation order (index equals position).
 */
async function scanRecoveryClaimChain(
  directory: string,
  operationKeyBasename: string,
  token: string,
): Promise<ScannedRecoveryChain> {
  const legacyName = `${operationKeyBasename}.${token}.claim`
  const generationPrefix = `${legacyName}.`
  let names: string[]
  try {
    names = await readdir(directory)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { claims: [] }
    throw error
  }
  let legacyPath: string | undefined
  const generations = new Map<number, string>()
  for (const name of names) {
    if (name === legacyName) {
      legacyPath = join(directory, name)
      continue
    }
    if (!name.startsWith(generationPrefix)) continue
    const suffix = name.slice(generationPrefix.length)
    if (suffix.length !== RECOVERY_CLAIM_INDEX_WIDTH || !/^\d{4}$/.test(suffix)) {
      throw new Error(`page-app lock: unexpected claim-like file at ${join(directory, name)}; operator repair required`)
    }
    const index = Number(suffix)
    if (index >= RECOVERY_CLAIM_MAX_GENERATIONS) {
      throw new Error(`page-app lock: recovery claim generation out of range at ${join(directory, name)}; operator repair required`)
    }
    generations.set(index, join(directory, name))
  }
  // A case-aliased claim is the same file as its canonical name on Windows,
  // so it would defeat the exact scan and make the canonical exclusive create
  // fail EEXIST forever. Reject it as operator repair instead of guessing
  // which spelling is authoritative.
  if (process.platform === 'win32') {
    const legacyLower = legacyName.toLowerCase()
    const generationPrefixLower = generationPrefix.toLowerCase()
    for (const name of names) {
      // Exact matches are the canonical chain and were handled above; only a
      // name that differs from a canonical claim by case is an alias.
      if (name === legacyName || name.startsWith(generationPrefix)) continue
      const lower = name.toLowerCase()
      if (lower === legacyLower) {
        throw new Error(`page-app lock: case-aliased legacy recovery claim at ${join(directory, name)}; operator repair required`)
      }
      if (!lower.startsWith(generationPrefixLower)) continue
      const suffix = lower.slice(generationPrefixLower.length)
      if (suffix.length === RECOVERY_CLAIM_INDEX_WIDTH
        && /^\d{4}$/.test(suffix)
        && Number(suffix) < RECOVERY_CLAIM_MAX_GENERATIONS) {
        throw new Error(`page-app lock: case-aliased recovery claim at ${join(directory, name)}; operator repair required`)
      }
    }
  }
  if (legacyPath !== undefined && generations.has(0)) {
    throw new Error(`page-app lock: ambiguous legacy claim at ${legacyPath} alongside chain generation 0000; operator repair required`)
  }
  const claims: RecoveryClaimEntry[] = []
  let expected = 0
  if (legacyPath !== undefined) {
    claims.push({ index: 0, path: legacyPath, pid: await readRequiredClaimantPid(legacyPath) })
    expected = 1
  }
  for (const [index, path] of [...generations.entries()].sort((a, b) => a[0] - b[0])) {
    if (index !== expected) {
      throw new Error(`page-app lock: recovery claim chain is discontinuous at ${path}; operator repair required`)
    }
    claims.push({ index, path, pid: await readRequiredClaimantPid(path) })
    expected += 1
  }
  return { claims }
}

/**
 * Atomically win the recovery claim for `token` — the single-winner gate of
 * the whole recovery path. Claims form an append-only successor chain
 * (`<operationKey>.<token>.claim.<generation>`; the pre-chain fixed-path
 * claim `<operationKey>.<token>.claim` counts as generation 0): a claim is
 * created with exclusive `wx` and never deleted, moved, or replaced, so the
 * chain only grows and each generation path is claimed by at most one
 * recoverer on every platform. Every scan validates the whole chain before
 * acting: generations must be contiguous from 0 and every claim readable (a
 * gap, a legacy/0000 coexistence, a malformed claim-like name, an
 * out-of-range index, or an unreadable claim fails closed), every ancestor
 * must be provably dead, and the tail must be provably dead for a recoverer
 * to create the next generation — so a dead high generation can never mask a
 * live ancestor. The `wx` create is the only atomic primitive; a recoverer
 * whose create fails EEXIST re-scans and observes the winner's live tail,
 * failing closed, and an exhausted chain (at the generation cap) fails closed
 * for operator repair. Because a successor can only be created over a
 * provably dead tail of a validated chain, at most one live recoverer ever
 * holds the winning claim, in the same process or across processes.
 * @param operationKey - the lock file path naming the claim chain.
 * @param token - the validated owner token naming the claim chain.
 */
async function acquireRecoveryClaim(operationKey: string, token: string): Promise<void> {
  const directory = dirname(operationKey)
  const prefix = `${basename(operationKey)}.${token}.claim.`
  // Fingerprint of the scan that immediately preceded each failed exclusive
  // create. An EEXIST whose re-scan is identical to the pre-create scan means
  // the conflicting file exists but the scan cannot see it (a case-insensitive
  // filesystem spelling the scan does not match, or an exotic concurrent
  // create/remove): retrying would spin forever, so recovery fails closed.
  let previousFingerprint: string | undefined
  for (;;) {
    const chain = await scanRecoveryClaimChain(directory, basename(operationKey), token)
    const fingerprint = chain.claims.map(claim => `${claim.index}:${claim.path}:${claim.pid}`).join('|')
    const tail = chain.claims.length === 0 ? undefined : chain.claims[chain.claims.length - 1]
    let tailIndex = -1
    if (tail !== undefined) {
      tailIndex = tail.index
      for (const ancestor of chain.claims.slice(0, -1)) {
        const liveness = processLiveness(ancestor.pid)
        if (liveness === false) continue
        if (liveness === true) {
          throw new Error(`page-app lock: recovery claim ancestor is still alive at ${ancestor.path}; operator repair required`)
        }
        throw new Error(`page-app lock: cannot determine liveness of recovery claim ancestor at ${ancestor.path}`)
      }
      const liveness = processLiveness(tail.pid)
      if (liveness === true) {
        throw new Error('page-app lock: recovery was already claimed by another recoverer')
      }
      if (liveness === 'indeterminate') {
        throw new Error(`page-app lock: cannot determine liveness of recovery claimant at ${tail.path}`)
      }
    }
    const next = tailIndex + 1
    if (next >= RECOVERY_CLAIM_MAX_GENERATIONS) {
      throw new Error('page-app lock: recovery claim chain is exhausted; operator repair required')
    }
    const nextPath = join(directory, `${prefix}${String(next).padStart(RECOVERY_CLAIM_INDEX_WIDTH, '0')}`)
    try {
      await writeFile(nextPath, `${process.pid}\n`, { mode: 0o600, flag: 'wx' })
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EEXIST') throw error
      if (previousFingerprint === fingerprint) {
        throw new Error('page-app lock: recovery claim create failed EEXIST with an unchanged scan; operator repair required')
      }
      // A concurrent recoverer created the next generation first; re-scan.
      previousFingerprint = fingerprint
    }
  }
}

/**
 * Atomically quarantine a dead lock under a token-specific name. Only the
 * claim winner from {@link acquireRecoveryClaim} — the sole recoverer allowed
 * past the chain gate — moves the lock to `<operationKey>.<token>.quarantine`.
 * On a rename failure the claim is retained and the error propagates:
 * recovery fails closed for operator repair, because claims are never deleted.
 * @param operationKey - the lock file path.
 * @param token - the validated owner token naming the quarantine.
 */
async function quarantineLock(operationKey: string, token: string): Promise<void> {
  await acquireRecoveryClaim(operationKey, token)
  await rename(operationKey, `${operationKey}.${token}.quarantine`)
}
/**
 * Startup recovery for an orphaned operation lock. A dead `manager` lock
 * whose token matches the active journal is quarantined under a token-specific
 * name by exactly one recoverer — the winner of the exclusive recovery claim
 * chain; a simultaneous loser fails rather than proceeding. When the lock is
 * already gone but the journal survives, recovery is still owed and the same
 * claim chain is advanced: the whole chain is validated first (contiguous
 * generations from 0, readable claims, provably dead ancestors — the legacy
 * fixed-path claim counts as generation 0 and coexisting with `.0000` is
 * ambiguous), then a provably dead tail is superseded by the next generation,
 * while a live, indeterminate, or unreadable tail fails closed, so exactly
 * one caller proceeds to the fresh `wx` acquisition and runs recovery in
 * every crash state. A dead `manager` lock without a journal is safe to
 * remove because the transaction protocol forbids all mutations before
 * journal publication and removes the journal only after commit. Every other
 * case fails closed for operator repair: a live pid, a mismatched token, an
 * unreadable payload, indeterminate liveness, or any dead `plugin-cli` lock
 * (generic pnpm may have stopped mid-mutation, and token-correlated
 * quarantine recovery is manager-only). The caller must win a fresh exclusive
 * lock acquisition before running recovery.
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
