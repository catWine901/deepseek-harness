/**
 * Client Workbench bridge: the manager provides this service while each
 * Workspace App Feature receives a caller-bound, deliberately narrow contract
 * through `inject: ['workbench']`. The bridge, not a Feature, reaches the
 * slots runtime. SlotRegistry's caller-bound service proxy therefore derives
 * immutable ownerPackage provenance from the Feature's Loader entry and owns
 * registrations on that Feature's fiber.
 * @module @deepseek-ai/dsh-client-ui-page-app-manager/client/workbench
 */

import { Service, type Context } from '@deepseek-ai/cordis'
import { PAGE_APP_SURFACE_SLOT } from './contracts.ts'

/** The injection service name for the client Workbench bridge. */
export const WORKBENCH_CLIENT_SERVICE = 'workbench'

/** One contract-v1 workspace surface registration. */
export interface WorkbenchSurfaceRegistration {
  /** The managed page id; it becomes the keyed surface slot key. */
  readonly pageId: string
  /** The owning Feature package name, retained for its contract provenance. */
  readonly packageName: string
  /** The Feature's render component. */
  readonly render: unknown
  /** Optional stable display order among managed surfaces. */
  readonly order?: number
}

/** The intentionally narrow client face injected into a Workspace App Feature. */
export interface WorkbenchClientBridge {
  /** Feature-lifetime cleanup registration. */
  readonly lifecycle: {
    /** Register one callback that releases with the calling Feature fiber. */
    onDispose(callback: () => void): () => void
  }
  /** The sole workspace-surface contribution entry. */
  readonly surfaces: {
    /** Register one keyed managed surface owned by the calling Feature. */
    registerWorkspaceSurface(registration: WorkbenchSurfaceRegistration): () => void
  }
}

/** Minimal slot registration seam the bridge needs; Features never receive it. */
interface ClientSlotsRegistrar {
  register(
    options: {
      name: string
      key: string
      order?: number
      inject?: () => Record<string, unknown>
    },
    component: unknown,
  ): () => void
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Caller-bound Workbench Contract v1 bridge for Workspace App Features. */
    workbench: WorkbenchClientBridge
  }
}

/**
 * Manager-owned service that materializes a Feature-bound contract face on
 * every caller access. Service getter binding is intentional: Cordis proxies
 * `this.ctx` to the consumer fiber, so both slot registration and lifecycle
 * release belong to that Feature rather than this manager's fiber.
 */
export class WorkbenchClientBridgeService extends Service {
  /** The lifecycle compartment for the calling Feature. */
  public get lifecycle(): WorkbenchClientBridge['lifecycle'] {
    return this.faceForCaller().lifecycle
  }

  /** The surface-registration compartment for the calling Feature. */
  public get surfaces(): WorkbenchClientBridge['surfaces'] {
    return this.faceForCaller().surfaces
  }

  /**
   * Build one stable-enough plain contract face over the current caller
   * context. The face is captured in a registered entry's inject callback, so
   * React receives the same Feature-bound lifetime bridge after registration.
   */
  private faceForCaller(): WorkbenchClientBridge {
    const caller = this.ctx
    const slots = caller.get('slots') as ClientSlotsRegistrar | undefined
    if (slots === undefined) {
      throw new Error('workbench bridge requires the client slots service before a Feature registers a surface')
    }
    const face: WorkbenchClientBridge = {
      lifecycle: {
        onDispose: (callback) => {
          const dispose = caller.effect(
            () => callback,
            'workbench: release one Feature side effect with its caller fiber',
          )
          return () => { void dispose() }
        },
      },
      surfaces: {
        registerWorkspaceSurface: registration => slots.register(
          {
            name: PAGE_APP_SURFACE_SLOT,
            key: registration.pageId,
            ...(registration.order === undefined ? {} : { order: registration.order }),
            inject: () => ({ workbench: face }),
          },
          registration.render,
        ),
      },
    }
    return face
  }

  /** Provide the bridge under the stable feature injection name. */
  public constructor(ctx: Context) {
    super(ctx, WORKBENCH_CLIENT_SERVICE)
  }
}
