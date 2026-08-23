/**
 * Launcher-owned profile runtime: immutable active-profile identity plus the
 * sole acknowledged live-recomposition API. `profile-boot` provides one
 * `ProfileRuntime` in `boot(..., prepare)` beside the launch-environment and
 * cmdline facts, before any config-tree entry mounts; `boot()` binds the root
 * Include entry to it immediately after `mountRootInclude` resolves. The
 * tree's manager plugin may inject the service during boot but cannot mutate
 * the profile until the initial tree has settled. Every generation — the
 * manager's apply/restore and both user-patch watchers — runs through one
 * serialized recomposition queue, so no independent `entry.update` writers
 * can race on the root Include.
 * @module @deepseek-ai/dsh-app-boot/profile-runtime
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { Context, FiberState, Service } from '@deepseek-ai/cordis'
import type { Entry, EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { applyEntryPatches, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import {
  parsePageAppManifest,
  readPageAppRegistry,
  renderPageAppRuntimeLayer,
  resolvePageAppProfilePaths,
  type PageAppRegistryEntry,
  type PageAppRegistryV1,
  type ValidatedManagedRoot,
} from '@deepseek-ai/dsh-page-app-profile'
import { dump } from 'js-yaml'
import { loadOptionalPatches, loadOverlayPatches } from './index.ts'

/** The service name the launcher provides `ProfileRuntime` under. */
export const PROFILE_RUNTIME_SERVICE = 'profileRuntime'

/** Immutable identity of the active profile the runtime manages. */
export interface ActiveProfileIdentity {
  /** The profile name (its directory basename). */
  readonly name: string
  /** Absolute profile directory. */
  readonly directory: string
}

/** The manager's expectation for one Managed Root of the staged runtime layer. */
export interface ExpectedManagedRoot {
  /** The registry row's package name. */
  readonly packageName: string
  /** The registry row's page id. */
  readonly pageId: string
  /** The root entry id the manager derived for this root. */
  readonly rootEntryId: string
  /** {@link canonicalManagedRootHash} of the derived root entry. */
  readonly hash: string
}

/** One acknowledged manager-layer generation request. */
export interface ProfileRuntimeApplyRequest {
  /**
   * The registry revision the staged layer belongs to. Carried for the
   * manager's transaction validation (registry publication follows
   * acknowledgement, so the runtime does not compare it against the file).
   */
  readonly registryRevision: number
  /**
   * The exact staged runtime-layer document. The runtime verifies the current
   * `runtime-layer.yml` content equals this string before recomposing, so an
   * apply can never acknowledge a layer that was not durably staged.
   */
  readonly runtimeLayer: string
  /** Every Managed Root the staged layer is expected to mount. */
  readonly expectedRoots: readonly ExpectedManagedRoot[]
}

/** The acknowledged outcome of one manager-layer generation. */
export interface ProfileRuntimeApplyResult {
  /** The manager-layer generation count after this apply (1 for the first). */
  readonly generation: number
  /** Root entry ids of expected roots that are active in the settled tree. */
  readonly activeRoots: readonly string[]
  /**
   * Root entry ids whose effective composed row differs from the manager's
   * derived expectation (a user patch configured, disabled, or replaced the
   * row). The manager reports these as `externally-overridden` and never
   * rewrites the user's patch.
   */
  readonly externallyOverridden: readonly string[]
}

/** Why a registry root was omitted from the safe derived layer at startup. */
export type ManagedRootOmissionReason = 'missing-dependency' | 'version-drift' | 'invalid-manifest'

/** One root the safe derived layer omitted, with the reason. */
export interface OmittedManagedRoot {
  /** The omitted root entry id. */
  readonly rootEntryId: string
  /** Why the root is unsafe to mount. */
  readonly reason: ManagedRootOmissionReason
}

/** Startup outcome of the manager runtime layer. */
export interface ManagerLayerStartup {
  /**
   * Present when the registry is corrupt: managed roots failed closed, the
   * corrupt registry is preserved, and the manager exposes this recovery
   * error.
   */
  readonly recoveryError?: string
  /** Roots omitted from the regenerated layer as unsafe. */
  readonly omitted: readonly OmittedManagedRoot[]
}

/** Every patch layer of one profile generation, in application order. */
export interface ProfileLayerInputs {
  /** Shipped and profile bundle layers (lowest precedence). */
  readonly bundlePatches: readonly PatchOptions[]
  /** The manager runtime layer, between the bundles and the user layers. */
  readonly managerPatches: readonly PatchOptions[]
  /** The profile's own `cordis.patch.yml`. */
  readonly profilePatches: readonly PatchOptions[]
  /** The home-level `$DSH_HOME/cordis.patch.yml`. */
  readonly homePatches: readonly PatchOptions[]
  /** Launcher overlays and the telemetry switch (highest precedence). */
  readonly overlays: readonly PatchOptions[]
}

/**
 * Compose one full generation patch list in precedence order: bundles →
 * manager runtime layer → profile patch → home patch → overlays/telemetry.
 * The result is a fresh structured clone so the Include's by-reference insert
 * rows can never bake an earlier generation's values into a later one.
 * @param inputs - the layer inputs in precedence order.
 * @returns a fresh patch list for one generation.
 */
export function composeProfilePatches(inputs: ProfileLayerInputs): PatchOptions[] {
  return structuredClone([
    ...inputs.bundlePatches,
    ...inputs.managerPatches,
    ...inputs.profilePatches,
    ...inputs.homePatches,
    ...inputs.overlays,
  ])
}

/**
 * Stable SHA-256 over the canonical YAML rendering of one Loader entry row.
 * Key order is normalized (`sortKeys`), so the manager's derived row and the
 * Loader's effective options of the same content hash identically; any user
 * patch that changes config, name, or disabled changes the hash, which is how
 * the runtime reports an external override by root id.
 * @param row - the entry row to hash.
 * @returns the hex SHA-256 digest of the canonical rendering.
 */
export function canonicalManagedRootHash(row: EntryOptions): string {
  const rendered = dump([{ insert: [row] }], { noRefs: true, sortKeys: true })
  return createHash('sha256').update(rendered).digest('hex')
}

/**
 * Read the current manager runtime layer of one profile as loader patches. A
 * missing layer means "no manager layer" and yields an empty list; an
 * unparsable or non-array file throws — at generation time a corrupt layer
 * fails loud instead of silently dropping the managed roots.
 * @param binName - the diagnostic prefix on thrown errors.
 * @param profileDir - absolute profile directory.
 * @returns the layer's patch list (empty when the file is absent).
 */
export function readManagerLayerPatches(binName: string, profileDir: string): PatchOptions[] {
  return loadOptionalPatches(binName, resolvePageAppProfilePaths(profileDir).runtimeLayer) ?? []
}

/** The derived runtime layer for one profile, before any file write. */
export interface DerivedRuntimeLayer {
  /** The registry that was read, or null when none has been published yet. */
  readonly registry: PageAppRegistryV1 | null
  /** The rendered layer for the safe roots (`[]` when nothing is safe). */
  readonly layer: string
  /** Roots omitted as unsafe, with the reason. */
  readonly omitted: readonly OmittedManagedRoot[]
  /** Present when the registry is corrupt: managed roots failed closed. */
  readonly recoveryError?: string
}

/**
 * Derive the safe runtime layer of one profile from its registry. The
 * registry is the ownership authority; this function never writes it. Each
 * enabled root is verified against the installed package before it is
 * included: a missing dependency or an installed version that differs from
 * the committed `resolvedVersion` omits the root (never auto-reinstalling or
 * running changed code), and an unreadable manifest, missing bundle patch,
 * absent root row, or unserializable entry tree omits it as invalid. A
 * corrupt registry yields `recoveryError` with an empty layer and omitted
 * list; a null registry (no manager data) is not an error.
 * @param binName - the diagnostic prefix on parse errors.
 * @param profileDir - absolute profile directory.
 * @returns the derived layer and its omission report.
 */
export async function deriveSafeRuntimeLayer(
  binName: string,
  profileDir: string,
): Promise<DerivedRuntimeLayer> {
  let registry: PageAppRegistryV1 | null
  try {
    registry = await readPageAppRegistry(profileDir)
  } catch (error) {
    return {
      registry: null,
      layer: '',
      omitted: [],
      recoveryError: `page-app registry is corrupt; managed roots failed closed and will not be mounted: ${String(error)}`,
    }
  }
  if (registry === null) return { registry: null, layer: '', omitted: [] }
  const roots: ValidatedManagedRoot[] = []
  const omitted: OmittedManagedRoot[] = []
  for (const entry of registry.entries) {
    if (!entry.enabled) continue
    const derived = deriveRoot(binName, profileDir, entry)
    if ('reason' in derived) {
      omitted.push({ rootEntryId: entry.page.rootEntryId, reason: derived.reason })
      continue
    }
    // Validate the root serializes alone so one unserializable tree (a `!!js`
    // expression or a relative Loader name) is omitted as invalid instead of
    // failing the whole layer.
    try {
      renderPageAppRuntimeLayer([derived.root])
    } catch {
      omitted.push({ rootEntryId: entry.page.rootEntryId, reason: 'invalid-manifest' })
      continue
    }
    roots.push(derived.root)
  }
  const layer = roots.length > 0 ? renderPageAppRuntimeLayer(roots) : '[]\n'
  return { registry, layer, omitted }
}

/**
 * Startup preparation of the manager runtime layer: regenerate a missing,
 * corrupt, or stale derived layer from a valid registry (the render is
 * deterministic, so any byte difference means regeneration is owed), and when
 * the registry is corrupt preserve it while removing any stale layer so no
 * orphaned managed roots can mount; the recovery error is returned for the
 * manager to expose. A profile without a registry is left untouched.
 * @param binName - the diagnostic prefix on parse errors.
 * @param profileDir - absolute profile directory.
 * @returns the startup outcome: recovery error (corrupt registry) and the
 * omitted unsafe roots of the regenerated layer.
 */
export async function prepareManagerRuntimeLayer(
  binName: string,
  profileDir: string,
): Promise<ManagerLayerStartup> {
  const derived = await deriveSafeRuntimeLayer(binName, profileDir)
  if (derived.recoveryError !== undefined) {
    // Preserve the corrupt registry; drop the derived layer so a stale layer
    // from a previous good state cannot mount orphaned roots.
    await rm(resolvePageAppProfilePaths(profileDir).runtimeLayer, { force: true })
    return { recoveryError: derived.recoveryError, omitted: [] }
  }
  if (derived.registry === null) return { omitted: [] }
  const paths = resolvePageAppProfilePaths(profileDir)
  let current: string | undefined
  try {
    current = readFileSync(paths.runtimeLayer, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (current !== derived.layer) {
    await mkdir(paths.directory, { recursive: true, mode: 0o700 })
    await writeFile(paths.runtimeLayer, derived.layer, { mode: 0o600 })
  }
  return { omitted: derived.omitted }
}

/** A root derivation outcome: a validated root, or the reason it was omitted. */
type DerivedRoot = { root: ValidatedManagedRoot } | { reason: ManagedRootOmissionReason }

/**
 * Probe the installed location of one registry package from the profile's own
 * node_modules walk. Manager packages are profile-local pnpm installs, so the
 * profile anchor finds them before any parent fallback.
 * @param profileDir - absolute profile directory.
 * @param packageName - the registry row's package name.
 * @returns the installed package directory, or undefined when not installed.
 */
function resolveInstalledPackageDir(profileDir: string, packageName: string): string | undefined {
  for (const searchPath of createRequire(join(profileDir, 'package.json')).resolve.paths(packageName) ?? []) {
    const candidate = join(searchPath, packageName)
    if (existsSync(join(candidate, 'package.json'))) return candidate
  }
  return undefined
}

/**
 * Derive one validated Managed Root from a registry row and its installed
 * package, or the reason the root is unsafe. The installed package must
 * exist, carry the committed version, declare a valid `dsh.workspace` v1
 * manifest and a resolvable `dsh.bundle.patch`, and the composed bundle
 * layer must contain the manifest's root row.
 * @param binName - the diagnostic prefix on parse errors.
 * @param profileDir - absolute profile directory.
 * @param entry - the enabled registry row.
 * @returns the validated root, or the omission reason.
 */
function deriveRoot(binName: string, profileDir: string, entry: PageAppRegistryEntry): DerivedRoot {
  const packageDir = resolveInstalledPackageDir(profileDir, entry.packageName)
  if (packageDir === undefined) return { reason: 'missing-dependency' }
  let installed: { version?: unknown; dsh?: unknown }
  try {
    installed = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as typeof installed
  } catch {
    return { reason: 'invalid-manifest' }
  }
  if (installed.version !== entry.resolvedVersion) return { reason: 'version-drift' }
  try {
    parsePageAppManifest(entry.packageName, installed)
  } catch {
    return { reason: 'invalid-manifest' }
  }
  const bundle = (installed.dsh as { bundle?: { patch?: unknown } } | undefined)?.bundle
  if (typeof bundle?.patch !== 'string' || bundle.patch === '') return { reason: 'invalid-manifest' }
  let patches: PatchOptions[]
  try {
    patches = loadOverlayPatches(binName, join(packageDir, bundle.patch))
  } catch {
    return { reason: 'invalid-manifest' }
  }
  // Compose the bundle patch list over an empty root exactly as the boot
  // include mounts layers, then take the single top-level row the manifest
  // names as the Managed Root tree.
  const rows = applyEntryPatches([], structuredClone(patches), () => {})
  const rootRow = rows.find(row => row.id === entry.page.rootEntryId)
  if (rootRow === undefined) return { reason: 'invalid-manifest' }
  return {
    root: {
      packageName: entry.packageName,
      pageId: entry.page.id,
      rootEntryId: entry.page.rootEntryId,
      enabled: entry.enabled,
      entries: [rootRow],
    },
  }
}

/** Options for constructing a {@link ProfileRuntime}. */
export interface ProfileRuntimeOptions {
  /** The immutable active-profile identity. */
  readonly identity: ActiveProfileIdentity
  /**
   * Build one fresh full-generation patch list (bundles → manager layer →
   * profile → home → overlays) with the manager layer read from the current
   * `runtime-layer.yml`; every generation gets a fresh structured clone.
   */
  readonly compose: () => readonly PatchOptions[]
  /** Startup recovery error when the registry is corrupt; managed roots failed closed. */
  readonly recoveryError?: string
  /** Roots the safe derived layer omitted at startup, with their reasons. */
  readonly omittedRoots?: readonly OmittedManagedRoot[]
}

/**
 * Launcher-provided Cordis service owning the acknowledged profile
 * recomposition. The manager plugin injects it (by {@link PROFILE_RUNTIME_SERVICE})
 * and calls {@link applyManagerLayer} / {@link restoreManagerLayer}; each
 * call composes one fresh generation, applies it through the root Include's
 * transactional update, waits for the Loader to settle, audits that every
 * expected root reached active state, and resolves with the acknowledged
 * generation only after the audit passes. The user-patch watchers route their
 * generations through the same serialized queue ({@link recompose}), so no
 * independent `entry.update` writers can race. A call before the root Include
 * is bound or before the initial tree has settled fails loudly; the manager
 * may inject the service during boot but cannot mutate until then.
 */
export class ProfileRuntime extends Service {
  /** The immutable active-profile identity. */
  public readonly identity: ActiveProfileIdentity
  /** Startup recovery error when the registry is corrupt; managed roots failed closed. */
  public readonly recoveryError: string | undefined
  /** Roots the safe derived layer omitted at startup, with their reasons. */
  public readonly omittedRoots: readonly OmittedManagedRoot[]

  private readonly compose: () => readonly PatchOptions[]
  private entry: Entry | undefined
  private settled = false
  private generation = 0
  private queue: Promise<unknown> = Promise.resolve()

  constructor(ctx: Context, options: ProfileRuntimeOptions) {
    super(ctx, PROFILE_RUNTIME_SERVICE)
    this.identity = Object.freeze({ ...options.identity })
    this.recoveryError = options.recoveryError
    this.omittedRoots = Object.freeze([...options.omittedRoots ?? []])
    this.compose = options.compose
  }

  /**
   * Bind the root Include entry to this runtime. Called by `boot()` right
   * after `mountRootInclude` resolves; until then (and until
   * {@link markSettled}) manager-layer calls fail loudly.
   * @param entry - the mounted root Include entry, or undefined when the tree
   * was disposed while mounting.
   */
  public bindRootInclude(entry: Entry | undefined): void {
    this.entry = entry
  }

  /**
   * Mark the initial tree as settled. Called by `boot()` after the activation
   * audit; the manager may not mutate the profile before this.
   */
  public markSettled(): void {
    this.settled = true
  }

  /**
   * Acknowledge one staged manager-layer generation: verify the current
   * `runtime-layer.yml` equals the request's layer, recompose the full
   * profile through the serialized queue, wait for the Include update and
   * Loader settlement, audit every expected root reached active state, and
   * report the active roots and any effective user override by root id.
   * Rejects when the layer was not staged as requested, when the Include
   * update or activation fails, or when the audit finds a root that did not
   * mount or did not reach active state.
   * @param request - the staged layer and its expected roots.
   * @returns the acknowledged generation with active roots and overrides.
   */
  public async applyManagerLayer(request: ProfileRuntimeApplyRequest): Promise<ProfileRuntimeApplyResult> {
    return this.recomposeManagerLayer(request)
  }

  /**
   * Restore a prior manager-layer generation (the rollback path): identical
   * contract to {@link applyManagerLayer}, distinguished by the caller's
   * intent so the manager can await the restored composition the same way it
   * awaits an apply.
   * @param request - the restored layer and its expected roots.
   * @returns the acknowledged generation with active roots and overrides.
   */
  public async restoreManagerLayer(request: ProfileRuntimeApplyRequest): Promise<ProfileRuntimeApplyResult> {
    return this.recomposeManagerLayer(request)
  }

  /**
   * Run one full-generation recomposition through the serialized queue
   * without an audit: the user-patch watchers call this so their updates
   * share the manager's serialized Include-update path. The compose callback
   * re-reads every layer fresh, so a watcher generation is a complete
   * snapshot. Fails loudly when the Include is not bound or the tree has not
   * settled.
   */
  public async recompose(): Promise<void> {
    this.assertMutable()
    await this.enqueue(async () => {
      await this.applyGeneration(this.compose())
    })
  }

  private async recomposeManagerLayer(request: ProfileRuntimeApplyRequest): Promise<ProfileRuntimeApplyResult> {
    this.assertMutable()
    return this.enqueue(async () => {
      const staged = await this.readStagedLayer()
      if (staged !== request.runtimeLayer) {
        throw new Error('page-app profile runtime: staged runtime layer does not match the apply request; manager repair required')
      }
      await this.applyGeneration(this.compose())
      return this.audit(request)
    })
  }

  private assertMutable(): void {
    if (this.entry === undefined) {
      throw new Error('page-app profile runtime: manager layer apply before the root Include is bound')
    }
    if (!this.settled) {
      throw new Error('page-app profile runtime: manager layer apply before the initial tree has settled')
    }
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task)
    this.queue = run.then(() => {}, () => {})
    return run
  }

  private async applyGeneration(patches: readonly PatchOptions[]): Promise<void> {
    const entry = this.entry
    if (entry === undefined) {
      throw new Error('page-app profile runtime: cannot recompose before the root Include is bound')
    }
    // Re-read the include's non-patch options at apply time, inside the
    // queue, so a concurrent generation's update can never be reverted by a
    // stale snapshot (the only config fields that exist are path/initial).
    const { patches: _previousPatches, ...includeConfig } = entry.options.config as {
      patches?: unknown
      [key: string]: unknown
    }
    await entry.update({ config: { ...includeConfig, patches: [...patches] } })
    const loader = this.ctx.get('loader')
    if (loader !== undefined) await loader.await()
  }

  private async readStagedLayer(): Promise<string | undefined> {
    const paths = resolvePageAppProfilePaths(this.identity.directory)
    try {
      return await readFile(paths.runtimeLayer, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  private audit(request: ProfileRuntimeApplyRequest): ProfileRuntimeApplyResult {
    const loader = this.ctx.get('loader')
    if (loader === undefined) {
      throw new Error('page-app profile runtime: the Loader tree is gone during the activation audit')
    }
    const entries = [...loader.entries()]
    const failures: string[] = []
    const activeRoots: string[] = []
    const externallyOverridden: string[] = []
    for (const expected of request.expectedRoots) {
      const row = entries.find(entry => entry.options.id === expected.rootEntryId)
      if (row === undefined) {
        failures.push(`managed root ${expected.rootEntryId} did not mount`)
        continue
      }
      if (canonicalManagedRootHash(row.options) !== expected.hash) {
        externallyOverridden.push(expected.rootEntryId)
      }
      const fiber = row.fiber
      if (fiber === undefined) {
        // A user-disabled row is an override (reported above), not a failure.
        if (row.disabled) continue
        failures.push(`managed root ${expected.rootEntryId} has no active fiber`)
        continue
      }
      if (fiber.state === FiberState.ACTIVE) {
        activeRoots.push(expected.rootEntryId)
        continue
      }
      failures.push(`managed root ${expected.rootEntryId} did not reach active state (fiber state ${String(fiber.state)})`)
    }
    if (failures.length > 0) {
      throw new Error(`page-app profile runtime: root activation audit failed: ${failures.join('; ')}`)
    }
    this.generation += 1
    return { generation: this.generation, activeRoots, externallyOverridden }
  }
}
