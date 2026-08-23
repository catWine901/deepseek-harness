/**
 * Shared profile boot for every `dsh` surface: resolve the profile, stack its
 * patch layers (bundle layers in `dsh.profile.bundles` order, the profile's
 * own `cordis.patch.yml`, `--patch` overlays, the telemetry switch), mount the
 * tree over the profile's empty root config, keep the profile patch layer
 * live, and wire fail-loud plus bounded shutdown.
 *
 * App flags are not the launcher's business: the invocation's inner arguments
 * are provided to the tree through `ctx.cmdlineArgs`, where any injected app
 * plugin may read the same immutable snapshot.
 * @module @deepseek-ai/dsh/profile-boot
 */

import { writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FiberState, type Context } from '@deepseek-ai/cordis'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import {
  boot,
  composeEntries,
  composeProfilePatches,
  healProfilesModuleFallback,
  installFailLoud,
  loadOptionalPatches,
  loadOverlayPatches,
  loadProfile,
  prepareManagerRuntimeLayer,
  PROFILE_PATCH_FILENAME,
  ProfileRuntime,
  readManagerLayerPatches,
  watchUserPatches,
  type ManagerLayerStartup,
  type Profile,
} from '@deepseek-ai/dsh-app-boot'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** Shipped agent-preset root: beside this app's own config, in both source and built layouts. */
const SHIPPED_PRESET_ROOT = fileURLToPath(new URL('../config/agent-presets/', import.meta.url))

import { DSH_LAUNCH_ENVIRONMENT_KEY, type LaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { provideCmdline } from '@deepseek-ai/dsh-cmdline'
import { createProcessShutdown, type ProcessShutdown } from './process-shutdown.ts'

const NAME = 'dsh'

/**
 * The home-level user patch layer (`$DSH_HOME/cordis.patch.yml`), applied
 * over every profile's own layer. Resolved per call, not at module load:
 * `$DSH_HOME` may be set by the test or launcher after import.
 * @returns the absolute patch-file path.
 */
export function homePatchPath(): string {
  return join(resolveDshHome(), PROFILE_PATCH_FILENAME)
}

/** Absolute path of this dsh installation's package.json (both anchors: src/ and lib/ sit one level under apps/cli). */
export const INSTALL_ANCHOR = fileURLToPath(new URL('../package.json', import.meta.url))

/** The session-telemetry row id the DSH_TELEMETRY_DISABLED switch targets. */
const TELEMETRY_ROW_ID = 'session-telemetry-otel'

/** The empty root entry list every profile tree patches over. */
const PROFILE_ROOT_CONFIG = `# dsh profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any
# --patch overlays. Edit cordis.patch.yml, not this file.
[]
`

/** Root config filename inside a profile directory. */
export const PROFILE_ROOT_FILENAME = 'cordis.yml'

/**
 * Resolve the telemetry opt-out switch into its boot patch. ANY non-empty
 * value (including `'0'`/`'false'`) disables: a privacy switch prefers
 * off-by-mistake over on-by-mistake. A composition without the telemetry row
 * exports nothing, so the switch is then trivially satisfied and no patch is
 * generated — custom profiles need not mount telemetry to run with the
 * switch set.
 * @param disabledEnv - the raw `DSH_TELEMETRY_DISABLED` value (`undefined` when unset).
 * @param hasRow - whether the composition carries the telemetry row.
 * @returns the disable patch, or `undefined` when no hard-disable patch is required.
 */
export function resolveTelemetryPatch(disabledEnv: string | undefined, hasRow: boolean): PatchOptions | undefined {
  if ((disabledEnv ?? '') === '' || !hasRow) return undefined
  return { id: TELEMETRY_ROW_ID, disabled: true }
}

/**
 * Load a resolved profile for `name`: heal the shared module fallback, then
 * (re)write the empty root config. The root is always rewritten: the whole
 * composition is patch layers, and the vendored Loader's tree write-back (a
 * plugin self-disposing persists the current tree) can bake composed rows
 * into this file — which would duplicate every bundle insert on the next
 * boot. The file exists on disk only because the Loader needs a real include
 * root to anchor `baseUrl` at the profile directory (the config dump anchors
 * on the same file, so both compose over the identical base).
 * @param name - the profile name.
 * @param userLayer - `false` skips parsing `cordis.patch.yml` (the default dump).
 * @returns the loaded profile.
 */
export function prepareProfile(name: string, userLayer = true): Profile {
  healProfilesModuleFallback(INSTALL_ANCHOR)
  const profile = loadProfile(NAME, name, INSTALL_ANCHOR, undefined, { userLayer })
  writeFileSync(join(profile.dir, PROFILE_ROOT_FILENAME), PROFILE_ROOT_CONFIG)
  return profile
}

/** One profile's patch layers (application order) and the row index of its pre-flag composition. */
export interface ComposedProfile {
  profile: Profile
  /** Bundle layers concatenated — the part below the manager and user layers on a live reload. */
  bundlePatches: PatchOptions[]
  /** The home-level user layer (`$DSH_HOME/cordis.patch.yml`), applied after the profile's own. */
  homePatches: PatchOptions[]
  /** Layers above the user layers on a live reload: `--patch` overlays and the telemetry switch. */
  overlays: PatchOptions[]
  /**
   * id → row of the composed tree (bundles + user layers + overlays), for the
   * launcher's own row checks.
   */
  rows: ReadonlyMap<string, EntryOptions>
}

/**
 * Load `name` and compose its effective patch stack: bundle layers in
 * `dsh.profile.bundles` order (the base bundle gates the shell stacks by
 * platform on its own rows), the profile's user layer, the home-level user
 * layer (`$DSH_HOME/cordis.patch.yml` — machine-local preferences that apply
 * to every profile, so it outranks the per-profile layer), `--patch` overlays,
 * then the telemetry switch.
 * @param name - the profile name.
 * @param patchFiles - `--patch` overlay paths, in argv order.
 * @returns the profile, its patch layers, and the composed row index.
 */
export function composeProfile(
  name: string,
  patchFiles: readonly string[],
): ComposedProfile {
  const profile = prepareProfile(name)
  const homePatches = loadOptionalPatches(NAME, homePatchPath()) ?? []
  const overlays = patchFiles.flatMap(file => loadOverlayPatches(NAME, resolve(file)))
  const bundlePatches = profile.layers.flatMap(layer => layer.patches)
  const rows = new Map<string, EntryOptions>()
  for (const row of composeEntries([bundlePatches, profile.patches, homePatches, overlays])) {
    if (typeof row.id === 'string') rows.set(row.id, row)
  }
  const composedOverlays = [...overlays]
  // The SHIPPED root is the part of the roster only this app can resolve: it
  // sits beside this app's own config, in both the source and built layouts.
  // The writable root the roster appends is `dsh-agent-presets`' own, so a
  // launcher that never reaches this patch still finds a person's presets.
  if (rows.has('agent-presets')) {
    composedOverlays.push({
      id: 'agent-presets',
      config: {
        ...(rows.get('agent-presets')?.config ?? {}) as Record<string, unknown>,
        roots: [{ path: SHIPPED_PRESET_ROOT, trust: 'system' }],
      },
    })
  }
  const telemetryPatch = resolveTelemetryPatch(process.env.DSH_TELEMETRY_DISABLED, rows.has(TELEMETRY_ROW_ID))
  if (telemetryPatch !== undefined) composedOverlays.push(telemetryPatch)
  return { profile, bundlePatches, homePatches, overlays: composedOverlays, rows }
}

/**
 * Compose one fresh full generation of one composed profile — the single
 * recomposition function shared by the initial boot, the user-patch watchers,
 * and the manager's acknowledged applies. The manager layer patches are
 * supplied by the caller (the boot-time snapshot or the last acknowledged
 * layer), never read from the staged file, so a staged-but-unacknowledged
 * layer can never go live early. Both user patch files are re-read per
 * generation, and the result is a fresh structured clone so mounted insert
 * rows can never leak across generations.
 * @param composed - the launcher-composed profile layers.
 * @param managerPatches - the manager layer patches for this generation.
 * @returns one fresh generation patch list (bundles → manager → profile → home → overlays).
 */
export function composeLivePatches(composed: ComposedProfile, managerPatches: readonly PatchOptions[]): PatchOptions[] {
  return composeProfilePatches({
    bundlePatches: composed.bundlePatches,
    managerPatches,
    profilePatches: loadOptionalPatches(NAME, composed.profile.patchPath) ?? [],
    homePatches: loadOptionalPatches(NAME, homePatchPath()) ?? [],
    overlays: composed.overlays,
  })
}

/** Options for {@link runProfile}. */
export interface RunProfileOptions {
  /** This run's frozen environment snapshot, provided before any entry mounts. */
  environment: LaunchEnvironmentSnapshot
  /** The profile name to boot. */
  profile: string
  /** `--patch` overlay paths, in argv order. */
  patchFiles: readonly string[]
  /** The invocation's inner arguments, handed to the tree through `ctx.cmdlineArgs`. */
  args: readonly string[]
}

/**
 * Re-throw a watcher-setup failure unless a shutdown already owns the tree:
 * a signal aborted this invocation, or an app requested exit (`ctx.appExit`
 * from a fast one-shot) and the root's disposal rejected the in-flight setup
 * await. Either way the failure describes a tree that is exiting as asked,
 * not a broken watch.
 * @param ctx - the booted root context.
 * @param signal - this invocation's signal-shutdown fact.
 * @param error - the setup failure.
 */
function suppressShutdownError(ctx: Context, signal: AbortSignal, error: unknown): void {
  if (signal.aborted) return
  if (ctx.fiber.state !== FiberState.ACTIVE || ctx.get('loader') === undefined) return
  throw error
}

/** The settled root context and the launcher-provided profile runtime of one boot. */
export interface ProfileBootResult {
  ctx: Context
  runtime: ProfileRuntime | undefined
}

/**
 * Boot one composed profile over its empty root config with the
 * launcher-provided profile runtime: the compose callback is
 * {@link composeLivePatches}, so the initial tree carries the current manager
 * layer between the bundle and user layers. The runtime is provided beside
 * the launch environment and cmdline facts before any config-tree entry
 * mounts; `boot()` binds it to the root Include and settles it, so the
 * manager plugin may inject it during boot but cannot mutate until then.
 * @param composed - the launcher-composed profile layers.
 * @param managerLayer - the startup manager-layer outcome ({@link prepareManagerRuntimeLayer}).
 * @param environment - this run's frozen environment snapshot.
 * @param args - the invocation's inner arguments for `ctx.cmdlineArgs`.
 * @param onPrepare - host-setup hook run first inside `boot(..., prepare)`
 * (the launcher records the in-flight context for signal teardown).
 * @param exit - the bounded exit request handed to `provideCmdline`.
 * @returns the settled root context and the provided runtime (undefined only
 * when a surface disposed the tree during startup).
 */
export async function bootComposedProfile(
  composed: ComposedProfile,
  managerLayer: ManagerLayerStartup,
  environment: LaunchEnvironmentSnapshot,
  args: readonly string[],
  onPrepare: (hostCtx: Context) => void,
  exit: (code: number) => void,
): Promise<ProfileBootResult> {
  const rootConfig = join(composed.profile.dir, PROFILE_ROOT_FILENAME)
  // The boot-time manager layer snapshot: what the initial composition mounts
  // becomes the runtime's acknowledged snapshot, so later watcher generations
  // keep it until a manager-layer apply/restore audit promotes a new one.
  const initialManagerPatches = readManagerLayerPatches(NAME, composed.profile.dir)
  let runtime: ProfileRuntime | undefined
  const ctx = await boot(NAME, rootConfig, composeLivePatches(composed, initialManagerPatches), (hostCtx) => {
    onPrepare(hostCtx)
    // Before any config-tree entry mounts, so plugins resolve all launch-time
    // environment values from the same immutable provenance snapshot.
    hostCtx.provide(DSH_LAUNCH_ENVIRONMENT_KEY, environment)
    // The command line and bounded exit request are launcher facts available
    // to every app plugin that injects the argument snapshot.
    provideCmdline(hostCtx, {
      args,
      exit,
    })
    // Launcher-owned profile runtime: immutable identity plus the sole
    // acknowledged live-recomposition API, beside the launch facts.
    runtime = new ProfileRuntime(hostCtx, {
      identity: { name: composed.profile.name, directory: composed.profile.dir },
      compose: managerPatches => composeLivePatches(composed, managerPatches),
      initialManagerPatches,
      ...managerLayer.recoveryError === undefined ? {} : { recoveryError: managerLayer.recoveryError },
      omittedRoots: managerLayer.omitted,
    })
  })
  return { ctx, runtime }
}

/**
 * Boot one profile invocation end to end and leave process lifetime to the
 * mounted plugins (or to a one-shot runner the composition mounts).
 * @param options - environment snapshot, profile name, overlays, and the booted app's own arguments.
 * @returns the settled root context and the shutdown controller.
 */
export async function runProfile(options: RunProfileOptions): Promise<{ ctx: Context; shutdown: ProcessShutdown }> {
  const composed = composeProfile(options.profile, options.patchFiles)
  // Startup manager-layer preparation: regenerate a missing/corrupt/stale
  // derived layer from a valid registry before the initial composition; a
  // corrupt registry fails managed roots closed and exposes a recovery error.
  const managerLayer = await prepareManagerRuntimeLayer(NAME, composed.profile.dir)
  const app: { current?: Context } = {}
  const shutdown = createProcessShutdown(async () => { await app.current?.fiber.dispose() })
  const signalShutdown = new AbortController()
  const interrupt = (code: number): void => {
    signalShutdown.abort()
    shutdown.interrupt(code)
  }
  // Signals own teardown throughout the startup window, not only after boot()
  // settles: an inserted provider can publish before sibling rows finish mounting.
  // SIGTERM is a supervisor's ordinary stop request and exits 0 on every
  // surface — the launcher does not know whether the app considered its work
  // complete; SIGINT is a user interrupt and reports 130.
  process.on('SIGTERM', () => { interrupt(0) })
  process.on('SIGINT', () => { interrupt(130) })
  installFailLoud(NAME, process, async () => {
    await app.current?.fiber.dispose()
  })

  const { ctx, runtime } = await bootComposedProfile(
    composed,
    managerLayer,
    options.environment,
    options.args,
    (hostCtx) => { app.current = hostCtx },
    code => void shutdown.shutdown(code),
  )
  app.current = ctx
  // A surface can dispose the whole tree while boot or this post-boot watcher
  // setup is still in flight — a signal, or a fast one-shot's appExit. Loader
  // presence and fiber state own liveness; the initial check skips a tree
  // that already exited, and the catch below re-checks for an exit that
  // landed mid-setup. Watching is unconditional: a one-shot surface exits
  // through its bounded shutdown, which disposes the watchers before the
  // loop drains.
  if (!signalShutdown.signal.aborted
    && ctx.fiber.state === FiberState.ACTIVE
    && ctx.get('loader') !== undefined) {
    try {
      // Config-only HMR for the live profile patch layer: the web bundle
      // disables the shared module-reload `hmr` row (its reload lifecycle is
      // untested), so when the composition leaves no HMR service, mount a
      // watch-only instance with no module roots — cordis.patch.yml edits stay
      // live on every long-lived surface. A silent skip would break the
      // documented hot-reload contract. HMR injects the timer service, which a
      // bare custom profile may not mount either.
      if (ctx.get('hmr') === undefined) {
        if (ctx.get('timer') === undefined) {
          await ctx.loader.create({ name: '@deepseek-ai/cordis-plugin-timer' })
        }
        await ctx.loader.create({ name: '@deepseek-ai/cordis-plugin-hmr', config: { root: [] } })
      }
      // Both user-patch watchers and the manager route through the runtime's
      // serialized recomposition queue — app-boot resolves the boot-only
      // control internally, so the injected service surface exposes no
      // un-audited recomposition: no independent entry.update writers.
      await watchUserPatches(ctx, {
        binName: NAME,
        filename: composed.profile.patchPath,
        ...runtime === undefined ? {} : { runtime },
      })
      await watchUserPatches(ctx, {
        binName: NAME,
        filename: homePatchPath(),
        ...runtime === undefined ? {} : { runtime },
      })
    } catch (error) {
      suppressShutdownError(ctx, signalShutdown.signal, error)
    }
  }
  return { ctx, shutdown }
}
