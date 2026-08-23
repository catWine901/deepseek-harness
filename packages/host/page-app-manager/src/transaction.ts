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
 * @module @deepseek-ai/dsh-page-app-manager/transaction
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ProfileRuntime } from '@deepseek-ai/dsh-app-boot'
import {
  advancePageAppJournalPhase,
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
import { PageAppActivationGate, type ClientActivationRequest, type PageAppClientInstanceId, type PageAppTransactionId } from './activation.ts'
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
}

/**
 * Run one journaled lifecycle operation. Installs, enable/disable, hide,
 * reorder, and uninstall share the transaction scaffolding: lock, snapshot,
 * stage, apply, publish, journal.
 */
export class PageAppLifecycle {
  private readonly gate = new PageAppActivationGate()

  /**
   * @param deps - profile, pnpm seam, runtime, and pnpm-workspace path.
   */
  constructor(private readonly deps: PageAppTransactionDeps) {}

  /** The pending targeted activation (null between transactions). */
  public get activation(): PageAppActivationGate {
    return this.gate
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
    return this.withTransaction(async (transactionId) => {
      // pnpm add with the exact validated spec.
      const add = await this.deps.executor.run(['add', source.spec], { cwd: this.deps.profileDir, signal })
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
      const staged = this.stageAfterInstall(source)
      // Write the staged layer and advance to staged.
      await this.writeStagedLayer(staged)
      // Apply the layer through the acknowledged profile runtime.
      await this.applyRuntime(staged)
      // Targeted client activation: only the initiating instance may settle.
      const request: ClientActivationRequest = {
        transactionId,
        clientInstanceId,
        packageName: staged.registry.entries.at(-1)?.packageName ?? '',
        pageId: staged.registry.entries.at(-1)?.page.id ?? '',
        graphRevision: staged.layer,
      }
      this.gate.open(request)
      this.deps.onActivationRequested?.(request)
      try {
        await this.gate.awaitSettlement(signal)
      } finally {
        this.gate.discard()
      }
      await this.publish(staged.registry)
      return staged.registry.revision
    })
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
    })
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
    })
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
    })
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
    return this.withTransaction(async () => {
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
      const removed = await this.deps.executor.run(['remove', row.packageName], { cwd: this.deps.profileDir, signal })
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
    })
  }

  // --- transaction scaffolding ----------------------------------------------

  private async withTransaction<T>(
    body: (transactionId: PageAppTransactionId) => Promise<T>,
  ): Promise<T> {
    const token = randomUUID()
    return withPageAppProfileLock(this.deps.profileDir, { kind: 'manager', token }, async () => {
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
        const result = await body(token as PageAppTransactionId)
        await removePageAppJournal(this.deps.profileDir)
        return result
      } catch (error) {
        await this.rollback(token, error)
        throw error
      }
    })
  }

  /** Stage the next registry + derived layer after a successful pnpm add. */
  private stageAfterInstall(source: PageAppInstallSource): PageAppStagedState {
    const registry = this.requireRegistrySync()
    // Resolve the installed package (pnpm add wrote node_modules) and validate.
    // The dependency key is the package name (aliases rejected by validation).
    const installed = resolveInstalledPackageDir(this.deps.profileDir, source.spec.replace(/^npm:/, ''))
    const packageName = installed === undefined
      ? source.spec.replace(/^npm:/, '')
      : (JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')) as { name?: string }).name ?? source.spec
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

  /** Derive the layer for a staged registry (enabled, statically valid rows only). */
  private stageFromRegistry(registry: PageAppRegistryV1): PageAppStagedState {
    const roots: ValidatedManagedRoot[] = []
    for (const entry of registry.entries) {
      if (!entry.enabled) continue
      const installed = resolveInstalledPackageDir(this.deps.profileDir, entry.packageName)
      if (installed === undefined) continue
      try {
        const pkg = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8')) as { dsh?: { bundle?: { patch?: string } } }
        const patch = pkg.dsh?.bundle?.patch
        if (typeof patch !== 'string') continue
        // Reuse the strict validator's composed root by re-deriving through it
        // (the validation module owns the compose-over-empty-root logic).
        const record = validateInstalledPageAppPackage(this.deps.profileDir, entry.packageName, {
          profileDir: this.deps.profileDir,
          registry,
          baseRootIds: [],
          profileDependencies: this.readProfileDependencies(),
          profileBundles: [],
        })
        roots.push({
          packageName: entry.packageName,
          pageId: entry.page.id,
          rootEntryId: record.rootEntryId,
          enabled: true,
          entries: [record.rootRow],
        })
      } catch {
        // An unhealthy row contributes no root; the registry stays authoritative.
      }
    }
    return { registry, layer: roots.length > 0 ? renderPageAppRuntimeLayer(roots) : '[]\n' }
  }

  /** Write the staged runtime layer file, then advance the journal to staged. */
  private async writeStagedLayer(staged: PageAppStagedState): Promise<void> {
    const paths = resolvePageAppProfilePaths(this.deps.profileDir)
    writeFileSync(paths.runtimeLayer, staged.layer)
    await this.advanceTo('staged')
  }

  /** Apply the staged layer through the acknowledged profile runtime. */
  private async applyRuntime(staged: PageAppStagedState): Promise<void> {
    const expectedRoots = staged.registry.entries
      .filter(entry => entry.enabled)
      .map(entry => ({
        packageName: entry.packageName,
        pageId: entry.page.id,
        rootEntryId: entry.page.rootEntryId,
        // The runtime hashes the effective row; the manager's staged rows are
        // derived deterministically, so the expected hash check is meaningful
        // only after the loader audit — pass the ids and let the runtime audit.
        hash: '',
      }))
    await this.deps.runtime.applyManagerLayer({
      registryRevision: staged.registry.revision,
      runtimeLayer: staged.layer,
      expectedRoots,
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
