/**
 * Explicit compatibility bootstrap for npm DSH 0.1.1-rc.2.
 *
 * That launcher predates the launcher-owned `profileRuntime` service and still
 * writes user-patch generations directly to the root Include. This module is
 * removable once the minimum public DSH release provides `profileRuntime`:
 * the first guard becomes a complete no-op on that native path.
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, parse, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { FiberState, type Context, type Fiber } from '@deepseek-ai/cordis'
import { applyEntryPatches, entryListSchema, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import type { Entry } from '@deepseek-ai/cordis-plugin-loader'
import { load } from 'js-yaml'
import {
  composeProfilePatches,
  loadOptionalPatches,
  loadOverlayPatches,
  prepareManagerRuntimeLayer,
  PROFILE_RUNTIME_SERVICE,
  ProfileRuntime,
  profileRuntimeControl,
  readManagerLayerPatches,
  type ProfileRuntimeApplyRequest,
  type ProfileRuntimeApplyResult,
} from '@deepseek-ai/dsh-app-boot/profile-runtime-bridge'

const NAME = 'dsh workspace manager legacy rc2 compatibility'
const MANAGER_PACKAGE = '@tingyu9527/dsh-workspace-manager'
const MANAGER_ENTRY_ID = 'page-app-manager'
const PROFILE_PATCH_FILENAME = 'cordis.patch.yml'
const PROFILE_ROOT_FILENAME = 'cordis.yml'

/** Pinned first row of the manager bundle's legacy bootstrap anchor. */
export const LEGACY_RC2_COMPAT_ENTRY_ID = 'page-app-manager-legacy-rc2-compat'

interface BundleBoundary {
  readonly bundlePatches: PatchOptions[]
  readonly suffix: PatchOptions[]
}

interface BundleManifest {
  readonly name?: unknown
  readonly version?: unknown
  readonly dsh?: { readonly bundle?: { readonly patch?: unknown } }
}

function compatibleNativeRuntime(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false
  const runtime = value as Record<string, unknown>
  const identity = runtime.identity
  return identity !== null && typeof identity === 'object'
    && Object.isFrozen(identity)
    && typeof (identity as Record<string, unknown>).name === 'string'
    && typeof (identity as Record<string, unknown>).directory === 'string'
    && typeof runtime.applyManagerLayer === 'function'
    && typeof runtime.restoreManagerLayer === 'function'
}

function terminalFiberState(state: FiberState): boolean {
  return state === FiberState.FAILED
    || state === FiberState.DISPOSED
    || state === FiberState.UNLOADING
}

function explicitlyDisablesCompat(layer: readonly PatchOptions[]): boolean {
  const rows = applyEntryPatches(
    [{ id: LEGACY_RC2_COMPAT_ENTRY_ID, name: `${MANAGER_PACKAGE}/legacy-rc2-compat` }],
    structuredClone([...layer]),
    () => {},
  )
  return rows.find(row => row.id === LEGACY_RC2_COMPAT_ENTRY_ID)?.disabled === true
}

function insertedRows(patch: unknown): unknown[] {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return []
  const insert = (patch as { insert?: unknown }).insert
  return Array.isArray(insert) ? insert : []
}

function rowIdentity(row: unknown): { id?: unknown; name?: unknown } {
  return row !== null && typeof row === 'object' && !Array.isArray(row) ? row : {}
}

function hasOrderedAnchor(layer: readonly PatchOptions[]): boolean {
  return orderedAnchorPatchIndexes(layer).length > 0
}

function orderedAnchorPatchIndexes(layer: readonly PatchOptions[]): number[] {
  return layer.flatMap((patch, patchIndex) => {
    const rows = insertedRows(patch)
    const found = rows.some((row, index) => {
      const first = rowIdentity(row)
      const second = rowIdentity(rows[index + 1])
      return first.id === LEGACY_RC2_COMPAT_ENTRY_ID
        && first.name === `${MANAGER_PACKAGE}/legacy-rc2-compat`
        && second.id === MANAGER_ENTRY_ID
        && second.name === MANAGER_PACKAGE
    })
    return found ? [patchIndex] : []
  })
}

function anchorCount(layer: readonly PatchOptions[]): number {
  return layer.flatMap(insertedRows).filter(row => rowIdentity(row).id === LEGACY_RC2_COMPAT_ENTRY_ID).length
}

/**
 * Prove the bundle/user boundary from the actual resolved bundle layers.
 * The manager bundle must be final and carry one ordered bootstrap→manager anchor.
 */
export function locateLegacyRc2BundleBoundary(
  patches: readonly PatchOptions[],
  bundleLayers: readonly (readonly PatchOptions[])[],
): BundleBoundary {
  const managerLayer = bundleLayers.at(-1)
  if (managerLayer === undefined || !hasOrderedAnchor(managerLayer)) {
    if (bundleLayers.some(layer => hasOrderedAnchor(layer))) {
      throw new Error(`${NAME}: manager compatibility anchor must be in the final bundle layer`)
    }
    throw new Error(`${NAME}: manager bundle lacks the ordered anchor`)
  }
  const allBundlePatches = bundleLayers.flatMap(layer => [...layer])
  if (anchorCount(allBundlePatches) !== 1) {
    throw new Error(`${NAME}: compatibility anchor must occur exactly once`)
  }
  const managerStart = allBundlePatches.length - managerLayer.length
  const expectedAnchorIndexes = orderedAnchorPatchIndexes(managerLayer)
  const receivedAnchorIndexes = orderedAnchorPatchIndexes(patches)
  const expectedManagerAnchorIndex = expectedAnchorIndexes[0]
  if (expectedManagerAnchorIndex === undefined) {
    throw new Error(`${NAME}: manager bundle lacks the ordered anchor`)
  }
  const expectedAnchorIndex = managerStart + expectedManagerAnchorIndex
  if (anchorCount(patches) !== 1 || receivedAnchorIndexes.length !== 1) {
    throw new Error(`${NAME}: root Include compatibility anchor must occur exactly once as an ordered pair`)
  }
  if (patches.length < allBundlePatches.length || receivedAnchorIndexes[0] !== expectedAnchorIndex) {
    throw new Error(`${NAME}: root Include compatibility anchor is outside its exact final-bundle position`)
  }
  return {
    bundlePatches: structuredClone(allBundlePatches),
    suffix: structuredClone(patches.slice(allBundlePatches.length)),
  }
}

function parseManagerPatches(content: string): PatchOptions[] {
  const parsed: unknown = load(content, { schema: entryListSchema })
  if (!Array.isArray(parsed)) throw new Error(`${NAME}: manager runtime layer must be a top-level array`)
  return parsed as PatchOptions[]
}

/** One FIFO shared by manager generations and legacy watcher updates. */
export class LegacyRc2UpdateCoordinator {
  private readonly managerOperation = new AsyncLocalStorage<boolean>()
  private tail: Promise<unknown> = Promise.resolve()
  private managerPatches: readonly PatchOptions[]
  private disposed = false

  constructor(private readonly bundlePatches: readonly PatchOptions[], initialManagerPatches: readonly PatchOptions[]) {
    this.managerPatches = structuredClone(initialManagerPatches)
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(task, task)
    this.tail = run.then(() => {}, () => {})
    return run
  }

  /** Run a complete manager apply/audit/promotion as one FIFO operation. */
  async runManager<T>(
    task: () => Promise<T>,
    promoted?: readonly PatchOptions[] | (() => readonly PatchOptions[]),
  ): Promise<T> {
    return await this.enqueue(async () => await this.managerOperation.run(true, async () => {
      const result = await task()
      if (promoted !== undefined) {
        this.managerPatches = structuredClone(typeof promoted === 'function' ? promoted() : promoted)
      }
      return result
    }))
  }

  /** Intercept one exact root-Include update. */
  async intercept(config: Record<string, unknown>, next: () => void | Promise<void>, dispose: () => void): Promise<void> {
    if (this.disposed || this.managerOperation.getStore() === true) {
      await next()
      return
    }
    const patches = config.patches
    if (!Array.isArray(patches)) {
      this.disposed = true
      dispose()
      await next()
      return
    }
    if (anchorCount(patches as PatchOptions[]) === 0) {
      // Bundle removal legitimately removes the anchor; release the interposer
      // and let that generation proceed unchanged.
      this.disposed = true
      dispose()
      await next()
      return
    }
    const boundary = locateLegacyRc2BundleBoundary(patches as PatchOptions[], [this.bundlePatches])
    await this.enqueue(async () => {
      if (explicitlyDisablesCompat(boundary.suffix)) {
        this.disposed = true
        dispose()
        config.patches = structuredClone([
          ...boundary.bundlePatches,
          ...boundary.suffix,
        ])
        await next()
        return
      }
      config.patches = structuredClone([
        ...boundary.bundlePatches,
        ...this.managerPatches,
        ...boundary.suffix,
      ])
      await next()
    })
  }
}

export class LegacyRc2ProfileRuntime extends ProfileRuntime {
  constructor(
    ctx: Context,
    options: ConstructorParameters<typeof ProfileRuntime>[1],
    private readonly coordinator: LegacyRc2UpdateCoordinator,
    private readonly ready: () => Promise<void>,
  ) {
    super(ctx, options)
  }

  override async applyManagerLayer(request: ProfileRuntimeApplyRequest): Promise<ProfileRuntimeApplyResult> {
    await this.ready()
    const patches = parseManagerPatches(request.runtimeLayer)
    return await this.coordinator.runManager(async () => await super.applyManagerLayer(request), patches)
  }

  override async restoreManagerLayer(request: ProfileRuntimeApplyRequest): Promise<ProfileRuntimeApplyResult> {
    await this.ready()
    const patches = parseManagerPatches(request.runtimeLayer)
    return await this.coordinator.runManager(async () => await super.restoreManagerLayer(request), patches)
  }
}

/**
 * Tear down the exact compatibility owner after an asynchronous post-bootstrap
 * failure.  The original error remains the primary diagnostic; a disposal
 * failure is retained alongside it instead of leaving a half-live service.
 */
export async function disposeLegacyRc2FiberAfterReadyFailure(
  ctx: Context,
  error: unknown,
  activeTimeoutMs = 10_000,
): Promise<void> {
  ctx.logger.error(error)
  if (ctx.fiber.state === FiberState.PENDING || ctx.fiber.state === FiberState.LOADING) {
    try {
      await awaitLegacyRc2FiberActive(ctx, activeTimeoutMs)
    } catch {
      // A terminal fiber already releases its owned service/effects. A mere
      // watchdog timeout is different: still attempt exact-owner disposal.
      if (terminalFiberState(ctx.fiber.state)) return
    }
  }
  try {
    await ctx.fiber.dispose()
  } catch (disposeError) {
    ctx.logger.error(new AggregateError(
      [error, disposeError],
      `${NAME}: post-bootstrap failure and compatibility-fiber disposal failure`,
    ))
  }
}

/** Wait until Cordis commits the bootstrap provider, without polling or awaiting this same fiber. */
export function awaitLegacyRc2FiberActive(ctx: Context, timeoutMs = 10_000): Promise<void> {
  const stateError = (): Error | undefined => {
    if (ctx.fiber.state === FiberState.ACTIVE) return
    if (ctx.fiber.state === FiberState.FAILED
      || ctx.fiber.state === FiberState.DISPOSED
      || ctx.fiber.state === FiberState.UNLOADING) {
      return new Error(`${NAME}: compatibility fiber exited before becoming active`)
    }
  }
  const initialError = stateError()
  if (ctx.fiber.state === FiberState.ACTIVE) return Promise.resolve()
  if (initialError !== undefined) return Promise.reject(initialError)

  return new Promise<void>((resolveBarrier, rejectBarrier) => {
    let settled = false
    let watchdog: ReturnType<typeof setTimeout> | undefined
    let stopListening = (): void => {}
    const finish = (error?: Error): void => {
      if (settled) return
      settled = true
      stopListening()
      if (watchdog !== undefined) clearTimeout(watchdog)
      if (error === undefined) resolveBarrier()
      else rejectBarrier(error)
    }
    const inspect = (): void => {
      if (ctx.fiber.state === FiberState.ACTIVE) finish()
      else {
        const error = stateError()
        if (error !== undefined) finish(error)
      }
    }
    stopListening = ctx.on('internal/status', (fiber) => {
      if (fiber === ctx.fiber) inspect()
    })
    // Close the check→subscribe lost-wakeup window.
    inspect()
    if (ctx.fiber.state !== FiberState.ACTIVE && !terminalFiberState(ctx.fiber.state)) {
      watchdog = setTimeout(() => {
        finish(new Error(`${NAME}: compatibility fiber did not become active within ${timeoutMs}ms`))
      }, timeoutMs)
    }
  })
}

/** Prepare the derived layer before capturing the exact restart snapshot. */
export async function prepareLegacyRc2ManagerSnapshot(
  binName: string,
  profileDirectory: string,
): Promise<{
  startup: Awaited<ReturnType<typeof prepareManagerRuntimeLayer>>
  managerPatches: PatchOptions[]
}> {
  const startup = await prepareManagerRuntimeLayer(binName, profileDirectory, MANAGER_PACKAGE)
  const managerPatches = readManagerLayerPatches(binName, profileDirectory)
  return { startup, managerPatches }
}

function resolvePackageManifest(requireFromProfile: NodeJS.Require, packageName: string): string {
  try {
    return requireFromProfile.resolve(`${packageName}/package.json`)
  } catch {
    let current = dirname(requireFromProfile.resolve(packageName))
    const root = parse(current).root
    while (current !== root) {
      const candidate = join(current, 'package.json')
      try {
        const manifest = JSON.parse(readFileSync(candidate, 'utf8')) as BundleManifest
        if (manifest.name === packageName) return candidate
      } catch {
        // Keep walking: package entry points commonly live below lib/.
      }
      current = dirname(current)
    }
    throw new Error(`${NAME}: cannot resolve package root for ${packageName}`)
  }
}

function readBundleLayers(profileDirectory: string): PatchOptions[][] {
  const manifest = JSON.parse(readFileSync(join(profileDirectory, 'package.json'), 'utf8')) as {
    dsh?: { profile?: { bundles?: unknown } }
  }
  const bundles = manifest.dsh?.profile?.bundles
  if (!Array.isArray(bundles) || !bundles.every(name => typeof name === 'string')) {
    throw new Error(`${NAME}: profile manifest has no ordered bundle list`)
  }
  if (bundles.at(-1) !== MANAGER_PACKAGE) {
    throw new Error(`${NAME}: manager bundle must be the final profile bundle`)
  }
  const requireFromProfile = createRequire(join(profileDirectory, 'package.json'))
  return bundles.map((packageName) => {
    const packageManifest = resolvePackageManifest(requireFromProfile, packageName)
    const bundle = JSON.parse(readFileSync(packageManifest, 'utf8')) as BundleManifest
    const patch = bundle.dsh?.bundle?.patch
    if (typeof patch !== 'string') throw new Error(`${NAME}: ${packageName} has no bundle patch`)
    return loadOverlayPatches(NAME, resolve(dirname(packageManifest), patch))
  })
}

interface LegacyRc2ProfileIdentity {
  readonly name: string
  readonly directory: string
  readonly homeDirectory: string
}

/** Validate the public launcher root against its authoritative DSH home helper. */
export function resolveLegacyRc2ProfileIdentity(
  dshHomePath: (...segments: string[]) => string,
  rootConfig: string,
): LegacyRc2ProfileIdentity {
  const homeDirectory = resolve(dshHomePath())
  const config = resolve(rootConfig)
  const profileDirectory = dirname(config)
  const name = profileDirectory.split(/[\\/]/u).at(-1) ?? ''
  const expected = resolve(dshHomePath('profiles', name, PROFILE_ROOT_FILENAME))
  if (name.length === 0 || config !== expected) {
    throw new Error(`${NAME}: root Include must target DSH_HOME/profiles/<name>/${PROFILE_ROOT_FILENAME}`)
  }
  return Object.freeze({ name, directory: profileDirectory, homeDirectory })
}

function strictRootInclude(ctx: Context): {
  entry: Entry
  profile: LegacyRc2ProfileIdentity
  patches: PatchOptions[]
} {
  const loader = ctx.root.get('loader')
  if (loader === undefined) throw new Error(`${NAME}: root Loader is unavailable`)
  const entry = loader.resolve('include')
  const config = entry.options.config as { path?: unknown; patches?: unknown } | undefined
  if (entry.options.id !== 'include' || entry.options.name !== 'cordis:include'
    || entry.fiber === undefined || typeof config?.path !== 'string' || !Array.isArray(config.patches)) {
    throw new Error(`${NAME}: root Include fingerprint failed`)
  }
  const rootConfig = fileURLToPath(new URL(config.path, entry.ctx.baseUrl))
  const dshHomePath: unknown = ctx.root.get('dshHomePath')
  if (typeof dshHomePath !== 'function') {
    throw new Error(`${NAME}: root dshHomePath service is unavailable`)
  }
  const profile = resolveLegacyRc2ProfileIdentity(
    dshHomePath as (...segments: string[]) => string,
    rootConfig,
  )
  return { entry, profile, patches: config.patches as PatchOptions[] }
}

/** Cordis plugin bootstrap. The native launcher path returns before any structural change. */
export function apply(ctx: Context): void {
  const nativeRuntime: unknown = ctx.root.get(PROFILE_RUNTIME_SERVICE)
  if (nativeRuntime !== undefined) {
    if (!compatibleNativeRuntime(nativeRuntime)) {
      throw new Error(`${NAME}: native profileRuntime service has an incompatible structure`)
    }
    return
  }

  const { entry, profile, patches } = strictRootInclude(ctx)
  const profileDirectory = profile.directory
  const requireFromProfile = createRequire(join(profileDirectory, 'package.json'))
  const appBootManifest = JSON.parse(readFileSync(
    resolvePackageManifest(requireFromProfile, '@deepseek-ai/dsh-app-boot'),
    'utf8',
  )) as BundleManifest
  if (appBootManifest.version !== '0.1.1-rc.2') {
    throw new Error(`${NAME}: legacy bootstrap supports only public @deepseek-ai/dsh-app-boot 0.1.1-rc.2`)
  }
  const bundleLayers = readBundleLayers(profileDirectory)
  const boundary = locateLegacyRc2BundleBoundary(patches, bundleLayers)
  const profilePatches = loadOptionalPatches(NAME, join(profileDirectory, PROFILE_PATCH_FILENAME)) ?? []
  const homeDirectory = profile.homeDirectory
  const homePatches = loadOptionalPatches(NAME, join(homeDirectory, PROFILE_PATCH_FILENAME)) ?? []
  const userPrefix = [...profilePatches, ...homePatches]
  if (!isDeepStrictEqual(boundary.suffix.slice(0, userPrefix.length), userPrefix)) {
    throw new Error(`${NAME}: root Include user-layer boundary does not match profile and home patches`)
  }
  const overlays = structuredClone(boundary.suffix.slice(userPrefix.length))
  const coordinator = new LegacyRc2UpdateCoordinator(boundary.bundlePatches, [])

  const rootFiber = entry.fiber
  const rootPath = (entry.options.config as { path: string }).path
  let dispose = (): void => {}
  dispose = ctx.on('internal/update', async function (this: Fiber, config, _noSave, next) {
    const candidate = config as Record<string, unknown>
    if (this !== rootFiber || candidate.path !== rootPath) {
      await next()
      return
    }
    await coordinator.intercept(candidate, next, dispose)
  }, { global: true, prepend: true })

  let preparedManagerPatches: readonly PatchOptions[] = []
  let postReady: Promise<void> = Promise.resolve()
  const runtime = new LegacyRc2ProfileRuntime(ctx, {
    identity: { name: profile.name, directory: profileDirectory },
    ownerPackageName: MANAGER_PACKAGE,
    compose: managerPatches => composeProfilePatches({
      bundlePatches: boundary.bundlePatches,
      managerPatches,
      profilePatches: loadOptionalPatches(NAME, join(profileDirectory, PROFILE_PATCH_FILENAME)) ?? [],
      homePatches: loadOptionalPatches(NAME, join(homeDirectory, PROFILE_PATCH_FILENAME)) ?? [],
      overlays,
    }),
    // Public rc2 does not await an asynchronous Include child apply. Provide
    // synchronously with an unusable provisional snapshot; every mutation
    // waits postReady, and the boot-only control atomically replaces this
    // snapshot only after prepare→read succeeds.
    initialManagerPatches: [],
  }, coordinator, async () => { await postReady })
  const control = profileRuntimeControl(runtime)
  if (control === undefined) throw new Error(`${NAME}: constructed runtime has no boot control`)
  control.bindRootInclude(entry)

  postReady = coordinator.runManager(async () => {
    const snapshot = await prepareLegacyRc2ManagerSnapshot(NAME, profileDirectory)
    preparedManagerPatches = snapshot.managerPatches
    control.initializeManagerSnapshot({
      managerPatches: preparedManagerPatches,
      ...snapshot.startup.recoveryError === undefined
        ? {}
        : { recoveryError: snapshot.startup.recoveryError },
      omittedRoots: snapshot.startup.omitted,
    })
    await awaitLegacyRc2FiberActive(ctx)
    await ctx.get('loader')?.await()
    await control.markSettled()
    // Recompose exactly the snapshot committed and read above. The manager
    // token bypasses this interposer's own listener while all external watcher
    // generations remain behind the same FIFO.
    await control.recompose()
  }, () => preparedManagerPatches)
  void postReady.catch(async (error: unknown) => {
    // The async initialization is detached from rc2's non-awaiting Include
    // apply, so every failure explicitly releases this exact owning fiber.
    await disposeLegacyRc2FiberAfterReadyFailure(ctx, error)
  })
  // The compatibility fiber must become ACTIVE before Loader settlement can
  // observe it. Post-bootstrap readiness is exposed through the runtime's
  // mutation methods and is also monitored above for fail-closed teardown.
  return
}
