/** Deterministically extract the Workspace Manager's out-of-tree repository skeleton. */

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { WORKSPACE_MANAGER_INTERNAL_PACKAGES } from './build-workspace-manager-host.ts'
import { isEntry } from './release/process.ts'

const VERSION = '1.0.0'
const MANAGER_NAME = '@tingyu9527/dsh-workspace-manager'
const REPOSITORY_URL = 'https://github.com/catWine901/dsh-workspace-manager'
const SOURCE_PACKAGES = [
  'packages/boot/page-app-profile',
  'packages/host/page-app-manager',
  'packages/client/ui-page-app-manager',
] as const

const README = `# DSH Workspace Manager

English | [中文](README.zh.md)

An out-of-tree Workspace Apps control plane for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It installs as a profile bundle and adds **Plugins → Workspace Apps** without making the built-in DSH shell depend on the manager.

## What it does

- Installs, enables, disables, hides, reorders, and uninstalls Workspace Apps per profile.
- Keeps \`.workspace-manager/registry.json\` as the sole ownership authority.
- Uses journaled transactions, a shared profile lock, live-tree rollback, and explicit recovery.
- Provides Workbench Contract v1 so managed Features stay Cordis-free.
- Preserves Native DSH when the manager is absent, disabled, reloading, or fails to render.
- Keeps package management and profile-file writes on the Host; the browser only calls the authorized Remote surface.

## Install

Requirements: a DeepSeek Harness 0.1.1-rc.2 source build (or a later compatible 0.1.x release), Node.js 20 or newer, and pnpm 11.7.0 on \`PATH\`. This package uses seams introduced after 0.1.0-rc.6 and is not compatible with the older 0.1.0-rc.6 public release.

\`\`\`sh
dsh plugin --profile <profile> add @tingyu9527/dsh-workspace-manager@1.0.0
dsh --profile <profile>
\`\`\`

Open **Plugins → Workspace Apps** to manage compatible Workspace App packages.

To update or remove the manager:

\`\`\`sh
dsh plugin --profile <profile> update @tingyu9527/dsh-workspace-manager
dsh plugin --profile <profile> remove @tingyu9527/dsh-workspace-manager
\`\`\`

The repository can also be installed directly when it contains the release artifacts:

\`\`\`sh
dsh plugin --profile <profile> add github:catWine901/dsh-workspace-manager
\`\`\`

## Architecture

The package combines three faces behind one installable bundle:

- **Profile core** owns paths, registry parsing, the mutation lock, journals, and deterministic runtime-layer documents.
- **Host manager** validates packages, runs transactions, projects state, and exposes the authorized \`pageAppManager\` Remote service.
- **Browser manager** renders settings and talks to the Host through generated Remote bindings; it never runs pnpm or writes profile files.

Managed Features run below a Feature Runtime Wrapper. Provider loss parks the Feature subtree through the normal loader lifecycle; provider return reloads it. The normative API is documented in [Workbench Contract v1](docs/workbench-contract-v1.md).

## Security and lifecycle guarantees

- Install sources are parsed as arguments; no shell command string is assembled.
- The manager never broadens pnpm \`allowBuilds\` and never deletes a user's pnpm store or source directory.
- Mutations are serialized per profile and either commit or restore the prior live layer and files.
- Activation acknowledgements are revision-bound and timeout-bounded.
- Profiles keep independent registries, orders, revisions, packages, and recovery state.
- A Workspace Feature that imports or depends on Cordis is rejected by the source, manifest, and admission boundaries.

## Compatibility and limits

- This 1.0.0 release targets the DSH 0.1.1-rc.2 seam packages and \`@deepseek-ai/cordis\` 4.0.x.
- Installation requires the Host client-module registry because activation must be acknowledged against an exact client-graph revision.
- Packages that need install scripts may require an operator-managed pnpm build allowance; the manager will not grant it automatically.
- Registry and user data are retained when the manager or an individual Workspace App is removed.

## Repository and release model

This repository is a deterministic distribution snapshot generated from the DeepSeek Harness monorepo. It contains the normalized source packages, tests, Workbench Contract, and prebuilt \`lib/\` artifacts shipped to npm. A release is accepted only after tarball content scanning and a fresh-profile install → start → disable → re-enable → uninstall smoke test.

## License

[MIT](LICENSE)
`

const README_ZH = `# DSH Workspace Manager

[English](README.md) | 中文

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的树外 Workspace Apps 控制面。它作为 profile bundle 安装并提供 **Plugins → Workspace Apps**，同时保持内置 DSH shell 不依赖 Manager。

## 功能

- 按 profile 安装、启用、禁用、隐藏、排序和卸载 Workspace App。
- 以 \`.workspace-manager/registry.json\` 作为唯一 ownership 权威。
- 使用日志事务、共享 profile 锁、live tree 回滚和显式恢复。
- 提供 Workbench Contract v1，使受管 Feature 自身保持 Cordis-free。
- Manager 缺失、禁用、重载或渲染失败时，Native DSH 仍可使用。
- 包管理与 profile 文件写入仅发生在 Host；浏览器只调用经过授权的 Remote 接口。

## 安装

要求：DeepSeek Harness 0.1.1-rc.2 源码构建（或后续兼容的 0.1.x 版本）、Node.js 20 或更高版本，并确保 pnpm 11.7.0 位于 \`PATH\`。本包依赖 0.1.0-rc.6 之后新增的 seam，因此不兼容较旧的 0.1.0-rc.6 公共版本。

\`\`\`sh
dsh plugin --profile <profile> add @tingyu9527/dsh-workspace-manager@1.0.0
dsh --profile <profile>
\`\`\`

打开 **Plugins → Workspace Apps** 管理兼容的 Workspace App 包。

更新或移除 Manager：

\`\`\`sh
dsh plugin --profile <profile> update @tingyu9527/dsh-workspace-manager
dsh plugin --profile <profile> remove @tingyu9527/dsh-workspace-manager
\`\`\`

当 GitHub 仓库已包含发布产物时，也可以直接安装：

\`\`\`sh
dsh plugin --profile <profile> add github:catWine901/dsh-workspace-manager
\`\`\`

## 架构

单个可安装 bundle 组合三个部分：

- **Profile core**：负责路径、registry 解析、变更锁、事务日志和确定性 runtime layer 文档。
- **Host Manager**：负责包校验、事务、状态投影以及经过授权的 \`pageAppManager\` Remote 服务。
- **Browser Manager**：负责 Settings 界面，并通过生成的 Remote 绑定与 Host 通信；它不会运行 pnpm，也不会写 profile 文件。

受管 Feature 位于 Feature Runtime Wrapper 下。Provider 丢失时，Feature 子树通过正常 loader 生命周期进入等待；Provider 恢复时自动重载。规范 API 见 [Workbench Contract v1](docs/workbench-contract-v1.md)。

## 安全与生命周期保证

- 安装源以参数形式解析，不拼接 shell 命令字符串。
- Manager 不会放宽 pnpm \`allowBuilds\`，也不会删除用户的 pnpm store 或源码目录。
- 每个 profile 的变更串行执行；事务要么提交，要么恢复此前的 live layer 与文件。
- 激活确认绑定精确 revision，并受超时限制。
- 不同 profile 的 registry、排序、revision、包和恢复状态彼此独立。
- 导入或依赖 Cordis 的 Workspace Feature 会被源码、manifest 和安装准入边界拒绝。

## 兼容性与限制

- 1.0.0 面向 DSH 0.1.1-rc.2 seam 包与 \`@deepseek-ai/cordis\` 4.0.x。
- 安装依赖 Host client-module registry，因为激活必须对精确 client graph revision 完成确认。
- 如果包需要执行安装脚本，操作者可能需要自行配置 pnpm build allowance；Manager 不会自动授权。
- 移除 Manager 或单个 Workspace App 时，registry 与用户数据会被保留。

## 仓库与发布模型

本仓库是从 DeepSeek Harness monorepo 确定性生成的发布快照，包含规范化源码包、测试、Workbench Contract，以及发布到 npm 的预构建 \`lib/\` 产物。发布前必须通过 tarball 内容扫描和 fresh profile 的安装 → 启动 → 禁用 → 重新启用 → 卸载 smoke test。

## 许可证

[MIT](LICENSE)
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

function releasePeerSpecifier(name: string, dshVersion: string, current: string): string {
  if (name === '@deepseek-ai/cordis') return '^4.0.1'
  if (name === '@deepseek-ai/cordis-plugin-include'
    || name === '@deepseek-ai/cordis-plugin-loader') return '^1.0.0'
  if (name.startsWith('@deepseek-ai/dsh-')) return `>=${dshVersion} <0.2.0`
  return current
}

/**
 * Resolve the only recursive-delete target owned by this extractor.
 * @param sourceRoot - DeepSeek Harness repository root.
 * @param candidate - requested extraction destination.
 * @param ownedOutputRoot - dedicated parent owned by the caller; the CLI uses dist/out-of-tree.
 * @returns the canonical workspace-manager output directory.
 */
export function resolveWorkspaceManagerDestination(
  sourceRoot: string,
  candidate: string,
  ownedOutputRoot = join(sourceRoot, 'dist/out-of-tree'),
): string {
  const expected = resolve(ownedOutputRoot, 'dsh-workspace-manager')
  const output = resolve(candidate)
  if (output !== expected) {
    throw new Error(`workspace manager extraction destination must be ${expected}; got ${output}`)
  }
  return output
}

/**
 * Generate the independent Workspace Manager repository skeleton.
 * @param sourceRoot - DeepSeek Harness repository root.
 * @param destination - output directory replaced atomically at directory granularity.
 * @param ownedOutputRoot - dedicated output parent whose workspace-manager child may be replaced.
 */
export function extractWorkspaceManager(sourceRoot: string, destination: string, ownedOutputRoot?: string): void {
  const root = resolve(sourceRoot)
  const output = resolveWorkspaceManagerDestination(root, destination, ownedOutputRoot)

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
  const rootManifest = readManifest(join(root, 'package.json'))
  const dshVersion = rootManifest.version
  if (typeof dshVersion !== 'string') throw new Error('DeepSeek Harness root package lacks a version')
  const collectedPeers = {
    ...Object.fromEntries(
      Object.entries(hostDependencies)
        .filter(([name]) => name.startsWith('@deepseek-ai/'))
        .map(([name, version]) => [name, version === `^${VERSION}` ? '^0.1.0' : version]),
    ),
    ...asPeers(normalizedHost),
    ...asPeers(normalizedClient),
    '@deepseek-ai/cordis': '^4.0.1',
  }
  const peerDependencies = Object.fromEntries(
    Object.entries(collectedPeers)
      .filter(([name]) => name !== '@deepseek-ai/dsh-page-app-manager'
        && !WORKSPACE_MANAGER_INTERNAL_PACKAGES.some(packageName => name === packageName))
      .map(([name, version]) => [name, releasePeerSpecifier(name, dshVersion, version)]),
  )
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
    packageManager: rootManifest.packageManager,
    main: './lib/index.js',
    types: './lib/types/index.d.ts',
    exports: {
      '.': { types: './lib/types/index.d.ts', default: './lib/index.js' },
      './client': { types: './lib/types/client/index.d.ts', default: './lib/client.js' },
      './package.json': './package.json',
    },
    files: ['lib', 'cordis.patch.yml', 'README.md', 'README.zh.md', 'CHANGELOG.md', 'LICENSE'],
    license: 'MIT',
    keywords: ['deepseek', 'dsh', 'workspace-apps', 'plugin-manager'],
    repository: {
      type: 'git',
      url: `git+${REPOSITORY_URL}.git`,
    },
    homepage: `${REPOSITORY_URL}#readme`,
    bugs: { url: `${REPOSITORY_URL}/issues` },
    publishConfig: { access: 'public' },
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
