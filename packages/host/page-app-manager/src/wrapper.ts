/**
 * Feature Runtime Wrapper (design D4, F-7): the named function plugin the
 * manager's runtime layer mounts as the parent row of every enabled,
 * statically valid Feature. The wrapper injects the {@link WORKBENCH_RUNTIME_SERVICE}
 * (so provider loss parks its fiber PENDING and return reloads it), mounts the
 * already-composed feature rows as Loader entries (each keeping its own entry
 * and fiber), and exposes only the contract surface to the Feature: the
 * feature's surface seat registers with its owning package provenance. The
 * module itself is the strict-mode boundary — a Feature never imports Cordis,
 * and the wrapper is the only host code that composes it.
 * @module @deepseek-ai/dsh-page-app-manager/wrapper
 */

import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { mountWrapperChildren, wrapperChildrenOf } from './adapter.ts'
import { WORKBENCH_RUNTIME_SERVICE } from './workbench-runtime.ts'

/** Stable plugin name of one wrapper row. */
export const name = 'page-app-manager.wrapper'

/** The wrapper waits for the Workbench Runtime; provider loss parks it PENDING. */
export const inject = [WORKBENCH_RUNTIME_SERVICE]

/** Validated wrapper config: the feature's package/page identity the wrapper composes. */
export const Config = z.object({
  /** The managed feature package name (the wrapper's ownerPackage lineage). */
  packageName: z.string().min(1),
  /** The managed page id (the surface seat key). */
  pageId: z.string().min(1),
  /** The feature's composed root row id. */
  rootEntryId: z.string().min(1),
  /** The admitted contract version of the feature's manifest. */
  contractVersion: z.number().int().positive(),
})

/**
 * Mount one wrapper row: mount the already-composed feature rows as Loader
 * entries (reverse-disposed with the wrapper fiber) and register the feature's
 * surface seat through the injected Workbench Runtime with the feature package
 * as its owner. Every side effect is owned by the wrapper fiber, so unload
 * (provider loss, disable, uninstall) releases the mounted rows and the seat
 * together.
 * @param ctx - the wrapper entry's context (inherits the Loader service and
 * injects the Workbench Runtime).
 * @param config - the validated wrapper config.
 */
export async function apply(ctx: Context, config: z.infer<typeof Config>): Promise<void> {
  const children = wrapperChildrenOf(ctx)
  if (children !== undefined) {
    const disposeChildren = await mountWrapperChildren(ctx, children)
    // The disposer IS the async removal: Cordis awaits returned disposer
    // promises during fiber unload, so provider loss removes the feature rows
    // before the loss settles — a fast provider return can never race a
    // still-in-flight removal and orphan re-created child entries.
    ctx.effect(
      () => disposeChildren,
      'page-app-manager.wrapper: dispose the mounted feature rows with the wrapper fiber',
    )
  }
  const runtime = ctx.workbenchRuntime
  const disposeSurface = runtime.surfaces.registerWorkspaceSurface({
    pageId: config.pageId,
    packageName: config.packageName,
  })
  ctx.effect(
    () => () => { disposeSurface() },
    'page-app-manager.wrapper: unregister the feature surface seat with the wrapper fiber',
  )
}
