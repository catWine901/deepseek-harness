// @vitest-environment jsdom
/**
 * PageAppShell keep-mounted behavior (spec §3/§4): DSH mounts immediately and
 * stays mounted (hidden while a managed page is active); an unvisited managed
 * page does not mount; first visit mounts it once; switching toggles HTML
 * `hidden` without unmount; stable page ids retain local React state; the
 * controller's eviction (disable/uninstall) drops the surface from the tree.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { useSyncExternalStore } from 'react'
import type { PageAppClientSnapshot } from '../src/client/controller.ts'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import { PageAppShell, type PageAppShellProps } from '../src/client/PageAppShell.tsx'
import { MutableObservable } from '../src/client/stores.ts'

/** A minimal StoredEntry fixture. */
function entry(pageId: string, ownerPackage: string): StoredEntry {
  return { component: () => null, options: Object.freeze({ key: pageId }), ownerPackage }
}

/** Build a controller-like snapshot fixture. */
function snapshot(over: Partial<PageAppClientSnapshot> = {}): PageAppClientSnapshot {
  return {
    registry: null,
    eligible: new Map(),
    activePageId: null,
    visitedPageIds: [],
    activation: null,
    failedPageIds: [],
    ...over,
  }
}

/** Test-held controller observable with a manual commit API. */
function makeStore(initial: PageAppClientSnapshot) {
  const store = new MutableObservable(initial)
  return { store, commit: (next: PageAppClientSnapshot) => { store.set(next) } }
}

/** Render the shell against a recording renderSlot and a store-backed hook. */
function mountShell(store: MutableObservable<PageAppClientSnapshot>) {
  const select = vi.fn()
  const uninstall = vi.fn()
  const t = ((key: string) => ({
    surfaceCrashed: 'This page failed',
    retry: 'Retry',
    uninstall: 'Uninstall',
  })[key] ?? key) as PageAppShellProps['t']
  const slotCalls: { key: string; entryKey?: string }[] = []
  const renderSlot = ((key: string, _owner: object, opts?: { entryKey?: string }) => {
    const entryKey = opts?.entryKey
    slotCalls.push({ key, ...(entryKey === undefined ? {} : { entryKey }) })
    return <div data-testid={`slot-${key}-${entryKey ?? 'builtin'}`} />
  }) as PageAppShellProps['renderSlot']
  const props: PageAppShellProps = {
    usePageApp: (sel: (s: PageAppClientSnapshot) => unknown) => sel(useSyncExternalStore(store.subscribe, store.getSnapshot)),
    select,
    uninstall,
    t,
    renderSlot,
  } as PageAppShellProps
  const utils = render(<PageAppShell {...props} />)
  return { select, uninstall, t, slotCalls, ...utils }
}

beforeEach(() => {
  vi.useRealTimers()
})

afterEach(() => {
  cleanup()
})

describe('PageAppShell keep-mounted behavior', () => {
  it('mounts the built-in DSH surface immediately and keeps it mounted', () => {
    const { store } = makeStore(snapshot())
    const { getByTestId, queryByTestId } = mountShell(store)
    expect(getByTestId('slot-page-app.shell.builtin-builtin')).toBeTruthy()
    // No visited pages: no managed surfaces mount.
    expect(queryByTestId('slot-page-app.shell.surface-page-a')).toBeNull()
  })

  it('does not mount an unvisited managed page', () => {
    const { store } = makeStore(snapshot({
      eligible: new Map([['page-a', entry('page-a', '@scope/a')]]),
      activePageId: null,
      visitedPageIds: [],
    }))
    const { queryByTestId } = mountShell(store)
    expect(queryByTestId('slot-page-app.shell.surface-page-a')).toBeNull()
  })

  it('mounts a page on first visit and keeps it mounted across switching', () => {
    const { store } = makeStore(snapshot({
      eligible: new Map([['page-a', entry('page-a', '@scope/a')]]),
      activePageId: null,
      visitedPageIds: [],
    }))
    const { getByTestId, container } = mountShell(store)
    // First visit: mounts once.
    act(() => { store.set(snapshot({
      eligible: new Map([['page-a', entry('page-a', '@scope/a')]]),
      activePageId: 'page-a',
      visitedPageIds: ['page-a'],
    })) })
    const surface = getByTestId('slot-page-app.shell.surface-page-a')
    expect(surface).toBeTruthy()
    // Switching away hides (does not unmount); DSH also stays mounted.
    act(() => { store.set(snapshot({
      eligible: new Map([['page-a', entry('page-a', '@scope/a')]]),
      activePageId: null,
      visitedPageIds: ['page-a'],
    })) })
    expect(container.querySelector('[data-page-id="page-a"]')).not.toBeNull()
    expect(container.querySelector('[data-page-id="dsh"]')).not.toBeNull()
  })

  it('toggles the HTML hidden attribute only while switching', () => {
    const { store } = makeStore(snapshot({
      eligible: new Map([['page-a', entry('page-a', '@scope/a')]]),
      activePageId: null,
      visitedPageIds: [],
    }))
    const { container } = mountShell(store)
    act(() => { store.set(snapshot({
      eligible: new Map([['page-a', entry('page-a', '@scope/a')]]),
      activePageId: 'page-a',
      visitedPageIds: ['page-a'],
    })) })
    const dsh = container.querySelector('[data-page-id="dsh"]') as HTMLElement
    const pageA = container.querySelector('[data-page-id="page-a"]') as HTMLElement
    expect(dsh.hasAttribute('hidden')).toBe(true)
    expect(pageA.hasAttribute('hidden')).toBe(false)
    act(() => { store.set(snapshot({
      eligible: new Map([['page-a', entry('page-a', '@scope/a')]]),
      activePageId: null,
      visitedPageIds: ['page-a'],
    })) })
    expect(container.querySelector('[data-page-id="dsh"]')?.hasAttribute('hidden')).toBe(false)
    expect(container.querySelector('[data-page-id="page-a"]')?.hasAttribute('hidden')).toBe(true)
  })

  it('preserves local React state across switching (stable keyed wrappers)', () => {
    const { store } = makeStore(snapshot({
      eligible: new Map([['page-a', entry('page-a', '@scope/a')]]),
      activePageId: null,
      visitedPageIds: [],
    }))
    const { container } = mountShell(store)
    act(() => { store.set(snapshot({
      eligible: new Map([['page-a', entry('page-a', '@scope/a')]]),
      activePageId: 'page-a',
      visitedPageIds: ['page-a'],
    })) })
    const first = container.querySelector('[data-page-id="page-a"]')
    expect(first).not.toBeNull()
    // Switch away and back: the SAME wrapper DOM node must remain (local
    // React state lives in the keyed subtree, so identity is the proof).
    act(() => { store.set(snapshot({
      eligible: new Map([['page-a', entry('page-a', '@scope/a')]]),
      activePageId: null,
      visitedPageIds: ['page-a'],
    })) })
    act(() => { store.set(snapshot({
      eligible: new Map([['page-a', entry('page-a', '@scope/a')]]),
      activePageId: 'page-a',
      visitedPageIds: ['page-a'],
    })) })
    expect(container.querySelector('[data-page-id="page-a"]')).toBe(first)
  })

  it('unmounts a managed surface when the controller evicts it (disable/uninstall)', () => {
    const { store } = makeStore(snapshot({
      eligible: new Map([['page-a', entry('page-a', '@scope/a')]]),
      activePageId: 'page-a',
      visitedPageIds: ['page-a'],
    }))
    const { queryByTestId, container } = mountShell(store)
    expect(queryByTestId('slot-page-app.shell.surface-page-a')).toBeTruthy()
    // The row is disabled/removed: the controller evicts the visited id and
    // the shell stops rendering the surface (it unmounts).
    act(() => { store.set(snapshot({
      eligible: new Map(),
      activePageId: null,
      visitedPageIds: [],
    })) })
    expect(queryByTestId('slot-page-app.shell.surface-page-a')).toBeNull()
    // DSH remains mounted throughout.
    expect(container.querySelector('[data-page-id="dsh"]')).not.toBeNull()
  })

  it('renders a manager-owned failure surface with retry and uninstall actions when a managed surface abdicates', () => {
    const { store } = makeStore(snapshot({
      eligible: new Map([['page-a', entry('page-a', '@scope/a')]]),
      activePageId: 'page-a',
      visitedPageIds: ['page-a'],
      failedPageIds: ['page-a'],
    }))
    const { container, getByRole, select, uninstall } = mountShell(store)
    // The failure face replaces the bare data-slot-error cell of the crashed
    // surface; the keyed wrapper stays mounted.
    expect(container.querySelector('[data-page-id="page-a"]')).not.toBeNull()
    expect(container.querySelector('[data-page-app-failure]')).not.toBeNull()
    const retry = getByRole('button', { name: 'Retry' })
    const uninstallButton = getByRole('button', { name: 'Uninstall' })
    act(() => { retry.click() })
    expect(select).toHaveBeenCalledWith('page-a')
    act(() => { uninstallButton.click() })
    expect(uninstall).toHaveBeenCalledWith('page-a')
  })

  it('the rail and DSH stay usable while one surface shows the failure face', () => {
    const { store } = makeStore(snapshot({
      registry: {
        profile: { name: 'p', directory: 'd' },
        revision: 1,
        entries: [
          { packageName: '@scope/a', page: { id: 'page-a', name: 'A', description: '', defaultOrder: 1, rootEntryId: 'r' }, order: 1, enabled: true, hidden: false, installedAt: '', updatedAt: '', source: { kind: 'registry', display: 'x' }, resolvedVersion: '1.0.0', health: 'ready' },
          { packageName: '@scope/b', page: { id: 'page-b', name: 'B', description: '', defaultOrder: 2, rootEntryId: 'r' }, order: 2, enabled: true, hidden: false, installedAt: '', updatedAt: '', source: { kind: 'registry', display: 'x' }, resolvedVersion: '1.0.0', health: 'ready' },
        ],
        operation: null, recovery: null,
      },
      eligible: new Map([
        ['page-a', entry('page-a', '@scope/a')],
        ['page-b', entry('page-b', '@scope/b')],
      ]),
      activePageId: 'page-a',
      visitedPageIds: ['page-a', 'page-b'],
      failedPageIds: ['page-a'],
    }))
    const { container, getByTestId } = mountShell(store)
    // DSH stays mounted; the rail still lists both pages; the healthy page-b
    // renders its surface while page-a shows the failure face.
    expect(container.querySelector('[data-page-id="dsh"]')).not.toBeNull()
    const railRows = [...container.querySelectorAll('[data-page-app-rail-item]')]
      .map(el => el.textContent ?? '')
    expect(railRows).toEqual(['DSH / Agent', 'A', 'B'])
    expect(container.querySelector('[data-page-app-failure]')).not.toBeNull()
    expect(getByTestId('slot-page-app.shell.surface-page-b')).toBeTruthy()
  })

  it('hides the active fallback to DSH when the page becomes hidden (no eviction)', () => {
    const { store } = makeStore(snapshot({
      registry: {
        profile: { name: 'p', directory: 'd' },
        revision: 1,
        entries: [{
          packageName: '@scope/a', page: { id: 'page-a', name: 'A', description: '', defaultOrder: 1, rootEntryId: 'r' },
          order: 1, enabled: true, hidden: true, installedAt: '', updatedAt: '', source: { kind: 'registry', display: 'x' },
          resolvedVersion: '1.0.0', health: 'ready',
        }],
        operation: null, recovery: null,
      },
      eligible: new Map([['page-a', entry('page-a', '@scope/a')]]),
      activePageId: null,
      visitedPageIds: ['page-a'],
    }))
    const { container } = mountShell(store)
    // The rail hides a hidden row (the shell filters hidden rows out of the
    // rail projection); DSH stays mounted.
    const railRows = [...container.querySelectorAll('[data-page-app-rail-item]')]
      .map(el => el.textContent ?? '')
    expect(railRows).toEqual(['DSH / Agent'])
    expect(container.querySelector('[data-page-id="dsh"]')).not.toBeNull()
  })
})
