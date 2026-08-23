/**
 * client-hmr, browser half: hot-reload driver for client plugin entries.
 *
 * Listens on the host's system SSE channel (`GET /plugins/events`); on a
 * `rebuilt` frame it reloads the entry's bundle and swaps the cordis
 * fiber in place. Every graph entry is a plugin bundle
 * — `immediately` rows differ only in stage-one prefetch (a boot
 * optimization), so all rostered plugin packages share these reload semantics;
 * normal packages (react family, cordis, shell, pure libs) are not entries
 * and shell changes still mean a page reload. Cascade is zero-touch:
 * downstream fibers key their activation epoch on provider fiber uids
 * (vendor/cordis/src/fiber.ts `_refresh`), so replacing a provider fiber
 * re-cascades natively — reloading a data-layer plugin (connection/runtime)
 * cascades into its UI dependents with no HMR-side bookkeeping.
 *
 * Reload order (lazy CJS table): invalidate (drop the stale factory and
 * materialized record) → prefetch (load and register the fresh
 * factory) → registry-first teardown → drain old fiber unload → remove
 * owned `<style data-plugin>` tags → `entry.refresh()` materializes the new
 * factory. Invalidate MUST precede prefetch: a live factory makes prefetch
 * a no-op, and re-executing a bundle over an undeleted registration is a
 * loud duplicate. The swap is safe because execution is pure registration
 * under the lazy model — every module side effect (CSS injection included)
 * lives in the factory closure and runs at materialization, inside
 * refresh(). That also keeps the CSS ordering guarantee: owned styles are
 * removed after the old fiber's disposers drained (SlotCore one-owner
 * unregister) and before materialization re-injects tags under the same
 * stable tag ids.
 *
 * Failure window: if prefetch rejects after invalidate, the module is left
 * unregistered while the OLD fiber keeps running untouched (teardown never
 * started) — degraded but recoverable, the next rebuilt frame retries from
 * scratch. Consistent with the no-rollback policy below. Known dev-only
 * race: a rebuilt frame overlapping a still-in-flight boot arrival shares
 * that arrival's task and may materialize the pre-rebuild bytes; the next
 * rebuilt frame self-heals.
 *
 * Why not the naive `entry.fiber.dispose()` → `entry.refresh()` path:
 * 1. `Entry.fiber` is never cleared on dispose (vendor/loader/src/config/
 *    entry.ts assigns it only in `_init`), so `refresh()` hits its
 *    `if (this.fiber) return` guard and no-ops.
 * 2. A bare `fiber.dispose()` lands in Loader's self-dispose branch
 *    (vendor/loader/src/index.ts `internal/plugin` case 4: the registry
 *    still holds the runtime at emit time), which flags the entry
 *    `disabled: true` — permanently.
 * vendor/hmr's reload skeleton documents the fix: delete the runtime record
 * FIRST (`registry.delete` → case 4 returns early, the entry stays enabled),
 * then rebuild. `entry.fiber` is additionally cleared so
 * `entry.refresh()` re-imports and re-plugins through the Loader's own
 * `_init` (entry-resolved config, automatic `fiber.entry` rebinding) instead
 * of hand-rolling `registry.plugin`. Client entries have exactly one fiber
 * per runtime, so `registry.delete` never collaterally disposes siblings.
 *
 * Self-reload: this plugin is itself a graph entry, so a rebuilt frame may
 * name it. The in-flight reload keeps running in the old bundle's closure
 * (its EventSource closes with the old fiber's effects); the new bundle's
 * apply opens a fresh channel. The connect-time graph frame then converges
 * the new client from the current module graph, so frames lost during the
 * EventSource gap self-heal.
 *
 * Failure policy: no rollback. An import failure leaves the entry
 * fiberless (the next rebuilt frame retries from scratch); an apply failure
 * leaves a FAILED fiber for the shell's status projection. Both log loudly.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Entry, Loader } from '@deepseek-ai/cordis-plugin-loader'
import type { ClientModuleLoader } from '@deepseek-ai/dsh-client-modules/client'
import type { WebBootGraph } from '@deepseek-ai/dsh-client-modules'
import type { PluginsEventFrame } from '../events.ts'
import { EVENTS_ENDPOINT } from '../events.ts'

export type { PluginsEventFrame } from '../events.ts'
export { EVENTS_ENDPOINT } from '../events.ts'

/** Cordis plugin name. */
export const name = 'client-hmr'

/** Required services: the vendored Loader (entry governance) and the client module system (boot provide, service name `modules`). */
export const inject = ['loader', 'modules']

/** Find the loader entry whose module specifier is `id` (entry tree ids are random; the package name lives in `options.name`). */
function findEntry(loader: Loader, id: string): Entry | undefined {
  for (const entry of loader.entries()) {
    if (entry.options.name === id) return entry
  }
  return undefined
}

/** Remove every `<style data-plugin>` tag owned by `id` (attribute compared verbatim — no CSS-selector escaping pitfalls). */
function removeOwnedStyles(id: string): void {
  for (const el of document.querySelectorAll('style[data-plugin]')) {
    if (el.getAttribute('data-plugin') === id) el.remove()
  }
}

/**
 * Reconcile the live module graph and Loader tree to a fresh `graph` frame.
 * The whole candidate is validated and published atomically by
 * {@link ClientModuleLoader.replaceGraph} BEFORE any loader mutation, so a
 * rejected wire leaves everything untouched. Removed rows drain through the
 * safe `loader.remove(entry.id)` path (entry disposal never persists
 * `options.disabled`), then their module factory/record and owned styles are
 * invalidated. Added rows prefetch in graph order (a failing arrival aborts
 * before any entry exists — no partial added set), then their Loader entries
 * are created and each fiber settles before the reconcile resolves.
 * Unchanged rows are never touched, so their entries, fibers, records, and
 * mounted component state retain identity.
 * @param loader - the client cordis Loader owning the entry tree.
 * @param modLoader - the client module system owning the graph and bundle table.
 * @param graph - the validated wire graph to converge to.
 * @throws {Error} when the wire is rejected (no state changed) or an added
 * bundle cannot arrive (the graph is current but the row is not mounted).
 */
export async function reconcileGraph(
  loader: Loader,
  modLoader: ClientModuleLoader,
  graph: WebBootGraph,
): Promise<void> {
  // Validate the entire candidate and publish it atomically; a throw here
  // means zero mutations anywhere.
  const diff = modLoader.replaceGraph(graph)
  // 1. Removals: drain the entry (safe path — entry._dispose guards the
  //    Loader's self-dispose branch, so options.disabled is never persisted),
  //    drop the module factory/record, and remove owned styles.
  for (const id of diff.removed) {
    const entry = findEntry(loader, id)
    if (entry !== undefined) await loader.remove(entry.id)
    modLoader.invalidate(id)
    removeOwnedStyles(id)
  }
  // 2. Additions: prefetch every added row in graph order, then create their
  //    entries. A prefetch failure aborts before any entry exists.
  for (const id of diff.added) {
    await modLoader.prefetch(id)
  }
  for (const id of diff.added) {
    const entryId = await loader.create({ name: id })
    const fiber = loader.resolve(entryId).fiber
    if (fiber !== undefined) await fiber.await()
  }
}

/**
 * Mount the HMR driver: subscribe to the system SSE channel and hot-swap
 * rebuilt entries.
 * @param ctx - plugin context with `loader` and `modules` available.
 */
export function apply(ctx: Context): void {
  // Both are declared injections (typed Context merges: `modules` from the
  // client module loader package, `loader` from the vendored Loader).
  const modLoader = ctx.modules
  const loader: Loader = ctx.loader

  async function reload(id: string): Promise<void> {
    const entry = findEntry(loader, id)
    if (entry === undefined) {
      ctx.logger.warn(`client-hmr: rebuilt frame for unknown entry "${id}" (not in the loader tree)`)
      return
    }
    // Invalidate first (drop stale factory + record — a live factory makes
    // prefetch a no-op and re-registration a loud duplicate), then run the
    // async half while the old fiber still serves: script loading registers
    // the fresh factory with zero side effects (lazy CJS — module bodies run
    // at materialization, not execution).
    modLoader.invalidate(id)
    await modLoader.prefetch(id)

    const oldFiber = entry.fiber
    if (oldFiber !== undefined) {
      // Registry-first teardown (see module comment): the runtime record must
      // be gone before the fiber's disposer emits internal/plugin, or the
      // Loader flags the entry disabled.
      const runtime = oldFiber.runtime
      if (runtime !== null) entry.ctx.registry.delete(runtime.callback)
      // Drain the unload: effect disposers (slots, subscriptions) must finish
      // before the new bundle executes and the new apply re-registers.
      while (oldFiber.inertia !== undefined) await oldFiber.inertia
      delete entry.fiber
    }
    // Old owned styles go before materialization re-injects them (the CSS
    // idempotency guard keys on stable tag ids).
    removeOwnedStyles(id)
    // Re-init through the entry: fiber cleared above, so refresh() re-imports
    // — materializing the prefetched factory (CSS injects here) — and
    // re-plugins under the entry context. Import failures are logged by
    // Entry._init and leave the entry fiberless (retryable).
    await entry.refresh()
    // Surface apply failures loudly (no rollback, FAILED state stays).
    await entry.fiber?.await()
  }

  // Serialize reloads and graph reconciles: frames can arrive faster than a
  // swap completes, and interleaved dispose/execute chains would corrupt the
  // single-slot handoff (or the graph/rebuild ordering).
  let queue: Promise<void> = Promise.resolve()
  const enqueue = (operation: () => Promise<void>, label: string): void => {
    queue = queue.then(operation).catch((error: unknown) => {
      ctx.logger.error(`client-hmr: ${label} failed`)
      ctx.logger.error(error)
    })
  }
  const handle = (frame: PluginsEventFrame): void => {
    switch (frame.type) {
      case 'rebuilt':
        enqueue(() => reload(frame.id), `reload of "${frame.id}"`)
        break
      case 'graph':
        // The connect-time snapshot AND every later graph broadcast converge
        // the live graph; after a self-reload this heals frames lost during
        // the EventSource gap. The generic path (no Workspace Apps
        // special-casing): the manager waits on the converged graph result.
        enqueue(() => reconcileGraph(loader, modLoader, frame.graph), 'graph reconcile')
        break
      default:
        // Merge-extensible frame union: unknown frame types from newer hosts
        // are ignored by design.
        break
    }
  }

  ctx.effect(() => {
    const source = new EventSource(EVENTS_ENDPOINT)
    source.addEventListener('message', (event: MessageEvent<string>) => {
      let frame: PluginsEventFrame
      try {
        frame = JSON.parse(event.data) as PluginsEventFrame
      } catch {
        // Wire boundary: a malformed dev-channel frame is dropped loudly.
        ctx.logger.warn(`client-hmr: unparseable event frame: ${event.data}`)
        return
      }
      handle(frame)
    })
    return () => { source.close() }
  }, 'client-hmr: event source')
}
