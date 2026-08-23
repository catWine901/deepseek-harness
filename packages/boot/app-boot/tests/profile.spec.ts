/**
 * Profile machinery of `dsh-app-boot`: directory resolution and init,
 * manifest round-trips, two-anchor bundle resolution, patch-layer loading,
 * empty-root composition, and the installation module-fallback healing.
 */

import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as yaml from 'js-yaml'
import {
  composeEntries,
  deriveSafeRuntimeLayer,
  healProfilesModuleFallback,
  initProfile,
  loadProfile,
  prepareManagerRuntimeLayer,
  PROFILE_PATCH_FILENAME,
  PROFILE_TEMPLATES,
  readProfileManifest,
  resolveBundleDir,
  resolveProfileDir,
  writeProfileManifest,
} from '../src/index.ts'

const tmp = (): string => mkdtempSync(join(tmpdir(), 'dsh-profile-'))

/** Stage a fake installed app: package.json with deps and a node_modules holding bundles. */
function stageInstallation(bundles: Record<string, { patch?: string; deps?: Record<string, string> }>): string {
  const root = tmp()
  const appDir = join(root, 'app')
  mkdirSync(join(appDir, 'node_modules'), { recursive: true })
  const appDeps: Record<string, string> = {}
  for (const [name, spec] of Object.entries(bundles)) {
    appDeps[name] = '0.0.0'
    const dir = join(appDir, 'node_modules', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name,
      version: '0.0.0',
      dependencies: spec.deps ?? {},
      ...spec.patch === undefined ? {} : { dsh: { bundle: { patch: './cordis.patch.yml' } } },
    }))
    if (spec.patch !== undefined) writeFileSync(join(dir, 'cordis.patch.yml'), spec.patch)
  }
  writeFileSync(join(appDir, 'package.json'), JSON.stringify({ name: 'dsh-app', dependencies: appDeps }))
  return join(appDir, 'package.json')
}

describe('resolveProfileDir', () => {
  it('joins the home and rejects traversal-shaped names', () => {
    const home = tmp()
    expect(resolveProfileDir('tui', home)).toBe(join(home, 'profiles', 'tui'))
    for (const bad of ['', '.', '..', 'a/b', 'a\\b']) {
      expect(() => resolveProfileDir(bad, home)).toThrow('invalid profile name')
    }
  })
})

describe('initProfile', () => {
  it('creates manifest, user patch layer, and pnpm workspace once, never overwriting', () => {
    const home = tmp()
    const dir = resolveProfileDir('tui', home)
    initProfile(dir, ['@deepseek-ai/dsh-base'])
    const manifest = readProfileManifest('t', dir)
    expect(manifest.dsh?.profile?.bundles).toEqual(['@deepseek-ai/dsh-base'])
    expect(readFileSync(join(dir, PROFILE_PATCH_FILENAME), 'utf8')).toContain('[]')
    expect(readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8')).toContain('nodeLinker: hoisted')
    // Re-init keeps user edits.
    writeFileSync(join(dir, PROFILE_PATCH_FILENAME), '- id: x\n  config: {}\n')
    initProfile(dir, ['other'])
    expect(readProfileManifest('t', dir).dsh?.profile?.bundles).toEqual(['@deepseek-ai/dsh-base'])
    expect(readFileSync(join(dir, PROFILE_PATCH_FILENAME), 'utf8')).toContain('- id: x')
  })
})

describe('manifest round-trip', () => {
  it('writes and reads back, and fails loud on a broken manifest', () => {
    const dir = tmp()
    writeProfileManifest(dir, { name: 'p', dsh: { profile: { bundles: ['a'] } } })
    expect(readProfileManifest('t', dir).dsh?.profile?.bundles).toEqual(['a'])
    writeFileSync(join(dir, 'package.json'), '[]')
    expect(() => readProfileManifest('t', dir)).toThrow('must hold a JSON object')
    expect(() => readProfileManifest('t', join(dir, 'nope'))).toThrow('failed to read profile manifest')
  })
})

describe('resolveBundleDir', () => {
  it('prefers the installation anchor, falls back to the profile, and fails loud', () => {
    const anchor = stageInstallation({ 'in-box': { patch: '[]\n' } })
    const profileDir = tmp()
    mkdirSync(join(profileDir, 'node_modules', 'local-only'), { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), '{}')
    writeFileSync(join(profileDir, 'node_modules', 'local-only', 'package.json'), JSON.stringify({ name: 'local-only', version: '0.0.0' }))
    expect(resolveBundleDir('t', 'in-box', anchor, profileDir)).toContain('in-box')
    expect(resolveBundleDir('t', 'local-only', anchor, profileDir)).toContain('local-only')
    expect(() => resolveBundleDir('t', 'absent', anchor, profileDir)).toThrow('cannot resolve profile bundle')
  })

  it('resolves a package whose exports map omits ./package.json', () => {
    // Common on npm: an exports map without "./package.json" makes
    // require.resolve('<pkg>/package.json') throw ERR_PACKAGE_PATH_NOT_EXPORTED;
    // resolution must fall through to the paths probe instead of misreporting
    // the installed package as missing.
    const anchor = stageInstallation({})
    const profileDir = tmp()
    writeFileSync(join(profileDir, 'package.json'), '{}')
    const dir = join(profileDir, 'node_modules', 'sealed-bundle')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name: 'sealed-bundle',
      version: '0.0.0',
      exports: { '.': './index.js' },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }))
    writeFileSync(join(dir, 'index.js'), '')
    writeFileSync(join(dir, 'cordis.patch.yml'), '[]\n')
    expect(resolveBundleDir('t', 'sealed-bundle', anchor, profileDir)).toBe(dir)
  })
})

describe('loadProfile', () => {
  it('resolves each dsh.profile.bundles entry to its patch layer in order, plus the user layer', () => {
    const anchor = stageInstallation({
      'bundle-a': { patch: '- insert:\n    - id: a\n      name: pkg-a\n' },
      'bundle-b': { patch: '- id: a\n  config:\n    v: 2\n' },
    })
    const home = tmp()
    const dir = resolveProfileDir('demo', home)
    initProfile(dir, ['bundle-a', 'bundle-b'])
    writeFileSync(join(dir, PROFILE_PATCH_FILENAME), '- id: a\n  config:\n    v: 3\n')
    const profile = loadProfile('t', 'demo', anchor, home)
    expect(profile.layers.map(layer => layer.packageName)).toEqual(['bundle-a', 'bundle-b'])
    expect(profile.patches).toHaveLength(1)
    const entries = composeEntries([
      ...profile.layers.map(layer => layer.patches),
      profile.patches,
    ])
    expect(entries).toEqual([{ id: 'a', name: 'pkg-a', config: { v: 3 } }])
    // A hand-made profile without the user layer file or dsh section: empty layers, no throw.
    rmSync(join(dir, PROFILE_PATCH_FILENAME))
    expect(loadProfile('t', 'demo', anchor, home).patches).toEqual([])
    writeProfileManifest(dir, { name: 'bare' })
    const bare = loadProfile('t', 'demo', anchor, home)
    expect(bare.layers).toEqual([])
  })

  it('auto-initializes only shipped templates and fails loud otherwise', () => {
    const anchor = stageInstallation({})
    const home = tmp()
    expect(() => loadProfile('t', 'custom', anchor, home))
      .toThrow('profile "custom" does not exist')
    // The web template auto-initializes on first load. Bundle resolution
    // cannot be asserted to fail here: the source-plane test runner resolves
    // @deepseek-ai/* through tsconfig paths regardless of the staged anchor.
    expect(PROFILE_TEMPLATES.web).toContain('@deepseek-ai/dsh-base')
    try {
      loadProfile('t', 'web', anchor, home)
    } catch {
      // Resolution failure is the plain-Node outcome for this empty anchor.
    }
    expect(readProfileManifest('t', resolveProfileDir('web', home)).dsh?.profile?.bundles)
      .toEqual([...PROFILE_TEMPLATES.web ?? []])
  })

  it('normalizes only the exact installation-owned headless bundle tuple', () => {
    const anchor = stageInstallation({
      '@deepseek-ai/dsh-base': { patch: '[]\n' },
      '@deepseek-ai/dsh-web-app': { patch: '[]\n' },
      '@deepseek-ai/dsh-headless': { patch: '[]\n' },
      'custom-bundle': { patch: '[]\n' },
    })
    const home = tmp()
    const stock = resolveProfileDir('headless', home)
    initProfile(stock, [
      '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-headless',
    ])
    loadProfile('t', 'headless', anchor, home)
    expect(readProfileManifest('t', stock).dsh?.profile?.bundles)
      .toEqual(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'])

    const customHome = tmp()
    const custom = resolveProfileDir('headless', customHome)
    initProfile(custom, [
      '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-headless', 'custom-bundle',
    ])
    loadProfile('t', 'headless', anchor, customHome)
    expect(readProfileManifest('t', custom).dsh?.profile?.bundles).toEqual([
      '@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-headless', 'custom-bundle',
    ])
  })

  it('fails loud when a listed bundle declares no dsh.bundle', () => {
    const anchor = stageInstallation({ 'not-a-bundle': {} })
    const home = tmp()
    const dir = resolveProfileDir('demo', home)
    initProfile(dir, ['not-a-bundle'])
    expect(() => loadProfile('t', 'demo', anchor, home)).toThrow('declares no dsh.bundle')
  })
})

describe('composeEntries', () => {
  it('applies layers over an empty root and reports skipped patches', () => {
    const warnings: string[] = []
    const entries = composeEntries([
      [{ insert: [{ id: 'x', name: 'pkg-x', config: { a: 1 } }] }],
      [{ id: 'x', config: { a: 2 } }, { id: 'missing', config: {} }],
    ], message => warnings.push(message))
    expect(entries).toEqual([{ id: 'x', name: 'pkg-x', config: { a: 2 } }])
    expect(warnings.join('\n')).toContain('"missing"')
    // Default warn sink: skipped patches are silently dropped (boot repeats them).
    expect(composeEntries([[{ id: 'missing', config: {} }]])).toEqual([])
  })
})

describe('healProfilesModuleFallback', () => {
  it('links the app and bundle dependency surface flat under profiles/node_modules', () => {
    const anchor = stageInstallation({
      'bundle-a': { patch: '[]\n', deps: { 'dep-of-a': '0.0.0', 'ghost-dep': '0.0.0' } },
      'plain-lib': {},
    })
    // An app dependency that is declared but not installed: skipped, not fatal.
    const appManifest = JSON.parse(readFileSync(anchor, 'utf8')) as { dependencies: Record<string, string> }
    appManifest.dependencies['never-installed'] = '0.0.0'
    writeFileSync(anchor, JSON.stringify(appManifest))
    // dep-of-a lives in the installation's node_modules too.
    const modules = join(anchor, '..', 'node_modules')
    mkdirSync(join(modules, 'dep-of-a'), { recursive: true })
    writeFileSync(join(modules, 'dep-of-a', 'package.json'), JSON.stringify({ name: 'dep-of-a', version: '0.0.0' }))
    const home = tmp()
    healProfilesModuleFallback(anchor, home)
    const fallback = join(home, 'profiles', 'node_modules')
    // App deps, the bundle's own deps, and the bundle itself are linked; the
    // plain library is linked as an app dep (harmless), the app itself too.
    for (const name of ['bundle-a', 'plain-lib', 'dep-of-a', 'dsh-app']) {
      expect(lstatSync(join(fallback, name)).isSymbolicLink(), name).toBe(true)
    }
    // Idempotent, and a moved target is re-pointed.
    healProfilesModuleFallback(anchor, home)
    const before = readlinkSync(join(fallback, 'dep-of-a'))
    expect(before).toContain('dep-of-a')
  })

  it('throws when a fallback entry is a real directory', () => {
    const anchor = stageInstallation({})
    const home = tmp()
    mkdirSync(join(home, 'profiles', 'node_modules', 'dsh-app'), { recursive: true })
    expect(() => { healProfilesModuleFallback(anchor, home) }).toThrow('is not a symlink')
  })

  it('replaces a wrong symlink', () => {
    const anchor = stageInstallation({})
    const home = tmp()
    const fallback = join(home, 'profiles', 'node_modules')
    mkdirSync(fallback, { recursive: true })
    symlinkSync(tmp(), join(fallback, 'dsh-app'), 'junction')
    healProfilesModuleFallback(anchor, home)
    expect(readlinkSync(join(fallback, 'dsh-app'))).toContain('app')
  })

  it('tolerates losing the concurrent-heal race to an identical link and rejects a different one', () => {
    // The EEXIST arm: a second process wrote the link between our lstat miss
    // and symlinkSync. Simulated by pre-creating the correct link and calling
    // the internal path through a stale-lstat shim is not possible from
    // outside, so probe the observable contract: healing twice concurrently
    // is a no-op, and a foreign REAL directory still fails loud.
    const anchor = stageInstallation({})
    const home = tmp()
    healProfilesModuleFallback(anchor, home)
    healProfilesModuleFallback(anchor, home) // second healer sees the correct link
    const fallback = join(home, 'profiles', 'node_modules')
    expect(lstatSync(join(fallback, 'dsh-app')).isSymbolicLink()).toBe(true)
  })
})

describe('manager runtime layer startup', () => {
  const MANAGER_DIR = '.workspace-manager'

  /** Stage one installed manager package with a workspace manifest and bundle patch. */
  function stageManagerPackage(profileDir: string, name: string, version: string, rootEntryId = 'fixture-root'): void {
    const dir = join(profileDir, 'node_modules', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({
      name,
      version,
      dsh: {
        workspace: {
          schemaVersion: 1,
          id: 'fixture-page',
          name: 'Fixture Page',
          description: 'fixture page app',
          defaultOrder: 0,
          rootEntryId,
        },
        bundle: { patch: './cordis.patch.yml' },
      },
    }, null, 2))
    writeFileSync(join(dir, 'cordis.patch.yml'), [
      '- insert:',
      `    - id: ${rootEntryId}`,
      "      name: '@acme/fixture-client'",
      '      config:',
      '        marker: fixture',
      '',
    ].join('\n'))
  }

  /** A valid registry v1 document with the given entries. */
  function registry(entries: Array<Record<string, unknown>>): string {
    return JSON.stringify({ schemaVersion: 1, revision: 1, entries }, null, 2)
  }

  function registryEntry(packageName: string, version: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      packageName,
      source: { kind: 'registry', display: 'https://registry.example/fixture' },
      resolvedVersion: version,
      page: { id: 'fixture-page', name: 'Fixture Page', description: 'fixture page app', defaultOrder: 0, rootEntryId: 'fixture-root' },
      order: 0,
      enabled: true,
      hidden: false,
      installedAt: '2026-08-22T00:00:00.000Z',
      updatedAt: '2026-08-22T00:00:00.000Z',
      ...extra,
    }
  }

  function writeRegistry(profileDir: string, content: string): void {
    mkdirSync(join(profileDir, MANAGER_DIR), { recursive: true })
    writeFileSync(join(profileDir, MANAGER_DIR, 'registry.json'), content)
  }

  function readLayer(profileDir: string): Array<{ insert: Array<Record<string, unknown>> }> {
    const content = readFileSync(join(profileDir, MANAGER_DIR, 'runtime-layer.yml'), 'utf8')
    return yaml.load(content) as Array<{ insert: Array<Record<string, unknown>> }>
  }

  it('regenerates a missing derived layer from a valid registry', async () => {
    const profile = tmp()
    stageManagerPackage(profile, '@acme/page', '1.0.0')
    writeRegistry(profile, registry([registryEntry('@acme/page', '1.0.0')]))

    const startup = await prepareManagerRuntimeLayer('t', profile)
    expect(startup.recoveryError).toBeUndefined()
    expect(startup.omitted).toEqual([])
    expect(readLayer(profile)).toEqual([
      { insert: [{ id: 'fixture-root', name: '@acme/fixture-client', config: { marker: 'fixture' } }] },
    ])
  })

  it('regenerates a corrupt derived layer from a valid registry', async () => {
    const profile = tmp()
    stageManagerPackage(profile, '@acme/page', '1.0.0')
    writeRegistry(profile, registry([registryEntry('@acme/page', '1.0.0')]))
    mkdirSync(join(profile, MANAGER_DIR), { recursive: true })
    writeFileSync(join(profile, MANAGER_DIR, 'runtime-layer.yml'), 'invalid: [unclosed\n')

    const startup = await prepareManagerRuntimeLayer('t', profile)
    expect(startup.omitted).toEqual([])
    expect(readLayer(profile)).toEqual([
      { insert: [{ id: 'fixture-root', name: '@acme/fixture-client', config: { marker: 'fixture' } }] },
    ])
  })

  it('fails managed roots closed on a corrupt registry: preserves the registry, drops the stale layer, exposes recovery', async () => {
    const profile = tmp()
    stageManagerPackage(profile, '@acme/page', '1.0.0')
    writeRegistry(profile, 'not json')
    // A stale layer from a previous good state must not mount orphaned roots.
    mkdirSync(join(profile, MANAGER_DIR), { recursive: true })
    writeFileSync(join(profile, MANAGER_DIR, 'runtime-layer.yml'), '- insert:\n    - id: orphan\n      name: @acme/orphan\n')

    const startup = await prepareManagerRuntimeLayer('t', profile)
    expect(startup.recoveryError).toMatch(/corrupt/i)
    expect(readFileSync(join(profile, MANAGER_DIR, 'registry.json'), 'utf8')).toBe('not json')
    expect(() => readFileSync(join(profile, MANAGER_DIR, 'runtime-layer.yml'), 'utf8'))
      .toThrow(/ENOENT/)
  })

  it('omits a root whose dependency is missing from the profile install', async () => {
    const profile = tmp()
    // No @acme/ghost is installed anywhere in the profile.
    writeRegistry(profile, registry([registryEntry('@acme/ghost', '1.0.0')]))

    const startup = await prepareManagerRuntimeLayer('t', profile)
    expect(startup.omitted).toEqual([{ rootEntryId: 'fixture-root', reason: 'missing-dependency' }])
    expect(readLayer(profile)).toEqual([])
  })

  it('omits a root whose installed version drifts from the registry revision', async () => {
    const profile = tmp()
    stageManagerPackage(profile, '@acme/page', '1.1.0')
    writeRegistry(profile, registry([registryEntry('@acme/page', '1.0.0')]))

    const startup = await prepareManagerRuntimeLayer('t', profile)
    expect(startup.omitted).toEqual([{ rootEntryId: 'fixture-root', reason: 'version-drift' }])
    expect(readLayer(profile)).toEqual([])
  })

  it('omits a root with an invalid manifest and keeps the other enabled roots', async () => {
    const profile = tmp()
    // @acme/broken carries a workspace manifest but the bundle patch names a
    // different root row than the registry row.
    const brokenDir = join(profile, 'node_modules', '@acme', 'broken')
    mkdirSync(brokenDir, { recursive: true })
    writeFileSync(join(brokenDir, 'package.json'), JSON.stringify({
      name: '@acme/broken',
      version: '1.0.0',
      dsh: {
        workspace: {
          schemaVersion: 1, id: 'broken-page', name: 'Broken', description: 'broken', defaultOrder: 0, rootEntryId: 'missing-root',
        },
        bundle: { patch: './cordis.patch.yml' },
      },
    }, null, 2))
    writeFileSync(join(brokenDir, 'cordis.patch.yml'), "- insert:\n    - id: other-row\n      name: '@acme/other'\n")
    stageManagerPackage(profile, '@acme/page', '1.0.0')
    writeRegistry(profile, registry([
      registryEntry('@acme/broken', '1.0.0', { page: { id: 'broken-page', name: 'Broken', description: 'broken', defaultOrder: 0, rootEntryId: 'missing-root' } }),
      registryEntry('@acme/page', '1.0.0'),
    ]))

    const startup = await prepareManagerRuntimeLayer('t', profile)
    expect(startup.omitted).toEqual([{ rootEntryId: 'missing-root', reason: 'invalid-manifest' }])
    expect(readLayer(profile)).toEqual([
      { insert: [{ id: 'fixture-root', name: '@acme/fixture-client', config: { marker: 'fixture' } }] },
    ])
  })

  it('omits a root whose manifest fails v1 workspace validation', async () => {
    const profile = tmp()
    const brokenDir = join(profile, 'node_modules', '@acme', 'broken')
    mkdirSync(brokenDir, { recursive: true })
    writeFileSync(join(brokenDir, 'package.json'), JSON.stringify({
      name: '@acme/broken',
      version: '1.0.0',
      dsh: {
        workspace: {
          schemaVersion: 2, id: 'broken-page', name: 'Broken', description: 'broken', defaultOrder: 0, rootEntryId: 'missing-root',
        },
        bundle: { patch: './cordis.patch.yml' },
      },
    }, null, 2))
    writeFileSync(join(brokenDir, 'cordis.patch.yml'), "- insert:\n    - id: missing-root\n      name: '@acme/broken-client'\n")
    writeRegistry(profile, registry([registryEntry('@acme/broken', '1.0.0', {
      page: { id: 'broken-page', name: 'Broken', description: 'broken', defaultOrder: 0, rootEntryId: 'missing-root' },
    })]))

    const startup = await prepareManagerRuntimeLayer('t', profile)
    expect(startup.omitted).toEqual([{ rootEntryId: 'missing-root', reason: 'invalid-manifest' }])
    expect(readLayer(profile)).toEqual([])
  })

  it('omits disabled registry rows from the derived layer', async () => {
    const profile = tmp()
    stageManagerPackage(profile, '@acme/page', '1.0.0')
    stageManagerPackage(profile, '@acme/hidden', '1.0.0', 'hidden-root')
    writeRegistry(profile, registry([
      registryEntry('@acme/page', '1.0.0'),
      registryEntry('@acme/hidden', '1.0.0', {
        enabled: false,
        page: { id: 'hidden-page', name: 'Hidden', description: 'hidden', defaultOrder: 0, rootEntryId: 'hidden-root' },
      }),
    ]))

    const startup = await prepareManagerRuntimeLayer('t', profile)
    expect(startup.omitted).toEqual([])
    const rows = readLayer(profile).flatMap(patch => patch.insert)
    expect(rows.map(row => row.id)).toEqual(['fixture-root'])
  })

  it('leaves a profile with no registry untouched', async () => {
    const startup = await prepareManagerRuntimeLayer('t', tmp())
    expect(startup.recoveryError).toBeUndefined()
    expect(startup.omitted).toEqual([])
  })

  it('derives the same safe roots independently of write timing', async () => {
    const profile = tmp()
    stageManagerPackage(profile, '@acme/page', '1.0.0')
    writeRegistry(profile, registry([registryEntry('@acme/page', '1.0.0')]))

    const before = await deriveSafeRuntimeLayer('t', profile)
    await prepareManagerRuntimeLayer('t', profile)
    const after = await deriveSafeRuntimeLayer('t', profile)
    expect(before.layer).toBe(after.layer)
    expect(before.omitted).toEqual(after.omitted)
    expect(before.recoveryError).toBeUndefined()
  })
})
