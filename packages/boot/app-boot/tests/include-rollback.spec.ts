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
import { boot } from '../src/index.ts'

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
    const generationA: Include.Config['patches'] = [{ id: 'effectful', config: { value: 'A' } }]
    const generationB: Include.Config['patches'] = [{ id: 'effectful', config: { fail: true } }]
    const ctx = await boot(NAME, join(dir, 'cordis.yml'), generationA)
    try {
      const include = [...ctx.loader.entries()].find(entry => entry.options.id === 'include')
      const effectful = [...ctx.loader.entries()].find(entry => entry.options.id === 'effectful')
      if (!include || !effectful) throw new Error('booted tree has no include or effectful entry')

      // Generation A is active: patched child options and the plugin effect they mounted.
      expect(effectful.options.config).toEqual({ value: 'A' })
      expect(ctx.get('pinnedGeneration')).toEqual({ value: 'A' })

      // The exact update `watchUserPatches` performs per user-layer generation:
      // re-read the include's non-patch options and swap the patch list.
      const { patches: _previousPatches, ...includeConfig } = include.options.config as Include.Config
      await expect(include.update({ config: { ...includeConfig, patches: generationB } }))
        .rejects.toThrow('failed to apply loader entry effectful')

      // Generation A is still the active tree: same include options, same child
      // options, same running fiber, same effect.
      expect(include.options.config).toEqual({ ...includeConfig, patches: generationA })
      expect(effectful.options.config).toEqual({ value: 'A' })
      expect(effectful.fiber).toBeDefined()
      expect(ctx.get('pinnedGeneration')).toEqual({ value: 'A' })

      // The next generation still applies: the rejected one did not wedge the tree.
      const generationC: Include.Config['patches'] = [{ id: 'effectful', config: { value: 'C' } }]
      await include.update({ config: { ...includeConfig, patches: generationC } })
      await ctx.loader.await()
      expect(include.options.config).toEqual({ ...includeConfig, patches: generationC })
      expect(effectful.options.config).toEqual({ value: 'C' })
      expect(ctx.get('pinnedGeneration')).toEqual({ value: 'C' })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
