import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  buildWorkspaceManagerHost,
  WORKSPACE_MANAGER_BUNDLE_IMPORTS,
  WORKSPACE_MANAGER_EXTERNAL_SEAMS,
  WORKSPACE_MANAGER_FORBIDDEN_PUBLIC_IMPORTS,
  WORKSPACE_MANAGER_RELEASE_INLINED_PACKAGES,
} from './build-workspace-manager-host.ts'
import { scanTarballContent } from './publication-payload.ts'
import { extractWorkspaceManager, resolveWorkspaceManagerDestination } from './extract-workspace-manager.ts'

const repoRoot = fileURLToPath(new URL('../', import.meta.url))
const temporaryRoot = mkdtempSync(join(tmpdir(), 'dsh-workspace-manager-extract-'))
const output = join(temporaryRoot, 'dsh-workspace-manager')
const hostBuild = join(temporaryRoot, 'host-build')

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

beforeAll(async () => {
  extractWorkspaceManager(repoRoot, output, temporaryRoot)
  await buildWorkspaceManagerHost({ repoRoot, outputDirectory: hostBuild })
})

afterAll(() => {
  rmSync(temporaryRoot, { recursive: true, force: true })
})

describe('workspace manager extraction', () => {
  it.each([
    ['repository root', repoRoot],
    ['repository parent', dirname(repoRoot)],
    ['sibling worktree', join(dirname(repoRoot), 'other-worktree')],
    ['broad existing directory', temporaryRoot],
  ])('rejects %s as an extraction destination before deletion', (_label, candidate) => {
    expect(() => { resolveWorkspaceManagerDestination(repoRoot, candidate) })
      .toThrow('workspace manager extraction destination must be')
    expect(statSync(temporaryRoot).isDirectory()).toBe(true)
  })

  it('accepts only the dedicated workspace manager output owned by the extractor', () => {
    expect(resolveWorkspaceManagerDestination(
      repoRoot,
      join(repoRoot, 'dist/out-of-tree/dsh-workspace-manager'),
    )).toBe(resolve(repoRoot, 'dist/out-of-tree/dsh-workspace-manager'))
  })

  it('skeleton manifest is private false with normal semver and no workspace: references', () => {
    const manifest = readJson(join(output, 'package.json'))
    expect(manifest.version).toBe('1.0.1')
    expect(manifest.private).toBe(false)
    expect(readFileSync(join(output, 'package.json'), 'utf8')).not.toContain('workspace:')
    for (const manifestPath of filesUnder(join(output, 'packages')).filter(path => path.endsWith('package.json'))) {
      const packageManifestPath = join(output, 'packages', manifestPath)
      const packageManifest = readFileSync(packageManifestPath, 'utf8')
      expect(readJson(packageManifestPath).version).toBe('1.0.1')
      expect(packageManifest).not.toContain('workspace:')
    }
  })

  it('publishes the personal package identity with actionable repository metadata', () => {
    const manifest = readJson(join(output, 'package.json'))
    expect(manifest).toMatchObject({
      name: '@tingyu9527/dsh-workspace-manager',
      repository: {
        type: 'git',
        url: 'git+https://github.com/catWine901/dsh-workspace-manager.git',
      },
      homepage: 'https://github.com/catWine901/dsh-workspace-manager#readme',
      bugs: { url: 'https://github.com/catWine901/dsh-workspace-manager/issues' },
      publishConfig: { access: 'public' },
    })

    const readme = readFileSync(join(output, 'README.md'), 'utf8')
    expect(readme).toContain('dsh plugin --profile web add @tingyu9527/dsh-workspace-manager')
    expect(readme).toContain('## What it does')
    expect(readme).toContain('## Security and lifecycle guarantees')
  })

  it('skeleton exports contain no ./src/* subpath', () => {
    const manifest = readJson(join(output, 'package.json'))
    expect(Object.keys(manifest.exports as Record<string, unknown>)).not.toContain('./src/*')
    expect((manifest.exports as Record<string, unknown>)['./wrapper']).toEqual({
      types: './lib/types/wrapper.d.ts',
      default: './lib/wrapper.js',
    })
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

  it('publishes only the runtime dependencies and official DSH/Cordis seams used by the artifact', () => {
    const manifest = readJson(join(output, 'package.json'))
    expect(manifest.dependencies).toEqual({
      'js-yaml': '^4.2.0',
      zod: '^4.0.0',
    })
    const peers = manifest.peerDependencies as Record<string, string>
    expect(peers).toEqual({
      '@deepseek-ai/dsh-app-boot': '>=0.1.1-rc.2 <0.2.0',
      '@deepseek-ai/dsh-typert-protocol': '>=0.1.1-rc.2 <0.2.0',
      '@deepseek-ai/cordis': '^4.0.1',
      '@deepseek-ai/cordis-plugin-include': '^1.0.6',
      '@deepseek-ai/dsh-api-remotes': '>=0.1.1-rc.2 <0.2.0',
      '@deepseek-ai/dsh-client-locale': '>=0.1.1-rc.2 <0.2.0',
      '@deepseek-ai/dsh-client-modules': '>=0.1.1-rc.2 <0.2.0',
      '@deepseek-ai/dsh-client-runtime': '>=0.1.1-rc.2 <0.2.0',
      '@deepseek-ai/dsh-client-ui-slots': '>=0.1.1-rc.2 <0.2.0',
      '@deepseek-ai/dsh-client-ui-settings': '>=0.1.1-rc.2 <0.2.0',
    })
    expect(peers).not.toHaveProperty('@deepseek-ai/dsh-page-app-profile')
    expect(peers).not.toHaveProperty('@deepseek-ai/dsh-atomic-write')
    expect(peers).not.toHaveProperty('@deepseek-ai/cordis-plugin-loader')
    expect(peers).not.toHaveProperty('@deepseek-ai/dsh-brand')
    expect(peers).not.toHaveProperty('@deepseek-ai/dsh-invariants')
    expect(peers).not.toHaveProperty('@deepseek-ai/dsh-page-app-manager')

    const readme = readFileSync(join(output, 'README.md'), 'utf8')
    expect(readme).toContain('@deepseek-ai/dsh@0.1.1-rc.2')
    expect(readme).toContain('not compatible with the older 0.1.0-rc.6 public release')
  })

  it('derives removed framework peers from the emitted Host import graph', () => {
    const hostImports = filesUnder(hostBuild)
      .filter(path => path.endsWith('.js'))
      .flatMap(path => ts.preProcessFile(readFileSync(join(hostBuild, path), 'utf8'), true, true)
        .importedFiles.map(({ fileName }) => fileName))

    expect(hostImports).toContain('@deepseek-ai/cordis')
    expect(hostImports).toContain('@deepseek-ai/cordis-plugin-include')
    expect(hostImports).not.toContain('@deepseek-ai/cordis-plugin-loader')
    expect(hostImports).not.toContain('@deepseek-ai/dsh-brand')
    expect(hostImports).not.toContain('@deepseek-ai/dsh-invariants')
    expect(WORKSPACE_MANAGER_EXTERNAL_SEAMS).toEqual([
      '@deepseek-ai/dsh-typert-protocol',
      '@deepseek-ai/cordis',
      '@deepseek-ai/cordis-plugin-include',
      '@deepseek-ai/cordis-plugin-loader',
    ])
  })

  it('bundles every non-public Host and client declaration owner', () => {
    const declarationImports = filesUnder(join(hostBuild, 'types'))
      .filter(path => path.endsWith('.d.ts'))
      .flatMap(path => ts.preProcessFile(readFileSync(join(hostBuild, 'types', path), 'utf8'), true, true)
        .importedFiles.map(({ fileName }) => fileName))

    expect(filesUnder(join(hostBuild, 'types'))).toContain(join('client', 'index.d.ts'))
    for (const packageName of WORKSPACE_MANAGER_FORBIDDEN_PUBLIC_IMPORTS) {
      expect(declarationImports.some(
        specifier => specifier === packageName || specifier.startsWith(`${packageName}/`),
      )).toBe(false)
    }
  })

  it('separates the rc.2 app-boot bridge import from manager-owned release dependencies', () => {
    expect(WORKSPACE_MANAGER_BUNDLE_IMPORTS).toContain('@deepseek-ai/dsh-app-boot/profile-runtime-bridge')
    expect(WORKSPACE_MANAGER_RELEASE_INLINED_PACKAGES).toEqual([
      '@deepseek-ai/dsh-page-app-profile',
      '@deepseek-ai/dsh-atomic-write',
    ])
    expect(WORKSPACE_MANAGER_RELEASE_INLINED_PACKAGES).not.toContain('@deepseek-ai/dsh-app-boot')
  })

  it('documents direct npm-form rc.2 compatibility and the audited legacy bridge in both languages', () => {
    const readme = readFileSync(join(output, 'README.md'), 'utf8')
    const readmeZh = readFileSync(join(output, 'README.zh.md'), 'utf8')
    const changelog = readFileSync(join(output, 'CHANGELOG.md'), 'utf8')
    const installCommands = [
      '```sh',
      'dsh plugin --profile web add @tingyu9527/dsh-workspace-manager',
      'dsh web',
      '```',
    ].join('\n')
    expect(readme).toContain('npm release `@deepseek-ai/dsh@0.1.1-rc.2`')
    expect(readme).toContain('fixes external-consumer installation')
    expect(readme).toContain('inlines the unpublished `dsh-page-app-profile` implementation')
    expect(readme).toContain('does not require a DSH source build')
    expect(readme).toContain('legacy rc.2 compatibility bridge')
    expect(readme).toContain('automatically stays inactive')
    expect(readme).toContain(installCommands)
    expect(readmeZh).toContain('npm 发布包 `@deepseek-ai/dsh@0.1.1-rc.2`')
    expect(readmeZh).toContain('修复 external consumer 安装')
    expect(readmeZh).toContain('内联未发布的 `dsh-page-app-profile` 实现')
    expect(readmeZh).toContain('不再要求 DSH source build')
    expect(readmeZh).toContain('旧版 rc.2 兼容桥')
    expect(readmeZh).toContain('自动保持不激活')
    expect(readmeZh).toContain(installCommands)
    expect(changelog).toContain('## 1.0.1')
    expect(changelog).toContain('public npm-form DSH 0.1.1-rc.2')
    expect(changelog).toContain('Fix external-consumer installation')
    expect(changelog).toContain('without a DSH source build')
  })

  it('keeps the source package docs and architecture note honest about the standalone boundary', () => {
    const profileReadme = readFileSync(join(repoRoot, 'packages/boot/page-app-profile/README.md'), 'utf8')
    const profileReadmeZh = readFileSync(join(repoRoot, 'packages/boot/page-app-profile/README.zh.md'), 'utf8')
    const managerReadme = readFileSync(join(repoRoot, 'packages/host/page-app-manager/README.md'), 'utf8')
    const managerReadmeZh = readFileSync(join(repoRoot, 'packages/host/page-app-manager/README.zh.md'), 'utf8')
    const noteRoot = join(repoRoot, '.agents/notes/implemented/architecture')
    const note = readFileSync(join(noteRoot, '2026-08-25-workspace-apps-architecture-optimization.md'), 'utf8')
    const noteZh = readFileSync(join(noteRoot, '2026-08-25-workspace-apps-architecture-optimization.zh.md'), 'utf8')

    expect(profileReadme).toContain('## Standalone release boundary')
    expect(profileReadme).toContain('not a second general app-boot runtime')
    expect(profileReadmeZh).toContain('## 独立发布边界')
    expect(profileReadmeZh).toContain('不是第二套通用 app-boot runtime')
    expect(managerReadme).toContain('## Cordis adapter and public rc.2 compatibility')
    expect(managerReadme).toContain('does not require `cordis-plugin-loader` as a package peer')
    expect(managerReadmeZh).toContain('## Cordis adapter 与公开 rc.2 兼容')
    expect(managerReadmeZh).toContain('不要求把 `cordis-plugin-loader` 声明为包 peer')
    expect(note).toContain('legacy rc.2 compatibility bridge')
    expect(note).toContain('fresh npm consumer')
    expect(noteZh).toContain('旧版 rc.2 兼容桥')
    expect(noteZh).toContain('全新 npm consumer')
  })

  it('skeleton never declares dsh.workspace', () => {
    const manifest = readJson(join(output, 'package.json'))
    expect(manifest.dsh).toMatchObject({ bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web' } })
    expect(readFileSync(join(output, 'cordis.patch.yml'), 'utf8')).toBe([
      '- insert:',
      '    - id: page-app-manager-legacy-rc2-compat',
      "      name: '@tingyu9527/dsh-workspace-manager/legacy-rc2-compat'",
      '    - id: page-app-manager',
      "      name: '@tingyu9527/dsh-workspace-manager'",
      '      config:',
      '        settlementTimeoutMs: 60000',
      '',
    ].join('\n'))
    expect(manifest.dsh as Record<string, unknown>).not.toHaveProperty('workspace')
  })

  it('extraction is deterministic (byte-identical on rerun)', () => {
    const first = treeDigest(output)
    extractWorkspaceManager(repoRoot, output, temporaryRoot)
    expect(treeDigest(output)).toBe(first)
  })

  it('packs the skeleton and scans the final tarball contents', () => {
    const packed = join(temporaryRoot, 'packed')
    execFileSync('pnpm', ['pack', '--pack-destination', packed], {
      cwd: output,
      stdio: 'pipe',
      shell: process.platform === 'win32',
    })
    const tarball = join(packed, 'tingyu9527-dsh-workspace-manager-1.0.1.tgz')
    expect(() => { scanTarballContent(tarball, member => !member.endsWith('/')) }).not.toThrow()
  })
})
