/**
 * Static Workspace Plugin Contract validation: every rule in spec §11 has a
 * fixture — package identity, dependency-key equality, in-package patch path,
 * strict manifest fields, one top-level root, matching root id, no ignored
 * patches/warnings, no relative names, uniqueness axes, base-id collision,
 * external-management collision, valid Web artifact, one client row, and
 * external self-reference rejection.
 */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parsePageAppManifest, type PageAppRegistryV1 } from '@deepseek-ai/dsh-page-app-profile'
import { SUPPORTED_CONTRACT_VERSIONS } from '../src/contract.ts'
import { validateInstalledPageAppPackage, type PageAppValidationContext } from '../src/validation.ts'

const PKG = '@fixture/valid-workspace'

interface FixturePackage {
  name: string
  version: string
  patchRows: unknown[]
  clientRowName: string
  rootRowId: string
  rootName?: string
  extra?: Record<string, unknown>
  clientExternal?: string[]
  workspaceSchemaVersion?: unknown
  clientPlatform?: string
  /** node_modules key the package is installed under (alias test). */
  dirKey?: string
}

let dir: string

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'dsh-page-app-validation-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

function writePackage(name: string, options: Partial<FixturePackage> = {}): void {
  const key = options.dirKey ?? name
  const pkgDir = join(dir, 'node_modules', ...key.split('/'))
  mkdirSync(join(pkgDir, 'lib'), { recursive: true })
  const insertRows = options.patchRows ?? [
    { id: options.rootRowId ?? 'workspace.valid', name: options.rootName ?? `${name}/client` },
    { id: 'fixture-client-row', name: options.clientRowName ?? name },
  ]
  // A managed bundle composes over an EMPTY root, so its rows must arrive as
  // one top-level `insert` patch (a flat row would be a config patch targeting
  // a missing entry and warn — the exact rule the validation enforces).
  writeFileSync(join(pkgDir, 'cordis.patch.yml'), JSON.stringify([{ insert: insertRows }]))
  writeFileSync(join(pkgDir, 'lib', 'client.js'), 'module.exports = {}\n')
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
    name,
    version: options.version ?? '1.0.0',
    exports: { './client': './lib/client.js', './package.json': './package.json' },
    dsh: {
      bundle: { patch: './cordis.patch.yml' },
      workspace: {
        schemaVersion: options.workspaceSchemaVersion ?? 1,
        id: options.rootRowId ?? 'workspace.valid',
        name: 'Fixture Valid',
        description: 'A valid fixture',
        defaultOrder: 100,
        rootEntryId: options.rootRowId ?? 'workspace.valid',
      },
      client: {
        platform: options.clientPlatform ?? 'web',
        ...options.clientExternal === undefined ? {} : { external: options.clientExternal },
      },
    },
    ...options.extra,
  }))
}

function writeProfileManifest(): void {
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture-profile', private: true }))
}

function context(overrides: Partial<PageAppValidationContext> = {}): PageAppValidationContext {
  return {
    profileDir: dir,
    registry: null,
    baseRootIds: [],
    profileDependencies: { [PKG]: '1.0.0' },
    profileBundles: [],
    ...overrides,
  }
}

const registryWith = (entry: Record<string, unknown>): PageAppRegistryV1 => ({
  schemaVersion: 1,
  revision: 1,
  entries: [{
    packageName: PKG,
    source: { kind: 'registry', display: PKG },
    resolvedVersion: '1.0.0',
    page: {
      id: 'workspace.valid',
      name: 'Fixture Valid',
      description: 'A valid fixture',
      defaultOrder: 100,
      rootEntryId: 'workspace.valid',
    },
    order: 100,
    enabled: true,
    hidden: false,
    installedAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    ...entry,
  }],
})

describe('static validation', () => {
  it('accepts a fully valid workspace package', () => {
    writeProfileManifest()
    writePackage(PKG)
    const record = validateInstalledPageAppPackage(dir, PKG, context())
    expect(record.packageName).toBe(PKG)
    expect(record.version).toBe('1.0.0')
    expect(record.rootEntryId).toBe('workspace.valid')
    expect(record.clientRowCount).toBe(1)
  })

  it('rejects a package declaring a direct cordis dependency', () => {
    writeProfileManifest()
    writePackage(PKG, { extra: { dependencies: { cordis: '^4.0.1' } } })
    expect(() => validateInstalledPageAppPackage(dir, PKG, context()))
      .toThrow(/declares a direct cordis dependency/)
  })

  it('rejects a package declaring a direct @deepseek-ai/cordis dependency', () => {
    writeProfileManifest()
    writePackage(PKG, { extra: { dependencies: { '@deepseek-ai/cordis': '^4.0.1' } } })
    expect(() => validateInstalledPageAppPackage(dir, PKG, context()))
      .toThrow(/declares a direct @deepseek-ai\/cordis dependency/)
  })

  it('rejects a package declaring a direct cordis devDependency', () => {
    writeProfileManifest()
    writePackage(PKG, { extra: { devDependencies: { cordis: '^4.0.1' } } })
    expect(() => validateInstalledPageAppPackage(dir, PKG, context()))
      .toThrow(/declares a direct cordis dependency \(devDependencies\)/)
  })

  it('rejects a package declaring a direct @deepseek-ai/cordis peerDependency', () => {
    writeProfileManifest()
    writePackage(PKG, { extra: { peerDependencies: { '@deepseek-ai/cordis': '^4.0.1' } } })
    expect(() => validateInstalledPageAppPackage(dir, PKG, context()))
      .toThrow(/declares a direct @deepseek-ai\/cordis dependency \(peerDependencies\)/)
  })

  it('rejects a package declaring a direct cordis optionalDependency', () => {
    writeProfileManifest()
    writePackage(PKG, { extra: { optionalDependencies: { cordis: '^4.0.1' } } })
    expect(() => validateInstalledPageAppPackage(dir, PKG, context()))
      .toThrow(/declares a direct cordis dependency \(optionalDependencies\)/)
  })

  it('accepts a package whose dependencies are cordis-free', () => {
    writeProfileManifest()
    writePackage(PKG, { extra: { dependencies: { 'some-lib': '^1.0.0' } } })
    const record = validateInstalledPageAppPackage(dir, PKG, context())
    expect(record.packageName).toBe(PKG)
  })

  it('rejects a package whose dependencies field is not a record', () => {
    writeProfileManifest()
    // A string dependencies field is malformed durable data; the boundary must
    // fail loud instead of silently treating it as cordis-free.
    writePackage(PKG, { extra: { dependencies: 'cordis@^4.0.1' } })
    expect(() => validateInstalledPageAppPackage(dir, PKG, context()))
      .toThrow(/dependencies must be a record/)
    // An array form is equally non-record.
    writePackage(PKG, { extra: { dependencies: ['cordis'] } })
    expect(() => validateInstalledPageAppPackage(dir, PKG, context()))
      .toThrow(/dependencies must be a record/)
    // Every dependency section shares the record requirement; the diagnostic
    // names the offending section.
    writePackage(PKG, { extra: { devDependencies: 'cordis@^4.0.1' } })
    expect(() => validateInstalledPageAppPackage(dir, PKG, context()))
      .toThrow(/devDependencies must be a record/)
  })

  it('rejects a missing dependency (no auto-adoption in v1)', () => {
    writeProfileManifest()
    writePackage(PKG)
    expect(() => validateInstalledPageAppPackage(dir, PKG, context({ profileDependencies: {} })))
      .toThrow(/not a direct dependency of the profile/)
  })

  it('rejects a package name that differs from the direct dependency key', () => {
    writeProfileManifest()
    // Installed under the key `@fixture/alias` (what pnpm add foo@npm:bar
    // produces) while the package.json names the real package.
    writePackage('@fixture/real-name', { dirKey: '@fixture/alias' })
    expect(() => validateInstalledPageAppPackage(dir, '@fixture/alias', context({
      profileDependencies: { '@fixture/alias': 'npm:@fixture/real-name@1.0.0' },
    }))).toThrow(/alias installs are rejected/)
  })

  it('rejects a package already installed as an external profile bundle', () => {
    writeProfileManifest()
    writePackage(PKG)
    expect(() => validateInstalledPageAppPackage(dir, PKG, context({ profileBundles: [PKG] })))
      .toThrow(/external profile bundle/)
  })

  it('rejects a missing dsh.bundle.patch', () => {
    writeProfileManifest()
    writePackage(PKG, { extra: { dsh: undefined } })
    expect(() => validateInstalledPageAppPackage(dir, PKG, context())).toThrow(/declares no dsh.bundle.patch/)
  })

  it('rejects a bundle patch that resolves outside the installed package', () => {
    writeProfileManifest()
    const pkgDir = join(dir, 'node_modules', ...PKG.split('/'))
    mkdirSync(join(pkgDir, 'lib'), { recursive: true })
    writeFileSync(join(pkgDir, 'lib', 'client.js'), 'module.exports = {}\n')
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({
      name: PKG,
      version: '1.0.0',
      exports: { './client': './lib/client.js' },
      dsh: { bundle: { patch: '../../escaped.patch.yml' }, workspace: { schemaVersion: 1 } },
    }))
    expect(() => validateInstalledPageAppPackage(dir, PKG, context())).toThrow(/resolves outside the installed package/)
  })

  it('refuses an unsupported contract version through the supportedContractVersions constant', () => {
    writeProfileManifest()
    writePackage(PKG, { workspaceSchemaVersion: 2 })
    expect(() => validateInstalledPageAppPackage(dir, PKG, context()))
      .toThrow(/unsupported contract version 2/)
  })

  it('keeps the manager contract constant compatible with the shared v1 manifest parser', () => {
    writeProfileManifest()
    // Both authorities must admit the same versions: the manager constant and
    // the shared parser's z.literal(1). Every constant member parses through
    // the parser, so the two cannot silently drift apart.
    for (const version of SUPPORTED_CONTRACT_VERSIONS) {
      const pkg = {
        dsh: {
          workspace: {
            schemaVersion: version,
            id: 'workspace.valid',
            name: 'Fixture Valid',
            description: 'A valid fixture',
            defaultOrder: 100,
            rootEntryId: 'workspace.valid',
          },
        },
      }
      expect(() => parsePageAppManifest(PKG, pkg)).not.toThrow()
    }
    // A version the parser rejects is diagnosed by the constant BEFORE the
    // shared parse would report its own shape error: the manager prechecks
    // numeric schema versions so the diagnostic names the unsupported version.
    writePackage(PKG, { workspaceSchemaVersion: 2 })
    let message = ''
    try {
      validateInstalledPageAppPackage(dir, PKG, context())
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toMatch(/unsupported contract version 2/)
    expect(message).not.toMatch(/page-app manifest/)
  })

  it('preserves the manifest shape error when the schema version is not numeric', () => {
    writeProfileManifest()
    writePackage(PKG, { workspaceSchemaVersion: 'two' })
    expect(() => validateInstalledPageAppPackage(dir, PKG, context())).toThrow(/page-app manifest/)
  })

  it('rejects duplicate package, page id, or root id against the registry', () => {
    writeProfileManifest()
    writePackage(PKG)
    expect(() => validateInstalledPageAppPackage(dir, PKG, context({ registry: registryWith({ packageName: PKG }) })))
      .toThrow(/already managed/)
    expect(() => validateInstalledPageAppPackage(dir, PKG, context({ registry: registryWith({ packageName: '@fixture/other' }) })))
      .toThrow(/workspace page id "workspace.valid" is already managed/)
    expect(() => validateInstalledPageAppPackage(dir, PKG, context({
      registry: registryWith({ packageName: '@fixture/other', page: { id: 'other', rootEntryId: 'workspace.valid' } }),
    }))).toThrow(/managed root id "workspace.valid" is already managed/)
  })

  it('rejects a root id that collides with the base composition', () => {
    writeProfileManifest()
    writePackage(PKG)
    expect(() => validateInstalledPageAppPackage(dir, PKG, context({ baseRootIds: ['workspace.valid'] })))
      .toThrow(/collides with the base composition/)
  })

  it('rejects a bundle whose patch targets rows the empty root lacks (ignored patches)', () => {
    writeProfileManifest()
    writePackage(PKG)
    // A flat config patch targeting a row the composed root never inserted:
    // the empty-root composition must report it as an ignored patch.
    const pkgDir = join(dir, 'node_modules', ...PKG.split('/'))
    writeFileSync(join(pkgDir, 'cordis.patch.yml'), JSON.stringify([
      { insert: [{ id: 'workspace.valid', name: `${PKG}/client` }] },
      { id: 'ghost-target', config: { enabled: true } },
    ]))
    expect(() => validateInstalledPageAppPackage(dir, PKG, context())).toThrow(/targets rows the empty root lacks/)
  })

  it('rejects a bundle that composes zero or multiple roots with the manifest root id', () => {
    writeProfileManifest()
    writePackage(PKG, { patchRows: [{ id: 'other-root', name: `${PKG}/client` }] })
    expect(() => validateInstalledPageAppPackage(dir, PKG, context())).toThrow(/exactly one required/)
    writePackage(PKG, { patchRows: [
      { id: 'workspace.valid', name: `${PKG}/client` },
      { id: 'workspace.valid', name: `${PKG}/client-2` },
    ] })
    expect(() => validateInstalledPageAppPackage(dir, PKG, context())).toThrow(/exactly one required/)
  })

  it('rejects a root row with a relative Loader module name', () => {
    writeProfileManifest()
    writePackage(PKG, { patchRows: [{ id: 'workspace.valid', name: './relative-impl' }] })
    expect(() => validateInstalledPageAppPackage(dir, PKG, context())).toThrow(/relative Loader module name/)
  })

  it('rejects a root tree that is not declarative (!!js marker)', () => {
    writeProfileManifest()
    writePackage(PKG, { patchRows: [{ id: 'workspace.valid', name: `${PKG}/client`, config: { marker: '!!js process.env.X' } }] })
    expect(() => validateInstalledPageAppPackage(dir, PKG, context())).toThrow(/not declarative/)
  })

  it('rejects a package without a web client declaration or artifact', () => {
    writeProfileManifest()
    writePackage(PKG, { clientPlatform: 'node' })
    expect(() => validateInstalledPageAppPackage(dir, PKG, context())).toThrow(/platform "web"/)
    writePackage(PKG, { extra: { exports: { './package.json': './package.json' } } })
    expect(() => validateInstalledPageAppPackage(dir, PKG, context())).toThrow(/exports no "\.\/client" bundle/)
  })

  it('rejects a bundle that composes zero or multiple client rows for the package', () => {
    writeProfileManifest()
    writePackage(PKG, { patchRows: [
      { id: 'workspace.valid', name: `${PKG}/client` },
      { id: 'fixture-client-row', name: 'some-other-package' },
    ] })
    expect(() => validateInstalledPageAppPackage(dir, PKG, context())).toThrow(/client row/)
    writePackage(PKG, { patchRows: [
      { id: 'workspace.valid', name: `${PKG}/client` },
      { id: 'fixture-client-row', name: PKG },
      { id: 'fixture-client-row-2', name: PKG },
    ] })
    expect(() => validateInstalledPageAppPackage(dir, PKG, context())).toThrow(/client row/)
  })

  it('rejects a self-referencing dsh.client.external', () => {
    writeProfileManifest()
    writePackage(PKG, { clientExternal: [PKG] })
    expect(() => validateInstalledPageAppPackage(dir, PKG, context())).toThrow(/requests itself in dsh.client.external/)
  })

  it('rejects a non-string external declaration', () => {
    writeProfileManifest()
    writePackage(PKG, { clientExternal: ['react'] })
    const pkgDir = join(dir, 'node_modules', ...PKG.split('/'))
    const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8')) as {
      dsh: { client: { external: unknown } }
    }
    pkg.dsh.client.external = 'react'
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify(pkg))
    expect(() => validateInstalledPageAppPackage(dir, PKG, context())).toThrow(/external must be a string array/)
  })

  it('rejects an uninstalled package', () => {
    writeProfileManifest()
    expect(() => validateInstalledPageAppPackage(dir, '@fixture/never-installed', context()))
      .toThrow(/not installed in the profile/)
  })
})
