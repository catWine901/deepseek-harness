// MutableObservable: the bare store primitive behind the page-app controller.
// Spec §14 requires a stable getSnapshot reference until a committed change and
// stable, disposable subscriptions (uSES-style currency).
import { describe, expect, it, vi } from 'vitest'
import { MutableObservable } from '../src/client/stores.ts'

describe('MutableObservable', () => {
  it('returns the same snapshot reference until a committed change', () => {
    const store = new MutableObservable<{ n: number }>({ n: 1 })
    const first = store.getSnapshot()
    expect(store.getSnapshot()).toBe(first)
    // Re-setting the exact same reference is not a committed change.
    store.set(first)
    expect(store.getSnapshot()).toBe(first)
    const next = { n: 2 }
    store.set(next)
    expect(store.getSnapshot()).toBe(next)
    expect(store.getSnapshot()).not.toBe(first)
  })

  it('notifies subscribers exactly once per committed reference change', () => {
    const store = new MutableObservable<{ n: number }>({ n: 0 })
    const spy = vi.fn()
    store.subscribe(spy)
    const first = { n: 1 }
    store.set(first)
    expect(spy).toHaveBeenCalledTimes(1)
    // Same reference: no notification.
    store.set(first)
    expect(spy).toHaveBeenCalledTimes(1)
    store.set({ n: 2 })
    expect(spy).toHaveBeenCalledTimes(2)
  })

  it('keeps subscriptions stable and disposable', () => {
    const store = new MutableObservable<number>(0)
    const a = vi.fn()
    const b = vi.fn()
    const disposeA = store.subscribe(a)
    const disposeB = store.subscribe(b)
    expect(disposeA).toBeTypeOf('function')
    expect(disposeB).toBeTypeOf('function')
    store.set(1)
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
    disposeA()
    store.set(2)
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(2)
    // Disposing twice is harmless.
    disposeA()
    store.set(3)
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(3)
  })

  it('does not notify after every subscriber unsubscribes', () => {
    const store = new MutableObservable<number>(0)
    const spy = vi.fn()
    const dispose = store.subscribe(spy)
    dispose()
    store.set(1)
    expect(spy).not.toHaveBeenCalled()
  })

  it('keeps the latest value readable after disposal of all subscriptions', () => {
    const store = new MutableObservable<string>('a')
    store.subscribe(() => {})()
    store.set('b')
    expect(store.getSnapshot()).toBe('b')
  })
})
