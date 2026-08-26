/**
 * Client half of the page-app fixture: the contract v1 surface. The fixture
 * consumes the Workbench Contract's single entry `registerWorkspaceSurface`
 * from the narrow, caller-bound `workbench` service. The manager owns the
 * client bridge; this Feature neither receives the slot ledger nor constructs
 * a contract adapter. The source stays Cordis-free (no cordis import and no
 * ctx API call): the injected Workbench face is the only seam the surface
 * logic reaches.
 * @module @deepseek-ai/dsh-page-app-fixture/client
 */

import { useEffect, useState, type ReactNode } from 'react'

/** The managed page id of the fixture's surface seat. */
export const PAGE_ID = 'dsh-page-app-fixture'
/** The owning Feature package name (provenance lineage). */
export const PACKAGE_NAME = '@deepseek-ai/dsh-page-app-fixture'
/** The fixture's stable order among managed surface entries. */
const SURFACE_ORDER = 100

/** The narrow client contract a Feature receives through `inject: ['workbench']`. */
export interface FixtureWorkbench {
  /** Feature-lifetime cleanup registration. */
  readonly lifecycle: {
    /** Register one callback that releases with the Feature fiber. */
    onDispose(callback: () => void): () => void
  }
  /** The sole workspace-surface contribution entry. */
  readonly surfaces: {
    /** Register one keyed managed surface through the manager bridge. */
    registerWorkspaceSurface(registration: FixtureSurfaceRegistration): () => void
  }
}

/** The fixture's surface contribution, consumed by the narrow bridge only. */
export interface FixtureSurfaceRegistration {
  readonly pageId: string
  readonly packageName: string
  readonly render: unknown
  readonly order?: number
}

/** The fixture surface's render props: the injected Workbench bridge face. */
export interface FixtureSurfaceProps {
  /** The contract-v1 Workbench bridge the manager handed the surface. */
  readonly workbench: FixtureWorkbench
}

/**
 * The real fixture surface (contract v1 render): a counter, a note field, and
 * a live tick created through the Workbench lifecycle. The shell keep-mounts
 * the surface under a stable keyed seat, so React state survives DSH
 * round-trips and hide; StrictMode cleanup/setup releases exactly what setup
 * created. The tick interval is registered through the Workbench lifecycle
 * (contract duty), so disposal releases it with the fixture.
 * @param props - the injected workbench face.
 */
export function PageAppFixture({ workbench }: FixtureSurfaceProps): ReactNode {
  const [count, setCount] = useState(0)
  const [note, setNote] = useState('')
  const [tick, setTick] = useState(0)

  useEffect(() => {
    const timer = setInterval(() => { setTick(value => value + 1) }, 1000)
    // The interval is created through the Workbench lifecycle: the release
    // callback clears it when the workbench disposes the fixture.
    const release = workbench.lifecycle.onDispose(() => { clearInterval(timer) })
    return () => {
      clearInterval(timer)
      release()
    }
  }, [workbench])

  return (
    <div data-page-app-fixture>
      <h2>Page App Fixture</h2>
      <p data-fixture-package>{PACKAGE_NAME}</p>
      <p data-fixture-count>{count}</p>
      <button type="button" data-fixture-increment onClick={() => { setCount(value => value + 1) }}>
        Increment
      </button>
      <input
        data-fixture-note
        value={note}
        aria-label="Fixture note"
        onChange={(event) => { setNote(event.currentTarget.value) }}
      />
      <p data-fixture-tick>{tick}</p>
    </div>
  )
}

/**
 * Register the fixture's keyed workspace surface through the Workbench
 * Contract entry. This is the single surface contribution the fixture makes;
 * the caller-bound Workbench bridge is supplied by injection, never built by
 * the fixture's own logic.
 * @param workbench - the injected contract-v1 Workbench bridge.
 * @returns a disposer that removes the registration.
 */
export function registerFixtureSurface(workbench: FixtureWorkbench): () => void {
  return workbench.surfaces.registerWorkspaceSurface({
    pageId: PAGE_ID,
    packageName: PACKAGE_NAME,
    render: PageAppFixture,
    order: SURFACE_ORDER,
  })
}

/** Required service: the manager's caller-bound Workbench Contract bridge. */
export const inject = ['workbench']

/**
 * The Loader calls `apply` after the manager has injected the caller-bound
 * Workbench bridge. Registering through that bridge preserves the Feature's
 * immutable owner provenance and binds every side effect to its fiber.
 * @param ctx - the narrow injected workbench face (structurally typed; never Cordis).
 */
export function apply(ctx: {
  workbench: FixtureWorkbench
}): void {
  registerFixtureSurface(ctx.workbench)
}
