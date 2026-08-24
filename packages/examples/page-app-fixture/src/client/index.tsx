/**
 * Client half of the page-app fixture: the contract v1 surface entry. The
 * fixture registers a KEYED workspace surface through `registerWorkspaceSurface`
 * — the single entry the Workbench Contract v1 document fixes. The shared
 * contract package arrives with the Workbench Runtime (M7); until then the
 * fixture owns this local copy of the entry so it stays Cordis-free and
 * self-contained, and M9 swaps it for the wrapper-injected WorkbenchContext.
 * @module @deepseek-ai/dsh-page-app-fixture/client
 */

/** One workspace surface registration (contract v1, design D2). */
export interface WorkbenchSurfaceRegistration {
  /** The managed page id; the surface seat is keyed by it. */
  readonly pageId: string
  /** The owning Feature package name (provenance lineage). */
  readonly packageName: string
  /** The surface renderer (a React component once M9 ships the real surface). */
  readonly render: unknown
}

/** Live keyed registrations (single module instance in the client bundle). */
const surfaces = new Map<string, WorkbenchSurfaceRegistration>()

/**
 * Register one keyed workspace surface (the contract v1 single entry).
 * @param registration - the page-keyed surface registration.
 * @returns a disposer that removes the registration.
 */
export function registerWorkspaceSurface(registration: WorkbenchSurfaceRegistration): () => void {
  surfaces.set(registration.pageId, registration)
  return () => {
    surfaces.delete(registration.pageId)
  }
}

/**
 * Read the surface registered under one page id.
 * @param pageId - the managed page id to look up.
 * @returns the registration, or undefined when none is registered.
 */
export function workspaceSurface(pageId: string): WorkbenchSurfaceRegistration | undefined {
  return surfaces.get(pageId)
}
