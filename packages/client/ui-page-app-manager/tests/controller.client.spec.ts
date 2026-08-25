// PageAppController state machine and targeted activation flow: first visit,
// stable visited order, hidden-active fallback to DSH without eviction,
// disable/uninstall eviction, registry invalidation of current selection, and
// the closed activation acknowledgement contract (spec §10.1 step 8, §14).
import { describe, expect, it } from 'vitest'
import type { PageAppActivationRequestedEvent, PageAppClientInstanceId, PageAppInstallSource } from '@deepseek-ai/dsh-page-app-manager/types'
import { PageAppController, type PageAppControllerDeps } from '../src/client/controller.ts'
import type { PageAppRemoteResult } from '../src/client/contracts.ts'
import { parsePageAppInstallSourceClient } from '../src/client/source.ts'
import {
  FakeRemote, FakeSlots, deferred, err, fakeEntry, fakeRow, fakeSnapshot, ok,
} from './fake-page-app.client.ts'

/** Build a started controller and flush the initial list. */
async function harness(remote: FakeRemote, slots: FakeSlots, clientInstanceId = 'client-a'): Promise<{
  controller: PageAppController
  dispose: () => void
  graphResolvers: Array<() => void>
}> {
  const graphResolvers: Array<() => void> = []
  const deps: PageAppControllerDeps = {
    remote,
    slots,
    clientInstanceId: clientInstanceId as PageAppClientInstanceId,
    awaitGraphRevision: (graphRevision: string) => {
      const gate = deferred<undefined>()
      graphResolvers.push(() => { gate.resolve(undefined) })
      void graphRevision
      return gate.promise
    },
    cancelGraphWait: () => {},
  }
  const controller = new PageAppController(deps)
  const dispose = controller.start()
  await flush()
  return { controller, dispose, graphResolvers }
}

/** A pending activation event fixture. */
function activationEvent(over: Partial<PageAppActivationRequestedEvent> = {}): PageAppActivationRequestedEvent {
  return {
    transactionId: 'tx-1',
    clientInstanceId: 'client-a',
    packageName: '@scope/app',
    pageId: 'page-a',
    graphRevision: 'layer-1',
    ...over,
  }
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

/** One validated install-source fixture. */
function installSource(): PageAppInstallSource {
  return parsePageAppInstallSourceClient('@example/script-workspace')
}

describe('state machine', () => {
  it('records first visit and keeps a stable first-visit order', async () => {
    const remote = new FakeRemote()
    const slots = new FakeSlots()
    remote.onList = () => Promise.resolve(ok(fakeSnapshot([
      fakeRow({ packageName: '@scope/a', pageId: 'page-a', enabled: true }),
      fakeRow({ packageName: '@scope/b', pageId: 'page-b', enabled: true }),
      fakeRow({ packageName: '@scope/c', pageId: 'page-c', enabled: true }),
    ])))
    slots.setEntries([
      fakeEntry('page-a', '@scope/a'),
      fakeEntry('page-b', '@scope/b'),
      fakeEntry('page-c', '@scope/c'),
    ])
    const { controller, dispose } = await harness(remote, slots)
    controller.select('page-b')
    controller.select('page-a')
    controller.select('page-c')
    controller.select('page-b') // revisit must NOT reorder
    const snap = controller.observable.getSnapshot()
    expect(snap.visitedPageIds).toEqual(['page-b', 'page-a', 'page-c'])
    expect(snap.activePageId).toBe('page-b')
    dispose()
  })

  it('never evicts a hidden page from visited, but falls the active selection back to DSH', async () => {
    const remote = new FakeRemote()
    const slots = new FakeSlots()
    remote.onList = () => Promise.resolve(ok(fakeSnapshot([
      fakeRow({ packageName: '@scope/a', pageId: 'page-a', enabled: true, hidden: false }),
    ])))
    slots.setEntries([fakeEntry('page-a', '@scope/a')])
    const { controller, dispose } = await harness(remote, slots)
    controller.select('page-a')
    expect(controller.observable.getSnapshot().activePageId).toBe('page-a')
    // The row becomes hidden: active falls back to DSH, visited survives.
    remote.onList = () => Promise.resolve(ok(fakeSnapshot([
      fakeRow({ packageName: '@scope/a', pageId: 'page-a', enabled: true, hidden: true }),
    ])))
    await controller.setHidden('page-a', true)
    const snap = controller.observable.getSnapshot()
    expect(snap.activePageId).toBeNull()
    expect(snap.visitedPageIds).toEqual(['page-a'])
    dispose()
  })

  it('evicts a disabled page from visited and falls the active selection back to DSH', async () => {
    const remote = new FakeRemote()
    const slots = new FakeSlots()
    remote.onList = () => Promise.resolve(ok(fakeSnapshot([
      fakeRow({ packageName: '@scope/a', pageId: 'page-a', enabled: true }),
    ])))
    slots.setEntries([fakeEntry('page-a', '@scope/a')])
    const { controller, dispose } = await harness(remote, slots)
    controller.select('page-a')
    remote.onList = () => Promise.resolve(ok(fakeSnapshot([
      fakeRow({ packageName: '@scope/a', pageId: 'page-a', enabled: false }),
    ])))
    await controller.setEnabled('page-a', false, new AbortController().signal)
    const snap = controller.observable.getSnapshot()
    expect(snap.activePageId).toBeNull()
    expect(snap.visitedPageIds).toEqual([])
    expect(snap.eligible.size).toBe(0)
    dispose()
  })

  it('evicts an uninstalled page from visited and the eligible set', async () => {
    const remote = new FakeRemote()
    const slots = new FakeSlots()
    remote.onList = () => Promise.resolve(ok(fakeSnapshot([
      fakeRow({ packageName: '@scope/a', pageId: 'page-a', enabled: true }),
    ])))
    slots.setEntries([fakeEntry('page-a', '@scope/a')])
    const { controller, dispose } = await harness(remote, slots)
    controller.select('page-a')
    remote.onList = () => Promise.resolve(ok(fakeSnapshot([])))
    await controller.uninstall('page-a', new AbortController().signal)
    const snap = controller.observable.getSnapshot()
    expect(snap.activePageId).toBeNull()
    expect(snap.visitedPageIds).toEqual([])
    expect(snap.eligible.size).toBe(0)
    dispose()
  })

  it('records an abdicated managed surface and clears the failure on select (retry) and eviction', async () => {
    const remote = new FakeRemote()
    const slots = new FakeSlots()
    remote.onList = () => Promise.resolve(ok(fakeSnapshot([
      fakeRow({ packageName: '@scope/a', pageId: 'page-a', enabled: true }),
    ])))
    slots.setEntries([fakeEntry('page-a', '@scope/a')])
    const { controller, dispose } = await harness(remote, slots)
    // A managed surface abdicates: the controller records the failed page.
    controller.recordEntryError('page-a')
    expect(controller.observable.getSnapshot().failedPageIds).toEqual(['page-a'])
    // Retry = re-select: the failure record clears so the shell remounts.
    controller.select('page-a')
    expect(controller.observable.getSnapshot().failedPageIds).toEqual([])
    // A disabled/uninstalled page's failure record dies with its eviction.
    controller.recordEntryError('page-a')
    remote.onList = () => Promise.resolve(ok(fakeSnapshot([])))
    await controller.uninstall('page-a', new AbortController().signal)
    expect(controller.observable.getSnapshot().failedPageIds).toEqual([])
    dispose()
  })

  it('evicts the visited page when the registry drops the row (external commit or reload)', async () => {
    const remote = new FakeRemote()
    const slots = new FakeSlots()
    remote.onList = () => Promise.resolve(ok(fakeSnapshot([
      fakeRow({ packageName: '@scope/a', pageId: 'page-a', enabled: true }),
    ])))
    slots.setEntries([fakeEntry('page-a', '@scope/a')])
    const { controller, dispose } = await harness(remote, slots)
    controller.select('page-a')
    // The registry is re-read from the remote and no longer contains the row.
    remote.onList = () => Promise.resolve(ok(fakeSnapshot([])))
    await controller.recover()
    const snap = controller.observable.getSnapshot()
    expect(snap.activePageId).toBeNull()
    expect(snap.visitedPageIds).toEqual([])
    dispose()
  })

  it('falls the active selection back to DSH but keeps visited when only the registry list fails', async () => {
    const remote = new FakeRemote()
    const slots = new FakeSlots()
    remote.onList = () => Promise.resolve(ok(fakeSnapshot([
      fakeRow({ packageName: '@scope/a', pageId: 'page-a', enabled: true }),
    ])))
    slots.setEntries([fakeEntry('page-a', '@scope/a')])
    const { controller, dispose } = await harness(remote, slots)
    controller.select('page-a')
    remote.onList = () => Promise.resolve(err('E_BROKEN', 'boom'))
    await controller.recover()
    const snap = controller.observable.getSnapshot()
    expect(snap.activePageId).toBeNull()
    // A transient read failure must not evict visited pages.
    expect(snap.visitedPageIds).toEqual(['page-a'])
    dispose()
  })

  it('keeps the snapshot reference stable across slot-ledger noise', async () => {
    const remote = new FakeRemote()
    const slots = new FakeSlots()
    remote.onList = () => Promise.resolve(ok(fakeSnapshot([
      fakeRow({ packageName: '@scope/a', pageId: 'page-a', enabled: true }),
    ])))
    // Real ledger entries are stable frozen objects; the fake must reuse the
    // same reference across mutations for the stability assertion to hold.
    const contribution = fakeEntry('page-a', '@scope/a')
    slots.setEntries([contribution])
    const { controller, dispose } = await harness(remote, slots)
    const first = controller.observable.getSnapshot()
    // A slot mutation that changes no eligible facts must keep the reference.
    slots.setEntries([contribution])
    expect(controller.observable.getSnapshot()).toBe(first)
    dispose()
  })

  it('propagates the registry revision through the initial list', async () => {
    const remote = new FakeRemote()
    const slots = new FakeSlots()
    remote.onList = () => Promise.resolve(ok(fakeSnapshot([
      fakeRow({ packageName: '@scope/a', pageId: 'page-a', enabled: true }),
    ], 3)))
    slots.setEntries([fakeEntry('page-a', '@scope/a')])
    const { controller, dispose } = await harness(remote, slots)
    expect(controller.observable.getSnapshot().registry?.revision).toBe(3)
    dispose()
  })
})

describe('targeted activation acknowledgement', () => {
  it('reconciles the activation event on every client (activation view present)', async () => {
    const remote = new FakeRemote()
    const slots = new FakeSlots()
    remote.onList = () => Promise.resolve(ok(fakeSnapshot([])))
    const { controller, dispose } = await harness(remote, slots, 'client-other')
    remote.emitActivation(activationEvent())
    const snap = controller.observable.getSnapshot()
    expect(snap.activation).not.toBeNull()
    expect(snap.activation?.packageName).toBe('@scope/app')
    expect(snap.activation?.pageId).toBe('page-a')
    expect(snap.activation?.converged).toBe(false)
    dispose()
  })

  it('marks the activation converged after the client graph reconciles', async () => {
    const remote = new FakeRemote()
    const slots = new FakeSlots()
    remote.onList = () => Promise.resolve(ok(fakeSnapshot([])))
    const { controller, dispose, graphResolvers } = await harness(remote, slots, 'client-other')
    remote.emitActivation(activationEvent())
    expect(controller.observable.getSnapshot().activation?.converged).toBe(false)
    graphResolvers[0]?.()
    await flush()
    expect(controller.observable.getSnapshot().activation?.converged).toBe(true)
    dispose()
  })

  it('only the matching client instance sends acknowledgement', async () => {
    const remote = new FakeRemote()
    const slots = new FakeSlots()
    remote.onList = () => Promise.resolve(ok(fakeSnapshot([])))
    // Non-target client: sees the activation, never acks.
    const other = await harness(remote, slots, 'client-other')
    remote.emitActivation(activationEvent())
    resolveAll(other.graphResolvers)
    await flush()
    expect(remote.calls.filter(call => call.method === 'ackClientActivation')).toHaveLength(0)
    other.dispose()

    // Target client: acks once with the exact transaction/client/package/page/revision.
    const target = await harness(remote, slots, 'client-a')
    remote.emitActivation(activationEvent())
    resolveAll(target.graphResolvers)
    await flush()
    const acks = remote.calls.filter(call => call.method === 'ackClientActivation')
    expect(acks).toHaveLength(1)
    expect(acks[0]?.args).toEqual(['tx-1', 'client-a', '@scope/app', 'page-a', 'layer-1'])
    // The transaction settles: the activation view clears on this client.
    expect(target.controller.observable.getSnapshot().activation).toBeNull()
    target.dispose()
  })

  it('a refused acknowledgement is terminal and clears the pending view', async () => {
    const remote = new FakeRemote()
    const slots = new FakeSlots()
    remote.onList = () => Promise.resolve(ok(fakeSnapshot([])))
    remote.onAckClientActivation = () => Promise.resolve(ok({ accepted: false, reason: 'stale' }))
    const { controller, dispose, graphResolvers } = await harness(remote, slots, 'client-a')
    remote.emitActivation(activationEvent())
    resolveAll(graphResolvers)
    await flush()
    expect(controller.observable.getSnapshot().activation).toBeNull()
    dispose()
  })

  it('an acknowledgement failure keeps the transaction pending until the host settles it', async () => {
    const remote = new FakeRemote()
    const slots = new FakeSlots()
    remote.onList = () => Promise.resolve(ok(fakeSnapshot([])))
    remote.onAckClientActivation = () => Promise.resolve(err('E_TX', 'settled elsewhere'))
    const { controller, dispose, graphResolvers } = await harness(remote, slots, 'client-a')
    remote.emitActivation(activationEvent())
    resolveAll(graphResolvers)
    await flush()
    // The controller clears its local view; the host owns the terminal outcome.
    expect(controller.observable.getSnapshot().activation).toBeNull()
    dispose()
  })

  it('controller disposal cancels in-flight acknowledgement', async () => {
    const remote = new FakeRemote()
    const slots = new FakeSlots()
    remote.onList = () => Promise.resolve(ok(fakeSnapshot([])))
    const { controller, dispose, graphResolvers } = await harness(remote, slots, 'client-a')
    remote.emitActivation(activationEvent())
    dispose() // before the graph converges
    resolveAll(graphResolvers)
    await flush()
    // No acknowledgement may fire after disposal.
    expect(remote.calls.filter(call => call.method === 'ackClientActivation')).toHaveLength(0)
    expect(remote.calls.filter(call => call.method === 'list')).toHaveLength(1) // only the initial list
    expect(controller.observable.getSnapshot().activation).not.toBeNull()
  })

  it('a committed revision after acknowledgement clears the pending view on every client', async () => {
    const remote = new FakeRemote()
    const slots = new FakeSlots()
    remote.onList = () => Promise.resolve(ok(fakeSnapshot([
      fakeRow({ packageName: '@scope/app', pageId: 'page-a', enabled: true }),
    ])))
    slots.setEntries([fakeEntry('page-a', '@scope/app')])
    const { controller, dispose } = await harness(remote, slots, 'client-other')
    remote.emitActivation(activationEvent())
    expect(controller.observable.getSnapshot().activation).not.toBeNull()
    remote.emitChanged(2)
    await flush()
    expect(controller.observable.getSnapshot().activation).toBeNull()
    dispose()
  })
})

describe('real cancellation signals (M1.2, D8/D9)', () => {
  it('passes a real AbortController signal to install and aborts on controller disposal', async () => {
    const remote = new FakeRemote()
    const slots = new FakeSlots()
    // The install hangs until the test settles it; the remote honors the
    // signal it received (the real abort consumer of the mutation).
    const gate = deferred<undefined>()
    let installSignal: AbortSignal | undefined
    remote.onInstall = (source, clientInstanceId, signal) => {
      void source
      void clientInstanceId
      installSignal = signal
      return new Promise<PageAppRemoteResult<number>>((resolve, reject) => {
        signal.addEventListener('abort', () => { reject(new DOMException('The operation was aborted', 'AbortError')) }, { once: true })
        void gate.promise.then(() => { resolve(ok(2)) })
      })
    }
    const { controller, dispose } = await harness(remote, slots)
    const pending = controller.install(installSource(), new AbortController().signal)
    await Promise.resolve()
    // The remote received a REAL signal, not undefined (void-signal bug).
    expect(installSignal).toBeInstanceOf(AbortSignal)
    expect(installSignal?.aborted).toBe(false)
    // Controller disposal aborts the in-flight call through that signal.
    dispose()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('reaches the installPackage remote wire method, never the reserved install spelling', async () => {
    const remote = new FakeRemote()
    const slots = new FakeSlots()
    const { controller, dispose } = await harness(remote, slots)
    await controller.install(installSource(), new AbortController().signal)
    await flush()
    // The gateway namespace service reserves `install` on its prototype, so
    // the controller's install action must call the `installPackage` remote.
    expect(remote.calls.filter(call => call.method === 'installPackage')).toHaveLength(1)
    expect(remote.calls.filter(call => call.method === 'install')).toHaveLength(0)
    dispose()
  })

  it('aborts setEnabled and uninstall through the controller signal', async () => {
    const remote = new FakeRemote()
    const slots = new FakeSlots()
    const enableGate = deferred<undefined>()
    const uninstallGate = deferred<undefined>()
    remote.onSetEnabled = (_pageId, _enabled, signal) => new Promise<PageAppRemoteResult<number>>((resolve, reject) => {
      signal.addEventListener('abort', () => { reject(new DOMException('The operation was aborted', 'AbortError')) }, { once: true })
      void enableGate.promise.then(() => { resolve(ok(2)) })
    })
    remote.onUninstall = (_pageId, signal) => new Promise<PageAppRemoteResult<number>>((resolve, reject) => {
      signal.addEventListener('abort', () => { reject(new DOMException('The operation was aborted', 'AbortError')) }, { once: true })
      void uninstallGate.promise.then(() => { resolve(ok(2)) })
    })
    const { controller, dispose } = await harness(remote, slots)
    const external = new AbortController()
    const enable = controller.setEnabled('page-a', true, external.signal)
    const remove = controller.uninstall('page-b', external.signal)
    await Promise.resolve()
    // One external abort propagates to both in-flight mutations.
    external.abort()
    await expect(enable).rejects.toMatchObject({ name: 'AbortError' })
    await expect(remove).rejects.toMatchObject({ name: 'AbortError' })
    dispose()
  })

  it('a pre-aborted signal rejects the mutation without reaching the remote', async () => {
    const remote = new FakeRemote()
    const slots = new FakeSlots()
    const { controller, dispose } = await harness(remote, slots)
    const external = new AbortController()
    external.abort()
    await expect(controller.install(installSource(), external.signal))
      .rejects.toMatchObject({ name: 'AbortError' })
    // The remote was never asked: the mutation rejected before the call.
    expect(remote.calls.filter(call => call.method === 'installPackage')).toHaveLength(0)
    dispose()
  })
})

/** Resolve every pending graph-convergence wait. */
function resolveAll(graphResolvers: Array<() => void>): void {
  for (const resolve of graphResolvers.splice(0)) resolve()
}
