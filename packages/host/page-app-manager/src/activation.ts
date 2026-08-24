/**
 * Targeted client activation acknowledgement: install publishes the registry
 * only after the FIRST valid acknowledgement from the opaque initiating client
 * instance. Every connected browser may reconcile the graph, but only the
 * targeted controller may acknowledge the transaction; stale transactions,
 * wrong instances, wrong package/page/revision, and second acknowledgements
 * are rejected (spec §10.1).
 * @module @deepseek-ai/dsh-page-app-manager/activation
 */

import type {
  ActivationAcknowledgement, ClientActivationRequest, PageAppClientInstanceId, PageAppTransactionId,
} from './types.ts'

/**
 * One-shot activation gate. The manager opens it with the pending request
 * before applying the runtime layer; the first acknowledgement that matches
 * every field settles it. The gate is single-shot per transaction: it is
 * discarded after the transaction ends (success, rollback, or abort).
 */
export class PageAppActivationGate {
  private request: ClientActivationRequest | undefined
  private settled = false
  private readonly waiters: Array<{
    resolve: (request: ClientActivationRequest) => void
    reject: (error: Error) => void
    signal: AbortSignal
    onAbort: () => void
    timer: ReturnType<typeof setTimeout> | undefined
  }> = []

  /** Whether an activation is currently pending. */
  public get pending(): boolean {
    return this.request !== undefined && !this.settled
  }

  /** The pending request, when one exists (even after settlement). */
  public get pendingRequest(): ClientActivationRequest | undefined {
    return this.request
  }

  /**
   * Announce the pending activation. A second open without settlement throws —
   * one gate, one transaction.
   * @param request - the targeted activation request.
   * @throws {Error} when a request is already open.
   */
  public open(request: ClientActivationRequest): void {
    if (this.request !== undefined) {
      throw new Error('page-app activation: gate already has a pending request')
    }
    this.request = request
  }

  /**
   * Wait for the first valid acknowledgement, bounded by a Host timeout.
   * Rejects when the gate is discarded before any acknowledgement arrives,
   * when the signal aborts, or when the timeout elapses first — a vanished
   * client can never hold the profile lock indefinitely in a live process.
   * @param signal - cancellation; an aborted wait rejects.
   * @param timeoutMs - Host cap on the settlement wait; elapsing rejects.
   * @returns the settled request.
   */
  public awaitSettlement(signal: AbortSignal, timeoutMs: number): Promise<ClientActivationRequest> {
    return new Promise<ClientActivationRequest>((resolve, reject) => {
      if (this.request === undefined) {
        reject(new Error('page-app activation: no pending activation to await'))
        return
      }
      if (this.settled) {
        resolve(this.request)
        return
      }
      if (signal.aborted) {
        reject(new Error('page-app activation: settlement wait aborted'))
        return
      }
      const onTimeout = (): void => {
        signal.removeEventListener('abort', onAbort)
        reject(new Error('page-app activation: settlement wait timed out'))
      }
      const timer = setTimeout(onTimeout, timeoutMs)
      const onAbort = (): void => {
        clearTimeout(timer)
        reject(new Error('page-app activation: settlement wait aborted'))
      }
      signal.addEventListener('abort', onAbort, { once: true })
      this.waiters.push({ resolve, reject, signal, onAbort, timer })
    })
  }

  /**
   * Try to settle the transaction with one client acknowledgement. Only the
   * first acknowledgement matching the pending request (transaction id,
   * client instance, package, page, revision) is accepted; anything else is
   * refused with its reason.
   * @param transactionId - the acknowledgement's transaction id.
   * @param clientInstanceId - the acknowledging client instance.
   * @param packageName - the acknowledged package.
   * @param pageId - the acknowledged page id.
   * @param graphRevision - the graph revision the client converged to.
   * @returns whether this attempt settled the gate.
   */
  public acknowledge(
    transactionId: PageAppTransactionId,
    clientInstanceId: PageAppClientInstanceId,
    packageName: string,
    pageId: string,
    graphRevision: string,
  ): ActivationAcknowledgement {
    const request = this.request
    if (request === undefined || this.settled) {
      return { accepted: false, reason: 'stale' }
    }
    if (clientInstanceId !== request.clientInstanceId) {
      return { accepted: false, reason: 'wrong-client' }
    }
    if (transactionId !== request.transactionId
      || packageName !== request.packageName
      || pageId !== request.pageId
      || graphRevision !== request.graphRevision) {
      return { accepted: false, reason: 'wrong-target' }
    }
    this.settled = true
    const waiters = this.waiters.splice(0)
    for (const waiter of waiters) {
      waiter.signal.removeEventListener('abort', waiter.onAbort)
      if (waiter.timer !== undefined) clearTimeout(waiter.timer)
      waiter.resolve(request)
    }
    return { accepted: true }
  }

  /** Discard the gate (rollback/abort path): pending waiters reject. */
  public discard(): void {
    this.request = undefined
    this.settled = false
    const waiters = this.waiters.splice(0)
    for (const waiter of waiters) {
      waiter.signal.removeEventListener('abort', waiter.onAbort)
      if (waiter.timer !== undefined) clearTimeout(waiter.timer)
      waiter.reject(new Error('page-app activation: gate discarded before settlement'))
    }
  }
}
