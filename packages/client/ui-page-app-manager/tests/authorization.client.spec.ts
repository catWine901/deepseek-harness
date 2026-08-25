// Closed authorization projection (spec §7): a surface contribution is
// eligible only when the registry owns the row, the row is enabled, the slot
// key equals the page id, the immutable ownerPackage equals the package name,
// and any pending activation names the same package, page id, and revision.
// Unrelated, wrong-provenance, duplicate, no-provenance, and runner-owned
// contributions are diagnosed but never projected.
import { describe, expect, it } from 'vitest'
import type { PageAppActivationRequestedEvent, PageAppClientInstanceId } from '@deepseek-ai/dsh-page-app-manager/types'
import { PageAppController, type PageAppControllerDeps } from '../src/client/controller.ts'
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

/** One pending activation event fixture. */
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

describe('closed authorization projection', () => {
  it('projects a row only when registry ownership, enabled, key, and ownerPackage all match', async () => {
    const remote = new FakeRemote()
    const slots = new FakeSlots()
    remote.onList = () => Promise.resolve(ok(fakeSnapshot([
      fakeRow({ packageName: '@scope/app', pageId: 'page-a', enabled: true }),
    ])))
    slots.setEntries([
      fakeEntry('page-a', '@scope/app'),
      // Unrelated plugin contribution: key matches but no registry row.
      fakeEntry('page-ghost', '@scope/other'),
    ])
    const { controller, dispose } = await harness(remote, slots)
    const snap = controller.observable.getSnapshot()
    expect(snap.registry).not.toBeNull()
    expect(snap.eligible.has('page-a')).toBe(true)
    expect(snap.eligible.has('page-ghost')).toBe(false)
    dispose()
  })

  it('never projects a disabled row even with a matching contribution', async () => {
    const remote = new FakeRemote()
    const slots = new FakeSlots()
    remote.onList = () => Promise.resolve(ok(fakeSnapshot([
      fakeRow({ packageName: '@scope/app', pageId: 'page-a', enabled: false }),
    ])))
    slots.setEntries([fakeEntry('page-a', '@scope/app')])
    const { controller, dispose } = await harness(remote, slots)
    expect(controller.observable.getSnapshot().eligible.has('page-a')).toBe(false)
    dispose()
  })

  it('never projects wrong-package provenance (key matches, owner differs)', async () => {
    const remote = new FakeRemote()
    const slots = new FakeSlots()
    remote.onList = () => Promise.resolve(ok(fakeSnapshot([
      fakeRow({ packageName: '@scope/app', pageId: 'page-a', enabled: true }),
    ])))
    slots.setEntries([fakeEntry('page-a', '@scope/other')])
    const { controller, dispose } = await harness(remote, slots)
    expect(controller.observable.getSnapshot().eligible.has('page-a')).toBe(false)
    dispose()
  })

  it('never projects a key that does not equal the page id', async () => {
    const remote = new FakeRemote()
    const slots = new FakeSlots()
    remote.onList = () => Promise.resolve(ok(fakeSnapshot([
      fakeRow({ packageName: '@scope/app', pageId: 'page-a', enabled: true }),
    ])))
    slots.setEntries([fakeEntry('page-b', '@scope/app')])
    const { controller, dispose } = await harness(remote, slots)
    expect(controller.observable.getSnapshot().eligible.has('page-a')).toBe(false)
    expect(controller.observable.getSnapshot().eligible.has('page-b')).toBe(false)
    dispose()
  })

  it('never projects duplicate contributions (diagnosed, not adopted)', async () => {
    const remote = new FakeRemote()
    const slots = new FakeSlots()
    remote.onList = () => Promise.resolve(ok(fakeSnapshot([
      fakeRow({ packageName: '@scope/app', pageId: 'page-a', enabled: true }),
    ])))
    slots.setEntries([
      fakeEntry('page-a', '@scope/app'),
      fakeEntry('page-a', '@scope/app'),
    ])
    const { controller, dispose } = await harness(remote, slots)
    expect(controller.observable.getSnapshot().eligible.has('page-a')).toBe(false)
    dispose()
  })

  it('never projects a no-provenance fiber (ownerPackage absent)', async () => {
    const remote = new FakeRemote()
    const slots = new FakeSlots()
    remote.onList = () => Promise.resolve(ok(fakeSnapshot([
      fakeRow({ packageName: '@scope/app', pageId: 'page-a', enabled: true }),
    ])))
    slots.setEntries([fakeEntry('page-a', undefined)])
    const { controller, dispose } = await harness(remote, slots)
    expect(controller.observable.getSnapshot().eligible.has('page-a')).toBe(false)
    dispose()
  })

  it('never projects a runner-owned contribution (runner package, not the registry row)', async () => {
    const remote = new FakeRemote()
    const slots = new FakeSlots()
    remote.onList = () => Promise.resolve(ok(fakeSnapshot([
      fakeRow({ packageName: '@scope/app', pageId: 'page-a', enabled: true }),
    ])))
    // cordis-client-runner mounts dynamic packages under its own Loader entry,
    // so the ledger attributes the contribution to the runner package name.
    slots.setEntries([fakeEntry('page-a', '@deepseek-ai/dsh-cordis-client-runner')])
    const { controller, dispose } = await harness(remote, slots)
    expect(controller.observable.getSnapshot().eligible.has('page-a')).toBe(false)
    dispose()
  })

  it('fails closed to an empty projection when the registry list fails', async () => {
    const remote = new FakeRemote()
    const slots = new FakeSlots()
    remote.onList = () => Promise.resolve(ok(fakeSnapshot([
      fakeRow({ packageName: '@scope/app', pageId: 'page-a', enabled: true }),
    ])))
    slots.setEntries([fakeEntry('page-a', '@scope/app')])
    const { controller, dispose } = await harness(remote, slots)
    expect(controller.observable.getSnapshot().registry).not.toBeNull()
    // The next refresh fails: the snapshot must surface null registry and an
    // empty eligible map (fail-closed), not stale rows.
    remote.onList = () => Promise.resolve(err('E_BROKEN', 'boom'))
    await controller.recover()
    const snap = controller.observable.getSnapshot()
    expect(snap.registry).toBeNull()
    expect(snap.eligible.size).toBe(0)
    dispose()
  })

  it('binds an eligible contribution to the exact page id across visits', async () => {
    const remote = new FakeRemote()
    const slots = new FakeSlots()
    remote.onList = () => Promise.resolve(ok(fakeSnapshot([
      fakeRow({ packageName: '@scope/app', pageId: 'page-a', enabled: true }),
      fakeRow({ packageName: '@scope/two', pageId: 'page-b', enabled: true }),
    ])))
    slots.setEntries([
      fakeEntry('page-a', '@scope/app'),
      fakeEntry('page-b', '@scope/two'),
    ])
    const { controller, dispose } = await harness(remote, slots)
    const eligible = controller.observable.getSnapshot().eligible
    expect(eligible.get('page-a')?.ownerPackage).toBe('@scope/app')
    expect(eligible.get('page-b')?.ownerPackage).toBe('@scope/two')
    dispose()
  })

  it('suppresses unrelated pages while a pending activation is open', async () => {
    const remote = new FakeRemote()
    const slots = new FakeSlots()
    remote.onList = () => Promise.resolve(ok(fakeSnapshot([
      fakeRow({ packageName: '@scope/one', pageId: 'page-one', enabled: true }),
      fakeRow({ packageName: '@scope/two', pageId: 'page-two', enabled: true }),
    ])))
    slots.setEntries([
      fakeEntry('page-one', '@scope/one'),
      fakeEntry('page-two', '@scope/two'),
    ])
    // A NON-target client: it reconciles but never acknowledges.
    const { controller, dispose } = await harness(remote, slots, 'client-other')
    expect(controller.observable.getSnapshot().eligible.size).toBe(2)
    // A pending activation names a DIFFERENT package/page: no existing row
    // matches package+page+revision, so the projection is empty until settle.
    remote.emitActivation(activationEvent({ packageName: '@scope/three', pageId: 'page-three' }))
    const during = controller.observable.getSnapshot()
    expect(during.activation).not.toBeNull()
    expect(during.eligible.size).toBe(0)
    // A committed revision settles the activation and restores the projection.
    remote.emitChanged(2)
    await flush()
    expect(controller.observable.getSnapshot().eligible.size).toBe(2)
    dispose()
  })

  it('projects the pending activation target only when package, page, and revision all match', async () => {
    const remote = new FakeRemote()
    const slots = new FakeSlots()
    remote.onList = () => Promise.resolve(ok(fakeSnapshot([
      fakeRow({ packageName: '@scope/app', pageId: 'page-a', enabled: true }),
    ])))
    slots.setEntries([fakeEntry('page-a', '@scope/app')])
    // Non-target client: only convergence tracking runs, no acknowledgement.
    const { controller, dispose, graphResolvers } = await harness(remote, slots, 'client-other')
    expect(controller.observable.getSnapshot().eligible.size).toBe(1)
    // Pending activation that names this exact package+page but a different
    // revision: not eligible until the client graph converges.
    remote.emitActivation(activationEvent({ graphRevision: 'layer-9' }))
    expect(controller.observable.getSnapshot().eligible.size).toBe(0)
    graphResolvers[0]?.()
    await flush()
    const snap = controller.observable.getSnapshot()
    expect(snap.eligible.size).toBe(1)
    expect(snap.activation?.converged).toBe(true)
    dispose()
  })
})
