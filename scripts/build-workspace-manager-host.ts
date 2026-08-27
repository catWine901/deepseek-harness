/** Build the standalone Workspace Manager Host artifact and its declaration bundle. */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { build } from 'tsdown'
import ts from 'typescript'

/** Manager-owned implementation packages included in the standalone release. */
export const WORKSPACE_MANAGER_RELEASE_INLINED_PACKAGES = [
  '@deepseek-ai/dsh-page-app-profile',
  '@deepseek-ai/dsh-atomic-write',
] as const

/** Exact package imports bundled into the standalone Host artifact. */
export const WORKSPACE_MANAGER_BUNDLE_IMPORTS = [
  ...WORKSPACE_MANAGER_RELEASE_INLINED_PACKAGES,
  '@deepseek-ai/dsh-app-boot/profile-runtime-bridge',
] as const

/** Framework packages that must always resolve from the consuming DSH Host. */
export const WORKSPACE_MANAGER_EXTERNAL_SEAMS = [
  '@deepseek-ai/dsh-typert-protocol',
  '@deepseek-ai/cordis',
  '@deepseek-ai/cordis-plugin-include',
  '@deepseek-ai/cordis-plugin-loader',
] as const

/** Inputs for the standalone Workspace Manager Host build. */
export interface WorkspaceManagerHostBuildOptions {
  /** DeepSeek Harness repository root. */
  readonly repoRoot: string
  /** Empty directory that will receive the standalone Host artifact. */
  readonly outputDirectory: string
}

function artifactFiles(root: string, prefix = ''): string[] {
  return readdirSync(join(root, prefix)).flatMap((name) => {
    const path = join(prefix, name)
    return statSync(join(root, path)).isDirectory() ? artifactFiles(root, path) : [path]
  })
}

function isManagerInternalImport(specifier: string): boolean {
  return WORKSPACE_MANAGER_BUNDLE_IMPORTS.some(
    packageName => specifier === packageName || specifier.startsWith(`${packageName}/`),
  )
}

/**
 * Reject a built Host artifact whose JavaScript or public declarations still
 * require a manager-owned package from the consumer's node_modules.
 * @param artifactRoot - directory containing the staged Host files.
 */
export function assertWorkspaceManagerHostClosure(artifactRoot: string): void {
  const root = resolve(artifactRoot)
  for (const path of artifactFiles(root)) {
    if (!/\.(?:[cm]?js|d\.[cm]?ts)$/.test(path)) continue
    const source = readFileSync(join(root, path), 'utf8')
    const imported = ts.preProcessFile(source, true, true).importedFiles
    const forbidden = imported.find(({ fileName }) => isManagerInternalImport(fileName))
    if (forbidden !== undefined) {
      throw new Error(
        `workspace manager Host artifact ${path.replaceAll('\\', '/')} requires unpublished package ${forbidden.fileName}`,
      )
    }
  }
}

/**
 * Build a release-only Host bundle that includes the manager-owned profile
 * implementation while retaining the official DSH and Cordis runtime seams.
 * @param options - source repository and fresh output directory.
 * @returns after JavaScript and the bundled public declaration are written.
 */
export async function buildWorkspaceManagerHost(
  options: WorkspaceManagerHostBuildOptions,
): Promise<void> {
  const repoRoot = resolve(options.repoRoot)
  const outputDirectory = resolve(options.outputDirectory)
  if (existsSync(outputDirectory) && readdirSync(outputDirectory).length > 0) {
    throw new Error(`workspace manager Host build output must be empty: ${outputDirectory}`)
  }
  mkdirSync(outputDirectory, { recursive: true })

  await build({
    config: false,
    cwd: join(repoRoot, 'packages/host/page-app-manager'),
    entry: ['lib/types/index.js', 'lib/types/legacy-rc2-compat.js', 'lib/types/wrapper.js'],
    outDir: outputDirectory,
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    sourcemap: false,
    clean: false,
    dts: false,
    deps: {
      alwaysBundle: [...WORKSPACE_MANAGER_BUNDLE_IMPORTS],
      neverBundle: [...WORKSPACE_MANAGER_EXTERNAL_SEAMS],
    },
  })

  await build({
    config: false,
    cwd: join(repoRoot, 'packages/host/page-app-manager'),
    entry: ['lib/types/index.d.ts', 'lib/types/legacy-rc2-compat.d.ts', 'lib/types/wrapper.d.ts'],
    outDir: join(outputDirectory, 'types'),
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    sourcemap: false,
    clean: false,
    dts: {
      dtsInput: true,
      emitDtsOnly: true,
      resolver: 'tsc',
      compilerOptions: { sourceMap: false, declarationMap: false },
    },
    deps: {
      alwaysBundle: [...WORKSPACE_MANAGER_BUNDLE_IMPORTS],
      neverBundle: [...WORKSPACE_MANAGER_EXTERNAL_SEAMS],
      dts: {
        alwaysBundle: [...WORKSPACE_MANAGER_BUNDLE_IMPORTS],
        neverBundle: [...WORKSPACE_MANAGER_EXTERNAL_SEAMS],
      },
    },
  })

  assertWorkspaceManagerHostClosure(outputDirectory)
}
