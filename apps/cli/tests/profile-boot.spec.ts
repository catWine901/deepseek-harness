/**
 * Launcher profile boot of `apps/cli`: the manager runtime layer interleaved
 * between bundle and user layers, the startup regeneration, and the
 * launcher-provided profile runtime over a real booted tree.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { composeEntries, initProfile, prepareManagerRuntimeLayer, PROFILE_PATCH_FILENAME } from '@deepseek-ai/dsh-app-boot'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { bootComposedProfile, composeLivePatches, composeProfile } from '../src/profile-boot.ts'

const NAME = 'dsh'
const tmp = (): string => mkdtempSync(join(tmpdir(), 'dsh-profile-boot-'))

/** Stage one profile-local bundle package whose patch the launcher resolves from the profile anchor. */
function stageProfileBundle(profileDir: string, name: string, patch: string): void {
  const dir = join(profileDir, 'node_modules', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name,
    version: '0.0.0',
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }))
  writeFileSync(join(dir, 'cordis.patch.yml'), patch)
}

describe('launcher layer order', () => {
  it('composes bundles → manager layer → profile → home → overlays through the launcher', () => {
    const home = tmp()
    vi.stubEnv('DSH_HOME', home)
    try {
      const profileDir = join(home, 'profiles', 'demo')
      initProfile(profileDir, ['fixture-bundle-a'])
      stageProfileBundle(profileDir, 'fixture-bundle-a', "- insert:\n    - id: shared\n      name: '@acme/a'\n      config:\n        value: bundle-a\n")
      writeFileSync(join(profileDir, PROFILE_PATCH_FILENAME), '- id: shared\n  config:\n    value: profile\n')
      writeFileSync(join(home, PROFILE_PATCH_FILENAME), '- id: shared\n  config:\n    value: home\n')
      mkdirSync(join(profileDir, '.workspace-manager'), { recursive: true })
      writeFileSync(join(profileDir, '.workspace-manager', 'runtime-layer.yml'), [
        '- insert:',
        '    - id: managed',
        "      name: '@acme/m'",
        '      config:',
        '        value: manager',
        '- id: shared',
        '  config:',
        '    value: manager-layer',
        '',
      ].join('\n'))
      const overlayPath = join(tmp(), 'overlay.yml')
      writeFileSync(overlayPath, '- id: shared\n  config:\n    value: overlay\n')

      const composed = composeProfile('demo', [overlayPath])
      const generation = composeLivePatches(composed)
      expect(composeEntries([generation])).toEqual([
        { id: 'shared', name: '@acme/a', config: { value: 'overlay' } },
        { id: 'managed', name: '@acme/m', config: { value: 'manager' } },
      ])
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe('launcher startup with a corrupt registry', () => {
  it('boots base rows with no managed roots and exposes the recovery error', async () => {
    const home = tmp()
    vi.stubEnv('DSH_HOME', home)
    try {
      const profileDir = join(home, 'profiles', 'demo')
      initProfile(profileDir, ['fixture-bundle-a'])
      stageProfileBundle(profileDir, 'fixture-bundle-a', '- insert:\n    - id: base\n      name: ./noop.mjs\n')
      writeFileSync(join(profileDir, 'noop.mjs'), 'export const name = "noop"\nexport function apply() {}\n')
      mkdirSync(join(profileDir, '.workspace-manager'), { recursive: true })
      writeFileSync(join(profileDir, '.workspace-manager', 'registry.json'), 'not json')
      // A stale layer from a previous good state must not mount orphaned roots.
      writeFileSync(join(profileDir, '.workspace-manager', 'runtime-layer.yml'), '- insert:\n    - id: orphan\n      name: ./noop.mjs\n')

      const composed = composeProfile('demo', [])
      const managerLayer = await prepareManagerRuntimeLayer(NAME, profileDir)
      expect(managerLayer.recoveryError).toMatch(/corrupt/i)

      const { ctx, runtime } = await bootComposedProfile(
        composed,
        managerLayer,
        createLaunchEnvironmentSnapshot([]),
        [],
        () => {},
        () => {},
      )
      try {
        expect(runtime?.recoveryError).toMatch(/corrupt/i)
        expect(runtime?.omittedRoots).toEqual([])
        // Base rows booted; the orphaned manager root did not mount.
        expect([...ctx.loader.entries()].some(entry => entry.options.id === 'base')).toBe(true)
        expect([...ctx.loader.entries()].some(entry => entry.options.id === 'orphan')).toBe(false)
        // The stale derived layer was dropped so no next boot can mount it.
        await expect(stat(join(profileDir, '.workspace-manager', 'runtime-layer.yml')))
          .rejects.toMatchObject({ code: 'ENOENT' })
      } finally {
        await ctx.fiber.dispose()
      }
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe('launcher startup with a valid registry', () => {
  it('regenerates the derived layer and mounts the managed root in the booted tree', async () => {
    const home = tmp()
    vi.stubEnv('DSH_HOME', home)
    try {
      const profileDir = join(home, 'profiles', 'demo')
      initProfile(profileDir, ['fixture-bundle-a'])
      stageProfileBundle(profileDir, 'fixture-bundle-a', '- insert:\n    - id: base\n      name: ./noop.mjs\n')
      writeFileSync(join(profileDir, 'noop.mjs'), 'export const name = "noop"\nexport function apply() {}\n')

      // The manager package the registry row names, and the client plugin the
      // derived root row mounts.
      const managerDir = join(profileDir, 'node_modules', '@acme', 'page')
      mkdirSync(managerDir, { recursive: true })
      writeFileSync(join(managerDir, 'package.json'), JSON.stringify({
        name: '@acme/page',
        version: '1.0.0',
        dsh: {
          workspace: {
            schemaVersion: 1, id: 'fixture-page', name: 'Fixture Page', description: 'fixture page app', defaultOrder: 0, rootEntryId: 'fixture-root',
          },
          bundle: { patch: './cordis.patch.yml' },
        },
      }, null, 2))
      writeFileSync(join(managerDir, 'cordis.patch.yml'), [
        '- insert:',
        '    - id: fixture-root',
        "      name: '@acme/fixture-client'",
        '      config:',
        '        marker: fixture',
        '',
      ].join('\n'))
      const clientDir = join(profileDir, 'node_modules', '@acme', 'fixture-client')
      mkdirSync(clientDir, { recursive: true })
      writeFileSync(join(clientDir, 'package.json'), JSON.stringify({
        name: '@acme/fixture-client', version: '1.0.0', type: 'module', main: './index.mjs',
      }))
      writeFileSync(join(clientDir, 'index.mjs'), 'export const name = "fixture-client"\nexport function apply() {}\n')

      mkdirSync(join(profileDir, '.workspace-manager'), { recursive: true })
      writeFileSync(join(profileDir, '.workspace-manager', 'registry.json'), JSON.stringify({
        schemaVersion: 1,
        revision: 1,
        entries: [{
          packageName: '@acme/page',
          source: { kind: 'registry', display: 'https://registry.example/fixture' },
          resolvedVersion: '1.0.0',
          page: { id: 'fixture-page', name: 'Fixture Page', description: 'fixture page app', defaultOrder: 0, rootEntryId: 'fixture-root' },
          order: 0,
          enabled: true,
          hidden: false,
          installedAt: '2026-08-22T00:00:00.000Z',
          updatedAt: '2026-08-22T00:00:00.000Z',
        }],
      }, null, 2))

      const composed = composeProfile('demo', [])
      const managerLayer = await prepareManagerRuntimeLayer(NAME, profileDir)
      expect(managerLayer.recoveryError).toBeUndefined()
      expect(managerLayer.omitted).toEqual([])

      const { ctx, runtime } = await bootComposedProfile(
        composed,
        managerLayer,
        createLaunchEnvironmentSnapshot([]),
        [],
        () => {},
        () => {},
      )
      try {
        expect(runtime).toBeDefined()
        const base = [...ctx.loader.entries()].find(entry => entry.options.id === 'base')
        const managed = [...ctx.loader.entries()].find(entry => entry.options.id === 'fixture-root')
        expect(base?.fiber).toBeDefined()
        expect(managed?.fiber).toBeDefined()
      } finally {
        await ctx.fiber.dispose()
      }
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
