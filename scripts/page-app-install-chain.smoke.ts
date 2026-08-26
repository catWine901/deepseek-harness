/** Local packed-artifact smoke for the out-of-tree Workspace Manager install chain. */

import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { execa } from 'execa'
import { extractWorkspaceManager } from './extract-workspace-manager.ts'
import { scanTarballContent, validateTarballPayloadContent } from './publication-payload.ts'
import { isEntry } from './release/process.ts'

/** Inputs for the built-bin install-chain smoke. */
export interface PageAppInstallChainOptions {
  /** Repository root containing the built packages and CLI. */
  readonly repoRoot: string
  /** Built dsh executable. */
  readonly dshBin: string
}

/** Observable milestones of the local install chain. */
export interface PageAppInstallChainResult {
  readonly tarballScanned: true
  readonly installedAndStarted: true
  readonly disabledWithNativeDsh: true
  readonly managerAbsentWhileDisabled: true
  readonly reenabled: true
  readonly uninstalled: true
}

/** Inputs whose build output is staged into the extracted package. */
export interface WorkspaceManagerArtifactStagingOptions {
  readonly repoRoot: string
  readonly clientBuildDirectory: string
  readonly extracted: string
}

function requireArtifact(path: string): void {
  if (!existsSync(path)) {
    throw new Error(`workspace manager install-chain requires built artifact ${path}; run pnpm run build first`)
  }
}

/**
 * Validate and copy the generated artifacts without rewriting their bytes.
 * @param options - built Host/client locations and extracted package root.
 */
export function stageWorkspaceManagerArtifacts(options: WorkspaceManagerArtifactStagingOptions): void {
  const repoRoot = resolve(options.repoRoot)
  const extracted = resolve(options.extracted)
  const hostLib = join(repoRoot, 'packages/host/page-app-manager/lib')
  const clientArtifact = join(resolve(options.clientBuildDirectory), 'client.js')
  requireArtifact(join(hostLib, 'index.js'))
  requireArtifact(clientArtifact)
  const clientBytes = readFileSync(clientArtifact)
  validateTarballPayloadContent(['lib/client.js'], () => clientBytes, 'workspace manager client build')

  cpSync(hostLib, join(extracted, 'lib'), { recursive: true })
  writeFileSync(join(extracted, 'lib/client.js'), clientBytes)
  const clientTypes = join(repoRoot, 'packages/client/ui-page-app-manager/lib/types/client')
  if (existsSync(clientTypes)) {
    cpSync(clientTypes, join(extracted, 'lib/types/client'), {
      recursive: true,
      filter: source => statSync(source).isDirectory() || source.endsWith('.d.ts'),
    })
  }
}

async function buildPathFreeClient(repoRoot: string, destination: string): Promise<void> {
  const tsdown = join(repoRoot, 'node_modules/tsdown/dist/run.mjs')
  requireArtifact(tsdown)
  await execa(process.execPath, [
    tsdown,
    '--minify',
    '--out-dir', destination,
    '--no-sourcemap',
  ], {
    cwd: join(repoRoot, 'packages/client/ui-page-app-manager'),
  })
  requireArtifact(join(destination, 'client.js'))
}

async function run(
  dshBin: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeout = 90_000,
): Promise<{ stdout: string; stderr: string }> {
  const result = await execa(process.execPath, [dshBin, ...args], {
    env,
    extendEnv: false,
    input: '',
    reject: false,
    timeout,
    killSignal: 'SIGKILL',
  })
  if (result.exitCode !== 0) {
    throw new Error(
      `workspace manager install-chain command failed (${args.join(' ')}): exit ${String(result.exitCode)}`
      + `\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    )
  }
  return { stdout: result.stdout, stderr: result.stderr }
}

function writeProbe(path: string, service: string, forbiddenService?: string): void {
  const marker = forbiddenService === undefined
    ? "'active'"
    : `ctx.get(${JSON.stringify(forbiddenService)}) === undefined ? 'forbidden-absent' : 'forbidden-present'`
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, [
    "import { writeFileSync } from 'node:fs'",
    `export const inject = [${JSON.stringify(service)}]`,
    'export function apply(ctx) {',
    `  writeFileSync(process.env.DSH_MANAGER_SMOKE_MARKER, ${marker})`,
    "  setTimeout(() => { process.emit('SIGTERM') }, 0)",
    '}',
    '',
  ].join('\n'))
}

function writeProfilePatch(path: string, probe: string, disabled: boolean): void {
  const patches = disabled
    ? ['- id: page-app-manager', '  disabled: true']
    : []
  patches.push(
    '- insert:',
    '    - id: workspace-manager-smoke-probe',
    `      name: ${pathToFileURL(probe).href}`,
    '',
  )
  writeFileSync(path, patches.join('\n'))
}

function manifestAt(path: string): {
  dependencies?: Record<string, string>
  dsh?: {
    profile?: {
      bundles?: string[]
    }
  }
} {
  return JSON.parse(readFileSync(path, 'utf8')) as {
    dependencies?: Record<string, string>
    dsh?: { profile?: { bundles?: string[] } }
  }
}

/**
 * Pack the extracted manager, install it into a fresh profile, exercise an
 * overlay disable/re-enable, and remove every local tarball dependency.
 * @param options - repository and built-bin locations.
 * @returns completed chain milestones; any failed milestone throws with command output.
 */
export async function runPageAppInstallChain(options: PageAppInstallChainOptions): Promise<PageAppInstallChainResult> {
  const repoRoot = resolve(options.repoRoot)
  const dshBin = resolve(options.dshBin)
  requireArtifact(dshBin)
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'dsh-workspace-manager-chain-'))
  try {
    const extracted = join(temporaryRoot, 'dsh-workspace-manager')
    const clientBuildDirectory = join(temporaryRoot, 'client-build')
    const packed = join(temporaryRoot, 'packed')
    const home = join(temporaryRoot, 'home')
    const profileName = 'workspace-manager-smoke'
    const profileDir = join(home, 'profiles', profileName)
    const marker = join(temporaryRoot, 'active')
    const managerProbe = join(temporaryRoot, 'manager-probe.mjs')
    const nativeProbe = join(temporaryRoot, 'native-probe.mjs')
    extractWorkspaceManager(repoRoot, extracted, temporaryRoot)
    await buildPathFreeClient(repoRoot, clientBuildDirectory)
    stageWorkspaceManagerArtifacts({ repoRoot, clientBuildDirectory, extracted })
    mkdirSync(packed, { recursive: true })
    await execa('pnpm', ['pack', '--pack-destination', packed], {
      cwd: extracted,
      shell: process.platform === 'win32',
    })
    const managerTarball = join(packed, 'catwine901-dsh-workspace-manager-1.0.0.tgz')
    scanTarballContent(managerTarball, member => !member.endsWith('/'))

    const env = { ...process.env, DSH_HOME: home }
    await run(dshBin, ['plugin', '--profile', profileName, 'add', managerTarball], env)
    const installed = manifestAt(join(profileDir, 'package.json'))
    if (!installed.dsh?.profile?.bundles?.includes('@catwine901/dsh-workspace-manager')) {
      throw new Error('workspace manager install-chain did not add the manager bundle to the fresh profile')
    }

    writeProbe(managerProbe, 'pageAppManager')
    writeProbe(nativeProbe, 'sessions', 'pageAppManager')
    writeProfilePatch(join(profileDir, 'cordis.patch.yml'), managerProbe, false)
    await run(dshBin, ['--profile', profileName], { ...env, DSH_MANAGER_SMOKE_MARKER: marker }, 30_000)
    if (!existsSync(marker)) throw new Error('workspace manager install-chain started without activating pageAppManager')

    rmSync(marker, { force: true })
    writeProfilePatch(join(profileDir, 'cordis.patch.yml'), nativeProbe, true)
    await run(dshBin, ['--profile', profileName], { ...env, DSH_MANAGER_SMOKE_MARKER: marker }, 30_000)
    if (readFileSync(marker, 'utf8') !== 'forbidden-absent') {
      throw new Error('workspace manager install-chain disable left pageAppManager active')
    }

    rmSync(marker, { force: true })
    writeProfilePatch(join(profileDir, 'cordis.patch.yml'), managerProbe, false)
    await run(dshBin, ['--profile', profileName], { ...env, DSH_MANAGER_SMOKE_MARKER: marker }, 30_000)
    if (!existsSync(marker)) throw new Error('workspace manager install-chain did not reactivate pageAppManager')

    await run(dshBin, [
      'plugin', '--profile', profileName, 'remove', '@catwine901/dsh-workspace-manager',
    ], env)
    const uninstalled = manifestAt(join(profileDir, 'package.json'))
    if (uninstalled.dependencies?.['@catwine901/dsh-workspace-manager'] !== undefined
      || uninstalled.dsh?.profile?.bundles?.includes('@catwine901/dsh-workspace-manager') === true) {
      throw new Error('workspace manager install-chain uninstall retained the manager dependency or bundle')
    }

    return {
      tarballScanned: true,
      installedAndStarted: true,
      disabledWithNativeDsh: true,
      managerAbsentWhileDisabled: true,
      reenabled: true,
      uninstalled: true,
    }
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true })
  }
}

if (isEntry(import.meta.url)) {
  const repoRoot = process.cwd()
  const result = await runPageAppInstallChain({ repoRoot, dshBin: join(repoRoot, 'apps/cli/lib/bin.js') })
  console.log(JSON.stringify(result))
}
