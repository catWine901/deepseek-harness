import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { scanTarballContent } from './publication-payload.ts'
import { extractWorkspaceManager } from './extract-workspace-manager.ts'

const repoRoot = fileURLToPath(new URL('../', import.meta.url))
const temporaryRoot = mkdtempSync(join(tmpdir(), 'dsh-workspace-manager-extract-'))
const output = join(temporaryRoot, 'dsh-workspace-manager')

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

function filesUnder(root: string, prefix = ''): string[] {
  return readdirSync(join(root, prefix)).flatMap((name) => {
    const relative = join(prefix, name)
    return statSync(join(root, relative)).isDirectory() ? filesUnder(root, relative) : [relative]
  }).sort()
}

function treeDigest(root: string): string {
  const hash = createHash('sha256')
  for (const relative of filesUnder(root)) {
    hash.update(relative.replaceAll('\\', '/'))
    hash.update('\0')
    hash.update(readFileSync(join(root, relative)))
    hash.update('\0')
  }
  return hash.digest('hex')
}

beforeAll(() => {
  extractWorkspaceManager(repoRoot, output)
})

afterAll(() => {
  rmSync(temporaryRoot, { recursive: true, force: true })
})

describe('workspace manager extraction', () => {
  it('skeleton manifest is private false with normal semver and no workspace: references', () => {
    const manifest = readJson(join(output, 'package.json'))
    expect(manifest.version).toBe('1.0.0')
    expect(manifest.private).toBe(false)
    expect(readFileSync(join(output, 'package.json'), 'utf8')).not.toContain('workspace:')
    for (const manifestPath of filesUnder(join(output, 'packages')).filter(path => path.endsWith('package.json'))) {
      const packageManifest = readFileSync(join(output, 'packages', manifestPath), 'utf8')
      expect(packageManifest).not.toContain('workspace:')
    }
  })

  it('skeleton exports contain no ./src/* subpath', () => {
    const manifest = readJson(join(output, 'package.json'))
    expect(Object.keys(manifest.exports as Record<string, unknown>)).not.toContain('./src/*')
    for (const manifestPath of filesUnder(join(output, 'packages')).filter(path => path.endsWith('package.json'))) {
      const packageManifest = readJson(join(output, 'packages', manifestPath))
      expect(Object.keys(packageManifest.exports as Record<string, unknown>)).not.toContain('./src/*')
    }
  })

  it('skeleton files cover lib only', () => {
    expect(readJson(join(output, 'package.json')).files).toEqual([
      'lib',
      'cordis.patch.yml',
      'README.md',
      'README.zh.md',
      'CHANGELOG.md',
      'LICENSE',
    ])
  })

  it('skeleton includes LICENSE, CHANGELOG, and the README pair', () => {
    expect(filesUnder(output)).toEqual(expect.arrayContaining([
      'LICENSE',
      'CHANGELOG.md',
      'README.md',
      'README.zh.md',
    ]))
  })

  it('skeleton declares a peer dependency on @deepseek-ai/cordis', () => {
    const manifest = readJson(join(output, 'package.json'))
    expect(manifest.peerDependencies).toMatchObject({ '@deepseek-ai/cordis': '^4.0.1' })
  })

  it('skeleton never declares dsh.workspace', () => {
    const manifest = readJson(join(output, 'package.json'))
    expect(manifest.dsh).toMatchObject({ bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } })
    expect(manifest.dsh as Record<string, unknown>).not.toHaveProperty('workspace')
  })

  it('extraction is deterministic (byte-identical on rerun)', () => {
    const first = treeDigest(output)
    extractWorkspaceManager(repoRoot, output)
    expect(treeDigest(output)).toBe(first)
  })

  it('packs the skeleton and scans the final tarball contents', () => {
    const packed = join(temporaryRoot, 'packed')
    execFileSync('pnpm', ['pack', '--pack-destination', packed], {
      cwd: output,
      stdio: 'pipe',
      shell: process.platform === 'win32',
    })
    const tarball = join(packed, 'deepseek-ai-dsh-workspace-manager-1.0.0.tgz')
    expect(() => { scanTarballContent(tarball, member => !member.endsWith('/')) }).not.toThrow()
  })
})
