/**
 * Fixture client spec: the client half consumes the Workbench Contract's
 * single surface entry `registerWorkspaceSurface` from the injected
 * WorkbenchContext face — the contract consumption is what the fixture owns,
 * while the injection face itself is supplied by the wrapper (host) and the
 * client boot (M9). The registration carries the managed page id, the owning
 * package, and the surface render, and the returned disposer removes it.
 */
import { describe, expect, it } from 'vitest'
import {
  PAGE_ID, PACKAGE_NAME, PageAppFixture, registerFixtureSurface,
  type FixtureSurfaceRegistration, type FixtureWorkbench,
} from '../src/client/index.tsx'

/** A minimal in-memory Workbench bridge double recording registrations. */
function fakeWorkbench(): {
  workbench: FixtureWorkbench
  registered: FixtureSurfaceRegistration[]
  disposed: string[]
} {
  const registered: FixtureSurfaceRegistration[] = []
  const disposed: string[] = []
  const workbench: FixtureWorkbench = {
    lifecycle: { onDispose: () => () => {} },
    surfaces: {
      registerWorkspaceSurface: (registration) => {
        registered.push(registration)
        return () => { disposed.push(registration.pageId) }
      },
    },
  }
  return { workbench, registered, disposed }
}

describe('page-app fixture client contract consumption', () => {
  it('registers the keyed surface through the Workbench Contract entry and disposes it', () => {
    const { workbench, registered, disposed } = fakeWorkbench()
    const dispose = registerFixtureSurface(workbench)
    expect(registered).toEqual([{
      pageId: PAGE_ID,
      packageName: PACKAGE_NAME,
      render: PageAppFixture,
      order: 100,
    }])
    expect(disposed).toEqual([])
    dispose()
    expect(disposed).toEqual([PAGE_ID])
  })
})
