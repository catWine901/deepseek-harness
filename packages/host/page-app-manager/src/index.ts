/**
 * Host page-app manager service: the read-only projection of one profile's
 * managed Workspace Apps plus staged-dependency validation. The registry is the
 * sole ownership authority — Plugin Inventory and unrelated Loader rows never
 * create entries — and every mutation (install/enable/disable/uninstall)
 * arrives in the transaction task (Task 8). The manager root is constructed
 * from the profile runtime and Loader facts only, so management-API readiness
 * can never gate the built-in DSH shell (SR-09).
 * @module @deepseek-ai/dsh-page-app-manager
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import type { Loader } from '@deepseek-ai/cordis-plugin-loader'
import { applyEntryPatches } from '@deepseek-ai/cordis-plugin-include'
import {
  canonicalManagedRootHash,
  loadOverlayPatches,
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
import type { PageAppManagerSnapshot, PageAppView } from './types.ts'
import { parsePageAppInstallSource } from './source.ts'
import type { PageAppInstallSource } from './types.ts'

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
  if (facts.loaderRow === undefined || facts.loaderRow.fiberState === undefined) {
    return { health: 'activation-failed', lastError: 'the managed root is not mounted with an active fiber in the runtime tree' }
  }
  if (!facts.loaderRow.hashMatches) {
    return { health: 'externally-overridden', lastError: 'a user patch configures, disables, or replaces the managed root' }
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
 * Build the Host page-app manager service.
 * @param ctx - plugin context with the Loader available.
 * @param options - the launcher-provided profile runtime (identity source).
 */
export class PageAppManager extends Service {
  private readonly profileRuntime: ProfileRuntime

  constructor(ctx: Context, options: { profileRuntime: ProfileRuntime }) {
    super(ctx, 'pageAppManager')
    this.profileRuntime = options.profileRuntime
  }

  /** The immutable active-profile identity (consumers cannot replace it). */
  public get identity(): { name: string; directory: string } {
    return this.profileRuntime.identity
  }

  /**
   * The full read-only projection of the managed set. The registry is the
   * ownership authority; health is derived from current dependency, version,
   * and runtime facts. Plugin Inventory and unrelated Loader rows never create
   * entries.
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
  private viewOf(row: PageAppRegistryEntry, loader: Loader | undefined): PageAppView {
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
  private factsOf(row: PageAppRegistryEntry, packageDir: string, loader: Loader | undefined): RowRuntimeFacts {
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
        expectedRootHash: undefined,
        loaderRow: undefined,
      }
    }
    let manifestValid = true
    try {
      parsePageAppManifest(row.packageName, installedPkg)
    } catch {
      manifestValid = false
    }
    let bundleValid = true
    let expectedRootHash: string | undefined
    const patch = installedPkg.dsh?.bundle?.patch
    try {
      if (typeof patch !== 'string' || patch === '') throw new Error('no bundle patch')
      const patches = loadOverlayPatches('page-app', join(packageDir, patch))
      const rows = applyEntryPatches([], structuredClone(patches), () => {})
      const rootRow = rows.find(candidate => candidate.id === row.page.rootEntryId)
      if (rootRow === undefined) throw new Error('root row missing')
      expectedRootHash = canonicalManagedRootHash(rootRow)
    } catch {
      bundleValid = false
    }
    let loaderRow: RowRuntimeFacts['loaderRow']
    if (loader === undefined || expectedRootHash === undefined) {
      loaderRow = undefined
    } else {
      const found = [...loader.entries()].find(candidate => candidate.options.id === row.page.rootEntryId)
      loaderRow = found === undefined
        ? undefined
        : {
          fiberState: found.fiber?.state,
          hashMatches: canonicalManagedRootHash(found.options) === expectedRootHash,
        }
    }
    return { installedVersion, manifestValid, bundleValid, expectedRootHash, loaderRow }
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
