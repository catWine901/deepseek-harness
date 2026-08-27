/**
 * Launcher-owned profile runtime: immutable active-profile identity plus the
 * sole acknowledged live-recomposition API. `profile-boot` provides one
 * `ProfileRuntime` in `boot(..., prepare)` beside the launch-environment and
 * cmdline facts, before any config-tree entry mounts; `boot()` binds the root
 * Include entry to it immediately after `mountRootInclude` resolves. The
 * tree's manager plugin may inject the service during boot but cannot mutate
 * the profile until the initial tree has settled — a settled mark that opens
 * the mutation gate only after launcher watcher setup fully succeeds, and
 * that treats a tree exiting mid-setup as the exit it is (never a boot
 * failure, never a settled partial setup). Watcher setup is transactional:
 * everything it creates is reverse-disposed on any incomplete outcome, so no
 * half-initialized runtime can outlive a failed setup. Every generation — the
 * manager's apply/restore and both user-patch watchers — runs through one
 * serialized recomposition queue, so no independent `entry.update` writers
 * can race on the root Include.
 * @module @deepseek-ai/dsh-app-boot/profile-runtime
 */

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, join } from 'node:path'
import { Context, Service, symbols, type FiberState } from '@deepseek-ai/cordis'
import type { Entry, EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import { applyEntryPatches, entryListSchema, type PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import {
  parsePageAppManifest,
  readPageAppRegistry,
  recoverOrphanedPageAppLock,
  renderPageAppRuntimeLayer,
  resolvePageAppProfilePaths,
  withPageAppProfileLock,
  type PageAppRegistryEntry,
  type PageAppRegistryV1,
  type PageAppRuntimeEntry,
  type ValidatedManagedRoot,
} from '@deepseek-ai/dsh-page-app-profile'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { dump, load } from 'js-yaml'
import { loadOptionalPatches, loadOverlayPatches } from './patches.ts'

// Cordis exposes FiberState as a const enum in declarations, not a runtime
// export in the public rc.2 package consumed by the standalone manager.
const FIBER_ACTIVE = 2 as FiberState.ACTIVE

/** The service name the launcher provides `ProfileRuntime` under. */
export const PROFILE_RUNTIME_SERVICE = 'profileRuntime'

/** The manager package that owns the Feature Runtime Wrapper module. */
export const PAGE_APP_MANAGER_PACKAGE_NAME = '@deepseek-ai/dsh-page-app-manager'

/** The service the manager provides under, and every wrapper fiber injects. */
export const WORKBENCH_RUNTIME_SERVICE = 'workbenchRuntime'

/** Deterministic prefix of one Feature Runtime Wrapper row id (`page-app.wrapper.<pageId>`). */
export const PAGE_APP_WRAPPER_ID_PREFIX = 'page-app.wrapper.'

/**
 * The deterministic wrapper row id of one managed page. The runtime layer and
 * the manager's facts/health lookup both derive the same id, so a staged
 * wrapper row and its loaded Loader entry are found by the same key.
 * @param pageId - the managed page id.
 * @returns `page-app.wrapper.<pageId>`.
 */
export function managedRootWrapperId(pageId: string): string {
  return `${PAGE_APP_WRAPPER_ID_PREFIX}${pageId}`
}

/**
 * Whether the manager package that owns the Feature Runtime Wrapper module is
 * resolvable from the profile. The manager may be profile-local, or supplied
 * by the launcher's controlled `$DSH_HOME/profiles/node_modules` fallback;
 * no higher ancestor is accepted, so an ambient parent store cannot satisfy
 * the wrapper dependency.
 * @param profileDir - absolute profile directory.
 * @returns true when the manager package.json exists in the profile's own
 * node_modules or its controlled `profiles` fallback.
 */
export function managerWrapperResolvable(profileDir: string): boolean {
  if (existsSync(join(profileDir, 'node_modules', PAGE_APP_MANAGER_PACKAGE_NAME, 'package.json'))) return true
  const profilesDir = dirname(profileDir)
  return basename(profilesDir) === 'profiles'
    && existsSync(join(profilesDir, 'node_modules', PAGE_APP_MANAGER_PACKAGE_NAME, 'package.json'))
}

/**
 * Derive the Feature Runtime Wrapper parent row of one statically valid root:
 * a named loader entry for the manager's wrapper module that injects the
 * `workbenchRuntime` service, carries the feature's package/page/root identity
 * in its config, and mounts the feature's composed rows as its `insert`
 * children. Every enabled root of the runtime layer takes this wrapper form,
 * so the manager's loader row lookup and hash expectation follow the same
 * shape.
 * @param input - the feature's package/page identity, contract version, and
 * composed feature rows.
 * @returns the wrapper parent row (a {@link PageAppRuntimeEntry}).
 */
export function managedRootWrapperRow(input: {
  readonly packageName: string
  readonly pageId: string
  readonly rootEntryId: string
  readonly contractVersion: number
  readonly entries: readonly PageAppRuntimeEntry[]
}): PageAppRuntimeEntry {
  return {
    id: managedRootWrapperId(input.pageId),
    name: `${PAGE_APP_MANAGER_PACKAGE_NAME}/wrapper`,
    inject: [WORKBENCH_RUNTIME_SERVICE],
    config: {
      packageName: input.packageName,
      pageId: input.pageId,
      rootEntryId: input.rootEntryId,
      contractVersion: input.contractVersion,
    },
    insert: [...input.entries],
  }
}

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
export type ManagedRootOmissionReason =
  | 'missing-dependency'
  | 'version-drift'
  | 'invalid-manifest'
  | 'missing-manager'

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
 * Parse one staged runtime-layer document (a top-level YAML array of loader
 * patch entries in the include dialect) into patches. This is the ONLY way an
 * apply/restore turns its request content into the manager layer of a
 * generation: the runtime never re-reads the layer file for composition.
 * @param content - the exact `runtimeLayer` of the apply request.
 * @returns the parsed patch list.
 */
function parseLayerDocument(content: string): PatchOptions[] {
  let parsed: unknown
  try {
    parsed = load(content, { schema: entryListSchema })
  } catch (error) {
    throw new Error(`page-app profile runtime: failed to parse the staged runtime layer: ${String(error)}`)
  }
  if (!Array.isArray(parsed)) {
    throw new Error('page-app profile runtime: staged runtime layer must be a top-level YAML array of loader patch entries')
  }
  return parsed as PatchOptions[]
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
 * corrupt, or stale derived layer from a valid registry, or fail managed
 * roots closed when the registry is corrupt. The whole derive-and-commit
 * cycle runs inside the shared profile operation lock (Task 1's
 * `withPageAppProfileLock`, after the same package's lock recovery so a
 * crashed owner cannot stall boot), the registry revision/content is
 * re-verified immediately before commit, and the layer is published through
 * the atomic writer (same-directory temp file plus atomic rename), so a
 * concurrent manager publication is never overwritten by this stale startup
 * and no reader can observe a partial layer. When the registry is corrupt it
 * is preserved while any stale layer is removed so no orphaned managed roots
 * can mount, and the recovery error is returned for the manager to expose.
 * When no registry exists the registry — the ownership authority — says
 * nothing is managed: any existing layer is an orphan and is removed (an
 * absent registry is a normal not-yet-managed state, not a recovery error).
 * @param binName - the diagnostic prefix on parse errors.
 * @param profileDir - absolute profile directory.
 * @returns the startup outcome: recovery error (corrupt registry) and the
 * omitted unsafe roots of the regenerated layer.
 */
export async function prepareManagerRuntimeLayer(
  binName: string,
  profileDir: string,
): Promise<ManagerLayerStartup> {
  const paths = resolvePageAppProfilePaths(profileDir)
  // Task 1 lock recovery first: a dead owner's lock must not stall boot; the
  // recovery also fails closed on a live holder (a concurrent manager owns
  // the profile — booting again is the caller's retry decision).
  await recoverOrphanedPageAppLock(profileDir)
  return withPageAppProfileLock(profileDir, { kind: 'manager', token: randomUUID() }, async () => {
    const derived = await deriveSafeRuntimeLayer(binName, profileDir)
    if (derived.recoveryError !== undefined) {
      // Preserve the corrupt registry; drop the derived layer so a stale layer
      // from a previous good state cannot mount orphaned roots.
      await rm(paths.runtimeLayer, { force: true })
      return { recoveryError: derived.recoveryError, omitted: [] }
    }
    if (derived.registry === null) {
      // No ownership authority: an orphaned layer must never mount.
      await rm(paths.runtimeLayer, { force: true })
      return { omitted: [] }
    }
    // Re-verify the registry is unchanged since the derivation. Both reads
    // happen inside the same lock boundary, so a change here means a writer
    // bypassed the lock and this stale derivation must not commit.
    const current = await readPageAppRegistry(profileDir)
    if (current === null
      || current.revision !== derived.registry.revision
      || JSON.stringify(current) !== JSON.stringify(derived.registry)) {
      throw new Error('page-app profile runtime: registry changed during manager-layer preparation; aborting regeneration')
    }
    let existing: string | undefined
    try {
      existing = readFileSync(paths.runtimeLayer, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (existing !== derived.layer) {
      await writeFileAtomic(paths.runtimeLayer, derived.layer, { mode: 0o600, dirMode: 0o700 })
    }
    return { omitted: derived.omitted }
  })
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
 * layer must contain the manifest's root row. The Feature Runtime Wrapper
 * module must resolve from the profile: the manager package that owns it has
 * to be installed, otherwise the root is omitted as `missing-manager` so a
 * boot after a manager uninstall survives with zero managed roots while the
 * registry stays owned. Every derived root is emitted in the wrapper parent
 * form (the feature rows become the wrapper's `insert` children).
 * @param binName - the diagnostic prefix on parse errors.
 * @param profileDir - absolute profile directory.
 * @param entry - the enabled registry row.
 * @returns the validated wrapper root, or the omission reason.
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
  let manifest: ReturnType<typeof parsePageAppManifest>
  try {
    manifest = parsePageAppManifest(entry.packageName, installed)
  } catch {
    return { reason: 'invalid-manifest' }
  }
  // The Feature Runtime Wrapper lives in the manager package; an uninstalled
  // manager (boot-after-uninstall) must omit every root instead of failing
  // boot on an unresolvable wrapper module.
  if (!managerWrapperResolvable(profileDir)) {
    return { reason: 'missing-manager' }
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
  const wrapper = managedRootWrapperRow({
    packageName: entry.packageName,
    pageId: entry.page.id,
    rootEntryId: entry.page.rootEntryId,
    contractVersion: manifest.schemaVersion,
    entries: [rootRow],
  })
  return {
    root: {
      packageName: entry.packageName,
      pageId: entry.page.id,
      rootEntryId: wrapper.id,
      enabled: entry.enabled,
      entries: [wrapper],
    },
  }
}

/** Options for constructing a {@link ProfileRuntime}. */
export interface ProfileRuntimeOptions {
  /** The immutable active-profile identity. */
  readonly identity: ActiveProfileIdentity
  /**
   * Build one fresh full-generation patch list from the given manager layer
   * patches (bundles → manager → profile → home → overlays); every
   * generation gets a fresh structured clone.
   */
  readonly compose: (managerPatches: readonly PatchOptions[]) => readonly PatchOptions[]
  /**
   * The boot-time acknowledged manager layer snapshot — exactly the patches
   * the initial composition mounted. Watcher generations compose this
   * snapshot until a manager-layer apply/restore audit promotes a new one.
   */
  readonly initialManagerPatches: readonly PatchOptions[]
  /**
   * Launcher-owned user-patch files routed through the serialized queue.
   * Consumed internally when the tree settles (after the boot activation
   * audit): the runtime ensures an HMR service and registers one watcher per
   * path that recomposes the acknowledged snapshot. The public watcher API
   * deliberately has no runtime-routing option, so this configuration is the
   * only way a watcher reaches the queue.
   */
  readonly watchPatches?: readonly { binName: string; filename: string }[]
  /** Startup recovery error when the registry is corrupt; managed roots failed closed. */
  readonly recoveryError?: string
  /** Roots the safe derived layer omitted at startup, with their reasons. */
  readonly omittedRoots?: readonly OmittedManagedRoot[]
}

/**
 * Launcher- and boot-only controls over a {@link ProfileRuntime}, deliberately
 * absent from the injected service surface: a service consumer can read the
 * manager-facing API but can never bind, settle, or trigger the un-audited
 * watcher recomposition. `boot()` binds and settles through
 * {@link profileRuntimeControl}; the runtime consumes its launcher-owned
 * watcher configuration internally at settle, and the launcher may still
 * trigger one watcher-path recomposition through
 * {@link ProfileRuntimeControl.recompose}.
 */
export interface ProfileRuntimeControl {
  /**
   * Bind the root Include entry to the runtime. Called by `boot()` right
   * after `mountRootInclude` resolves; until then (and until
   * {@link ProfileRuntimeControl.markSettled}) manager-layer calls fail loudly.
   * @param entry - the mounted root Include entry, or undefined when the tree
   * was disposed while mounting.
   */
  bindRootInclude(entry: Entry | undefined): void
  /**
   * Mark the initial tree as settled and register the launcher-owned watcher
   * paths. Called by `boot()` after the activation audit; the manager may not
   * mutate the profile before this, and the watchers only exist afterwards.
   * The mutation gate opens only after watcher setup fully succeeds: a setup
   * failure on a live tree — including an `INACTIVE_EFFECT` — rolls back
   * every resource the setup created and fails boot loud; only a tree that
   * actually exited during setup (or an `INACTIVE_EFFECT` that lands on such
   * a tree) keeps the gate closed and lets boot resolve. A partial watcher
   * set is never settled.
   */
  markSettled(): Promise<void>
  /**
   * Run one full-generation recomposition through the serialized queue
   * without an audit, composing the acknowledged manager layer snapshot: the
   * user-patch watchers call this so their updates share the manager's
   * serialized Include-update path. Fails loudly when the Include is not
   * bound or the tree has not settled.
   */
  recompose(): Promise<void>
}

/**
 * Every piece of state the runtime owns, including the immutable identity and
 * all launcher-controlled mutable state (acknowledged snapshot, binding,
 * settled flag, generation, queue). A `ProfileRuntimeState` lives only in the
 * module-private {@link states} WeakMap keyed by the raw service instance:
 * the injected service carries no own enumerable or writable properties, so a
 * consumer holding the Cordis traceable proxy can enumerate or overwrite
 * nothing that affects identity or launcher state.
 */
class ProfileRuntimeState {
  readonly identity: ActiveProfileIdentity
  readonly recoveryError: string | undefined
  readonly omittedRoots: readonly OmittedManagedRoot[]
  readonly compose: (managerPatches: readonly PatchOptions[]) => readonly PatchOptions[]
  /** Launcher-owned user-patch files watched through the serialized queue. */
  readonly watchPatches: readonly { binName: string; filename: string }[]
  /** The launcher/boot-only control, built once over this state's closures. */
  readonly control: ProfileRuntimeControl

  /** The last acknowledged manager-layer patches; promoted only after an audit passes. */
  managerPatches: readonly PatchOptions[]
  entry: Entry | undefined
  settled = false
  generation = 0
  queue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly ctx: Context,
    options: ProfileRuntimeOptions,
  ) {
    this.identity = Object.freeze({ ...options.identity })
    this.recoveryError = options.recoveryError
    this.omittedRoots = Object.freeze([...options.omittedRoots ?? []])
    this.compose = options.compose
    this.managerPatches = [...options.initialManagerPatches]
    this.watchPatches = Object.freeze([...options.watchPatches ?? []].map(watch => Object.freeze({ ...watch })))
    this.control = {
      bindRootInclude: (entry): void => { this.entry = entry },
      markSettled: async (): Promise<void> => {
        // The mutation gate opens only after watcher setup fully succeeds: a
        // manager-layer call while registration is still pending rejects as
        // not settled, a setup failure on a live tree keeps the gate closed
        // (and fails boot), and a tree that exited during setup never opens it.
        this.settled = await this.registerWatchPatches()
      },
      recompose: (): Promise<void> => this.recomposeInternal(),
    }
  }

  /**
   * Whether the booted tree is already exiting or gone (the app left exactly
   * as asked): the Loader service has been unregistered and/or the root fiber
   * is no longer active. A setup error that lands on such a tree describes the
   * exit, not a watch failure.
   * @returns true when the tree is disposing or disposed.
   */
  private treeExited(): boolean {
    return this.ctx.get('loader') === undefined || this.ctx.fiber.state !== FIBER_ACTIVE
  }

  /**
   * Register the launcher-owned user-patch watchers on the serialized queue.
   * Runs when the tree settles (boot's post-audit mark): an absent HMR
   * service is mounted watch-only (no module roots), then one config watcher
   * per path recomposes the acknowledged snapshot. The whole setup is one
   * transactional scope: every loader entry this call creates and every
   * watcher disposer `registerConfig` returns is owned by the call and
   * reverse-disposed on any incomplete outcome — a later failure, an
   * `INACTIVE_EFFECT`, or the tree exiting — while pre-existing timer/HMR
   * services and entries are never touched. `INACTIVE_EFFECT` and every
   * other setup error are graceful only when the tree has actually exited
   * (the exit is what was asked, the gate stays closed and boot resolves);
   * the same error on a live tree is a real watcher-setup failure, so setup
   * rolls back and fails boot loud instead of resolving into a permanently
   * unusable half-initialized runtime. A disposal that lands between a
   * registration resolving and setup returning is caught by a liveness
   * recheck after every registration and once more at the end.
   * @returns false when the tree exited during setup or a watcher failed
   * gracefully (`INACTIVE_EFFECT` or any error on an exited tree) — the
   * mutation gate stays closed for a tree that never fully settled; true only
   * when every watcher is registered on a live tree.
   */
  private async registerWatchPatches(): Promise<boolean> {
    if (this.watchPatches.length === 0) return !this.treeExited()
    if (this.treeExited()) return false
    // One transactional setup scope: resources this call creates (loader
    // entries, watcher disposers) are reverse-disposed on any incomplete
    // outcome; pre-existing timer/HMR services and entries are never touched.
    const owned: Array<() => void | Promise<void>> = []
    const rollback = async (): Promise<void> => {
      for (const dispose of owned.splice(0).reverse()) {
        try {
          await dispose()
        } catch {
          // A rollback failure must not hide the setup failure that triggered it.
        }
      }
    }
    try {
      if (this.ctx.get('hmr') === undefined) {
        const loader = this.ctx.get('loader')
        if (loader === undefined) return false // the tree exited while settling
        if (this.ctx.get('timer') === undefined) {
          const id = await loader.create({ name: '@deepseek-ai/cordis-plugin-timer' })
          owned.push(() => loader.remove(id))
        }
        const id = await loader.create({ name: '@deepseek-ai/cordis-plugin-hmr', config: { root: [] } })
        owned.push(() => loader.remove(id))
      }
      const hmr = this.ctx.get('hmr')
      if (hmr === undefined) {
        if (this.treeExited()) {
          await rollback()
          return false
        }
        throw new Error('page-app profile runtime: the HMR service is unavailable for user-patch watching')
      }
      for (const watch of this.watchPatches) {
        const dispose = await hmr.registerConfig(watch.filename, () => this.recomposeInternal())
        owned.push(dispose)
        // The tree can exit right after a registration resolves; the gate
        // opens only when every watcher is registered and the tree is still
        // live, so a partial set is rolled back and never settles.
        if (this.treeExited()) {
          await rollback()
          return false
        }
      }
      return true
    } catch (error) {
      await rollback()
      // INACTIVE_EFFECT and every other setup error describe the exit only
      // when the tree has actually gone away; on a live tree the same error
      // is a real watcher-setup failure and must fail boot loud.
      if (this.treeExited()) return false
      throw error
    }
  }

  /**
   * Acknowledge one staged manager-layer generation: verify the current
   * `runtime-layer.yml` equals the request's layer, parse and apply the
   * request's exact content through the serialized queue, wait for the
   * Include update and Loader settlement, audit every expected root reached
   * active state, and — only after the audit passes — promote the request's
   * layer to the acknowledged snapshot that watcher generations compose.
   * Rejects when the layer was not staged as requested, when the Include
   * update or activation fails, or when the audit finds a root that did not
   * mount or did not reach active state; a rejected apply never promotes the
   * candidate and never advances the generation.
   * @param request - the staged layer and its expected roots.
   * @returns the acknowledged generation with active roots and overrides.
   */
  async applyManagerLayer(request: ProfileRuntimeApplyRequest): Promise<ProfileRuntimeApplyResult> {
    return this.recomposeManagerLayer(request)
  }

  /**
   * Restore a prior manager-layer generation (the rollback path): identical
   * contract to {@link ProfileRuntimeState.applyManagerLayer}, distinguished
   * by the caller's intent so the manager can await the restored composition
   * the same way it awaits an apply.
   * @param request - the restored layer and its expected roots.
   * @returns the acknowledged generation with active roots and overrides.
   */
  async restoreManagerLayer(request: ProfileRuntimeApplyRequest): Promise<ProfileRuntimeApplyResult> {
    return this.recomposeManagerLayer(request)
  }

  private async recomposeInternal(): Promise<void> {
    this.assertMutable()
    await this.enqueue(async () => {
      await this.applyGeneration(this.compose(this.managerPatches))
    })
  }

  private async recomposeManagerLayer(request: ProfileRuntimeApplyRequest): Promise<ProfileRuntimeApplyResult> {
    this.assertMutable()
    return this.enqueue(async () => {
      const staged = await this.readStagedLayer()
      if (staged !== request.runtimeLayer) {
        throw new Error('page-app profile runtime: staged runtime layer does not match the apply request; manager repair required')
      }
      // Parse and apply the request's exact content — never re-read the disk
      // for the manager layer, so a file swap after verification can neither
      // be applied nor acknowledged.
      const patches = parseLayerDocument(request.runtimeLayer)
      await this.applyGeneration(this.compose(patches))
      const result = this.audit(request)
      // Promote the acknowledged snapshot only after the audit passed; a
      // failed generation leaves the previous acknowledged layer in force.
      this.managerPatches = patches
      return result
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
      if (fiber.state === FIBER_ACTIVE) {
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

/** Module-private state registry keyed by the raw service instance. */
const states = new WeakMap<ProfileRuntime, ProfileRuntimeState>()

/**
 * Resolve the module-private state by walking the traceable proxy chain to
 * the registered raw instance. Every hop checks the state registry BEFORE
 * following the proxy's `symbols.original` escape hatch, so a directly
 * registered object resolves immediately: a raw instance's own properties —
 * including a consumer-written `symbols.original` key — can never redirect
 * state, because the raw instance is the registry key and the direct hit is
 * returned first. Only objects that are NOT directly registered are unwrapped,
 * one layer at a time, until the registered raw instance is reached; the walk
 * stops on `undefined`, on a non-object target, and on any object already
 * visited (a self/cycle reference) and reports the miss instead of looping.
 * `this` inside a proxied method arrives as the shadow receiver, which also
 * unwraps through the chain.
 * @param runtime - the service instance in any raw or traceable proxy form.
 * @returns the module-private state, or undefined when no hop is registered.
 */
function resolveState(runtime: ProfileRuntime): ProfileRuntimeState | undefined {
  const visited = new Set<object>()
  let current: unknown = runtime
  while (typeof current === 'object' && current !== null) {
    if (visited.has(current)) return undefined
    visited.add(current)
    const direct = states.get(current as ProfileRuntime)
    if (direct !== undefined) return direct
    current = (current as Record<symbol, unknown>)[symbols.original]
  }
  return undefined
}

/**
 * Resolve the module-private state for a service instance, failing loud when
 * the instance is not registered. A direct registry hit takes precedence at
 * every hop; see {@link resolveState} for the full walk contract.
 * @param runtime - the service instance in any raw or traceable proxy form.
 * @returns the module-private state.
 * @throws {Error} when no hop in the proxy chain is registered.
 */
function stateOf(runtime: ProfileRuntime): ProfileRuntimeState {
  const state = resolveState(runtime)
  if (state === undefined) {
    throw new Error('page-app profile runtime: state is unavailable for this instance')
  }
  return state
}

/**
 * Resolve the launcher/boot-only control for a profile runtime. The control
 * lives in the module-private state registry; it is not exported from the
 * package entry surface, so consumers of the injected service cannot reach
 * bind/settle/recompose through any public string, symbol, or package API.
 * Directly registered raw instances are resolved without consulting any
 * writable own property; only non-registered proxy forms are unwrapped, and
 * only when the unwrapped chain resolves to a registered instance.
 * @param runtime - the service instance (raw or any traceable proxy layer).
 * @returns the control, or undefined when no hop in the proxy chain is
 * registered (never happens for instances built through {@link ProfileRuntime}).
 */
export function profileRuntimeControl(runtime: ProfileRuntime): ProfileRuntimeControl | undefined {
  return resolveState(runtime)?.control
}

/**
 * Launcher-provided Cordis service owning the acknowledged profile
 * recomposition. The manager plugin injects it (by {@link PROFILE_RUNTIME_SERVICE})
 * and calls {@link ProfileRuntime.applyManagerLayer} /
 * {@link ProfileRuntime.restoreManagerLayer}; each call composes one fresh
 * generation, applies it through the root Include's transactional update,
 * waits for the Loader to settle, audits that every expected root reached
 * active state, and resolves with the acknowledged generation only after the
 * audit passes. All state lives in the module-private state registry keyed by
 * the raw instance, so this object itself carries no own enumerable or
 * writable properties beyond the Cordis service base fields — a consumer can
 * replace neither the identity nor any launcher-controlled value. The
 * user-patch watchers route their generations through the same serialized
 * queue via the boot-only control, so no independent `entry.update` writers
 * can race. A call before the root Include is bound or before the initial
 * tree has settled fails loudly; the manager may inject the service during
 * boot but cannot mutate until then.
 */
export class ProfileRuntime extends Service {
  constructor(ctx: Context, options: ProfileRuntimeOptions) {
    super(ctx, PROFILE_RUNTIME_SERVICE)
    states.set(this, new ProfileRuntimeState(ctx, options))
  }

  /** The immutable active-profile identity; consumers cannot replace it. */
  public get identity(): ActiveProfileIdentity {
    return stateOf(this).identity
  }

  /** Startup recovery error when the registry is corrupt; managed roots failed closed. */
  public get recoveryError(): string | undefined {
    return stateOf(this).recoveryError
  }

  /** Roots the safe derived layer omitted at startup, with their reasons. */
  public get omittedRoots(): readonly OmittedManagedRoot[] {
    return stateOf(this).omittedRoots
  }

  /**
   * Acknowledge one staged manager-layer generation; see
   * {@link ProfileRuntimeState.applyManagerLayer} for the full contract.
   * @param request - the staged layer and its expected roots.
   * @returns the acknowledged generation with active roots and overrides.
   */
  public async applyManagerLayer(request: ProfileRuntimeApplyRequest): Promise<ProfileRuntimeApplyResult> {
    return stateOf(this).applyManagerLayer(request)
  }

  /**
   * Restore a prior manager-layer generation (the rollback path); see
   * {@link ProfileRuntimeState.restoreManagerLayer} for the full contract.
   * @param request - the restored layer and its expected roots.
   * @returns the acknowledged generation with active roots and overrides.
   */
  public async restoreManagerLayer(request: ProfileRuntimeApplyRequest): Promise<ProfileRuntimeApplyResult> {
    return stateOf(this).restoreManagerLayer(request)
  }
}
