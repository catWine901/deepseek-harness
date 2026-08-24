/**
 * Layout plugin, browser half: one inject()+register() pair contributes
 * AppFrame into the page-app shell's built-in DSH seat
 * ('page-app.shell.builtin') and, in the same breath, declares the four child
 * slots (declaration = exclusive render authority), seats the layout store
 * (panel geometry), and wires the panel-action service face. The page-app
 * manager owns the outer `root` seat; this package is the Original DSH
 * Surface occupant inside it. ctx.layout is the cross-plugin panel-action
 * contract; navigation state lives with the runtime sessions service. A
 * second effect seats the theme presenter, which projects ctx.theme
 * snapshots onto document.body.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
// Type-only: pulls the page-app shell's SlotMap merge (the
// 'page-app.shell.builtin' entry) into this program, so the DSH surface
// registers into the manager-declared seat instead of the runtime root.
import type {} from '@deepseek-ai/dsh-client-ui-page-app-manager/client'
import type { PanelActions } from './service.ts'
import { AppFrame } from './AppFrame.tsx'
import { createLayoutStore } from './stores.ts'
import { LayoutController } from './service.ts'
import { ThemePresenter } from './theme-presenter.ts'

// Contract exports only (export-convergence rule: cross-package consumers
// keep a symbol exported; test-only/package-internal symbols live off /src).
// ILayout: the ctx.layout face consumers and test fakes type against.
// OwnerShare contracts below are the render-side halves registrants compose
// against; the frame components and the store factory are package-internal.
export { LayoutController } from './service.ts'
export type { ILayout } from './service.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The outward face only; the concrete service stays inside this plugin. */
    layout: import('./service.ts').ILayout
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    // The 'page-app.shell.builtin' entry itself is the page-app shell's
    // built-in DSH seat (declared there); these four are the frame's children,
    // declared by the same register() call that contributes AppFrame. Session
    // owners never pass sessionId: the framework injects it as a standard prop.
    /**
     * The whole left column. OCCUPIED by ui-sidebar's SidebarRoot, which
     * declares the workspace and settings seats inside it — registering here
     * replaces the navigation column outright rather than adding to it, and
     * the seats it declares disappear with it. To add something to the
     * sidebar, register into one of those inner seats instead.
     *
     * The occupant receives the frame's live column state (collapsed, width)
     * and is expected to render the compact control rail while collapsed.
     */
    'sidebar': { kind: 'single'; scope: 'root'; owner: SidebarOwnerProps }
    /**
     * The whole center column, across both the no-session hero and a live
     * conversation. OCCUPIED by ui-conversation's ConversationRoot, which
     * declares the session body, composer, and input seats inside it —
     * registering here replaces the entire conversation surface (and removes
     * every seat it declares) rather than adding to it.
     *
     * Current-session-optional: the occupant owns both states without
     * changing its React identity, so it keeps its own state across a session
     * switch. It receives no owner props; session facts arrive through the
     * framework hooks of the `session-maybe` scope.
     */
    'conversation': { kind: 'single'; scope: 'session-maybe'; owner: ConvOwnerProps }
    /**
     * The right details column, shown when the layout opens it. OCCUPIED by
     * ui-conversation's DetailsPanel, which declares the tool-details seat
     * inside it — registering here replaces the column and takes that seat
     * with it. Absent an occupant the column renders nothing.
     *
     * No owner props: the framework injects the session id and hooks for the
     * `session` scope, and `ctx.layout` owns whether the column is open.
     */
    'details': { kind: 'single'; scope: 'session'; owner: DetailsOwnerProps }
    /**
     * Frame-wide floating layer, above every column and outside their scroll
     * containers. Deliberately generic and unowned by any feature: a badge, a
     * toast stack or a status pill all belong here, and entries order among
     * themselves. The layer itself is click-through — entries opt back into
     * pointer events — so an occupant never blocks the app underneath.
     *
     * This is the additive seat for a frame-wide surface of your own: a fresh
     * `id` is added beside the shipped entries instead of replacing them.
     */
    'shell.overlay': { kind: 'list'; scope: 'root' }
  }
}

// OwnerShare contracts — the render-side share the slot owner supplies at
// renderSlot. Registrants IMPORT these and compose their full component props
// through the four-share intersection (PropsRuntime & PropsRenderSlots &
// PropsStore & I). Conversation business state and actions arrive through
// framework-standard hooks and each registrant's inject face, not owner props.

/** Sidebar owner share: live column state from the frame's concession solve. */
export interface SidebarOwnerProps {
  /** True when the sidebar is closed (the column renders the compact control rail). */
  collapsed: boolean
  /** Rendered column width in px (SIDEBAR_COLLAPSED when collapsed). */
  width: number
}

/** Conversation owner share: business state and actions belong to the registrant. */
export interface ConvOwnerProps {}

/** Details owner share: empty — sessionId arrives as a framework-standard prop. */
export interface DetailsOwnerProps {}

/** Required services (cordis fiber inject — the loader passes all module exports as an object plugin). */
export const inject = ['slots', 'theme']

/**
 * Client plugin body: provide ctx.layout, then compose AppFrame through the
 * dual-path registration (D5): when the page-app manager declares the builtin
 * DSH seat ('page-app.shell.builtin') through a live root occupant, the frame
 * registers into that seat with the four child-slot declarations, the layout
 * store seat, and the inject hook that hands the store's bound actions to the
 * service — exactly as the pre-fallback composition did; when the seat is
 * absent or its declaring occupant is not live, the frame registers into the
 * built-in 'root' seat at priority 1 (strictly worse than the manager's
 * default 0) so Native DSH renders with no manager and survives a root-shell
 * crash without a browser refresh. One 'slots/changed' subscription reconciles
 * both paths; the switch collapses the active path's child declarations
 * before the other registers, so the single declarer rule and the single-seat
 * same-priority throw never fire (the core commits the root-entries mutation
 * before notifying child declarations, which makes the yield synchronous).
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  const layout = new LayoutController()
  ctx.effect(() => {
    const disposeService = ctx.reflect.provide('layout', layout)
    /** The active composition path: the manager's builtin seat or the root fallback. */
    let active: 'builtin' | 'root' | null = null
    let disposeActive: (() => void) | null = null

    /** Register AppFrame into one seat with the four children, store, and actions. */
    const registerFrame = (target: 'builtin' | 'root'): (() => void) => {
      // The inject hook's only side effect connects the root store to
      // ctx.layout; conversation business actions belong to their registrants.
      const inject = (actions: PanelActions) => {
        layout.attachPanels(actions)
        return {}
      }
      if (target === 'builtin') {
        return ctx.slots.register({
          name: 'page-app.shell.builtin',
          children: {
            'sidebar': { kind: 'single', scope: 'root' },
            'conversation': { kind: 'single', scope: 'session-maybe' },
            'details': { kind: 'single', scope: 'session' },
            'shell.overlay': { kind: 'list', scope: 'root' },
          },
          // Exclusive store: the factory itself — the framework instantiates
          // per entry and delivers useStore/actions to AppFrame as standard
          // props.
          store: createLayoutStore,
          inject,
        }, AppFrame)
      }
      return ctx.slots.register({
        name: 'root',
        // Strictly worse than the manager's default 0: the cell's lowest live
        // priority renders, so the manager wins while live and the fallback
        // wins once the manager is absent or its entry abdicated.
        priority: 1,
        children: {
          'sidebar': { kind: 'single', scope: 'root' },
          'conversation': { kind: 'single', scope: 'session-maybe' },
          'details': { kind: 'single', scope: 'session' },
          'shell.overlay': { kind: 'list', scope: 'root' },
        },
        store: createLayoutStore,
        inject,
      }, AppFrame)
    }

    /** Switch (or keep) the active path; the previous path's children collapse first. */
    const activate = (target: 'builtin' | 'root'): void => {
      if (active === target) return
      // Commit the target BEFORE tearing down the previous path: the teardown
      // fires nested 'slots/changed' mutations that re-enter reconcile, and a
      // re-entrant reconcile must see the target as already active.
      active = target
      const disposePrevious = disposeActive
      disposeActive = null
      disposePrevious?.()
      disposeActive = registerFrame(target)
    }

    /**
     * Reconcile the two paths against the ledger on every slot mutation. Path
     * (i) requires the builtin seat to be declared BY A LIVE root occupant: an
     * abdicated manager (crashed shell) leaves the seat declared while the
     * root cell falls to the fallback, so Native DSH renders without a
     * refresh. The fallback is the only root registrant at priority 1; any
     * other live occupant is the manager.
     */
    const reconcile = (): void => {
      const builtinDeclared = ctx.slots.spec('page-app.shell.builtin') !== undefined
      const managerLive = ctx.slots.entriesOfSlot('root')
        .some(entry => (entry.options.priority ?? 0) !== 1)
      if (builtinDeclared && managerLive) activate('builtin')
      else activate('root')
    }

    const off = ctx.on('slots/changed', reconcile)
    reconcile()
    return () => {
      off()
      disposeActive?.()
      // provide()'s disposer settles asynchronously; teardown is synchronous fire-and-forget.
      void disposeService()
    }
  }, 'ui-layout: service + dual-path registration')

  // Theme presentation: pure DOM writes from resolved snapshots — initial
  // state through the getter once, then event-driven only; no React path.
  ctx.effect(() => {
    const presenter = new ThemePresenter()
    presenter.apply(ctx.theme.getTheme())
    const off = ctx.on('theme/change', (snapshot) => { presenter.apply(snapshot) })
    return () => {
      off()
      presenter.dispose()
    }
  }, 'ui-layout: theme presenter')
}