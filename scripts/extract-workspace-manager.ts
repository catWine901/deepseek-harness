/** Deterministically extract the Workspace Manager's out-of-tree repository skeleton. */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, parse, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { isEntry } from './release/process.ts'

const VERSION = '1.0.0'
const MANAGER_NAME = '@deepseek-ai/dsh-workspace-manager'
const SOURCE_PACKAGES = [
  'packages/boot/page-app-profile',
  'packages/host/page-app-manager',
  'packages/client/ui-page-app-manager',
] as const

const README = `# DSH Workspace Manager

Out-of-tree delivery skeleton for DSH Workspace Apps. The repository preserves the profile, Host Manager, and browser Manager sources together with the normative Workbench Contract v1 under \`docs/\`.

The package installs through \`dsh plugin --profile <profile> add <tarball>\`. Build the \`lib/\` artifacts before packing; publication and remote repository creation remain explicit release actions.
`

const README_ZH = `# DSH Workspace Manager

DSH Workspace Apps 的出树交付骨架。仓库保留 Profile、Host Manager、浏览器 Manager 源码，并在 \`docs/\` 下携带 Workbench Contract v1 规范。

该包通过 \`dsh plugin --profile <profile> add <tarball>\` 安装。打包前必须生成 \`lib/\` 产物；发布与远程仓库创建仍是显式发布操作。
`

const CHANGELOG = `# Changelog

## 1.0.0

- Establish the out-of-tree Workspace Manager repository and package contract.
`

const PATCH = `- insert:
    - id: page-app-manager
      name: '${MANAGER_NAME}'
      config:
        settlementTimeoutMs: 60000
`

type Manifest = Record<string, unknown>

function readManifest(path: string): Manifest {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON object`)
  }
  return parsed as Manifest
}

function write(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content.endsWith('\n') ? content : `${content}\n`)
}

function writeJson(path: string, value: unknown): void {
  write(path, JSON.stringify(value, undefined, 2))
}

function dependencySections(manifest: Manifest): Array<keyof Manifest> {
  return ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies']
    .filter(section => manifest[section] !== undefined)
}

function normalizeWorkspaceSpecifiers(manifest: Manifest, extractedNames: ReadonlySet<string>): Manifest {
  const normalized: Manifest = { ...manifest, version: VERSION, private: false }
  delete normalized.repository
  for (const section of dependencySections(normalized)) {
    const dependencies = normalized[section]
    if (dependencies === null || typeof dependencies !== 'object' || Array.isArray(dependencies)) continue
    normalized[section] = Object.fromEntries(Object.entries(dependencies).map(([name, value]) => {
      if (typeof value !== 'string' || !value.startsWith('workspace:')) return [name, value]
      return [name, extractedNames.has(name) ? `^${VERSION}` : '^0.1.0']
    }))
  }
  if (normalized.exports !== null && typeof normalized.exports === 'object' && !Array.isArray(normalized.exports)) {
    const exportsField = { ...(normalized.exports as Record<string, unknown>) }
    delete exportsField['./src/*']
    normalized.exports = exportsField
  }
  return normalized
}

function copyIfPresent(source: string, destination: string): void {
  if (existsSync(source)) cpSync(source, destination, { recursive: true })
}

function copyPackageSources(sourceRoot: string, output: string, packagePath: string, names: ReadonlySet<string>): void {
  const source = join(sourceRoot, packagePath)
  const destination = join(output, 'packages', basename(packagePath))
  mkdirSync(destination, { recursive: true })
  for (const entry of ['src', 'tests', 'README.md', 'README.zh.md', 'tsconfig.json', 'tsconfig.build.json']) {
    copyIfPresent(join(source, entry), join(destination, entry))
  }
  writeJson(join(destination, 'package.json'), normalizeWorkspaceSpecifiers(
    readManifest(join(source, 'package.json')),
    names,
  ))
}

function asDependencies(manifest: Manifest): Record<string, string> {
  const value = manifest.dependencies
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
}

function asPeers(manifest: Manifest): Record<string, string> {
  const value = manifest.peerDependencies
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
}

/**
 * Generate the independent Workspace Manager repository skeleton.
 * @param sourceRoot - DeepSeek Harness repository root.
 * @param destination - output directory replaced atomically at directory granularity.
 */
export function extractWorkspaceManager(sourceRoot: string, destination: string): void {
  const root = resolve(sourceRoot)
  const output = resolve(destination)
  if (output === parse(output).root || output === root) throw new Error(`refusing to replace extraction destination ${output}`)

  const sourceManifests = SOURCE_PACKAGES.map(packagePath => readManifest(join(root, packagePath, 'package.json')))
  const extractedNames = new Set(sourceManifests.map((manifest) => {
    if (typeof manifest.name !== 'string') throw new Error('workspace manager source package lacks a name')
    return manifest.name
  }))
  const [profileManifest, hostManifest, clientManifest] = sourceManifests
  if (profileManifest === undefined || hostManifest === undefined || clientManifest === undefined) {
    throw new Error('workspace manager extraction requires all three source packages')
  }

  rmSync(output, { recursive: true, force: true })
  mkdirSync(output, { recursive: true })
  for (const packagePath of SOURCE_PACKAGES) copyPackageSources(root, output, packagePath, extractedNames)

  copyIfPresent(join(root, 'packages/host/page-app-manager/src'), join(output, 'src/host'))
  copyIfPresent(join(root, 'packages/boot/page-app-profile/src'), join(output, 'src/profile'))
  copyIfPresent(join(root, 'packages/client/ui-page-app-manager/src'), join(output, 'src/client'))
  copyIfPresent(join(root, 'packages/host/page-app-manager/tests'), join(output, 'tests/host'))
  copyIfPresent(join(root, 'packages/boot/page-app-profile/tests'), join(output, 'tests/profile'))
  copyIfPresent(join(root, 'packages/client/ui-page-app-manager/tests'), join(output, 'tests/client'))

  const normalizedHost = normalizeWorkspaceSpecifiers(hostManifest, extractedNames)
  const normalizedClient = normalizeWorkspaceSpecifiers(clientManifest, extractedNames)
  const hostDependencies = asDependencies(normalizedHost)
  const dependencies = Object.fromEntries(
    Object.entries(hostDependencies).filter(([name]) => !name.startsWith('@deepseek-ai/')),
  )
  const peerDependencies = {
    ...Object.fromEntries(
      Object.entries(hostDependencies)
        .filter(([name]) => name.startsWith('@deepseek-ai/'))
        .map(([name, version]) => [name, version === `^${VERSION}` ? '^0.1.0' : version]),
    ),
    ...asPeers(normalizedHost),
    ...asPeers(normalizedClient),
    '@deepseek-ai/cordis': '^4.0.1',
  }
  const clientDsh = clientManifest.dsh
  const client = clientDsh !== null && typeof clientDsh === 'object' && !Array.isArray(clientDsh)
    ? (clientDsh as Record<string, unknown>).client
    : undefined
  writeJson(join(output, 'package.json'), {
    name: MANAGER_NAME,
    description: 'Out-of-tree DSH Workspace Apps manager',
    version: VERSION,
    private: false,
    type: 'module',
    packageManager: readManifest(join(root, 'package.json')).packageManager,
    main: './lib/index.js',
    types: './lib/types/index.d.ts',
    exports: {
      '.': { types: './lib/types/index.d.ts', default: './lib/index.js' },
      './client': { types: './lib/types/client/index.d.ts', default: './lib/client.js' },
      './package.json': './package.json',
    },
    files: ['lib', 'cordis.patch.yml', 'README.md', 'README.zh.md', 'CHANGELOG.md', 'LICENSE'],
    license: 'MIT',
    dsh: { bundle: { patch: './cordis.patch.yml' }, client },
    dependencies,
    peerDependencies,
  })
  write(join(output, 'cordis.patch.yml'), PATCH)
  write(join(output, 'README.md'), README)
  write(join(output, 'README.zh.md'), README_ZH)
  write(join(output, 'CHANGELOG.md'), CHANGELOG)
  copyIfPresent(join(root, 'LICENSE'), join(output, 'LICENSE'))
  copyIfPresent(
    join(root, 'docs/superpowers/specs/2026-08-25-workspace-apps-workbench-contract-v1.md'),
    join(output, 'docs/workbench-contract-v1.md'),
  )
}

function main(): void {
  const { values } = parseArgs({ options: { out: { type: 'string' } }, allowPositionals: false })
  const root = process.cwd()
  const destination = resolve(root, values.out ?? 'dist/out-of-tree/dsh-workspace-manager')
  extractWorkspaceManager(root, destination)
  console.log(`workspace manager skeleton extracted to ${relative(root, destination).replaceAll('\\', '/')}`)
}

if (isEntry(import.meta.url)) main()
