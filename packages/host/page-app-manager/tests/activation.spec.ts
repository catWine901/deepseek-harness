/**
 * Targeted client activation acknowledgement gate: the first valid
 * acknowledgement settles the install, and the settlement wait is bounded by a
 * Host timeout and by the caller's AbortSignal. A timeout rejects the wait the
 * same way an abort does; discard rejects every pending waiter and clears its
 * abort listeners and timers, so a vanished client can never hold the profile
 * lock indefinitely in a live process.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PageAppActivationGate } from '../src/activation.ts'
import type { ClientActivationRequest } from '../src/types.ts'

const request: ClientActivationRequest = {
  transactionId: 'txn-1' as never,
  clientInstanceId: 'client-1' as never,
  packageName: '@fixture/valid-workspace',
  pageId: 'workspace.valid',
  graphRevision: 'graph-rev-1',
}

afterEach(() => {
  vi.useRealTimers()
})

describe('activation settlement gate', () => {
  it('resolves on the first valid acknowledgement before the timeout', async () => {
    const gate = new PageAppActivationGate()
    gate.open(request)
    const promise = gate.awaitSettlement(new AbortController().signal, 5_000)
    const result = gate.acknowledge(
      request.transactionId, request.clientInstanceId, request.packageName, request.pageId, request.graphRevision,
    )
    expect(result).toEqual({ accepted: true })
    await expect(promise).resolves.toEqual(request)
    gate.discard()
  })

  it('rejects the settlement wait when the timeout elapses', async () => {
    vi.useFakeTimers()
    const gate = new PageAppActivationGate()
    gate.open(request)
    const waiter = gate.awaitSettlement(new AbortController().signal, 100)
    expect(vi.getTimerCount()).toBe(1)
    vi.advanceTimersByTime(100)
    await expect(waiter).rejects.toThrow(/settlement wait timed out/)
    // The waiter's timer and abort listener were released.
    expect(vi.getTimerCount()).toBe(0)
  })

  it('rejects on abort before the timeout', async () => {
    const controller = new AbortController()
    const gate = new PageAppActivationGate()
    gate.open(request)
    const promise = gate.awaitSettlement(controller.signal, 5_000)
    controller.abort()
    await expect(promise).rejects.toThrow(/settlement wait aborted/)
    gate.discard()
  })

  it('discard rejects pending waiters and clears listeners', async () => {
    vi.useFakeTimers()
    const gate = new PageAppActivationGate()
    const controller = new AbortController()
    gate.open(request)
    const waiter = gate.awaitSettlement(controller.signal, 1_000)
    expect(vi.getTimerCount()).toBe(1)
    gate.discard()
    await expect(waiter).rejects.toThrow(/gate discarded before settlement/)
    // No waiter retains a timer, and the removed abort listener is a no-op.
    expect(vi.getTimerCount()).toBe(0)
    controller.abort()
  })
})
