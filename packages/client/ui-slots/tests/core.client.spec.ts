// SlotCore terminal-design behavior: the single register composition API —
// a-priori 'root', children declaration/authorization, load-time validation,
// one-axis lifecycle cascade, store scope pinning, subscription API.
import { describe, expect, it, vi } from 'vitest'
import type { SlotComponent, StoreHandle } from '@deepseek-ai/dsh-client-ui-slots'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'

// 'root' is NOT merged here: the runtime package owns the built-in row, and
// the client aggregate program would see both merges collide.
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'test.single': { kind: 'single'; scope: 'root' }
    'test.single.target': { kind: 'single'; scope: 'root' }
    'test.single.third': { kind: 'single'; scope: 'root' }
    'test.session': { kind: 'single'; scope: 'session' }
    'test.list': { kind: 'list'; scope: 'root' }
    'test.keyed': { kind: 'keyed'; scope: 'session' }
    'test.chain': { kind: 'chain'; scope: 'session'; owner: { tags: string[] } }
    'test.grandchild': { kind: 'single'; scope: 'root' }
    'test.deep': { kind: 'single'; scope: 'root' }
  }
}

// Wide-accepting fixture: assignable wherever the composed constraint is an
// object type (children-declaring fixtures erase via `as never` instead —
// RendersCheck would demand a renderSlot consumer).
const Comp: SlotComponent<object> = () => null

/** A minimal structurally-valid store handle (identity is what the ledger tracks). */
function fakeHandle(): StoreHandle<{ n: number }, Record<string, (d: { n: number }) => void>> {
  return {
    spec: { init: () => ({ n: 0 }), actions: {} },
    create: () => { throw new Error('not under test') },
  }
}

/** Register a root-frame entry declaring the four test child slots. */
function mountFrame(core: SlotCore) {
  return core.register({
    name: 'root',
    children: {
      'test.single': { kind: 'single', scope: 'root' },
      'test.single.target': { kind: 'single', scope: 'root' },
      'test.single.third': { kind: 'single', scope: 'root' },
      'test.session': { kind: 'single', scope: 'session' },
      'test.list': { kind: 'list', scope: 'root' },
      'test.keyed': { kind: 'keyed', scope: 'session' },
      'test.chain': { kind: 'chain', scope: 'session' },
    },
  // Type-level renderSlot presence is proven by the type-chain spec; erasing
  // here keeps runtime fixtures terse.
  }, Comp as never)
}

const flushMicrotasks = () => new Promise<void>((resolve) => { queueMicrotask(resolve) })

describe('a-priori root and declaration gate', () => {
  it('seeds root as single/root at construction', () => {
    const core = new SlotCore()
    expect(core.specDynamic('root')).toEqual({ kind: 'single', scope: 'root' })
  })

  it('throws on registering into an undeclared slot', () => {
    const core = new SlotCore()
    expect(() => core.register({ name: 'test.single' }, Comp)).toThrow('not declared')
  })

  it('root is single: a second frame registration throws', () => {
    const core = new SlotCore()
    mountFrame(core)
    expect(() => core.register({ name: 'root' }, Comp)).toThrow('already has a registration')
  })

  it('children declaration makes child slots registerable, with specs recorded', () => {
    const core = new SlotCore()
    mountFrame(core)
    expect(core.specDynamic('test.session')).toEqual({ kind: 'single', scope: 'session' })
    expect(() => core.register({ name: 'test.single' }, Comp)).not.toThrow()
  })

  it('duplicate child declaration throws naming the first declarer', () => {
    const core = new SlotCore()
    mountFrame(core)
    core.register({ name: 'test.single', children: { 'test.grandchild': { kind: 'single', scope: 'root' } } }, Comp as never)
    expect(() => core.register(
      { name: 'test.session', children: { 'test.grandchild': { kind: 'single', scope: 'root' } }, registrant: 'imposter' },
      Comp as never,
    )).toThrow(/already declared.*test\.single/)
  })
})

describe('lifecycle cascade (one axis)', () => {
  it('disposing a declaring entry collapses child slots and their contributions recursively', () => {
    const core = new SlotCore()
    const disposeFrame = mountFrame(core)
    const disposeChild = core.register(
      { name: 'test.single', children: { 'test.grandchild': { kind: 'single', scope: 'root' } } }, Comp as never)
    core.register({ name: 'test.grandchild' }, Comp)
    expect(core.entries('test.grandchild')).toHaveLength(1)

    disposeFrame()
    expect(core.specDynamic('test.single')).toBeUndefined()
    expect(core.specDynamic('test.grandchild')).toBeUndefined()
    expect(core.entries('test.single')).toHaveLength(0)
    expect(core.entries('test.grandchild')).toHaveLength(0)
    // Stale disposer of a cascaded-away entry is a no-op.
    expect(() => { disposeChild() }).not.toThrow()
    // Slots return to undeclared: contributing again throws until redeclared.
    expect(() => core.register({ name: 'test.single' }, Comp)).toThrow('not declared')
  })

  it('registration disposers are idempotent', () => {
    const core = new SlotCore()
    const dispose = mountFrame(core)
    dispose()
    dispose()
    expect(core.entries('root')).toHaveLength(0)
    // Redeclare works after collapse.
    mountFrame(core)
    expect(core.specDynamic('test.single')).toBeDefined()
  })

  it('isLive tracks ledger membership across dispose', () => {
    const core = new SlotCore()
    mountFrame(core)
    const dispose = core.register({ name: 'test.single' }, Comp)
    const entry = core.entries('test.single')[0]!
    expect(core.isLive(entry)).toBe(true)
    dispose()
    expect(core.isLive(entry)).toBe(false)
  })

  it('finishes retirement and later same-key listeners before propagating a mutation failure', () => {
    const core = new SlotCore()
    const store = fakeHandle()
    const registration = core.register({
      name: 'root',
      store,
      children: {
        'test.single': { kind: 'single', scope: 'root' },
        'test.session': { kind: 'single', scope: 'session' },
      },
    }, Comp as never)
    core.register({ name: 'test.single' }, Comp)
    const failure = new Error('root mutation failed')
    const laterListener = vi.fn()
    const offFailing = core.onMutate((key) => {
      if (key === 'root') throw failure
    })
    const offLater = core.onMutate((key) => {
      if (key === 'root') laterListener()
    })

    expect(() => { registration() }).toThrow(failure)
    offFailing()
    offLater()

    expect(laterListener).toHaveBeenCalledOnce()
    expect(core.specDynamic('test.single')).toBeUndefined()
    expect(core.specDynamic('test.session')).toBeUndefined()
    expect(core.entries('test.single')).toHaveLength(0)
    expect(() => { registration(); registration() }).not.toThrow()
    core.register({
      name: 'root', children: { 'test.session': { kind: 'single', scope: 'session' } },
    }, Comp as never)
    expect(() => core.register({ name: 'test.session', store }, Comp as never)).not.toThrow()
  })

  it('rolls back an initial registration when a mutation listener throws', () => {
    const core = new SlotCore()
    mountFrame(core)
    const store = fakeHandle()
    const failure = new Error('initial test.single mutation failed')
    const off = core.onMutate((key) => {
      if (key === 'test.single') throw failure
    })

    expect(() => core.register({
      name: 'test.single',
      store,
      children: { 'test.grandchild': { kind: 'single', scope: 'root' } },
    }, Comp as never)).toThrow()
    off()

    expect(core.entries('test.single')).toHaveLength(0)
    expect(core.specDynamic('test.grandchild')).toBeUndefined()
    // Both the entry ledger and the core store pin roll back, so the same
    // handle remains legal under a different scope.
    expect(() => core.register({ name: 'test.session', store }, Comp as never)).not.toThrow()
  })

  it('does not orphan child declarations when an initial mutation cascades its parent', () => {
    const core = new SlotCore()
    const disposeFrame = mountFrame(core)
    const store = fakeHandle()
    const off = core.onMutate((key) => {
      if (key === 'test.single') disposeFrame()
    })

    const staleRegistration = core.register({
      name: 'test.single',
      store,
      children: { 'test.grandchild': { kind: 'single', scope: 'root' } },
    }, Comp as never)
    off()

    expect(core.entries('test.single')).toHaveLength(0)
    expect(core.specDynamic('test.single')).toBeUndefined()
    expect(core.specDynamic('test.grandchild')).toBeUndefined()
    expect(() => { staleRegistration(); staleRegistration() }).not.toThrow()
    core.register({
      name: 'root', children: { 'test.session': { kind: 'single', scope: 'session' } },
    }, Comp as never)
    expect(() => core.register({ name: 'test.session', store }, Comp as never)).not.toThrow()
  })
})

describe('atomic single-slot retarget', () => {
  it('preserves the entry, descendants, metadata, store pin, and original disposer authority', () => {
    const core = new SlotCore()
    mountFrame(core)
    const store = fakeHandle()
    const registration = core.register({
      name: 'test.single',
      children: { 'test.grandchild': { kind: 'single', scope: 'root' } },
      store,
      registrant: 'layout-frame',
    }, Comp as never)
    core.register({ name: 'test.grandchild' }, Comp)
    const entry = core.entries('test.single')[0]!
    const descendant = core.entries('test.grandchild')[0]!
    const declarationEpoch = core.declarationEpoch('test.grandchild')
    const declarationChanged = vi.fn()
    const offDeclaration = core.subscribeDeclaration('test.grandchild', declarationChanged)

    registration.retarget('test.single.target')

    expect(core.entries('test.single')).toHaveLength(0)
    expect(core.entries('test.single.target')).toEqual([entry])
    expect(core.entries('test.grandchild')).toEqual([descendant])
    expect(entry.registrant).toBe('layout-frame')
    expect(entry.store).toBe(store)
    expect(core.declarationEpoch('test.grandchild')).toBe(declarationEpoch)
    expect(declarationChanged).not.toHaveBeenCalled()
    const root = core.snapshot('root')[0]!
    const target = root.children.find(child => child.name === 'test.single.target')
    expect(target?.children.map(child => child.name)).toEqual(['test.grandchild'])

    registration()
    registration()
    expect(core.entries('test.single.target')).toHaveLength(0)
    expect(core.specDynamic('test.grandchild')).toBeUndefined()
    // The original handle's one root-scope pin was released exactly once.
    expect(() => core.register({ name: 'test.session', store }, Comp as never)).not.toThrow()
    offDeclaration()
  })

  it('rejects undeclared, occupied, non-single, and cross-scope targets without partial mutation', () => {
    const core = new SlotCore()
    mountFrame(core)
    const registration = core.register({
      name: 'test.single',
      children: { 'test.grandchild': { kind: 'single', scope: 'root' } },
    }, Comp as never)
    const entry = core.entries('test.single')[0]!
    core.register({ name: 'test.single.target' }, Comp)

    expect(() => { registration.retarget('missing' as never) }).toThrow(/not declared/)
    expect(() => { registration.retarget('test.single.target') }).toThrow(/already has a registration/)
    expect(() => { registration.retarget('test.list') }).toThrow(/single slots/)
    expect(() => { registration.retarget('test.session') }).toThrow(/same scope/)
    expect(core.entries('test.single')).toEqual([entry])
    expect(core.entries('test.single.target')).toHaveLength(1)
    expect(core.specDynamic('test.grandchild')).toEqual({ kind: 'single', scope: 'root' })
  })

  it('rejects direct and deep slots in its own declaration subtree without any mutation', () => {
    const core = new SlotCore()
    mountFrame(core)
    const registration = core.register({
      name: 'test.single',
      children: { 'test.grandchild': { kind: 'single', scope: 'root' } },
    }, Comp as never)
    const disposeChild = core.register({
      name: 'test.grandchild',
      children: { 'test.deep': { kind: 'single', scope: 'root' } },
    }, Comp as never)
    const sourceEntry = core.entries('test.single')[0]!
    const childEntry = core.entries('test.grandchild')[0]!
    const sourceVersion = core.getVersion('test.single')
    const directVersion = core.getVersion('test.grandchild')
    const deepVersion = core.getVersion('test.deep')
    const mutations: string[] = []
    const offMutate = core.onMutate(key => mutations.push(key))

    expect(() => { registration.retarget('test.grandchild') }).toThrow(/own declaration subtree/)
    expect(() => { registration.retarget('test.deep') }).toThrow(/own declaration subtree/)

    expect(core.entries('test.single')).toEqual([sourceEntry])
    expect(core.entries('test.grandchild')).toEqual([childEntry])
    expect(core.specDynamic('test.deep')).toEqual({ kind: 'single', scope: 'root' })
    expect(core.getVersion('test.single')).toBe(sourceVersion)
    expect(core.getVersion('test.grandchild')).toBe(directVersion)
    expect(core.getVersion('test.deep')).toBe(deepVersion)
    expect(mutations).toEqual([])
    expect(core.snapshot('test.single')[0]?.children[0]?.children[0]?.name).toBe('test.deep')

    // Failed validation leaves the original authority usable for a valid move.
    registration.retarget('test.single.target')
    expect(core.entries('test.single.target')).toEqual([sourceEntry])
    disposeChild()
    registration()
    offMutate()
  })

  it('rejects a non-single source and a retired registration', () => {
    const core = new SlotCore()
    mountFrame(core)
    const listRegistration = core.register({ name: 'test.list', id: 'row' }, Comp)
    expect(() => { listRegistration.retarget('test.single.target') }).toThrow(/single slots/)
    expect(core.entries('test.list')).toHaveLength(1)

    const registration = core.register({ name: 'test.single' }, Comp)
    registration.retarget('test.single')
    expect(core.entries('test.single')).toHaveLength(1)
    registration()
    expect(() => { registration.retarget('test.single.target') }).toThrow(/cannot retarget/)
    expect(core.entries('test.single.target')).toHaveLength(0)
  })

  it('leaves a cascaded registration stale, idempotently disposable, and unable to retarget', () => {
    const core = new SlotCore()
    const disposeFrame = mountFrame(core)
    const registration = core.register({ name: 'test.single' }, Comp)

    disposeFrame()

    expect(() => { registration.retarget('test.single.target') }).toThrow(/cannot retarget/)
    expect(() => { registration(); registration() }).not.toThrow()
  })

  it('publishes old and new mutations only after both ledgers show the final state', async () => {
    const core = new SlotCore()
    mountFrame(core)
    await flushMicrotasks()
    const registration = core.register({ name: 'test.single' }, Comp)
    const entry = core.entries('test.single')[0]!
    await flushMicrotasks()
    const synchronous: Array<{ key: string; source: number; target: number }> = []
    const subscribed: Array<{ key: string; source: number; target: number }> = []
    const snapshot = (key: string) => ({
      key,
      source: core.entries('test.single').length,
      target: core.entries('test.single.target').length,
    })
    const offMutate = core.onMutate((key) => {
      if (key === 'test.single' || key === 'test.single.target') synchronous.push(snapshot(key))
    })
    const offSource = core.subscribe('test.single', () => { subscribed.push(snapshot('test.single')) })
    const offTarget = core.subscribe('test.single.target', () => { subscribed.push(snapshot('test.single.target')) })

    registration.retarget('test.single.target')

    expect(core.entries('test.single.target')).toEqual([entry])
    expect(synchronous).toEqual([
      { key: 'test.single', source: 0, target: 1 },
      { key: 'test.single.target', source: 0, target: 1 },
    ])
    await flushMicrotasks()
    expect(subscribed).toEqual([
      { key: 'test.single', source: 0, target: 1 },
      { key: 'test.single.target', source: 0, target: 1 },
    ])
    offMutate()
    offSource()
    offTarget()
  })

  it('commits both key versions and notifications before propagating a source-listener failure', async () => {
    const core = new SlotCore()
    mountFrame(core)
    await flushMicrotasks()
    const registration = core.register({ name: 'test.single' }, Comp)
    await flushMicrotasks()
    const sourceVersion = core.getVersion('test.single')
    const targetVersion = core.getVersion('test.single.target')
    const mutations: string[] = []
    const sourceChanged = vi.fn()
    const targetChanged = vi.fn()
    const offSource = core.subscribe('test.single', sourceChanged)
    const offTarget = core.subscribe('test.single.target', targetChanged)
    const failure = new Error('source listener failed')
    const offMutate = core.onMutate((key) => {
      if (key !== 'test.single' && key !== 'test.single.target') return
      mutations.push(key)
      if (key === 'test.single') throw failure
    })

    expect(() => { registration.retarget('test.single.target') }).toThrow(failure)
    offMutate()

    expect(core.entries('test.single')).toHaveLength(0)
    expect(core.entries('test.single.target')).toHaveLength(1)
    expect(core.getVersion('test.single')).toBe(sourceVersion + 1)
    expect(core.getVersion('test.single.target')).toBe(targetVersion + 1)
    expect(mutations).toEqual(['test.single', 'test.single.target'])
    await flushMicrotasks()
    expect(sourceChanged).toHaveBeenCalledOnce()
    expect(targetChanged).toHaveBeenCalledOnce()
    offSource()
    offTarget()
  })

  it('allows same-target listener reentry but rejects a different target until the outer move publishes', () => {
    const core = new SlotCore()
    mountFrame(core)
    const registration = core.register({ name: 'test.single' }, Comp)
    let differentTargetError: unknown
    const offMutate = core.onMutate((key) => {
      if (key !== 'test.single') return
      registration.retarget('test.single.target')
      try {
        registration.retarget('test.single.third')
      } catch (error) {
        differentTargetError = error
      }
    })

    expect(() => { registration.retarget('test.single.target') }).not.toThrow()
    offMutate()

    expect(differentTargetError).toBeInstanceOf(Error)
    expect((differentTargetError as Error).message).toMatch(/retarget.*in progress/)
    expect(core.entries('test.single')).toHaveLength(0)
    expect(core.entries('test.single.target')).toHaveLength(1)
    expect(core.entries('test.single.third')).toHaveLength(0)
  })
})

describe('kind semantics', () => {
  it('keyed: duplicate key throws, missing key throws', () => {
    const core = new SlotCore()
    mountFrame(core)
    core.register({ name: 'test.keyed', key: 'a' }, Comp)
    expect(() => core.register({ name: 'test.keyed', key: 'a' }, Comp)).toThrow('key "a"')
    // Statically rejected (KindOptions); runtime guard stays for dynamic callers.
    // @ts-expect-error keyed registration requires options.key
    expect(() => core.register({ name: 'test.keyed' }, Comp)).toThrow('requires options.key')
    expect(() => core.register({ name: 'test.keyed', key: 'b' }, Comp)).not.toThrow()
  })

  it('list: duplicate id throws, missing id throws, entries sort by order stably', () => {
    const core = new SlotCore()
    mountFrame(core)
    core.register({ name: 'test.list', id: 'c', order: 10 }, Comp)
    core.register({ name: 'test.list', id: 'a' }, Comp)
    core.register({ name: 'test.list', id: 'b' }, Comp)
    expect(() => core.register({ name: 'test.list', id: 'a' }, Comp)).toThrow('id "a"')
    // @ts-expect-error list registration requires options.id
    expect(() => core.register({ name: 'test.list' }, Comp)).toThrow('requires options.id')
    expect(core.entries('test.list').map(e => e.options.id)).toEqual(['a', 'b', 'c'])
  })

  it('chain: missing select throws; select and priority land on the stored entry', () => {
    const core = new SlotCore()
    mountFrame(core)
    // Statically rejected (KindOptions); runtime guard stays for dynamic callers.
    // @ts-expect-error chain registration requires options.select
    expect(() => core.register({ name: 'test.chain' }, Comp)).toThrow('requires options.select')
    const select = ({ tags }: { tags: string[] }) => tags[0] ?? null
    core.register({ name: 'test.chain', select, priority: 5 }, Comp as never)
    const entry = core.entries('test.chain')[0]!
    expect(entry.select).toBe(select)
    expect(entry.options.priority).toBe(5)
  })

  it('chain: entries sort by priority ascending, ties keep registration order', () => {
    const core = new SlotCore()
    mountFrame(core)
    const sel = () => null
    core.register({ name: 'test.chain', select: sel, priority: 10, registrant: 'late' }, Comp as never)
    core.register({ name: 'test.chain', select: sel, registrant: 'default-a' }, Comp as never)
    core.register({ name: 'test.chain', select: sel, registrant: 'default-b' }, Comp as never)
    core.register({ name: 'test.chain', select: sel, priority: -1, registrant: 'first' }, Comp as never)
    expect(core.entries('test.chain').map(e => e.registrant))
      .toEqual(['first', 'default-a', 'default-b', 'late'])
  })

  it('single: second registration throws, disposer frees the seat', () => {
    const core = new SlotCore()
    mountFrame(core)
    const dispose = core.register({ name: 'test.single' }, Comp)
    expect(() => core.register({ name: 'test.single' }, Comp)).toThrow('already has a registration')
    dispose()
    expect(core.entries('test.single')).toHaveLength(0)
    expect(() => core.register({ name: 'test.single' }, Comp)).not.toThrow()
  })
})

describe('store scope pinning', () => {
  it('one shared handle under two scopes throws at load', () => {
    const core = new SlotCore()
    mountFrame(core)
    const handle = fakeHandle()
    core.register({ name: 'test.session', store: handle }, Comp as never)
    expect(() => core.register({ name: 'test.single', store: handle }, Comp as never))
      .toThrow('one handle, one scope')
  })

  it('same handle under same scope is fine; full unmount releases the pin', () => {
    const core = new SlotCore()
    mountFrame(core)
    const handle = fakeHandle()
    const d1 = core.register({ name: 'test.list', id: 'x', store: handle }, Comp as never)
    const d2 = core.register({ name: 'test.list', id: 'y', store: handle }, Comp as never)
    d1()
    // Still mounted once — scope stays pinned.
    expect(() => core.register({ name: 'test.session', store: handle }, Comp as never))
      .toThrow('one handle, one scope')
    d2()
    // All mounts gone: the handle may pin a new scope.
    expect(() => core.register({ name: 'test.session', store: handle }, Comp as never)).not.toThrow()
  })

  it('factories are exempt from pinning (no shared identity)', () => {
    const core = new SlotCore()
    mountFrame(core)
    const factory = () => fakeHandle()
    core.register({ name: 'test.session', store: factory }, Comp as never)
    expect(() => core.register({ name: 'test.single', store: factory }, Comp as never)).not.toThrow()
  })

  it('cascade releases store pins of collapsed child entries', () => {
    const core = new SlotCore()
    const disposeFrame = mountFrame(core)
    const handle = fakeHandle()
    core.register({ name: 'test.session', store: handle }, Comp as never)
    disposeFrame()
    mountFrame(core)
    expect(() => core.register({ name: 'test.single', store: handle }, Comp as never)).not.toThrow()
  })
})

describe('subscription API', () => {
  it('tracks declaration epochs separately from ordinary entry mutations', () => {
    const core = new SlotCore()
    expect(core.declarationEpoch('root')).toBe(1)
    expect(core.declarationEpoch('test.list')).toBe(0)
    const disposeFrame = mountFrame(core)
    const declared = core.declarationEpoch('test.list')
    expect(declared).toBe(1)
    const disposeEntry = core.register({ name: 'test.list', id: 'a' }, Comp)
    disposeEntry()
    expect(core.declarationEpoch('test.list')).toBe(declared)
    disposeFrame()
    expect(core.declarationEpoch('test.list')).toBe(declared + 1)
    mountFrame(core)
    expect(core.declarationEpoch('test.list')).toBe(declared + 2)
  })

  it('entries() returns a stable cached reference between mutations', () => {
    const core = new SlotCore()
    mountFrame(core)
    core.register({ name: 'test.list', id: 'a' }, Comp)
    const first = core.entries('test.list')
    expect(core.entries('test.list')).toBe(first)
    core.register({ name: 'test.list', id: 'b' }, Comp)
    expect(core.entries('test.list')).not.toBe(first)
  })

  it('bumps version synchronously but batches notifications per microtask', async () => {
    const core = new SlotCore()
    mountFrame(core)
    const fn = vi.fn()
    core.subscribe('test.list', fn)
    const before = core.getVersion('test.list')
    core.register({ name: 'test.list', id: 'a' }, Comp)
    core.register({ name: 'test.list', id: 'b' }, Comp)
    expect(core.getVersion('test.list')).toBe(before + 2)
    expect(fn).not.toHaveBeenCalled()
    await flushMicrotasks()
    expect(fn).toHaveBeenCalledTimes(1)
    core.register({ name: 'test.list', id: 'c' }, Comp)
    await flushMicrotasks()
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('declaration itself notifies child-key subscribers (subscribe-ahead allowed)', async () => {
    const core = new SlotCore()
    const fn = vi.fn()
    core.subscribe('test.single', fn)
    mountFrame(core)
    await flushMicrotasks()
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('notifies declaration subscribers synchronously, excluding entries, until unsubscribe', () => {
    const core = new SlotCore()
    const fn = vi.fn()
    const unsubscribe = core.subscribeDeclaration('test.list', fn)
    const disposeFrame = mountFrame(core)
    expect(fn).toHaveBeenCalledTimes(1)
    core.register({ name: 'test.list', id: 'ordinary' }, Comp)
    expect(fn).toHaveBeenCalledTimes(1)
    disposeFrame()
    expect(fn).toHaveBeenCalledTimes(2)
    unsubscribe()
    mountFrame(core)
    expect(fn).toHaveBeenCalledTimes(2)
  })

  it('commits sibling declarations before notifying declaration subscribers', () => {
    const core = new SlotCore()
    let duplicateDeclaration: unknown
    const unsubscribe = core.subscribeDeclaration('test.single', () => {
      core.register({ name: 'test.list', id: 'from-listener' }, Comp)
      try {
        core.register({
          name: 'test.single',
          children: { 'test.list': { kind: 'list', scope: 'root' } },
        }, Comp as never)
      } catch (error) {
        duplicateDeclaration = error
      }
    })

    const disposeFrame = mountFrame(core)
    expect(core.entries('test.list')).toHaveLength(1)
    expect(String(duplicateDeclaration)).toContain('already declared')
    unsubscribe()
    disposeFrame()
    expect(core.specDynamic('test.list')).toBeUndefined()
  })

  it('notifies only subscribers of the touched key; unsubscribe stops delivery', async () => {
    const core = new SlotCore()
    mountFrame(core)
    await flushMicrotasks()
    const single = vi.fn()
    const list = vi.fn()
    core.subscribe('test.single', single)
    const unsubscribe = core.subscribe('test.list', list)
    core.register({ name: 'test.single' }, Comp)
    await flushMicrotasks()
    expect(single).toHaveBeenCalledTimes(1)
    expect(list).not.toHaveBeenCalled()
    unsubscribe()
    core.register({ name: 'test.list', id: 'a' }, Comp)
    await flushMicrotasks()
    expect(list).not.toHaveBeenCalled()
  })

  it('a mutation from inside a flush re-schedules instead of being lost', async () => {
    const core = new SlotCore()
    mountFrame(core)
    await flushMicrotasks()
    const seen: number[] = []
    let reentered = false
    core.subscribe('test.list', () => {
      seen.push(core.getVersion('test.list'))
      if (!reentered) {
        reentered = true
        core.register({ name: 'test.list', id: 'reentrant' }, Comp)
      }
    })
    core.register({ name: 'test.list', id: 'a' }, Comp)
    await flushMicrotasks()
    await flushMicrotasks()
    expect(seen).toHaveLength(2)
    expect(core.entries('test.list')).toHaveLength(2)
  })

  it('getVersion is 0 for untouched keys and monotonic across redeclaration', () => {
    const core = new SlotCore()
    expect(core.getVersion('test.single')).toBe(0)
    const dispose = mountFrame(core)
    dispose()
    const after = core.getVersion('test.single')
    mountFrame(core)
    expect(core.getVersion('test.single')).toBeGreaterThan(after)
  })

  it('onMutate fires synchronously per mutation with the touched key', () => {
    const core = new SlotCore()
    const keys: string[] = []
    const off = core.onMutate(key => keys.push(key))
    mountFrame(core)
    // Contribution first, then each declared child key.
    expect(keys).toEqual([
      'root', 'test.single', 'test.single.target', 'test.single.third',
      'test.session', 'test.list', 'test.keyed', 'test.chain',
    ])
    keys.length = 0
    core.register({ name: 'test.list', id: 'a' }, Comp)
    expect(keys).toEqual(['test.list'])
    off()
    core.register({ name: 'test.list', id: 'b' }, Comp)
    expect(keys).toHaveLength(1)
  })
})

describe('owner package provenance (output-only metadata)', () => {
  it('stores no ownerPackage when the registration supplies none', () => {
    const core = new SlotCore()
    mountFrame(core)
    core.register({ name: 'test.single' }, Comp)
    expect(core.entries('test.single')[0]?.ownerPackage).toBeUndefined()
  })

  it('rejects ownerPackage in typed public register options and ignores it at runtime', () => {
    const core = new SlotCore()
    mountFrame(core)
    // ownerPackage is derived output provenance; the public options type must
    // never carry it (compile error) and the runtime must ignore the key.
    // @ts-expect-error ownerPackage is output-only provenance, never a public register option
    core.register({ name: 'test.single', ownerPackage: '@deepseek-ai/dsh-forged' }, Comp)
    expect(core.entries('test.single')[0]?.ownerPackage).toBeUndefined()
  })

  it('stamps the runtime internal metadata channel onto the stored entry', () => {
    const core = new SlotCore()
    mountFrame(core)
    // The third argument is the runtime Service's internal ownerPackage channel
    // (typed callers never reach it through the two-argument public overloads).
    ;(core.register as (options: object, component: unknown, ownerPackage: string) => () => void)(
      { name: 'test.single' }, Comp, '@deepseek-ai/dsh-client-ui-layout')
    expect(core.entries('test.single')[0]?.ownerPackage).toBe('@deepseek-ai/dsh-client-ui-layout')
  })
})

describe('runtime immutability of owner provenance', () => {
  it('defines ownerPackage as a non-writable own property even when the value is undefined', () => {
    const core = new SlotCore()
    mountFrame(core)
    core.register({ name: 'test.single' }, Comp)
    const entry = core.entries('test.single')[0]!
    const descriptor = Object.getOwnPropertyDescriptor(entry, 'ownerPackage')
    expect(descriptor?.writable).toBe(false)
    expect(descriptor?.configurable).toBe(false)
    expect(descriptor?.value).toBeUndefined()
  })

  it('freezes the stored entry and the live entries array, preserving the stable reference', () => {
    const core = new SlotCore()
    mountFrame(core)
    core.register({ name: 'test.single' }, Comp)
    const first = core.entries('test.single')
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first[0]!)).toBe(true)
    // Strict-mode writes to a frozen entry or array must be rejected.
    const entry = first[0]! as { ownerPackage?: string | undefined }
    expect(() => { entry.ownerPackage = '@deepseek-ai/dsh-forged' }).toThrow()
    const mutable = first as unknown as { component: unknown; options: object }[]
    expect(() => { mutable.push({ component: null, options: {} }) }).toThrow()
    expect(core.entries('test.single')).toBe(first) // stable reference between mutations
  })
})
