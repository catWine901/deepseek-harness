/**
 * Host page-app manager service: the read-only projection of one profile's
 * managed Workspace Apps plus staged-dependency validation. The registry is the
 * sole ownership authority — Plugin Inventory and unrelated Loader rows never
 * create entries — and every mutation (install/enable/disable/uninstall)
 * arrives in the transaction task (Task 8). The manager root is constructed
 * from the profile runtime and Loader facts only, so management-API readiness
 * can never gate the built-in DSH shell (SR-09). Mutating Remote methods carry
 * a final `signal` the transaction honors, the activation acknowledgement is
 * bounded by the configurable `settlementTimeoutMs`, and the lifecycle is
 * disposed with the manager fiber so a reload cannot orphan a transaction.
 * @module @deepseek-ai/dsh-page-app-manager
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { composePatchRows, findLoaderRow, fiberStateOf, isActiveFiberState, managedRootHash, type EntryOptions, type LoaderLike } from './adapter.ts'
import {
  loadOverlayPatches,
  managedRootWrapperId,
  managedRootWrapperRow,
  managerWrapperResolvable,
  PROFILE_RUNTIME_SERVICE,
  WORKBENCH_RUNTIME_SERVICE,
  type ProfileRuntime,
} from '@deepseek-ai/dsh-app-boot'
import {
  parsePageAppJournal,
  parsePageAppManifest,
  parsePageAppRegistry,
  resolvePageAppProfilePaths,
  type PageAppRegistryEntry,
  type PageAppRegistryV1,
} from '@deepseek-ai/dsh-page-app-profile'
import type { PageAppClientInstanceId, PageAppManagerConfig, PageAppTransactionId } from './types.ts'
import type { PageAppManagerSnapshot, PageAppView, PageAppInstallSource } from './types.ts'
import { parsePageAppInstallSource } from './source.ts'
import { PageAppLifecycle } from './transaction.ts'
import { createPnpmExecutor, type PageAppPackageExecutor } from './executor.ts'
import { recoverPageAppTransaction } from './recovery.ts'
import { createWorkbenchRuntime } from './workbench-runtime.ts'

export * from './types.ts'
export * from './source.ts'
export * from './validation.ts'
export * from './executor.ts'
export * from './activation.ts'
export * from './transaction.ts'
export * from './recovery.ts'
export * from './workbench-runtime.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The Host page-app manager service (profile-scoped ownership projection). */
    pageAppManager: PageAppManager
  }
}

/** Runtime facts one row's health derives from. */
interface RowRuntimeFacts {
  readonly installedVersion: string | undefined
  readonly manifestValid: boolean
  readonly bundleValid: boolean
  readonly wrapperResolvable: boolean
  readonly expectedRootHash: string | undefined
  readonly loaderRow: { fiberState: number | undefined; hashMatches: boolean } | undefined
}

/** Derive one row's health from current dependency/version/runtime facts. */
function deriveHealth(
  entry: PageAppRegistryEntry,
  facts: RowRuntimeFacts,
): { health: PageAppView['health']; runtimeState?: string; lastError?: string } {
  if (!entry.enabled) return { health: 'disabled' }
  if (facts.installedVersion === undefined) {
    return { health: 'missing-dependency', lastError: 'the package dependency is not installed in this profile' }
  }
  if (facts.installedVersion !== entry.resolvedVersion) {
    return { health: 'version-drift', lastError: `installed ${facts.installedVersion} does not match committed ${entry.resolvedVersion}` }
  }
  if (!facts.manifestValid || !facts.bundleValid) {
    return { health: 'invalid-manifest', lastError: 'the installed package no longer satisfies the Workspace Plugin Contract' }
  }
  if (!facts.wrapperResolvable) {
    return { health: 'missing-manager', lastError: 'the page-app manager wrapper is not installed in this profile' }
  }
  if (facts.loaderRow === undefined || !isActiveFiberState(facts.loaderRow.fiberState)) {
    return { health: 'activation-failed', lastError: 'the managed wrapper row is not mounted with an active fiber in the runtime tree' }
  }
  if (!facts.loaderRow.hashMatches) {
    return { health: 'externally-overridden', lastError: 'a user patch configures, disables, or replaces the managed wrapper row' }
  }
  return { health: 'ready', runtimeState: String(facts.loaderRow.fiberState) }
}

/** Sync read of the ownership authority; a missing file is a normal empty state. */
function readRegistrySync(profileDir: string): { registry: PageAppRegistryV1 | null; recoveryError?: string } {
  const paths = resolvePageAppProfilePaths(profileDir)
  let content: string
  try {
    content = readFileSync(paths.registry, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return { registry: null }
    return { registry: null, recoveryError: `page-app registry is unreadable; managed roots failed closed: ${String(error)}` }
  }
  try {
    return { registry: parsePageAppRegistry(JSON.parse(content)) }
  } catch (error) {
    return { registry: null, recoveryError: `page-app registry is corrupt; managed roots failed closed: ${String(error)}` }
  }
}

/**
 * Build the Host page-app manager service. Extends `TypertRemoteService` so the
 * generated `pageAppManager` namespace exposes the mutation API; the read
 * projection and staged validation are plain methods on the same service.
 * @param ctx - plugin context with the Loader available.
 * @param options - the launcher-provided profile runtime (identity source).
 */
export class PageAppManager extends TypertRemoteService {
  private readonly profileRuntime: ProfileRuntime
  private readonly lifecycle: PageAppLifecycle

  constructor(ctx: Context, options: {
    profileRuntime: ProfileRuntime
    executor?: PageAppPackageExecutor
    /** The resolved plugin config: the Host settlement-wait cap. */
    config: { settlementTimeoutMs: number }
  }) {
    super(ctx, 'pageAppManager')
    this.profileRuntime = options.profileRuntime
    this.lifecycle = new PageAppLifecycle({
      profileDir: this.profileRuntime.identity.directory,
      executor: options.executor ?? createPnpmExecutor(),
      runtime: this.profileRuntime,
      pnpmWorkspaceFile: join(this.profileRuntime.identity.directory, 'pnpm-workspace.yaml'),
      settlementTimeoutMs: options.config.settlementTimeoutMs,
      clientGraphRev: () => {
        // The Host client-modules registry owns the graph served as
        // `window.__DSH_BOOT__`; the activation request must carry its exact
        // revision so the acknowledgement proves convergence.
        const modules = ctx.get('clientModules') as { graph(): { rev: string } } | undefined
        if (modules === undefined) {
          throw new Error('page-app install: the host client-modules registry is unavailable; cannot converge the activation graph')
        }
        return modules.graph().rev
      },
      onChanged: (revision) => { ctx.emit('page-app-manager/changed', revision) },
      onActivationRequested: (request) => { ctx.emit('page-app-manager/activation-requested', request) },
    })
  }

  /** The immutable active-profile identity (consumers cannot replace it). */
  public get identity(): { name: string; directory: string } {
    return this.profileRuntime.identity
  }

  /** The pending targeted client activation gate (install acknowledgement). */
  public get activation(): PageAppLifecycle['activation'] {
    return this.lifecycle.activation
  }

  /** Abort the in-flight transaction; wired to the manager fiber's effect. */
  public dispose(): void {
    this.lifecycle.dispose()
  }

  /**
   * The full read-only projection of the managed set. The registry is the
   * ownership authority; health is derived from current dependency, version,
   * and runtime facts. Plugin Inventory and unrelated Loader rows never create
   * entries.
   * @returns the immutable snapshot.
   */
  @Remote('list')
  public list(): PageAppManagerSnapshot {
    return this.snapshot()
  }

  /**
   * Install one managed package (the Remote entry of the Settings add-flow).
   * @param source - the validated install source.
   * @param clientInstanceId - the opaque initiating client instance.
   * @param signal - cancellation; aborts pnpm and the activation wait.
   * @returns the committed registry revision.
   */
  @Remote('install')
  public install(source: PageAppInstallSource, clientInstanceId: PageAppClientInstanceId, signal: AbortSignal): Promise<number> {
    return this.lifecycle.install(source, clientInstanceId, signal)
  }

  /**
   * Enable or disable one managed page.
   * @param pageId - the managed page id.
   * @param enabled - the new enabled state.
   * @param signal - cancellation; honored by the shared lock.
   * @returns the committed registry revision.
   */
  @Remote('setEnabled')
  public setEnabled(pageId: string, enabled: boolean, signal: AbortSignal): Promise<number> {
    return this.lifecycle.setEnabled(pageId, enabled, signal)
  }

  /**
   * Hide or show one managed page (presentation only).
   * @param pageId - the managed page id.
   * @param hidden - the new hidden state.
   * @returns the committed registry revision.
   */
  @Remote('setHidden')
  public setHidden(pageId: string, hidden: boolean): Promise<number> {
    return this.lifecycle.setHidden(pageId, hidden)
  }

  /**
   * Reorder managed pages.
   * @param pageIds - page ids in the desired order.
   * @returns the committed registry revision.
   */
  @Remote('reorder')
  public reorder(pageIds: readonly string[]): Promise<number> {
    return this.lifecycle.reorder(pageIds)
  }

  /**
   * Uninstall one managed page from the current profile.
   * @param pageId - the managed page id.
   * @param signal - cancellation; aborts pnpm and the activation wait.
   * @returns the committed registry revision.
   */
  @Remote('uninstall')
  public uninstall(pageId: string, signal: AbortSignal): Promise<number> {
    return this.lifecycle.uninstall(pageId, signal)
  }

  /**
   * Acknowledge a pending targeted client activation. Only the first valid
   * acknowledgement from the initiating client instance settles the install.
   * @param transactionId - the transaction the acknowledgement names.
   * @param clientInstanceId - the acknowledging client instance.
   * @param packageName - the acknowledged package.
   * @param pageId - the acknowledged page id.
   * @param graphRevision - the graph revision the client converged to.
   * @returns whether this attempt settled the transaction.
   */
  @Remote('ackClientActivation')
  public ackClientActivation(
    transactionId: PageAppTransactionId,
    clientInstanceId: PageAppClientInstanceId,
    packageName: string,
    pageId: string,
    graphRevision: string,
  ): { accepted: boolean; reason?: string } {
    const result = this.lifecycle.activation.acknowledge(
      transactionId, clientInstanceId, packageName, pageId, graphRevision,
    )
    return { accepted: result.accepted, ...result.reason === undefined ? {} : { reason: result.reason } }
  }

  /**
   * Run the startup/operator recovery over the profile journal.
   * @returns the recovery outcome.
   */
  @Remote('recover')
  public recover(): Promise<{ action: string; message?: string }> {
    return recoverPageAppTransaction(
      this.profileRuntime.identity.directory,
      createPnpmExecutor(),
      this.profileRuntime,
    ).then(outcome => ({ action: outcome.action, ...outcome.message === undefined ? {} : { message: outcome.message } }))
  }

  /**
   * The full read-only projection of the managed set (the `list` Remote
   * delegates here; the raw method stays available to host-side consumers).
   * @returns the immutable snapshot.
   */
  public snapshot(): PageAppManagerSnapshot {
    const profile = this.profileRuntime.identity
    const { registry, recoveryError } = readRegistrySync(profile.directory)
    const operation = readJournalOperation(profile.directory)
    const loader = this.ctx.get('loader')
    const entries = registry === null
      ? []
      : registry.entries.map(row => Object.freeze(this.viewOf(row, loader)))
    return Object.freeze({
      profile: Object.freeze({ ...profile }),
      revision: registry?.revision ?? 0,
      entries: Object.freeze(entries),
      operation,
      recovery: recoveryError === undefined ? null : Object.freeze({ message: recoveryError }),
    })
  }

  /**
   * Parse and classify one Settings add-flow source spec. Local directory
   * sources are additionally preflighted against the on-disk package; registry,
   * git, link, and tarball sources await the pnpm staging step (Task 8) before
   * the full static validation runs. Never mutates ownership.
   * @param source - the raw specifier (or an already-typed source).
   * @returns the validated install source plus a preflight note.
   * @throws {Error} when the spec is rejected (kind grammar, credentials, relative path).
   */
  public validateInstall(source: string | PageAppInstallSource): { source: PageAppInstallSource; preflight: string | null } {
    const parsed = typeof source === 'string' ? parsePageAppInstallSource(source) : source
    if (parsed.kind !== 'file') {
      return { source: parsed, preflight: 'pnpm staging required before static validation (transaction task)' }
    }
    // Local directory preflight: the package.json at the path must carry a
    // name and a workspace block; the full contract check runs after pnpm.
    try {
      const pkg = JSON.parse(readFileSync(join(parsed.spec, 'package.json'), 'utf8')) as {
        name?: unknown
        dsh?: { workspace?: unknown }
      }
      if (typeof pkg.name !== 'string' || pkg.name === '' || typeof pkg.dsh?.workspace !== 'object' || pkg.dsh.workspace === null) {
        throw new Error('no name or dsh.workspace block')
      }
      return { source: parsed, preflight: null }
    } catch (error) {
      throw new Error(`page-app install source: ${parsed.spec} is not a valid workspace package: ${String(error)}`)
    }
  }

  /** Project one registry row into its view with derived health. */
  private viewOf(row: PageAppRegistryEntry, loader: LoaderLike | undefined): PageAppView {
    const profile = this.profileRuntime.identity
    const nodeModules = join(profile.directory, 'node_modules', row.packageName)
    const facts: RowRuntimeFacts = this.factsOf(row, nodeModules, loader)
    const { health, runtimeState, lastError } = deriveHealth(row, facts)
    return Object.freeze({
      packageName: row.packageName,
      source: row.source,
      resolvedVersion: row.resolvedVersion,
      page: row.page,
      order: row.order,
      enabled: row.enabled,
      hidden: row.hidden,
      installedAt: row.installedAt,
      updatedAt: row.updatedAt,
      health,
      ...runtimeState === undefined ? {} : { runtimeState },
      ...lastError === undefined ? {} : { lastError },
    })
  }

  /** Collect the current dependency/version/manifest/bundle/runtime facts of one row. */
  private factsOf(row: PageAppRegistryEntry, packageDir: string, loader: LoaderLike | undefined): RowRuntimeFacts {
    let installedPkg: { version?: unknown; dsh?: { bundle?: { patch?: unknown } } } | undefined
    try {
      installedPkg = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as typeof installedPkg
    } catch {
      installedPkg = undefined
    }
    const installedVersion = typeof installedPkg?.version === 'string' ? installedPkg.version : undefined
    if (installedPkg === undefined || installedVersion !== row.resolvedVersion) {
      return {
        installedVersion,
        manifestValid: false,
        bundleValid: false,
        wrapperResolvable: false,
        expectedRootHash: undefined,
        loaderRow: undefined,
      }
    }
    let manifestValid = true
    let contractVersion = 1
    try {
      contractVersion = parsePageAppManifest(row.packageName, installedPkg).schemaVersion
    } catch {
      manifestValid = false
    }
    let bundleValid = true
    let expectedRootHash: string | undefined
    const patch = installedPkg.dsh?.bundle?.patch
    try {
      if (typeof patch !== 'string' || patch === '') throw new Error('no bundle patch')
      const patches = loadOverlayPatches('page-app', join(packageDir, patch))
      const rows = composePatchRows(patches)
      const rootRow = rows.find(candidate => candidate.id === row.page.rootEntryId)
      if (rootRow === undefined) throw new Error('root row missing')
      // The runtime layer mounts the Feature Runtime Wrapper parent row; the
      // row's health follows the wrapper entry, not the bare feature row.
      const wrapper = managedRootWrapperRow({
        packageName: row.packageName,
        pageId: row.page.id,
        rootEntryId: row.page.rootEntryId,
        contractVersion,
        entries: [rootRow],
      }) as unknown as EntryOptions
      expectedRootHash = managedRootHash(wrapper)
    } catch {
      bundleValid = false
    }
    let loaderRow: RowRuntimeFacts['loaderRow']
    if (loader === undefined || expectedRootHash === undefined) {
      loaderRow = undefined
    } else {
      const found = findLoaderRow(loader, managedRootWrapperId(row.page.id))
      loaderRow = found === undefined
        ? undefined
        : {
          fiberState: fiberStateOf(found),
          hashMatches: managedRootHash(found.options) === expectedRootHash,
        }
    }
    return {
      installedVersion,
      manifestValid,
      bundleValid,
      wrapperResolvable: managerWrapperResolvable(this.profileRuntime.identity.directory),
      expectedRootHash,
      loaderRow,
    }
  }
}

/** Read the durable journal phase as the in-flight operation view. */
function readJournalOperation(profileDir: string): { phase: 'prepared' | 'staged' | 'committing' } | null {
  const paths = resolvePageAppProfilePaths(profileDir)
  let content: string
  try {
    content = readFileSync(paths.journal, 'utf8')
  } catch {
    // No journal (or an unreadable one — the mutation path fails closed on the
    // parser) means no operation in flight.
    return null
  }
  try {
    const journal = parsePageAppJournal(JSON.parse(content))
    return { phase: journal.phase }
  } catch {
    return null
  }
}

/** Stable Cordis plugin name. */
export const name = 'page-app-manager'

/** Required services: the launcher-owned profile runtime and the Loader. */
export const inject = [PROFILE_RUNTIME_SERVICE, 'loader']

/** Validated plugin config: the Host settlement-wait cap (defaults in the schema). */
export const Config = z.object({
  settlementTimeoutMs: z.number().int().positive().default(60_000),
})

/**
 * Mount the Host page-app manager service as a Cordis plugin: reads the
 * launcher-owned profile runtime (the immutable identity and the only
 * acknowledged live-recomposition writer), provides the Workbench Runtime
 * under the contract service name (the Feature Runtime Wrapper fibers inject
 * it, so provider loss parks them PENDING and return reloads them), and
 * constructs the manager over the runtime. The manager must never infer the
 * profile from cwd or browser arguments (spec §8.1). Constructing the
 * TypertRemoteService registers it on the caller's fiber, so it unregisters
 * automatically when the fiber unloads; the effect disposes the lifecycle so
 * an in-flight transaction aborts with the manager fiber instead of orphaning
 * under a half-dead manager. The `ctx.provide` call is itself fiber-scoped:
 * its disposer deletes the service and re-evaluates every dependent wrapper.
 * @param ctx - Host context with the profile runtime and Loader mounted.
 * @param config - resolved plugin config (Cordis applies the schema default).
 */
export function apply(ctx: Context, config: PageAppManagerConfig): void {
  const runtime = ctx.get(PROFILE_RUNTIME_SERVICE) as ProfileRuntime
  // The Workbench Runtime lives and dies with the manager fiber: `ctx.provide`
  // registers a fiber effect whose disposer removes the service and notifies
  // every fiber injecting it, so an uninstalled or reloaded manager leaves the
  // wrapper fibers PENDING until a provider returns.
  ctx.provide(WORKBENCH_RUNTIME_SERVICE, createWorkbenchRuntime(ctx))
  // Constructing the manager provides ctx.pageAppManager on this fiber; the
  // Service base auto-unregisters it when the fiber unloads.
  const manager = new PageAppManager(ctx, {
    profileRuntime: runtime,
    config: { settlementTimeoutMs: config.settlementTimeoutMs ?? 60_000 },
  })
  ctx.effect(() => () => { manager.dispose() }, 'page-app-manager: abort in-flight transactions when the manager fiber unloads')
}
