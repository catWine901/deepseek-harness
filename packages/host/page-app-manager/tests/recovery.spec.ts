/**
 * Recovery-table tests: durable journal/file-state pairs decide the outcome —
 * complete-commit, restore-before-state, and fail-closed conflict/recovery.
 * The manager never guesses when both recorded sides changed.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProfileRuntime, ProfileRuntimeApplyRequest } from '@deepseek-ai/dsh-app-boot'
import { recoverPageAppTransaction } from '../src/recovery.ts'
import type { PageAppPackageExecutor } from '../src/executor.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dsh-page-app-recovery-'))
  mkdirSync(join(dir, '.workspace-manager'), { recursive: true })
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const registryPath = (): string => join(dir, '.workspace-manager', 'registry.json')
const layerPath = (): string => join(dir, '.workspace-manager', 'runtime-layer.yml')
const journalPath = (): string => join(dir, '.workspace-manager', 'transaction.json')

const hashOf = (content: string): string => createHash('sha256').update(content).digest('hex')

function writeRegistry(content: string): void {
  writeFileSync(registryPath(), content)
}

function writeJournal(phase: 'prepared' | 'staged' | 'committing', beforeRegistry: string | null): void {
  const files: Record<string, { present: boolean; sha256?: string }> = {
    'registry.json': beforeRegistry === null ? { present: false } : { present: true, sha256: hashOf(beforeRegistry) },
    'runtime-layer.yml': { present: true, sha256: hashOf('[]\n') },
    '../package.json': { present: true, sha256: hashOf('{}\n') },
    '../pnpm-lock.yaml': { present: false },
  }
  // The journal records before-state; recovery restores from the private
  // backups the transaction wrote before any mutation.
  if (beforeRegistry !== null) writeFileSync(`${registryPath()}.backup`, beforeRegistry)
  writeFileSync(`${layerPath()}.backup`, '[]\n')
  writeFileSync(join(dir, 'package.json.backup'), '{}\n')
  writeFileSync(journalPath(), JSON.stringify({ schemaVersion: 1, phase, lockOwnerToken: 'token-1', files }))
}

function executorConvergence(exitCode: number): { executor: PageAppPackageExecutor; calls: { install: number } } {
  const calls = { install: 0 }
  return {
    calls,
    executor: {
      run: async (args) => {
        if (args[0] === 'install') calls.install += 1
        return { exitCode, stdout: '', stderr: exitCode === 0 ? '' : 'convergence failed' }
      },
    },
  }
}

/** A runtime whose restore/apply always acknowledge (used by the existing recovery-table cases). */
function restoreOkRuntime(): ProfileRuntime {
  return {
    identity: { name: 'fixture-profile', directory: dir },
    applyManagerLayer: async () => ({ generation: 1, activeRoots: [], externallyOverridden: [] }),
    restoreManagerLayer: async () => ({ generation: 1, activeRoots: [], externallyOverridden: [] }),
  } as unknown as ProfileRuntime
}

describe('transaction recovery', () => {
  it('reports none when no journal exists', async () => {
    expect(await recoverPageAppTransaction(dir, executorConvergence(0).executor, restoreOkRuntime())).toEqual({ action: 'none' })
  })

  it('completes a committed transaction: registry changed at committing → journal removed', async () => {
    writeRegistry('{ "committed": true }')
    writeJournal('committing', '{ "before": true }')
    expect(await recoverPageAppTransaction(dir, executorConvergence(0).executor, restoreOkRuntime())).toEqual({ action: 'commit-completed' })
    expect(() => readFileSync(journalPath(), 'utf8')).toThrow()
  })

  it('restores before-state when the registry is unchanged (no commit), then clears the journal', async () => {
    const before = '{ "revision": 0, "entries": [] }'
    writeRegistry(before)
    writeJournal('staged', before)
    // A staged layer that must be rolled back.
    writeFileSync(layerPath(), 'staged-but-uncommitted')
    writeFileSync(`${layerPath()}.backup`, '[]\n')
    const { executor, calls } = executorConvergence(0)
    const outcome = await recoverPageAppTransaction(dir, executor, restoreOkRuntime())
    expect(outcome).toEqual({ action: 'restored' })
    expect(readFileSync(layerPath(), 'utf8')).toBe('[]\n')
    expect(calls.install).toBe(1)
    expect(() => readFileSync(journalPath(), 'utf8')).toThrow()
  })

  it('fails closed when the registry changed at a pre-commit phase (conflict, never guess)', async () => {
    writeRegistry('{ "changed": true }')
    writeJournal('prepared', '{ "before": true }')
    const outcome = await recoverPageAppTransaction(dir, executorConvergence(0).executor, restoreOkRuntime())
    expect(outcome.action).toBe('recovery-required')
    expect(outcome.message).toMatch(/phase "prepared"/)
  })

  it('fails closed when the registry is unreadable and the journal says it existed', async () => {
    writeJournal('staged', '{ "before": true }')
    const outcome = await recoverPageAppTransaction(dir, executorConvergence(0).executor, restoreOkRuntime())
    expect(outcome.action).toBe('recovery-required')
    expect(outcome.message).toMatch(/unreadable/)
  })

  it('retains the journal and reports recovery-required when convergence fails', async () => {
    const before = '{ "revision": 0, "entries": [] }'
    writeRegistry(before)
    writeJournal('staged', before)
    const outcome = await recoverPageAppTransaction(dir, executorConvergence(1).executor, restoreOkRuntime())
    expect(outcome.action).toBe('recovery-required')
    expect(outcome.message).toMatch(/convergence failed/)
    // Journal retained.
    expect(readFileSync(journalPath(), 'utf8')).toContain('token-1')
  })

  it('restores the live layer before converging on restore-before-state', async () => {
    const before = '{ "schemaVersion": 1, "revision": 3, "entries": [] }'
    writeRegistry(before)
    writeJournal('staged', before)
    const order: string[] = []
    const restoreSpy = vi.fn(async (_request: ProfileRuntimeApplyRequest) => {
      order.push('restore')
      return { generation: 1, activeRoots: [], externallyOverridden: [] }
    })
    const runtime = {
      identity: { name: 'fixture-profile', directory: dir },
      restoreManagerLayer: restoreSpy,
    } as unknown as ProfileRuntime
    const executor: PageAppPackageExecutor = {
      run: async () => {
        order.push('converge')
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    }
    const outcome = await recoverPageAppTransaction(dir, executor, runtime)
    expect(outcome).toEqual({ action: 'restored' })
    expect(order).toEqual(['restore', 'converge'])
    const request = restoreSpy.mock.calls[0]?.[0] as ProfileRuntimeApplyRequest
    expect(request.registryRevision).toBe(3)
    expect(request.runtimeLayer).toBe('[]\n')
    expect(request.expectedRoots).toEqual([])
  })

  it('runs recovery under the shared profile lock', async () => {
    const before = '{ "revision": 0, "entries": [] }'
    writeRegistry(before)
    writeJournal('staged', before)
    const lockPath = join(dir, '.workspace-manager', 'operation.lock')
    let sawManagerLock = false
    const executor: PageAppPackageExecutor = {
      run: async (args) => {
        if (args[0] === 'install') {
          sawManagerLock = existsSync(lockPath)
            && (JSON.parse(readFileSync(lockPath, 'utf8')) as { ownerKind: string }).ownerKind === 'manager'
        }
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    }
    const outcome = await recoverPageAppTransaction(dir, executor, restoreOkRuntime())
    expect(outcome).toEqual({ action: 'restored' })
    expect(sawManagerLock).toBe(true)
  })

  it('keeps the journal and reports recovery-required when the layer audit fails', async () => {
    const before = '{ "revision": 0, "entries": [] }'
    writeRegistry(before)
    writeJournal('staged', before)
    const runtime = {
      identity: { name: 'fixture-profile', directory: dir },
      restoreManagerLayer: async () => { throw new Error('restore audit failed: root did not mount') },
    } as unknown as ProfileRuntime
    const outcome = await recoverPageAppTransaction(dir, executorConvergence(0).executor, runtime)
    expect(outcome.action).toBe('recovery-required')
    expect(outcome.message).toMatch(/restore audit failed/)
    // Journal retained.
    expect(readFileSync(journalPath(), 'utf8')).toContain('token-1')
  })
})
