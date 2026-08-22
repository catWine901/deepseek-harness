import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { recoverOrphanedPageAppLock, withPageAppProfileLock } from '../src/lock.ts'
import { resolvePageAppProfilePaths } from '../src/paths.ts'

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

afterEach(() => {
  vi.restoreAllMocks()
})

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
      .toEqual(['operation.lock.token-x.claim', 'operation.lock.token-x.quarantine', 'transaction.json'])
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

    let callbackRuns = 0
    const recover = async (): Promise<void> => {
      await recoverOrphanedPageAppLock(profile)
      await withPageAppProfileLock(profile, { kind: 'manager', token: 'recoverer' }, async () => {
        callbackRuns += 1
        await new Promise(resolve => setTimeout(resolve, 30))
      })
    }

    const results = await Promise.allSettled([recover(), recover()])

    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1)
    expect(callbackRuns).toBe(1)
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
    await writeFile(`${paths.operationKey}.token-x.claim`, `${process.pid}\n`, { flag: 'wx', mode: 0o600 })

    await expect(recoverOrphanedPageAppLock(profile)).rejects.toThrow(/already claimed|recoverer/i)
  })

  it('proceeds to complete recovery when the recorded claimant is provably dead', async () => {
    const profile = await scratch()
    const paths = resolvePageAppProfilePaths(profile)
    await mkdir(paths.directory, { recursive: true })
    await writeFile(paths.journal, journal('token-x'), { flag: 'wx', mode: 0o600 })
    const dead = await deadPid()
    await writeFile(`${paths.operationKey}.token-x.claim`, `${dead}\n`, { flag: 'wx', mode: 0o600 })

    await expect(recoverOrphanedPageAppLock(profile)).resolves.toBeUndefined()
  })
})
