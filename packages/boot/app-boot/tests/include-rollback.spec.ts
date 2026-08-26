/**
 * Failed root Include updates retain the previously active tree: the
 * transactional contract the profile runtime layer will rely on before any
 * transaction code is written. A generation whose child apply fails leaves
 * the previous generation's options and effects active, and the next
 * generation still applies.
 */

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Include } from '@deepseek-ai/cordis-plugin-include'
import { boot, loadOptionalPatches, PROFILE_PATCH_FILENAME, ProfileRuntime } from '../src/index.ts'

const NAME = 'dsh-test-bin'

describe('root Include update rollback', () => {
  it('keeps generation A active with its options and effects when generation B fails during child apply', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-include-rollback-'))
    writeFileSync(join(dir, 'effectful.mjs'), [
      'export const name = "effectful"',
      'export function apply(ctx, config = {}) {',
      '  if (config.fail) throw new Error("candidate generation failed to apply")',
      '  ctx.provide("pinnedGeneration", config)',
      '}',
      '',
    ].join('\n'))
    writeFileSync(join(dir, 'cordis.yml'), '- id: effectful\n  name: ./effectful.mjs\n  config:\n    value: base\n')
    const patchFile = join(dir, PROFILE_PATCH_FILENAME)
    const generationA: Include.Config['patches'] = [{ id: 'effectful', config: { value: 'A' } }]
    writeFileSync(patchFile, '- id: effectful\n  config:\n    value: A\n')
    let refresh: (() => Promise<void>) | undefined
    const ctx = await boot(NAME, join(dir, 'cordis.yml'), generationA, (hostCtx) => {
      hostCtx.provide('hmr', {
        registerConfig: async (_filename: string, callback: () => Promise<void>) => {
          refresh = callback
          return async () => {}
        },
      })
      new ProfileRuntime(hostCtx, {
        identity: { name: 'demo', directory: dir },
        compose: () => loadOptionalPatches(NAME, patchFile) ?? [],
        initialManagerPatches: [],
        watchPatches: [{ binName: NAME, filename: patchFile }],
      })
    })
    try {
      expect(refresh).toBeDefined()
      const include = [...ctx.loader.entries()].find(entry => entry.options.id === 'include')
      const effectful = [...ctx.loader.entries()].find(entry => entry.options.id === 'effectful')
      if (!include || !effectful) throw new Error('booted tree has no include or effectful entry')

      // Generation A is active: patched child options and the plugin effect they mounted.
      expect(effectful.options.config).toEqual({ value: 'A' })
      expect(ctx.get('pinnedGeneration')).toEqual({ value: 'A' })

      // The ProfileRuntime watcher reads the fresh patch file and swaps the
      // complete generation through the serialized root Include update.
      const { patches: _previousPatches, ...includeConfig } = include.options.config as Include.Config
      writeFileSync(patchFile, '- id: effectful\n  config:\n    fail: true\n')
      await expect(refresh!())
        .rejects.toThrow('failed to apply loader entry effectful')

      // Generation A is still the active tree: same include options, same child
      // options, same running fiber, same effect.
      expect(include.options.config).toEqual({ ...includeConfig, patches: generationA })
      expect(effectful.options.config).toEqual({ value: 'A' })
      expect(effectful.fiber).toBeDefined()
      expect(ctx.get('pinnedGeneration')).toEqual({ value: 'A' })

      // The next generation still applies: the rejected one did not wedge the tree.
      const generationC: Include.Config['patches'] = [{ id: 'effectful', config: { value: 'C' } }]
      writeFileSync(patchFile, '- id: effectful\n  config:\n    value: C\n')
      await refresh!()
      expect(include.options.config).toEqual({ ...includeConfig, patches: generationC })
      expect(effectful.options.config).toEqual({ value: 'C' })
      expect(ctx.get('pinnedGeneration')).toEqual({ value: 'C' })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
