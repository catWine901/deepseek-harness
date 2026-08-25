/**
 * Workbench Runtime (design D4): the Host service a Feature Runtime Wrapper
 * injects and the only surface a Feature reaches through. The runtime carries
 * the minimal contract-v1 domain API — lifecycle disposal, workspace-surface
 * registration, events, storage get/set, and a host call seam — and is
 * provided under {@link WORKBENCH_RUNTIME_SERVICE} by the manager fiber, so
 * disposer removal deletes the service and Cordis re-evaluates every dependent
 * wrapper fiber (provider loss parks them PENDING; re-provide reloads them).
 * Every registered side effect is owned by the runtime's fiber and released in
 * reverse mount order when the fiber unloads. The contract's client render
 * wiring lands with the fixture migration (M9); this host half records the
 * surface seat and its owning package provenance.
 * @module @deepseek-ai/dsh-page-app-manager/workbench-runtime
 */

import type { Context } from '@deepseek-ai/cordis'

/** The service name the manager provides the Workbench Runtime under. */
export const WORKBENCH_RUNTIME_SERVICE = 'workbenchRuntime'

/** One workspace surface seat registered through the contract. */
export interface WorkbenchSurfaceRegistration {
  /** The managed page id the surface seat is keyed by. */
  readonly pageId: string
  /** The owning package name (provenance lineage, equals the wrapper's feature package). */
  readonly packageName: string
  /**
   * The surface render contributed by the Feature. The host half records the
   * seat and provenance; the client render fills this through the Workbench
   * Context injection face when the fixture migrates (M9).
   */
  readonly render?: unknown
}

/** One event subscription the runtime holds for a Feature. */
export interface WorkbenchEventSubscription {
  /**
   * Subscribe to one runtime event name.
   * @param name - the event name.
   * @param listener - the listener invoked with the emitted payload.
   * @returns a disposer that removes the listener.
   */
  on(name: string, listener: (payload: unknown) => void): () => void
  /**
   * Emit one runtime event.
   * @param name - the event name.
   * @param payload - the payload every listener receives.
   */
  emit(name: string, payload?: unknown): void
}

/** The Feature-facing domain API the manager provides. */
export interface WorkbenchRuntime {
  /** Lifecycle disposal: every side effect a Feature registers releases with the runtime. */
  readonly lifecycle: {
    /**
     * Register one disposal callback that runs when the runtime fiber unloads.
     * @param callback - the callback to run at disposal.
     * @returns a disposer that removes the callback.
     */
    onDispose(callback: () => void): () => void
  }
  /** Workspace-surface registration: the contract's single surface entry. */
  readonly surfaces: {
    /**
     * Register one workspace surface seat. The returned disposer removes the
     * registration; the runtime records the owning package provenance.
     * @param registration - page id, owning package, and the surface render.
     * @returns a disposer that removes the registration.
     */
    registerWorkspaceSurface(registration: WorkbenchSurfaceRegistration): () => void
    /** Every live surface registration, in registration order. */
    list(): readonly WorkbenchSurfaceRegistration[]
  }
  /** Runtime events: the Feature subscribes through the contract, never Cordis. */
  readonly events: WorkbenchEventSubscription
  /** Keyed storage the runtime owns per fiber. */
  readonly storage: {
    /** Read one stored value (undefined when absent). */
    get(key: string): unknown
    /** Store one value under a key. */
    set(key: string, value: unknown): void
  }
  /** Host call seam: the Feature invokes Host capabilities by name. */
  readonly host: {
    /**
     * Call one Host capability. Contract v1 keeps the seam but wires no
     * capability yet: the fixture migration (M9) registers the surface
     * lifecycle behind this face, so an unknown method fails loud instead of
     * silently no-oping.
     * @param method - the capability name.
     * @param args - the capability arguments.
     * @returns the capability result.
     * @throws {Error} naming the unwired method.
     */
    call(method: string, ...args: unknown[]): Promise<unknown>
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The Workbench Runtime service provided by the manager fiber. */
    workbenchRuntime: WorkbenchRuntime
  }
}

/**
 * Build the Workbench Runtime for one manager fiber. The runtime's ctx effect
 * owns every registered side effect: when the fiber unloads, disposer-owned
 * callbacks, surface seats, listeners, and storage release together, and the
 * service unregistration (Cordis's provide disposer) re-evaluates dependent
 * wrapper fibers.
 * @param ctx - the manager's plugin context (the providing fiber).
 * @returns the Feature-facing domain API.
 */
export function createWorkbenchRuntime(ctx: Context): WorkbenchRuntime {
  const disposeCallbacks = new Set<() => void>()
  const surfaceSeats = new Map<string, WorkbenchSurfaceRegistration>()
  const listeners = new Map<string, Set<(payload: unknown) => void>>()
  const store = new Map<string, unknown>()

  const release = (): void => {
    for (const callback of [...disposeCallbacks]) {
      try {
        callback()
      } catch {
        // One failing disposer must not hide the runtime release.
      }
    }
    disposeCallbacks.clear()
    surfaceSeats.clear()
    listeners.clear()
    store.clear()
  }
  ctx.effect(() => release, `${WORKBENCH_RUNTIME_SERVICE}: release every registered Workbench side effect with the manager fiber`)

  return {
    lifecycle: {
      onDispose: (callback) => {
        disposeCallbacks.add(callback)
        return () => { disposeCallbacks.delete(callback) }
      },
    },
    surfaces: {
      registerWorkspaceSurface: (registration) => {
        surfaceSeats.set(registration.pageId, Object.freeze({ ...registration }))
        return () => { surfaceSeats.delete(registration.pageId) }
      },
      list: () => [...surfaceSeats.values()],
    },
    events: {
      on: (name, listener) => {
        const existing = listeners.get(name)
        const set = existing ?? new Set<(payload: unknown) => void>()
        if (existing === undefined) listeners.set(name, set)
        set.add(listener)
        return () => { set.delete(listener) }
      },
      emit: (name, payload) => {
        for (const listener of [...(listeners.get(name) ?? [])]) listener(payload)
      },
    },
    storage: {
      get: key => store.get(key),
      set: (key, value) => { store.set(key, value) },
    },
    host: {
      call: (method: string, ..._args: unknown[]) => {
        throw new Error(`page-app workbench: no host method "${method}" is wired (contract v1 wires host capabilities with the fixture migration)`)
      },
    },
  }
}
