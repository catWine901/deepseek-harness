import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { recoverOrphanedPageAppLock, withPageAppProfileLock } from '../src/lock.ts'
import { resolvePageAppProfilePaths } from '../src/paths.ts'

const fsState = vi.hoisted(() => ({
  armPauseOnClaimRead: false,
  releaseClaimRead: () => {},
  claimReadReached: () => {},
  // Pauses the first read of a claim that was moved into a tombstone whose
  // content no longer matches the dead claimant the mover inspected — the
  // stale mover's verify read, which the pre-chain implementation performs
  // after it renamed a replaced live claim away.
  armPauseOnTombMismatch: false,
  releaseReplacedClaimRead: () => {},
  replacedClaimReadReached: () => {},
  deadClaimantPid: undefined as number | undefined,
  // Simulates a case-insensitive filesystem hiding claim files from the
  // scan while the create still conflicts: readdir filters every '.claim'
  // name out and writeFile answers EEXIST for claim paths, so the scan state
  // stays unchanged after a failed exclusive create.
  armHideClaimFiles: false,
  armEexistOnClaimWrite: false,
}))

// Deterministic interleaving control for the three-recoverer test: the FIRST
// recovery claim-file read after arming captures the current content and
// blocks until the test releases it, letting concurrent recoverers finish a
// full takeover before the paused reader acts on its stale read. A second
// hook pauses the stale mover's verify read of a tombstone whose content no
// longer matches the dead claimant it inspected, so the test can insert a
// third recoverer into the replacement window.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const readFile = (async (path: unknown, ...rest: unknown[]) => {
    const file = String(path)
    if (file.includes('.claim') && fsState.armPauseOnClaimRead) {
      fsState.armPauseOnClaimRead = false
      const content = String(await (actual.readFile as (p: unknown, ...a: unknown[]) => Promise<unknown>)(path, ...rest))
      fsState.claimReadReached()
      await new Promise<void>((resolveGate) => { fsState.releaseClaimRead = resolveGate })
      return content
    }
    if (file.includes('.tomb') && fsState.armPauseOnTombMismatch && fsState.deadClaimantPid !== undefined) {
      const content = String(await (actual.readFile as (p: unknown, ...a: unknown[]) => Promise<unknown>)(path, ...rest))
      if (content.trim() !== String(fsState.deadClaimantPid)) {
        fsState.armPauseOnTombMismatch = false
        fsState.replacedClaimReadReached()
        await new Promise<void>((resolveGate) => { fsState.releaseReplacedClaimRead = resolveGate })
      }
      return content
    }
    return (actual.readFile as (p: unknown, ...a: unknown[]) => Promise<unknown>)(path, ...rest)
  }) as typeof actual.readFile
  const readdir = (async (path: unknown, ...rest: unknown[]) => {
    const names = await (actual.readdir as (p: unknown, ...a: unknown[]) => Promise<string[]>)(path, ...rest)
    if (!fsState.armHideClaimFiles) return names
    return names.filter(name => !name.includes('.claim'))
  }) as typeof actual.readdir
  const writeFile = (async (path: unknown, ...rest: unknown[]) => {
    const file = String(path)
    if (fsState.armEexistOnClaimWrite && file.includes('.claim')) {
      // Yield to the event loop so a hypothetical infinite retry loop cannot
      // starve the test's race timer.
      await new Promise<void>(resolve => setImmediate(resolve))
      throw Object.assign(new Error('EEXIST: injected claim conflict'), { code: 'EEXIST' })
    }
    return (actual.writeFile as (p: unknown, ...a: unknown[]) => Promise<unknown>)(path, ...rest)
  }) as typeof actual.writeFile
  return { ...actual, readFile, readdir, writeFile }
})

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dsh-page-app-lock-'))
}

/** A pid that existed and has exited, so liveness probes answer ESRCH deterministically. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  const pid = child.pid
  if (pid === undefined) throw new Error('failed to spawn the dead-pid probe')
  await Promise.race([
    once(child, 'exit'),
    once(child, 'error').then(() => { throw new Error('dead-pid probe failed to start') }),
  ])
  return pid
}

function lockPayload(ownerKind: string, ownerToken: string, pid: number): string {
  return JSON.stringify({
    schemaVersion: 1,
    ownerKind,
    ownerToken,
    pid,
    acquiredAt: '2026-08-22T00:00:00.000Z',
  }, null, 2)
}

function journal(lockOwnerToken: string): string {
  return JSON.stringify({ schemaVersion: 1, phase: 'prepared', lockOwnerToken, files: {} }, null, 2)
}

async function waitForLock(lockPath: string): Promise<void> {
  for (;;) {
    try {
      await stat(lockPath)
      return
    } catch {
      await new Promise(resolve => setTimeout(resolve, 5))
    }
  }
}

/**
 * One full recovery attempt: orphan recovery prep, then recovery work under
 * the fresh profile lock. Used by the concurrent single-winner tests.
 */
function recoveryAttempt(profile: string, callbackRuns: { count: number }): () => Promise<void> {
  return async () => {
    await recoverOrphanedPageAppLock(profile)
    await withPageAppProfileLock(profile, { kind: 'manager', token: 'recoverer' }, async () => {
      callbackRuns.count += 1
      await new Promise(resolve => setTimeout(resolve, 30))
    })
  }
}

afterEach(() => {
  vi.restoreAllMocks()
  fsState.armPauseOnClaimRead = false
  fsState.releaseClaimRead = () => {}
  fsState.claimReadReached = () => {}
  fsState.armPauseOnTombMismatch = false
  fsState.releaseReplacedClaimRead = () => {}
  fsState.replacedClaimReadReached = () => {}
  fsState.deadClaimantPid = undefined
  fsState.armHideClaimFiles = false
  fsState.armEexistOnClaimWrite = false
})

/**
 * Await `task`, rejecting with a labelled timeout error when it does not
 * settle within `ms`. The recovery paths under test must fail closed — a
 * promise that never settles is the infinite-retry bug this suite pins.
 */
async function settlesWithin<T>(task: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      task,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`operation did not settle within ${ms}ms`))
        }, ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

describe('withPageAppProfileLock', () => {
  it('creates exactly .workspace-manager/operation.lock with a complete v1 payload', async () => {
    const profile = await scratch()
    await withPageAppProfileLock(profile, { kind: 'manager', token: 'token-1' }, async () => {
      const paths = resolvePageAppProfilePaths(profile)
      expect((await readdir(paths.directory))).toEqual(['operation.lock'])
      if (process.platform !== 'win32') {
        expect((await stat(paths.operationKey)).mode & 0o777).toBe(0o600)
        expect((await stat(paths.directory)).mode & 0o777).toBe(0o700)
      }
      const payload = JSON.parse(await readFile(paths.operationKey, 'utf8')) as Record<string, unknown>
      expect(payload.schemaVersion).toBe(1)
      expect(payload.ownerKind).toBe('manager')
      expect(payload.ownerToken).toBe('token-1')
      expect(payload.pid).toBe(process.pid)
      expect(typeof payload.acquiredAt).toBe('string')
      expect(Number.isNaN(Date.parse(String(payload.acquiredAt)))).toBe(false)
    })
  })

  it('serializes two contenders: the second runs only after the first releases', async () => {
    const profile = await scratch()
    const events: string[] = []
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    const first = withPageAppProfileLock(profile, { kind: 'manager', token: 'first' }, async () => {
      events.push('first-started')
      await gate
      events.push('first-done')
    })
    await waitForLock(resolvePageAppProfilePaths(profile).operationKey)
    const second = withPageAppProfileLock(profile, { kind: 'manager', token: 'second' }, async () => {
      events.push('second-started')
    })
    await new Promise(resolve => setTimeout(resolve, 60))
    expect(events).toEqual(['first-started'])
    release()
    await Promise.all([first, second])
    expect(events).toEqual(['first-started', 'first-done', 'second-started'])
  })

  it('releases the lock when the operation throws', async () => {
    const profile = await scratch()
    await expect(withPageAppProfileLock(profile, { kind: 'manager', token: 'token' }, async () => {
      throw new Error('boom')
    })).rejects.toThrow('boom')
    await expect(stat(resolvePageAppProfilePaths(profile).operationKey)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('recoverOrphanedPageAppLock', () => {
  it('is a no-op when no lock exists', async () => {
    const profile = await scratch()
    await expect(recoverOrphanedPageAppLock(profile)).resolves.toBeUndefined()
  })

  it('atomically renames a dead manager lock to a token-specific quarantine when its token matches the journal', async () => {
    const profile = await scratch()
    const paths = resolvePageAppProfilePaths(profile)
    await mkdir(paths.directory, { recursive: true, mode: 0o700 })
    await writeFile(paths.operationKey, lockPayload('manager', 'token-x', await deadPid()), { flag: 'wx', mode: 0o600 })
    await writeFile(paths.journal, journal('token-x'), { flag: 'wx', mode: 0o600 })

    await recoverOrphanedPageAppLock(profile)

    expect((await readdir(paths.directory)).sort())
      .toEqual(['operation.lock.token-x.claim.0000', 'operation.lock.token-x.quarantine', 'transaction.json'])
    await expect(stat(paths.operationKey)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('removes a dead manager lock without a journal because no mutation precedes journal publication', async () => {
    const profile = await scratch()
    const paths = resolvePageAppProfilePaths(profile)
    await mkdir(paths.directory, { recursive: true })
    await writeFile(paths.operationKey, lockPayload('manager', 'token-x', await deadPid()), { flag: 'wx', mode: 0o600 })

    await recoverOrphanedPageAppLock(profile)

    expect(await readdir(paths.directory)).toEqual([])
  })

  it('fails closed for a dead plugin-cli lock without a journal', async () => {
    const profile = await scratch()
    const paths = resolvePageAppProfilePaths(profile)
    await mkdir(paths.directory, { recursive: true })
    await writeFile(paths.operationKey, lockPayload('plugin-cli', 'token-x', await deadPid()), { flag: 'wx', mode: 0o600 })

    await expect(recoverOrphanedPageAppLock(profile)).rejects.toThrow(/plugin-cli|repair/i)
    await expect(stat(paths.operationKey)).resolves.toBeDefined()
  })

  it('fails closed when the owning process is still alive', async () => {
    const profile = await scratch()
    const paths = resolvePageAppProfilePaths(profile)
    await mkdir(paths.directory, { recursive: true })
    await writeFile(paths.operationKey, lockPayload('manager', 'token-x', process.pid), { flag: 'wx', mode: 0o600 })

    await expect(recoverOrphanedPageAppLock(profile)).rejects.toThrow(/alive/i)
    await expect(stat(paths.operationKey)).resolves.toBeDefined()
  })

  it('fails closed when the journal token does not match the lock token', async () => {
    const profile = await scratch()
    const paths = resolvePageAppProfilePaths(profile)
    await mkdir(paths.directory, { recursive: true })
    await writeFile(paths.operationKey, lockPayload('manager', 'token-x', await deadPid()), { flag: 'wx', mode: 0o600 })
    await writeFile(paths.journal, journal('token-y'), { flag: 'wx', mode: 0o600 })

    await expect(recoverOrphanedPageAppLock(profile)).rejects.toThrow(/token/i)
    await expect(stat(paths.operationKey)).resolves.toBeDefined()
  })

  it('fails closed when the lock payload is unreadable', async () => {
    const profile = await scratch()
    const paths = resolvePageAppProfilePaths(profile)
    await mkdir(paths.directory, { recursive: true })
    await writeFile(paths.operationKey, 'not json', { flag: 'wx', mode: 0o600 })

    await expect(recoverOrphanedPageAppLock(profile)).rejects.toThrow(/unreadable|payload/i)
    await expect(stat(paths.operationKey)).resolves.toBeDefined()
  })

  it('fails closed when process liveness is indeterminate', async () => {
    const profile = await scratch()
    const paths = resolvePageAppProfilePaths(profile)
    await mkdir(paths.directory, { recursive: true })
    await writeFile(paths.operationKey, lockPayload('manager', 'token-x', await deadPid()), { flag: 'wx', mode: 0o600 })
    const spy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw Object.assign(new Error('EINVAL: injected liveness probe failure'), { code: 'EINVAL' })
    })

    await expect(recoverOrphanedPageAppLock(profile)).rejects.toThrow(/liveness|indeterminate/i)
    spy.mockRestore()
    await expect(stat(paths.operationKey)).resolves.toBeDefined()
  })

  it('lets only one of two simultaneous recoverers rename the dead lock; the loser fails', async () => {
    const profile = await scratch()
    const paths = resolvePageAppProfilePaths(profile)
    await mkdir(paths.directory, { recursive: true })
    await writeFile(paths.operationKey, lockPayload('manager', 'token-x', await deadPid()), { flag: 'wx', mode: 0o600 })
    await writeFile(paths.journal, journal('token-x'), { flag: 'wx', mode: 0o600 })

    const results = await Promise.allSettled([
      recoverOrphanedPageAppLock(profile),
      recoverOrphanedPageAppLock(profile),
    ])

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.filter(result => result.status === 'rejected')
    expect(rejected).toHaveLength(1)
    expect(String((rejected[0] as PromiseRejectedResult).reason)).toMatch(/already claimed|recoverer/i)
    const names = await readdir(paths.directory)
    expect(names.filter(name => name.endsWith('.quarantine'))).toHaveLength(1)
    await expect(stat(paths.operationKey)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('runs recovery work exactly once: only the rename winner proceeds to the fresh wx acquire', async () => {
    const profile = await scratch()
    const paths = resolvePageAppProfilePaths(profile)
    await mkdir(paths.directory, { recursive: true })
    await writeFile(paths.operationKey, lockPayload('manager', 'token-x', await deadPid()), { flag: 'wx', mode: 0o600 })
    await writeFile(paths.journal, journal('token-x'), { flag: 'wx', mode: 0o600 })

    const callbackRuns = { count: 0 }
    const recover = recoveryAttempt(profile, callbackRuns)

    const results = await Promise.allSettled([recover(), recover()])

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect(callbackRuns.count).toBe(1)
    expect((await readdir(paths.directory)).filter(name => name.endsWith('.quarantine'))).toHaveLength(1)
  })

  it('fails closed for a dead plugin-cli lock even when a journal matches its token', async () => {
    const profile = await scratch()
    const paths = resolvePageAppProfilePaths(profile)
    await mkdir(paths.directory, { recursive: true })
    await writeFile(paths.operationKey, lockPayload('plugin-cli', 'token-x', await deadPid()), { flag: 'wx', mode: 0o600 })
    await writeFile(paths.journal, journal('token-x'), { flag: 'wx', mode: 0o600 })

    await expect(recoverOrphanedPageAppLock(profile)).rejects.toThrow(/plugin-cli|repair/i)
    await expect(stat(paths.operationKey)).resolves.toBeDefined()
    expect((await readdir(paths.directory)).filter(name => name.endsWith('.quarantine'))).toHaveLength(0)
  })

  it('narrows an existing permissive manager directory to owner-only on POSIX', async () => {
    const profile = await scratch()
    const paths = resolvePageAppProfilePaths(profile)
    await mkdir(paths.directory, { recursive: true, mode: 0o755 })

    await withPageAppProfileLock(profile, { kind: 'manager', token: 'token-1' }, async () => {
      if (process.platform !== 'win32') {
        expect((await stat(paths.directory)).mode & 0o777).toBe(0o700)
      }
    })
  })

  it('never removes a lock file it no longer owns', async () => {
    const profile = await scratch()
    const paths = resolvePageAppProfilePaths(profile)
    await withPageAppProfileLock(profile, { kind: 'manager', token: 'ours' }, async () => {
      // Another holder's payload replaces ours while we hold the path; release
      // must not delete a lock whose owner token it cannot verify.
      await writeFile(paths.operationKey, lockPayload('manager', 'theirs', process.pid), { mode: 0o600, flag: 'w' })
    })
    const payload = JSON.parse(await readFile(paths.operationKey, 'utf8')) as Record<string, unknown>
    expect(payload.ownerToken).toBe('theirs')
  })

  it('fails closed when a live claimant already owns recovery', async () => {
    const profile = await scratch()
    const paths = resolvePageAppProfilePaths(profile)
    await mkdir(paths.directory, { recursive: true })
    await writeFile(paths.journal, journal('token-x'), { flag: 'wx', mode: 0o600 })
    await writeFile(`${paths.operationKey}.token-x.claim.0000`, `${process.pid}\n`, { flag: 'wx', mode: 0o600 })

    await expect(recoverOrphanedPageAppLock(profile)).rejects.toThrow(/already claimed|recoverer/i)
  })

  it('proceeds to complete recovery when the recorded claimant is provably dead', async () => {
    const profile = await scratch()
    const paths = resolvePageAppProfilePaths(profile)
    await mkdir(paths.directory, { recursive: true })
    await writeFile(paths.journal, journal('token-x'), { flag: 'wx', mode: 0o600 })
    const dead = await deadPid()
    await writeFile(`${paths.operationKey}.token-x.claim.0000`, `${dead}\n`, { flag: 'wx', mode: 0o600 })

    await expect(recoverOrphanedPageAppLock(profile)).resolves.toBeUndefined()
    // The provably dead tail was superseded by exactly one live successor.
    expect(await readFile(`${paths.operationKey}.token-x.claim.0001`, 'utf8')).toBe(`${process.pid}\n`)
  })

  it('atomically takes over a stale claim: with a missing lock and live journal, exactly one recoverer runs recovery', async () => {
    const profile = await scratch()
    const paths = resolvePageAppProfilePaths(profile)
    await mkdir(paths.directory, { recursive: true })
    await writeFile(paths.journal, journal('token-x'), { flag: 'wx', mode: 0o600 })
    const dead = await deadPid()
    await writeFile(`${paths.operationKey}.token-x.claim.0000`, `${dead}\n`, { flag: 'wx', mode: 0o600 })

    const callbackRuns = { count: 0 }
    const recover = recoveryAttempt(profile, callbackRuns)

    const results = await Promise.allSettled([recover(), recover()])

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect(callbackRuns.count).toBe(1)
    // The take-over claim now records this process as the live recoverer.
    expect(await readFile(`${paths.operationKey}.token-x.claim.0001`, 'utf8')).toBe(`${process.pid}\n`)
  })

  it('atomically claims recovery when no claim exists but the journal survives', async () => {
    const profile = await scratch()
    const paths = resolvePageAppProfilePaths(profile)
    await mkdir(paths.directory, { recursive: true })
    await writeFile(paths.journal, journal('token-x'), { flag: 'wx', mode: 0o600 })

    const callbackRuns = { count: 0 }
    const recover = recoveryAttempt(profile, callbackRuns)

    const results = await Promise.allSettled([recover(), recover()])

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect(callbackRuns.count).toBe(1)
  })

  it('lets at most one of three recoverers win when a stale mover replaces a live claim (A/B/C)', async () => {
    const profile = await scratch()
    const paths = resolvePageAppProfilePaths(profile)
    await mkdir(paths.directory, { recursive: true })
    await writeFile(paths.journal, journal('token-x'), { flag: 'wx', mode: 0o600 })
    const dead = await deadPid()
    // Only the legacy fixed-path claim is planted: the pre-chain
    // implementation (which honors only that path) runs deterministically RED
    // on this fixture (B moves A's live claim away, C creates into the empty
    // fixed path, and A and C both win), while the chain algorithm treats the
    // legacy claim as generation 0, supersedes it exactly once at .0001, and
    // fails B and C closed on the live tail.
    await writeFile(`${paths.operationKey}.token-x.claim`, `${dead}\n`, { flag: 'wx', mode: 0o600 })

    fsState.deadClaimantPid = dead
    fsState.armPauseOnClaimRead = true
    fsState.armPauseOnTombMismatch = true

    // B stale-reads the dead claimant and pauses before acting on it.
    const bRuns = { count: 0 }
    const bReached = new Promise<void>((resolveReached) => { fsState.claimReadReached = resolveReached })
    const bPromise = recoveryAttempt(profile, bRuns)()
    await bReached

    // A completes a full takeover and wins the recovery.
    const aRuns = { count: 0 }
    const aPromise = recoveryAttempt(profile, aRuns)()
    await aPromise

    // B resumes; on the pre-chain implementation it moves A's live claim to
    // its tombstone and pauses at the verify read, leaving the fixed claim
    // path empty for C. On the chain, B's successor create fails EEXIST and B
    // fails closed without ever pausing.
    fsState.releaseClaimRead()
    const bMoved = new Promise<void>((resolveReached) => { fsState.replacedClaimReadReached = resolveReached })
    const bSettled = bPromise.then(
      () => 'settled',
      () => 'settled',
    )
    await Promise.race([bMoved, bSettled])

    // C attempts recovery inside B's replacement window and runs to
    // completion while B stays paused, so C's claim create lands before B can
    // restore anything. B only resumes after C settles.
    const cRuns = { count: 0 }
    const cPromise = recoveryAttempt(profile, cRuns)()
    await cPromise.then(
      () => undefined,
      () => undefined,
    )

    fsState.releaseReplacedClaimRead()
    const results = await Promise.allSettled([aPromise, bPromise, cPromise])

    // Exactly one recoverer wins: A. B and C fail closed instead of both
    // proceeding with A, so no two recoverers ever return success together.
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(2)
    expect(aRuns.count + bRuns.count + cRuns.count).toBe(1)
    // The chain advanced exactly one generation past the planted dead claim.
    expect(await readFile(`${paths.operationKey}.token-x.claim.0001`, 'utf8')).toBe(`${process.pid}\n`)
    expect((await readdir(paths.directory)).filter(name => name.endsWith('.tomb'))).toEqual([])
  })

  it('fails closed when the recovery claim chain reaches its generation cap', async () => {
    const profile = await scratch()
    const paths = resolvePageAppProfilePaths(profile)
    await mkdir(paths.directory, { recursive: true })
    await writeFile(paths.journal, journal('token-x'), { flag: 'wx', mode: 0o600 })
    const dead = await deadPid()
    for (let index = 0; index < 64; index += 1) {
      await writeFile(`${paths.operationKey}.token-x.claim.${String(index).padStart(4, '0')}`, `${dead}\n`, { flag: 'wx', mode: 0o600 })
    }

    await expect(recoverOrphanedPageAppLock(profile)).rejects.toThrow(/chain exhausted|repair/i)
  })

  it('fails closed on a live low generation with a gap and a dead high generation, creating nothing', async () => {
    const profile = await scratch()
    const paths = resolvePageAppProfilePaths(profile)
    await mkdir(paths.directory, { recursive: true })
    await writeFile(paths.journal, journal('token-x'), { flag: 'wx', mode: 0o600 })
    const dead = await deadPid()
    // The review scenario: a live generation-0 recoverer, a missing 0001, and
    // a dead high generation. The highest-legal-generation tail logic would
    // supersede 0002 and let a second recoverer win alongside the live one.
    await writeFile(`${paths.operationKey}.token-x.claim.0000`, `${process.pid}\n`, { flag: 'wx', mode: 0o600 })
    await writeFile(`${paths.operationKey}.token-x.claim.0002`, `${dead}\n`, { flag: 'wx', mode: 0o600 })

    await expect(recoverOrphanedPageAppLock(profile)).rejects.toThrow(/repair/i)
    // No new generation was created: the planted chain is untouched.
    expect((await readdir(paths.directory)).filter(name => name.startsWith('operation.lock.token-x.claim')).sort())
      .toEqual(['operation.lock.token-x.claim.0000', 'operation.lock.token-x.claim.0002'])
  })

  it('fails closed when a continuous chain contains a live ancestor', async () => {
    const profile = await scratch()
    const paths = resolvePageAppProfilePaths(profile)
    await mkdir(paths.directory, { recursive: true })
    await writeFile(paths.journal, journal('token-x'), { flag: 'wx', mode: 0o600 })
    const dead = await deadPid()
    await writeFile(`${paths.operationKey}.token-x.claim.0000`, `${process.pid}\n`, { flag: 'wx', mode: 0o600 })
    await writeFile(`${paths.operationKey}.token-x.claim.0001`, `${dead}\n`, { flag: 'wx', mode: 0o600 })

    await expect(recoverOrphanedPageAppLock(profile)).rejects.toThrow(/ancestor|repair/i)
    expect((await readdir(paths.directory)).filter(name => name.startsWith('operation.lock.token-x.claim')).sort())
      .toEqual(['operation.lock.token-x.claim.0000', 'operation.lock.token-x.claim.0001'])
  })

  it('fails closed when a continuous chain contains an indeterminate ancestor', async () => {
    const profile = await scratch()
    const paths = resolvePageAppProfilePaths(profile)
    await mkdir(paths.directory, { recursive: true })
    await writeFile(paths.journal, journal('token-x'), { flag: 'wx', mode: 0o600 })
    const ancestorPid = await deadPid()
    const tailPid = await deadPid()
    await writeFile(`${paths.operationKey}.token-x.claim.0000`, `${ancestorPid}\n`, { flag: 'wx', mode: 0o600 })
    await writeFile(`${paths.operationKey}.token-x.claim.0001`, `${tailPid}\n`, { flag: 'wx', mode: 0o600 })
    // Only the ancestor's probe is indeterminate; the tail stays provably dead
    // so the pre-chain tail-only logic would have superseded it.
    const originalKill = process.kill.bind(process)
    const spy = vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: number | string) => {
      if (pid === ancestorPid) {
        throw Object.assign(new Error('EINVAL: injected liveness probe failure'), { code: 'EINVAL' })
      }
      return originalKill(pid, signal)
    })

    await expect(recoverOrphanedPageAppLock(profile)).rejects.toThrow(/ancestor|liveness|indeterminate|repair/i)
    spy.mockRestore()
    expect((await readdir(paths.directory)).filter(name => name.startsWith('operation.lock.token-x.claim')).sort())
      .toEqual(['operation.lock.token-x.claim.0000', 'operation.lock.token-x.claim.0001'])
  })

  it('fails closed when a chain ancestor is unreadable or malformed', async () => {
    const profile = await scratch()
    const paths = resolvePageAppProfilePaths(profile)
    await mkdir(paths.directory, { recursive: true })
    await writeFile(paths.journal, journal('token-x'), { flag: 'wx', mode: 0o600 })
    const dead = await deadPid()
    await writeFile(`${paths.operationKey}.token-x.claim.0000`, 'not a pid\n', { flag: 'wx', mode: 0o600 })
    await writeFile(`${paths.operationKey}.token-x.claim.0001`, `${dead}\n`, { flag: 'wx', mode: 0o600 })

    await expect(recoverOrphanedPageAppLock(profile)).rejects.toThrow(/unreadable|repair/i)
    expect((await readdir(paths.directory)).filter(name => name.startsWith('operation.lock.token-x.claim')).sort())
      .toEqual(['operation.lock.token-x.claim.0000', 'operation.lock.token-x.claim.0001'])
  })

  it('fails closed on claim-like anomalous generation names without creating a chain', async () => {
    const dead = await deadPid()
    for (const suffix of ['00000', '000x', '0000.extra', '12345']) {
      const profile = await scratch()
      const paths = resolvePageAppProfilePaths(profile)
      await mkdir(paths.directory, { recursive: true })
      await writeFile(paths.journal, journal('token-x'), { flag: 'wx', mode: 0o600 })
      await writeFile(`${paths.operationKey}.token-x.claim.${suffix}`, `${dead}\n`, { flag: 'wx', mode: 0o600 })

      await expect(recoverOrphanedPageAppLock(profile)).rejects.toThrow(/claim-like|repair/i)
      // The anomalous file stays and no chain generation was created.
      expect((await readdir(paths.directory)).filter(name => name.startsWith('operation.lock.token-x.claim')).sort())
        .toEqual([`operation.lock.token-x.claim.${suffix}`])
    }
  })

  it('fails closed on an out-of-range generation index without creating anything', async () => {
    const profile = await scratch()
    const paths = resolvePageAppProfilePaths(profile)
    await mkdir(paths.directory, { recursive: true })
    await writeFile(paths.journal, journal('token-x'), { flag: 'wx', mode: 0o600 })
    const dead = await deadPid()
    await writeFile(`${paths.operationKey}.token-x.claim.0064`, `${dead}\n`, { flag: 'wx', mode: 0o600 })

    await expect(recoverOrphanedPageAppLock(profile)).rejects.toThrow(/out of range|exhausted|repair/i)
    expect((await readdir(paths.directory)).filter(name => name.startsWith('operation.lock.token-x.claim')).sort())
      .toEqual(['operation.lock.token-x.claim.0064'])
  })

  it('proceeds when a continuous multi-generation chain is fully dead', async () => {
    const profile = await scratch()
    const paths = resolvePageAppProfilePaths(profile)
    await mkdir(paths.directory, { recursive: true })
    await writeFile(paths.journal, journal('token-x'), { flag: 'wx', mode: 0o600 })
    const dead = await deadPid()
    await writeFile(`${paths.operationKey}.token-x.claim.0000`, `${dead}\n`, { flag: 'wx', mode: 0o600 })
    await writeFile(`${paths.operationKey}.token-x.claim.0001`, `${dead}\n`, { flag: 'wx', mode: 0o600 })

    await expect(recoverOrphanedPageAppLock(profile)).resolves.toBeUndefined()
    expect(await readFile(`${paths.operationKey}.token-x.claim.0002`, 'utf8')).toBe(`${process.pid}\n`)
  })

  it('treats a legacy fixed-path claim as generation 0 and continues at 0001 when it is dead', async () => {
    const profile = await scratch()
    const paths = resolvePageAppProfilePaths(profile)
    await mkdir(paths.directory, { recursive: true })
    await writeFile(paths.journal, journal('token-x'), { flag: 'wx', mode: 0o600 })
    const dead = await deadPid()
    await writeFile(`${paths.operationKey}.token-x.claim`, `${dead}\n`, { flag: 'wx', mode: 0o600 })

    await expect(recoverOrphanedPageAppLock(profile)).resolves.toBeUndefined()
    expect(await readFile(`${paths.operationKey}.token-x.claim.0001`, 'utf8')).toBe(`${process.pid}\n`)
    // The legacy claim occupies generation 0; no .0000 generation was created.
    await expect(stat(`${paths.operationKey}.token-x.claim.0000`)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('fails closed when a legacy fixed-path claim coexists with chain generation 0000', async () => {
    const profile = await scratch()
    const paths = resolvePageAppProfilePaths(profile)
    await mkdir(paths.directory, { recursive: true })
    await writeFile(paths.journal, journal('token-x'), { flag: 'wx', mode: 0o600 })
    const dead = await deadPid()
    await writeFile(`${paths.operationKey}.token-x.claim`, `${dead}\n`, { flag: 'wx', mode: 0o600 })
    await writeFile(`${paths.operationKey}.token-x.claim.0000`, `${dead}\n`, { flag: 'wx', mode: 0o600 })

    await expect(recoverOrphanedPageAppLock(profile)).rejects.toThrow(/ambiguous|repair/i)
    expect((await readdir(paths.directory)).filter(name => name.startsWith('operation.lock.token-x.claim')).sort())
      .toEqual(['operation.lock.token-x.claim', 'operation.lock.token-x.claim.0000'])
  })

  it('fails closed when the legacy fixed-path claim is live', async () => {
    const profile = await scratch()
    const paths = resolvePageAppProfilePaths(profile)
    await mkdir(paths.directory, { recursive: true })
    await writeFile(paths.journal, journal('token-x'), { flag: 'wx', mode: 0o600 })
    await writeFile(`${paths.operationKey}.token-x.claim`, `${process.pid}\n`, { flag: 'wx', mode: 0o600 })

    await expect(recoverOrphanedPageAppLock(profile)).rejects.toThrow(/already claimed|recoverer/i)
    expect((await readdir(paths.directory)).filter(name => name.startsWith('operation.lock.token-x.claim')).sort())
      .toEqual(['operation.lock.token-x.claim'])
  })

  it('rejects unsafe owner tokens at acquisition and never creates the lock', async () => {
    const profile = await scratch()
    const paths = resolvePageAppProfilePaths(profile)
    for (const token of ['../evil', 'a/b', 'a\\b', '..', '', 'token with space']) {
      await expect(withPageAppProfileLock(profile, { kind: 'manager', token }, async () => {})).rejects.toThrow(/token/i)
    }
    await expect(stat(paths.operationKey)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('fails closed on an unsafe token in a planted payload without touching anything outside', async () => {
    const profile = await scratch()
    const paths = resolvePageAppProfilePaths(profile)
    await mkdir(paths.directory, { recursive: true })
    await writeFile(paths.operationKey, lockPayload('manager', '../outside-evidence', await deadPid()), { flag: 'wx', mode: 0o600 })
    await writeFile(paths.journal, journal('token-x'), { flag: 'wx', mode: 0o600 })

    await expect(recoverOrphanedPageAppLock(profile)).rejects.toThrow(/unreadable|token|payload/i)
    expect((await readdir(paths.directory)).sort()).toEqual(['operation.lock', 'transaction.json'])
    // No claim or quarantine path escaped the manager directory.
    await expect(stat(resolve(profile, '..', 'outside-evidence'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe.skipIf(process.platform !== 'win32')('case-insensitive filesystem aliases (win32)', () => {
  // On Windows the filesystem matches names case-insensitively while the claim
  // scan compares them case-sensitively: a claim written with a different case
  // (e.g. by a tool that capitalized the lock name) is invisible to the scan,
  // yet an exclusive create of the canonical name conflicts with it. Recovery
  // must fail closed instead of retrying the same EEXIST forever.
  it('fails closed on a case-aliased claim generation instead of retrying forever', { timeout: 20_000 }, async () => {
    const profile = await scratch()
    const paths = resolvePageAppProfilePaths(profile)
    await mkdir(paths.directory, { recursive: true, mode: 0o700 })
    await writeFile(paths.journal, journal('token-x'), { flag: 'wx', mode: 0o600 })
    const dead = await deadPid()
    const alias = join(paths.directory, 'Operation.lock.token-x.claim.0000')
    await writeFile(alias, `${dead}\n`, { flag: 'wx', mode: 0o600 })

    await expect(settlesWithin(recoverOrphanedPageAppLock(profile), 3_000))
      .rejects.toThrow(/case-aliased|unchanged|repair/i)
    // Nothing was created or removed: the alias stays and no canonical claim
    // generation exists.
    expect((await readdir(paths.directory)).filter(name => name.includes('.claim')))
      .toEqual(['Operation.lock.token-x.claim.0000'])
  })

  it('fails closed on a case-aliased legacy fixed-path claim', { timeout: 20_000 }, async () => {
    const profile = await scratch()
    const paths = resolvePageAppProfilePaths(profile)
    await mkdir(paths.directory, { recursive: true, mode: 0o700 })
    await writeFile(paths.journal, journal('token-x'), { flag: 'wx', mode: 0o600 })
    const dead = await deadPid()
    const alias = join(paths.directory, 'Operation.lock.token-x.claim')
    await writeFile(alias, `${dead}\n`, { flag: 'wx', mode: 0o600 })

    await expect(settlesWithin(recoverOrphanedPageAppLock(profile), 3_000))
      .rejects.toThrow(/case-aliased|unchanged|repair/i)
    expect((await readdir(paths.directory)).filter(name => name.includes('.claim')))
      .toEqual(['Operation.lock.token-x.claim'])
  })

  it('fails closed on a case-aliased lock payload naming an unsafe claim path', { timeout: 20_000 }, async () => {
    // A dead lock whose payload token would name a claim chain that already
    // exists under a case-aliased name: quarantine recovery must fail closed
    // rather than spin on the claim create.
    const profile = await scratch()
    const paths = resolvePageAppProfilePaths(profile)
    await mkdir(paths.directory, { recursive: true, mode: 0o700 })
    const dead = await deadPid()
    await writeFile(paths.operationKey, lockPayload('manager', 'token-x', dead), { flag: 'wx', mode: 0o600 })
    await writeFile(paths.journal, journal('token-x'), { flag: 'wx', mode: 0o600 })
    await writeFile(join(paths.directory, 'Operation.lock.token-x.claim.0000'), `${dead}\n`, { flag: 'wx', mode: 0o600 })

    await expect(settlesWithin(recoverOrphanedPageAppLock(profile), 3_000))
      .rejects.toThrow(/case-aliased|unchanged|repair/i)
    expect((await readdir(paths.directory)).filter(name => name.includes('.claim')))
      .toEqual(['Operation.lock.token-x.claim.0000'])
    // The lock was never quarantined: the claim conflict stopped recovery.
    await expect(stat(paths.operationKey)).resolves.toBeDefined()
  })
})

describe('recovery claim conflicts invisible to the scan', () => {
  // Simulates the case-insensitive filesystem behavior on every platform: the
  // conflicting file is hidden from readdir (so the scan state never changes)
  // while the exclusive create answers EEXIST. The acquisition loop must fail
  // closed on the unchanged scan instead of retrying forever.
  it('fails closed when an exclusive claim create EEXISTs with an unchanged scan', { timeout: 20_000 }, async () => {
    const profile = await scratch()
    const paths = resolvePageAppProfilePaths(profile)
    await mkdir(paths.directory, { recursive: true, mode: 0o700 })
    await writeFile(paths.journal, journal('token-x'), { flag: 'wx', mode: 0o600 })
    const dead = await deadPid()
    await writeFile(`${paths.operationKey}.token-x.claim.0000`, `${dead}\n`, { flag: 'wx', mode: 0o600 })

    fsState.armHideClaimFiles = true
    fsState.armEexistOnClaimWrite = true
    await expect(settlesWithin(recoverOrphanedPageAppLock(profile), 3_000))
      .rejects.toThrow(/unchanged|repair/i)
    // No chain generation was created; the planted claim stays untouched.
    // Disarm the readdir mask first so the assertion sees the real directory.
    fsState.armHideClaimFiles = false
    expect((await readdir(paths.directory)).filter(name => name.includes('.claim')))
      .toEqual(['operation.lock.token-x.claim.0000'])
  })
})
