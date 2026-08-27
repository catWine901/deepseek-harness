import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const packageRoot = dirname(fileURLToPath(new URL('../package.json', import.meta.url)))

describe('profile-runtime bridge publication', () => {
  it('exports a stable built JavaScript entry included in the package payload', () => {
    const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as {
      exports: Record<string, { types: string; default: string }>
      files: string[]
    }
    expect(manifest.exports['./profile-runtime-bridge']).toEqual({
      types: './lib/types/profile-runtime-bridge.d.ts',
      default: './lib/profile-runtime-bridge.js',
    })
    expect(manifest.files).toContain('lib/profile-runtime-bridge.js')
    const buildConfig = readFileSync(join(packageRoot, 'tsdown.config.ts'), 'utf8')
    expect(buildConfig).toContain('\'lib/types/profile-runtime-bridge.js\'')
    expect(buildConfig).toContain('neverBundle: [')
    expect(buildConfig).toContain('\'@deepseek-ai/cordis-plugin-include\'')
  })

  it('keeps the emitted bridge on the host Cordis and Include graph', async () => {
    const builtEntry = join(packageRoot, 'lib', 'profile-runtime-bridge.js')
    const source = readFileSync(builtEntry, 'utf8')
    expect(source).toMatch(/from "@deepseek-ai\/cordis-plugin-include"/u)
    expect(source).not.toContain('function applyEntryPatches')
    expect(source).not.toContain('vendor/include')
    const bridge = await import(new URL('../lib/profile-runtime-bridge.js', import.meta.url).href) as unknown as {
      ProfileRuntime: unknown
    }
    expect(bridge.ProfileRuntime).toBeTypeOf('function')
  })
})
