/**
 * Journaled lifecycle transactions for managed Workspace Apps (spec §10).
 * Every mutation runs inside the shared profile mutation lock, writes a
 * prepared journal plus private before-state backups BEFORE any owned file
 * changes, stages the registry + derived runtime layer, applies the layer
 * through the acknowledged ProfileRuntime recomposition, and only then
 * publishes the registry and removes the journal. Any failure before COMMIT
 * rolls back: restore backups, run the inverse pnpm operation, restore the
 * profile manifest/lockfile, and converge `node_modules` with a profile-local
 * `pnpm install`. A failed convergence retains the journal and exposes
 * `recovery-required` — the system never pretends to be clean (spec §27).
 * Cancellation flows end-to-end: the Remote signal and the manager fiber's
 * lifecycle controller are merged per transaction, so an abort or a manager
 * reload cancels pnpm and the activation wait, and the acknowledgement wait is
 * bounded by the configurable `settlementTimeoutMs` (spec §10.3).
 * @module @deepseek-ai/dsh-page-app-manager/transaction
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { managedRootWrapperRow, type ProfileRuntime } from '@deepseek-ai/dsh-app-boot'
import { type ExpectedManagedRoot } from '@deepseek-ai/dsh-app-boot'
import { managedRootHash, type EntryOptions } from './adapter.ts'
import {
  advancePageAppJournalPhase,
  parsePageAppRegistry,
  readPageAppJournal,
  readPageAppRegistry,
  removePageAppJournal,
  renderPageAppRuntimeLayer,
  resolvePageAppProfilePaths,
  snapshotPageAppJournalFiles,
  writePageAppJournal,
  writePageAppRegistry,
  withPageAppProfileLock,
  type PageAppJournalV1,
  type PageAppRegistryEntry,
  type PageAppRegistryV1,
  type ValidatedManagedRoot,
} from '@deepseek-ai/dsh-page-app-profile'
import type { PageAppInstallSource } from './types.ts'
import type { ClientActivationRequest, PageAppClientInstanceId, PageAppTransactionId } from './types.ts'
import { PageAppActivationGate } from './activation.ts'
import type { PageAppPackageExecutor } from './executor.ts'
import { validateInstalledPageAppPackage, resolveInstalledPackageDir } from './validation.ts'

/** Error whose message names pnpm's exact allowBuilds/build-script diagnostic. */
export class PageAppBuildPermissionError extends Error {}

/** Every pnpm invocation refused under `allowBuilds` (pnpm >= 10 wording). */
const ALLOW_BUILDS_PATTERNS = [
  /allowBuilds/i,
  /Ignored build scripts/i,
  /approve-builds/i,
  /build scripts of .* were blocked/i,
]

/** Transaction execution dependencies. */
export interface PageAppTransactionDeps {
  /** Absolute profile directory. */
  readonly profileDir: string
  /** The pnpm execution seam. */
  readonly executor: PageAppPackageExecutor
  /** The launcher-owned acknowledged profile recomposition service. */
  readonly runtime: ProfileRuntime
  /** Absolute pnpm-workspace.yaml path (never edited; allowBuilds diagnostics read it). */
  readonly pnpmWorkspaceFile: string
  /** Host cap on the client activation acknowledgement wait, in milliseconds. */
  readonly settlementTimeoutMs: number
  /**
   * Read the Host client-graph revision the install's activation request
   * carries. The acknowledgement is only meaningful against the exact graph
   * the client must converge to, never the runtime-layer document.
   */
  readonly clientGraphRev: () => string
  /** Called after each committed registry publication (the manager emits `page-app-manager/changed`). */
  readonly onChanged?: (revision: number) => void
  /** Called when the targeted activation gate opens (the manager emits `page-app-manager/activation-requested`). */
  readonly onActivationRequested?: (request: ClientActivationRequest) => void
}

/** Manager-relative owned files the journal snapshots before every mutation. */
const OWNED_RELATIVE_FILES = ['registry.json', 'runtime-layer.yml', '../package.json', '../pnpm-lock.yaml'] as const

/** Whether one pnpm failure output carries an allowBuilds refusal. */
function isAllowBuildsFailure(output: string): boolean {
  return ALLOW_BUILDS_PATTERNS.some(pattern => pattern.test(output))
}

/** The registry revision + staged layer one transaction will commit. */
export interface PageAppStagedState {
  readonly registry: PageAppRegistryV1
  readonly layer: string
  /** The runtime-audit expectations of the staged roots (hashes never empty). */
  readonly expectedRoots: readonly ExpectedManagedRoot[]
}

/**
 * Run one journaled lifecycle operation. Installs, enable/disable, hide,
 * reorder, and uninstall share the transaction scaffolding: lock, snapshot,
 * stage, apply, publish, journal.
 */
export class PageAppLifecycle {
  private readonly gate = new PageAppActivationGate()
  /** Aborts the in-flight transaction when the manager fiber unloads. */
  private readonly inFlight = new AbortController()
  private disposed = false

  /**
   * @param deps - profile, pnpm seam, runtime, pnpm-workspace path, settlement
   * timeout, and the client-graph revision reader.
   */
  constructor(private readonly deps: PageAppTransactionDeps) {}

  /** The pending targeted activation (null between transactions). */
  public get activation(): PageAppActivationGate {
    return this.gate
  }

  /**
   * Abort the in-flight transaction and refuse further mutations. Wired to the
   * manager fiber's effect, so a manager reload cannot orphan a running
   * transaction (the profile lock releases through rollback).
   */
  public dispose(): void {
    this.disposed = true
    this.inFlight.abort()
  }

  /**
   * Install one managed package (spec §10.1): pnpm add → resolve → static
   * validation → stage → apply → targeted client acknowledgement → publish.
   * @param source - the validated install source.
   * @param clientInstanceId - the opaque initiating client instance (only it
   * may acknowledge).
   * @param signal - cancellation (aborts pnpm and the acknowledgement wait).
   * @returns the committed registry revision.
   */
  public async install(
    source: PageAppInstallSource,
    clientInstanceId: PageAppClientInstanceId,
    signal: AbortSignal,
  ): Promise<number> {
    return this.withTransaction(async (transactionId, txSignal) => {
      // The post-add direct dependency key is resolved from the before/after
      // profile manifest delta; capture the before state before pnpm mutates it.
      const dependenciesBefore = this.readProfileDependencies()
      // pnpm add with the exact validated spec.
      const add = await this.deps.executor.run(['add', source.spec], { cwd: this.deps.profileDir, signal: txSignal })
      if (add.exitCode !== 0) {
        if (isAllowBuildsFailure(add.stderr)) {
          throw new PageAppBuildPermissionError(
            'page-app install: pnpm refused the dependency build scripts; the manager never broadens allowBuilds. '
            + `pnpm said: ${add.stderr.trim().split('\n').slice(-4).join(' ')}`,
          )
        }
        throw new Error(`page-app install: pnpm add failed: ${add.stderr.trim()}`)
      }
      // Resolve the actual installed package name/version, then validate.
      const staged = this.stageAfterInstall(source, dependenciesBefore)
      // Write the staged layer and advance to staged.
      await this.writeStagedLayer(staged)
      // Apply the layer through the acknowledged profile runtime.
      await this.applyRuntime(staged)
      // Targeted client activation: only the initiating instance may settle.
      // The request carries the Host client-graph revision after the
      // generation — never the runtime-layer document — so the client
      // converges to an exact rev match before acknowledging.
      const request: ClientActivationRequest = {
        transactionId,
        clientInstanceId,
        packageName: staged.registry.entries.at(-1)?.packageName ?? '',
        pageId: staged.registry.entries.at(-1)?.page.id ?? '',
        graphRevision: this.deps.clientGraphRev(),
      }
      this.gate.open(request)
      this.deps.onActivationRequested?.(request)
      try {
        await this.gate.awaitSettlement(txSignal, this.deps.settlementTimeoutMs)
      } finally {
        this.gate.discard()
      }
      await this.publish(staged.registry)
      return staged.registry.revision
    }, signal)
  }

  /**
   * Enable or disable one managed page (spec §10.2/§10.3): stage the registry
   * row and the derived layer, apply, and publish. Disable unloads the root;
   * enable remounts it. Never runs pnpm.
   * @param pageId - the managed page id.
   * @param enabled - the new enabled state.
   * @param signal - cancellation.
   * @returns the committed registry revision.
   */
  public async setEnabled(pageId: string, enabled: boolean, signal: AbortSignal): Promise<number> {
    // Enable/disable never runs pnpm or waits on the client; the signal is
    // part of the uniform mutation API and is honored by the shared lock.
    void signal
    return this.withTransaction(async () => {
      const current = await this.requireRegistry()
      const registry = {
        ...current,
        revision: current.revision + 1,
        entries: current.entries.map(row => row.page.id === pageId
          ? { ...row, enabled, updatedAt: new Date().toISOString() }
          : row),
      }
      const staged = this.stageFromRegistry(registry)
      await this.writeStagedLayer(staged)
      await this.applyRuntime(staged)
      await this.publish(staged.registry)
      return staged.registry.revision
    }, signal)
  }

  /**
   * Hide one managed page (spec §10.5): presentation only — no runtime layer
   * change, no unload.
   * @param pageId - the managed page id.
   * @param hidden - the new hidden state.
   * @returns the committed registry revision.
   */
  public async setHidden(pageId: string, hidden: boolean): Promise<number> {
    return this.withTransaction(async () => {
      const current = await this.requireRegistry()
      const registry = {
        ...current,
        revision: current.revision + 1,
        entries: current.entries.map(row => row.page.id === pageId
          ? { ...row, hidden, updatedAt: new Date().toISOString() }
          : row),
      }
      await this.publish(registry)
      return registry.revision
    }, new AbortController().signal)
  }

  /**
   * Reorder managed pages (spec §10.5): presentation only.
   * @param pageIds - page ids in the desired order (rows not listed keep their relative order after them).
   * @returns the committed registry revision.
   */
  public async reorder(pageIds: readonly string[]): Promise<number> {
    return this.withTransaction(async () => {
      const current = await this.requireRegistry()
      const byId = new Map(current.entries.map(row => [row.page.id, row]))
      for (const id of pageIds) {
        if (!byId.has(id)) throw new Error(`page-app reorder: unknown page id "${id}"`)
      }
      const ordered: PageAppRegistryEntry[] = []
      for (const id of pageIds) {
        const row = byId.get(id)
        if (row !== undefined) ordered.push(row)
      }
      const rest = current.entries.filter(row => !pageIds.includes(row.page.id))
      const entries = ordered.concat(rest).map((row, index) => ({ ...row, order: index + 1 }))
      const registry = { ...current, revision: current.revision + 1, entries }
      await this.publish(registry)
      return registry.revision
    }, new AbortController().signal)
  }

  /**
   * Uninstall one managed page (spec §10.4): disable/unload sequence, pnpm
   * remove, remove the row, publish. The manager never deletes the original
   * local source or the pnpm global store.
   * @param pageId - the managed page id.
   * @param signal - cancellation.
   * @returns the committed registry revision.
   */
  public async uninstall(pageId: string, signal: AbortSignal): Promise<number> {
    return this.withTransaction(async (_transactionId, txSignal) => {
      const current = await this.requireRegistry()
      const row = current.entries.find(entry => entry.page.id === pageId)
      if (row === undefined) throw new Error(`page-app uninstall: unknown page id "${pageId}"`)
      // 1. Disable/unload without publishing the final row yet.
      const disabled = {
        ...current,
        entries: current.entries.map(entry => entry.page.id === pageId ? { ...entry, enabled: false } : entry),
      }
      const staged = this.stageFromRegistry(disabled)
      await this.writeStagedLayer(staged)
      await this.applyRuntime(staged)
      // 2. pnpm remove the actual package name.
      const removed = await this.deps.executor.run(['remove', row.packageName], { cwd: this.deps.profileDir, signal: txSignal })
      if (removed.exitCode !== 0) {
        throw new Error(`page-app uninstall: pnpm remove failed: ${removed.stderr.trim()}`)
      }
      // 3. Drop the row and publish the regenerated layer.
      const final = this.stageFromRegistry({
        ...disabled,
        revision: disabled.revision + 1,
        entries: disabled.entries.filter(entry => entry.page.id !== pageId),
      })
      await this.writeStagedLayer(final)
      await this.publish(final.registry)
      return final.registry.revision
    }, signal)
  }

  // --- transaction scaffolding ----------------------------------------------

  private async withTransaction<T>(
    body: (transactionId: PageAppTransactionId, signal: AbortSignal) => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    if (this.disposed) {
      throw new Error('page-app transaction: the manager has been disposed; no new mutations')
    }
    const token = randomUUID()
    return withPageAppProfileLock(this.deps.profileDir, { kind: 'manager', token }, async () => {
      // A durable journal means a crashed transaction owns the profile; never
      // overwrite its decision — the operator runs recover() first.
      if ((await readPageAppJournal(this.deps.profileDir)) !== null) {
        throw new Error('page-app transaction: a journal exists; run recover() first (recovery-required)')
      }
      // Merge the caller's cancellation with the manager fiber's lifecycle
      // controller: either abort cancels pnpm and the settlement wait, so a
      // manager reload cannot orphan a running transaction.
      const merged = new AbortController()
      if (signal.aborted || this.inFlight.signal.aborted) merged.abort()
      const onCallerAbort = (): void => { merged.abort() }
      const onLifecycleAbort = (): void => { merged.abort() }
      signal.addEventListener('abort', onCallerAbort, { once: true })
      this.inFlight.signal.addEventListener('abort', onLifecycleAbort, { once: true })
      try {
        // Snapshot owned before-state and write the prepared journal FIRST:
        // recovery forbids any mutation before journal publication.
        const files = await snapshotPageAppJournalFiles(this.deps.profileDir, OWNED_RELATIVE_FILES)
        const prepared: PageAppJournalV1 = Object.freeze({
          schemaVersion: 1,
          phase: 'prepared',
          lockOwnerToken: token,
          files,
        })
        await writePageAppJournal(this.deps.profileDir, prepared)
        try {
          const result = await body(token as PageAppTransactionId, merged.signal)
          await removePageAppJournal(this.deps.profileDir)
          return result
        } catch (error) {
          await this.rollback(token, error)
          throw error
        }
      } finally {
        signal.removeEventListener('abort', onCallerAbort)
        this.inFlight.signal.removeEventListener('abort', onLifecycleAbort)
      }
    })
  }

  /** Stage the next registry + derived layer after a successful pnpm add. */
  private stageAfterInstall(source: PageAppInstallSource, dependenciesBefore: Readonly<Record<string, string>>): PageAppStagedState {
    const registry = this.requireRegistrySync()
    // Resolve the direct profile dependency key pnpm add actually wrote — from
    // the observable before/after manifest delta, never from the raw spec: for
    // a local link:/file:/tarball/Git source pnpm keys the dependency by
    // the package's own name (the spec is only the dependency value), while
    // the raw spec is not even a node_modules key. Validate against the real key.
    const packageName = this.resolveInstalledPackageKey(source, dependenciesBefore, this.readProfileDependencies())
    const record = validateInstalledPageAppPackage(this.deps.profileDir, packageName, {
      profileDir: this.deps.profileDir,
      registry,
      baseRootIds: [],
      profileDependencies: this.readProfileDependencies(),
      profileBundles: [],
    })
    const manifest = record.manifest
    const entry = {
      packageName,
      source: source.display,
      resolvedVersion: record.version,
      page: {
        id: manifest.id,
        name: manifest.name,
        description: manifest.description,
        defaultOrder: manifest.defaultOrder,
        rootEntryId: manifest.rootEntryId,
      },
      order: manifest.defaultOrder,
      enabled: true,
      hidden: false,
      installedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    const next: PageAppRegistryV1 = registry === null
      ? { schemaVersion: 1, revision: 1, entries: [entry] }
      : {
        ...registry,
        revision: registry.revision + 1,
        entries: [...registry.entries, entry],
      }
    return this.stageFromRegistry(next)
  }

  /**
   * Resolve the direct profile dependency key one successful `pnpm add` wrote.
   * The key comes from observable post-add profile state (the before/after
   * manifest delta), never pathname parsing or raw-spec heuristics: for a
   * local link:/file:/tarball/Git source pnpm keys the dependency by the
   * package's OWN name and the spec is only the dependency value, so the raw
   * spec can never name node_modules. A registry source keeps its bare package
   * name as the valid direct key when present — including a no-delta
   * reinstall where pnpm leaves the manifest dependency untouched. Non-registry
   * sources must produce exactly one added or changed key; zero or multiple
   * candidates are rejected with a deterministic, actionable error — never
   * guessed.
   * @param source - the validated install source.
   * @param before - the profile's direct dependencies captured before `pnpm add`.
   * @param after - the profile's direct dependencies read after success.
   * @returns the direct dependency key of the installed package.
   * @throws {Error} when a non-registry source produced zero or multiple
   * added/changed keys.
   */
  private resolveInstalledPackageKey(
    source: PageAppInstallSource,
    before: Readonly<Record<string, string>>,
    after: Readonly<Record<string, string>>,
  ): string {
    if (source.kind === 'registry') {
      const bare = source.spec.replace(/^npm:/, '')
      if (after[bare] !== undefined) return bare
    }
    const candidates = Object.keys(after)
      .filter(key => before[key] === undefined || before[key] !== after[key])
      .sort()
    const [candidate] = candidates
    if (candidates.length !== 1 || candidate === undefined) {
      const detail = candidates.length === 0
        ? 'produced no direct profile dependency change'
        : `changed ${candidates.length} direct profile dependencies (${candidates.join(', ')})`
      throw new Error(
        `page-app install: pnpm add ${detail} for source "${source.display.display}"; `
        + 'exactly one added or changed dependency key is required to resolve the installed package',
      )
    }
    return candidate
  }

  /** Derive the layer for a staged registry (enabled, statically valid rows only). */
  private stageFromRegistry(registry: PageAppRegistryV1): PageAppStagedState {
    const roots: ValidatedManagedRoot[] = []
    const expectedRoots: ExpectedManagedRoot[] = []
    for (const entry of registry.entries) {
      if (!entry.enabled) continue
      const row = composedManagedRow(this.deps.profileDir, entry, registry, this.readProfileDependencies())
      if (row === undefined) continue
      // Every staged root takes the Feature Runtime Wrapper parent form, using
      // the app-boot renderer as the single implementation the runtime layer
      // derivation shares (the layer, the transaction, and the health lookup
      // can never drift).
      const wrapper = managedRootWrapperRow({
        packageName: entry.packageName,
        pageId: entry.page.id,
        rootEntryId: row.rootEntryId,
        contractVersion: row.contractVersion,
        entries: [row.rootRow],
      }) as unknown as EntryOptions
      roots.push({
        packageName: entry.packageName,
        pageId: entry.page.id,
        rootEntryId: wrapper.id,
        enabled: true,
        entries: [wrapper],
      })
      expectedRoots.push({
        packageName: entry.packageName,
        pageId: entry.page.id,
        rootEntryId: wrapper.id,
        hash: managedRootHash(wrapper),
      })
    }
    return {
      registry,
      layer: roots.length > 0 ? renderPageAppRuntimeLayer(roots) : '[]\n',
      expectedRoots,
    }
  }

  /** Write the staged runtime layer file, then advance the journal to staged. */
  private async writeStagedLayer(staged: PageAppStagedState): Promise<void> {
    const paths = resolvePageAppProfilePaths(this.deps.profileDir)
    writeFileSync(paths.runtimeLayer, staged.layer)
    await this.advanceTo('staged')
  }

  /** Apply the staged layer through the acknowledged profile runtime. */
  private async applyRuntime(staged: PageAppStagedState): Promise<void> {
    await this.deps.runtime.applyManagerLayer({
      registryRevision: staged.registry.revision,
      runtimeLayer: staged.layer,
      expectedRoots: staged.expectedRoots,
    })
  }

  /** Publish the registry and advance the journal to committing. */
  private async publish(registry: PageAppRegistryV1): Promise<void> {
    await writePageAppRegistry(this.deps.profileDir, registry)
    await this.advanceTo('committing')
    this.deps.onChanged?.(registry.revision)
  }

  /** Re-read the durable journal and walk it forward to the target phase (never a stale in-memory object). */
  private async advanceTo(target: 'staged' | 'committing'): Promise<void> {
    const current = await readPageAppJournal(this.deps.profileDir)
    if (current === null) throw new Error('page-app transaction: journal missing while advancing')
    let journal = current
    while (journal.phase !== target) {
      journal = advancePageAppJournalPhase(journal, journal.phase === 'prepared' ? 'staged' : 'committing')
    }
    await writePageAppJournal(this.deps.profileDir, journal)
  }

  /** Restore before-state and converge; a failed convergence retains the journal. */
  private async rollback(token: string, cause: unknown): Promise<void> {
    try {
      const journal = await readPageAppJournal(this.deps.profileDir)
      if (journal !== null && journal.lockOwnerToken !== token) {
        throw new Error('page-app rollback: journal owner token mismatch')
      }
      // Restore the live Include tree through the acknowledged runtime FIRST
      // (last-known-good): the prior layer is staged back, recomposed, and its
      // audit awaited before any owned file changes. An audit failure rejects
      // and keeps the journal as recovery-required.
      if (journal !== null) {
        await this.restoreLiveLayer(journal)
      }
      const files = journal?.files ?? {}
      for (const [relative, state] of Object.entries(files)) {
        const paths = resolvePageAppProfilePaths(this.deps.profileDir)
        const absolute = relative === 'registry.json' || relative === 'runtime-layer.yml'
          ? join(paths.directory, relative)
          : join(this.deps.profileDir, relative.replace(/^\.\.\//, ''))
        if (state.present) {
          try {
            const backup = await readFile(`${absolute}.backup`, 'utf8')
            writeFileSync(absolute, backup)
          } catch {
            // Restore failures fall through to recovery-required below.
          }
        } else {
          await rm(absolute, { force: true })
        }
      }
      // Converge node_modules to the restored manifest/lockfile.
      const converge = await this.deps.executor.run(['install'], { cwd: this.deps.profileDir, signal: new AbortController().signal })
      if (converge.exitCode !== 0) {
        throw new Error(`page-app rollback: pnpm install convergence failed (${converge.stderr.trim()}); journal retained`)
      }
    } catch (rollbackError) {
      // Keep the journal: recovery-required, never pretend clean.
      throw new Error(
        `page-app transaction failed (${String(cause instanceof Error ? cause.message : cause)}) `
        + `and rollback is incomplete (${String(rollbackError instanceof Error ? rollbackError.message : rollbackError)}); `
        + 'managerState = recovery-required',
      )
    }
  }

  /**
   * Restore the prior manager-layer generation the journal recorded: stage the
   * before layer, recompute its expected-root hashes from the before registry,
   * and await the runtime's restore audit. A restore failure propagates so the
   * journal stays and recovery-required is reported.
   */
  private async restoreLiveLayer(journal: PageAppJournalV1): Promise<void> {
    const paths = resolvePageAppProfilePaths(this.deps.profileDir)
    let registry: PageAppRegistryV1 | null = null
    const registryState = journal.files['registry.json']
    if (registryState?.present === true) {
      try {
        registry = parsePageAppRegistry(JSON.parse(await readFile(`${paths.registry}.backup`, 'utf8')))
      } catch {
        // An unreadable before registry restores as the empty composition.
      }
    }
    let runtimeLayer = '[]\n'
    const layerState = journal.files['runtime-layer.yml']
    if (layerState?.present === true) {
      try {
        runtimeLayer = await readFile(`${paths.runtimeLayer}.backup`, 'utf8')
      } catch {
        // A missing before layer restores as the empty composition.
      }
    }
    // The runtime verifies the staged file equals the request; stage the
    // restored layer before recomposing.
    writeFileSync(paths.runtimeLayer, runtimeLayer)
    await this.deps.runtime.restoreManagerLayer({
      registryRevision: registry?.revision ?? 0,
      runtimeLayer,
      expectedRoots: registry === null ? [] : derivePageAppExpectedRoots(this.deps.profileDir, registry),
    })
  }

  private async requireRegistry(): Promise<PageAppRegistryV1> {
    const registry = await readPageAppRegistry(this.deps.profileDir)
    if (registry === null) throw new Error('page-app: no registry has been published')
    return registry
  }

  private requireRegistrySync(): PageAppRegistryV1 | null {
    try {
      return JSON.parse(readFileSync(resolvePageAppProfilePaths(this.deps.profileDir).registry, 'utf8')) as PageAppRegistryV1
    } catch {
      return null
    }
  }

  private readProfileDependencies(): Record<string, string> {
    try {
      const pkg = JSON.parse(readFileSync(join(this.deps.profileDir, 'package.json'), 'utf8')) as {
        dependencies?: Record<string, string>
      }
      return pkg.dependencies ?? {}
    } catch {
      return {}
    }
  }
}

/** The strict validator's composed root of one enabled registry row, when healthy. */
function composedManagedRow(
  profileDir: string,
  entry: PageAppRegistryEntry,
  registry: PageAppRegistryV1,
  profileDependencies: Record<string, string>,
): { rootEntryId: string; rootRow: ReturnType<typeof validateInstalledPageAppPackage>['rootRow']; contractVersion: number } | undefined {
  const installed = resolveInstalledPackageDir(profileDir, entry.packageName)
  if (installed === undefined) return undefined
  try {
    const pkg = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')) as { dsh?: { bundle?: { patch?: string } } }
    if (typeof pkg.dsh?.bundle?.patch !== 'string') return undefined
    // Reuse the strict validator's composed root (the validation module owns
    // the compose-over-empty-root logic); the expected hash is its real one.
    // The row being re-derived is already owned — exclude its own package so
    // the admission uniqueness checks keep guarding the OTHER rows.
    const record = validateInstalledPageAppPackage(profileDir, entry.packageName, {
      profileDir,
      registry: {
        ...registry,
        entries: registry.entries.filter(row => row.packageName !== entry.packageName),
      },
      baseRootIds: [],
      profileDependencies,
      profileBundles: [],
    })
    return {
      rootEntryId: record.rootEntryId,
      rootRow: record.rootRow,
      contractVersion: record.manifest.schemaVersion,
    }
  } catch {
    // An unhealthy row contributes no root; the registry stays authoritative.
    return undefined
  }
}

/**
 * Derive the runtime-audit expectations for one registry (rollback/recovery
 * restore paths recompute them from the journal's before-state). Hashes are
 * `managedRootHash` (the adapter's `canonicalManagedRootHash` delegate) of the
 * Feature Runtime Wrapper parent row — never empty — so the audit and the
 * health lookup share the wrapper form.
 * @param profileDir - absolute profile directory (resolution anchor).
 * @param registry - the registry to derive enabled roots from.
 * @returns one expectation per enabled, statically valid row.
 */
export function derivePageAppExpectedRoots(profileDir: string, registry: PageAppRegistryV1): ExpectedManagedRoot[] {
  const profileDependencies = readProfileDependenciesFrom(profileDir)
  const expectedRoots: ExpectedManagedRoot[] = []
  for (const entry of registry.entries) {
    if (!entry.enabled) continue
    const row = composedManagedRow(profileDir, entry, registry, profileDependencies)
    if (row === undefined) continue
    const wrapper = managedRootWrapperRow({
      packageName: entry.packageName,
      pageId: entry.page.id,
      rootEntryId: row.rootEntryId,
      contractVersion: row.contractVersion,
      entries: [row.rootRow],
    }) as unknown as EntryOptions
    expectedRoots.push({
      packageName: entry.packageName,
      pageId: entry.page.id,
      rootEntryId: wrapper.id,
      hash: managedRootHash(wrapper),
    })
  }
  return expectedRoots
}

function readProfileDependenciesFrom(profileDir: string): Record<string, string> {
  try {
    const pkg = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    return pkg.dependencies ?? {}
  } catch {
    return {}
  }
}
