/** Fresh public-registry DSH consumer smoke for the standalone Workspace Manager tarball. */

import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { Browser, Page } from '../apps/web/node_modules/playwright/index.js'
import { execa } from 'execa'
import { openWorkspaceAppsTab } from '../apps/web/tests/workspace-apps-e2e-support.ts'
import { buildWorkspaceManagerHost } from './build-workspace-manager-host.ts'
import { extractWorkspaceManager } from './extract-workspace-manager.ts'
import { stageWorkspaceManagerArtifacts } from './page-app-install-chain.smoke.ts'
import { scanTarballContent } from './publication-payload.ts'
import { pnpmInvocation } from './pnpm-invocation.ts'
import { isEntry } from './release/process.ts'

const DSH_PACKAGE = '@deepseek-ai/dsh@0.1.1-rc.2'
const MANAGER_PACKAGE = '@tingyu9527/dsh-workspace-manager'
const FIXTURE_PACKAGE = '@fixture/dsh-workspace-app'
const PROFILE = 'web'
const COMMAND_TIMEOUT_MS = 300_000
const WEB_READY_TIMEOUT_MS = 90_000
const STOP_TIMEOUT_MS = 10_000

export interface CommandDiagnostic {
  readonly command: string
  readonly cwd: string
  readonly exitCode: number | null | undefined
  readonly stdout: string
  readonly stderr: string
}

interface PackReport {
  readonly filename: string
}

interface RunningWeb {
  readonly child: ChildProcessWithoutNullStreams
  readonly exited: Promise<void>
  readonly url: Promise<string>
}

/** Observable milestones of the fresh external-consumer gate. */
export interface PageAppExternalConsumerResult {
  readonly publishedDshInstalled: true
  readonly consumerBinResolved: true
  readonly strictPeerClosure: true
  readonly nonEmptyRegistryActive: true
  readonly managerServiceAndUiRegistered: true
  readonly disabledNativeBoot: true
  readonly reenabled: true
  readonly removedNativeBoot: true
}

function scrubbedEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/(?:KEY|SECRET|TOKEN|PASSWORD)/i.test(name)))
  return {
    ...env,
    ...overrides,
    DSH_TELEMETRY_DISABLED: '1',
    npm_config_audit: 'false',
    npm_config_fund: 'false',
  }
}

async function runCommand(
  file: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  diagnostics: CommandDiagnostic[],
  timeout = COMMAND_TIMEOUT_MS,
  displayCommand = `${file} ${args.join(' ')}`,
  streamOutput = false,
): Promise<string> {
  const subprocess = execa(file, [...args], {
    cwd,
    env,
    extendEnv: false,
    reject: false,
    killSignal: 'SIGKILL',
    shell: false,
  })
  if (streamOutput) {
    subprocess.stdout.pipe(process.stdout, { end: false })
    subprocess.stderr.pipe(process.stderr, { end: false })
  }
  const deadline = Symbol('command deadline')
  let timer: NodeJS.Timeout | undefined
  const outcome = await Promise.race([
    subprocess,
    new Promise<typeof deadline>((resolveDeadline) => {
      timer = setTimeout(() => { resolveDeadline(deadline) }, timeout)
    }),
  ])
  let result
  if (outcome === deadline) {
    const pid = subprocess.pid
    if (pid === undefined) throw new Error(`external consumer timed-out command has no pid: ${displayCommand}`)
    await terminateProcessTree(pid, subprocess.then(() => undefined), diagnostics)
    result = await subprocess
  } else {
    result = outcome
  }
  if (timer !== undefined) clearTimeout(timer)
  const record = {
    command: displayCommand,
    cwd,
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  }
  diagnostics.push(record)
  if (outcome === deadline) {
    throw new Error(
      `external consumer command timed out after ${String(timeout)}ms (${record.command})`
      + `\nstdout:\n${record.stdout}\nstderr:\n${record.stderr}`,
    )
  }
  if (result.exitCode !== 0) {
    throw new Error(
      `external consumer command failed (${record.command}): exit ${String(record.exitCode)}`
      + `\nstdout:\n${record.stdout}\nstderr:\n${record.stderr}`,
    )
  }
  return result.stdout
}

async function runPnpm(
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  diagnostics: CommandDiagnostic[],
): Promise<string> {
  const invocation = pnpmInvocation(args, env)
  return await runCommand(
    invocation.command,
    invocation.args,
    cwd,
    env,
    diagnostics,
    COMMAND_TIMEOUT_MS,
    `pnpm ${args.join(' ')}`,
  )
}

function parsePackFilename(stdout: string, packedDirectory: string): string {
  const parsed: unknown = JSON.parse(stdout)
  const report: unknown = Array.isArray(parsed) ? (parsed as readonly unknown[])[0] : parsed
  if (report === null || typeof report !== 'object' || typeof (report as PackReport).filename !== 'string') {
    throw new Error(`pnpm pack --json returned no filename: ${stdout}`)
  }
  const filename = (report as PackReport).filename
  return isAbsolute(filename) ? resolve(filename) : resolve(packedDirectory, filename)
}

async function buildManagerTarball(
  repoRoot: string,
  temporaryRoot: string,
  packedDirectory: string,
  env: NodeJS.ProcessEnv,
  diagnostics: CommandDiagnostic[],
): Promise<string> {
  const extracted = join(temporaryRoot, 'dsh-workspace-manager')
  const hostBuildDirectory = join(temporaryRoot, 'manager-host')
  const clientBuildDirectory = join(temporaryRoot, 'manager-client')
  extractWorkspaceManager(repoRoot, extracted, temporaryRoot)
  await buildWorkspaceManagerHost({ repoRoot, outputDirectory: hostBuildDirectory })
  const tsdown = join(repoRoot, 'node_modules/tsdown/dist/run.mjs')
  await runCommand(process.execPath, [
    tsdown,
    '--minify',
    '--out-dir', clientBuildDirectory,
    '--no-sourcemap',
  ], join(repoRoot, 'packages/client/ui-page-app-manager'), {
    ...env,
    DSH_PAGE_APP_MANAGER_CLIENT_MODULE_ID: MANAGER_PACKAGE,
  }, diagnostics)
  stageWorkspaceManagerArtifacts({ repoRoot, hostBuildDirectory, clientBuildDirectory, extracted })
  const output = await runPnpm([
    'pack', '--json', '--pack-destination', packedDirectory,
  ], extracted, env, diagnostics)
  const tarball = parsePackFilename(output, packedDirectory)
  if (!existsSync(tarball)) throw new Error(`pnpm pack reported missing tarball ${tarball}`)
  scanTarballContent(tarball, member => !member.endsWith('/'))
  return tarball
}

async function buildWorkspaceFixtureTarball(
  temporaryRoot: string,
  packedDirectory: string,
  env: NodeJS.ProcessEnv,
  diagnostics: CommandDiagnostic[],
): Promise<string> {
  const fixture = join(temporaryRoot, 'workspace-app-fixture')
  mkdirSync(fixture, { recursive: true })
  writeFileSync(join(fixture, 'package.json'), `${JSON.stringify({
    name: FIXTURE_PACKAGE,
    version: '1.0.0',
    type: 'module',
    main: './index.js',
    files: ['index.js', 'cordis.patch.yml'],
    dsh: {
      workspace: {
        schemaVersion: 1,
        id: 'fixture-page',
        name: 'Fixture Page',
        description: 'External consumer restart fixture',
        defaultOrder: 0,
        rootEntryId: 'fixture-root',
      },
      bundle: { patch: './cordis.patch.yml' },
    },
  }, null, 2)}\n`)
  writeFileSync(join(fixture, 'index.js'), [
    "export const name = 'fixture-workspace-app'",
    'export function apply() {}',
    '',
  ].join('\n'))
  writeFileSync(join(fixture, 'cordis.patch.yml'), [
    '- insert:',
    '    - id: fixture-root',
    `      name: '${FIXTURE_PACKAGE}'`,
    '',
  ].join('\n'))
  const output = await runPnpm([
    'pack', '--json', '--pack-destination', packedDirectory,
  ], fixture, env, diagnostics)
  const tarball = parsePackFilename(output, packedDirectory)
  if (!existsSync(tarball)) throw new Error(`fixture pack reported missing tarball ${tarball}`)
  return tarball
}

function writeFixtureRegistry(profileDirectory: string): void {
  const managerDirectory = join(profileDirectory, '.workspace-manager')
  mkdirSync(managerDirectory, { recursive: true })
  writeFileSync(join(managerDirectory, 'registry.json'), `${JSON.stringify({
    schemaVersion: 1,
    revision: 1,
    entries: [{
      packageName: FIXTURE_PACKAGE,
      source: { kind: 'registry', display: `${FIXTURE_PACKAGE}@1.0.0` },
      resolvedVersion: '1.0.0',
      page: {
        id: 'fixture-page',
        name: 'Fixture Page',
        description: 'External consumer restart fixture',
        defaultOrder: 0,
        rootEntryId: 'fixture-root',
      },
      order: 0,
      enabled: true,
      hidden: false,
      installedAt: '2026-08-27T00:00:00.000Z',
      updatedAt: '2026-08-27T00:00:00.000Z',
    }],
  }, null, 2)}\n`)
}

function resolveConsumerDshBin(consumer: string): string {
  const requireFromConsumer = createRequire(join(consumer, 'package.json'))
  const manifest = requireFromConsumer.resolve('@deepseek-ai/dsh/package.json')
  const bin = resolve(dirname(manifest), 'lib/bin.js')
  const relativeToConsumer = relative(resolve(consumer, 'node_modules'), bin)
  if (relativeToConsumer.startsWith('..') || isAbsolute(relativeToConsumer) || !existsSync(bin)) {
    throw new Error(`external consumer resolved dsh outside consumer node_modules: ${bin}`)
  }
  return bin
}

function webDiagnostics(child: ChildProcessWithoutNullStreams, cwd: string, diagnostics: CommandDiagnostic[]): {
  stdout: string[]
  stderr: string[]
} {
  const output = { stdout: [] as string[], stderr: [] as string[] }
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => { output.stdout.push(chunk) })
  child.stderr.on('data', (chunk: string) => { output.stderr.push(chunk) })
  child.once('exit', (exitCode) => {
    diagnostics.push({
      command: 'node <consumer node_modules>/@deepseek-ai/dsh/lib/bin.js web --no-open --host 127.0.0.1 --port 0',
      cwd,
      exitCode,
      stdout: output.stdout.join(''),
      stderr: output.stderr.join(''),
    })
  })
  return output
}

function startWeb(
  dshBin: string,
  consumer: string,
  env: NodeJS.ProcessEnv,
  diagnostics: CommandDiagnostic[],
): RunningWeb {
  const child = spawn(process.execPath, [
    dshBin, 'web', '--no-open', '--host', '127.0.0.1', '--port', '0',
  ], { cwd: consumer, env, stdio: 'pipe', windowsHide: true })
  const output = webDiagnostics(child, consumer, diagnostics)
  const exited = new Promise<void>((resolveExit, rejectExit) => {
    child.once('error', rejectExit)
    child.once('exit', () => { resolveExit() })
  })
  const url = new Promise<string>((resolveUrl, rejectUrl) => {
    const timer = setTimeout(() => {
      rejectUrl(new Error(
        `external consumer dsh web did not become ready in ${String(WEB_READY_TIMEOUT_MS)}ms`
        + `\nstdout:\n${output.stdout.join('')}\nstderr:\n${output.stderr.join('')}`,
      ))
    }, WEB_READY_TIMEOUT_MS)
    const inspect = (chunk: string): void => {
      const match = /dsh web: (http:\/\/127\.0\.0\.1:\d+)/.exec(chunk)
      if (match?.[1] !== undefined) {
        clearTimeout(timer)
        resolveUrl(match[1])
      }
    }
    child.stdout.on('data', inspect)
    child.stderr.on('data', inspect)
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      rejectUrl(new Error(
        `external consumer dsh web exited before ready: code ${String(code)}, signal ${String(signal)}`
        + `\nstdout:\n${output.stdout.join('')}\nstderr:\n${output.stderr.join('')}`,
      ))
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      rejectUrl(error)
    })
  })
  return { child, exited, url }
}

async function bounded(promise: Promise<void>, timeout: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined
  const timedOut = await Promise.race([
    promise.then(() => false),
    new Promise<true>((resolveTimeout) => { timer = setTimeout(() => { resolveTimeout(true) }, timeout) }),
  ])
  if (timer !== undefined) clearTimeout(timer)
  return timedOut
}

async function terminateProcessTree(
  pid: number,
  exited: Promise<void>,
  diagnostics: CommandDiagnostic[],
): Promise<void> {
  if (process.platform === 'win32') {
    const result = await execa('taskkill', ['/PID', String(pid), '/T', '/F'], {
      reject: false,
      timeout: STOP_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      shell: false,
    })
    diagnostics.push({
      command: `taskkill /PID ${String(pid)} /T /F`,
      cwd: process.cwd(),
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    })
    if (result.exitCode !== 0 && !/not found|not running|no running instance/iu.test(`${result.stdout}\n${result.stderr}`)) {
      throw new Error(`taskkill failed for process tree ${String(pid)}: ${result.stderr || result.stdout}`)
    }
  } else {
    try { process.kill(pid, 'SIGTERM') } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
    }
    if (await bounded(exited, STOP_TIMEOUT_MS)) {
      try { process.kill(pid, 'SIGKILL') } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error
      }
    }
  }
  if (await bounded(exited, STOP_TIMEOUT_MS)) {
    throw new Error(`external consumer process tree ${String(pid)} did not reach exit after termination`)
  }
}

async function stopWeb(running: RunningWeb, diagnostics: CommandDiagnostic[]): Promise<void> {
  if (running.child.exitCode !== null || running.child.signalCode !== null) {
    await running.exited
    return
  }
  running.child.kill('SIGTERM')
  if (!await bounded(running.exited, STOP_TIMEOUT_MS)) return
  const pid = running.child.pid
  if (pid === undefined) throw new Error('external consumer web process has no pid for forced cleanup')
  await terminateProcessTree(pid, running.exited, diagnostics)
}

async function openPage(browser: Browser, url: string): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: 'en-US' })
  const browserErrors: string[] = []
  page.on('console', (message) => {
    if (message.type() === 'error') browserErrors.push(`console: ${message.text()}`)
  })
  page.on('pageerror', (error) => { browserErrors.push(`pageerror: ${error.stack ?? error.message}`) })
  await page.goto(url, { waitUntil: 'load', timeout: 30_000 })
  try {
    await page.getByRole('tree', { name: 'Sessions' }).waitFor({ timeout: 30_000 })
  } catch (error) {
    const body = await page.locator('body').innerText().catch(() => '<body unavailable>')
    throw new Error(
      `external consumer page did not render Native Sessions at ${page.url()}`
      + `\nbody:\n${body.slice(0, 4_000)}\nbrowser errors:\n${browserErrors.join('\n')}`,
      { cause: error },
    )
  }
  const welcome = page.getByRole('button', { name: 'Continue', exact: true })
  const welcomeVisible = await welcome.waitFor({ state: 'visible', timeout: 3_000 })
    .then(() => true, () => false)
  if (welcomeVisible) {
    await welcome.click()
  }
  const later = page.getByRole('button', { name: 'Configure later', exact: true })
  const laterVisible = await later.waitFor({ state: 'visible', timeout: 3_000 })
    .then(() => true, () => false)
  if (laterVisible) {
    await later.click()
    await later.waitFor({ state: 'hidden', timeout: 15_000 })
  }
  return page
}

async function assertManagerRegistered(page: Page): Promise<void> {
  const dialog = await openWorkspaceAppsTab(page)
  try {
    await dialog.getByText(`Current Profile: ${PROFILE}`, { exact: true }).waitFor({ timeout: 30_000 })
    const fixture = dialog.locator('[data-page-app-row="fixture-page"]')
    await fixture.getByText('Fixture Page', { exact: true }).waitFor({ timeout: 30_000 })
    await fixture.locator('[data-health="ready"]').waitFor({ timeout: 30_000 })
  } catch (error) {
    throw new Error(`external consumer Workspace Apps content did not become ready\ndialog:\n${await dialog.innerText()}`, {
      cause: error,
    })
  }
}

async function assertManagerAbsent(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  await dialog.waitFor({ timeout: 15_000 })
  await dialog.getByRole('button', { name: 'Plugins', exact: true }).click()
  await dialog.getByRole('tablist').waitFor({ timeout: 15_000 })
  if (await dialog.getByRole('tab', { name: 'Workspace Apps', exact: true }).count() !== 0) {
    throw new Error('external consumer native DSH unexpectedly registered the Workspace Apps tab')
  }
}

function writeManagerOverlay(profileDirectory: string, disabled: boolean): void {
  writeFileSync(
    join(profileDirectory, 'cordis.patch.yml'),
    disabled ? '- id: page-app-manager\n  disabled: true\n' : '[]\n',
  )
}

function unlinkNestedLinks(path: string): void {
  if (!existsSync(path)) return
  const stat = lstatSync(path)
  if (stat.isSymbolicLink()) {
    unlinkSync(path)
    return
  }
  if (!stat.isDirectory()) return
  for (const name of readdirSync(path)) unlinkNestedLinks(join(path, name))
}

function formatDiagnostics(records: readonly CommandDiagnostic[]): string {
  return records.map(record => [
    `$ (cwd ${record.cwd}) ${record.command}`,
    `exit: ${String(record.exitCode)}`,
    `stdout:\n${record.stdout}`,
    `stderr:\n${record.stderr}`,
  ].join('\n')).join('\n\n')
}

/** Resolve the smoke result only after every cleanup outcome is known. */
export function finishExternalConsumerSmoke(
  result: PageAppExternalConsumerResult | undefined,
  failure: unknown,
  cleanupFailures: readonly unknown[],
  diagnostics: readonly CommandDiagnostic[],
): PageAppExternalConsumerResult {
  const causes = failure === undefined ? [...cleanupFailures] : [failure, ...cleanupFailures]
  if (causes.length > 0) {
    throw new AggregateError(causes, `external consumer smoke failed\n\n${formatDiagnostics(diagnostics)}`)
  }
  if (result === undefined) {
    throw new AggregateError(
      [new Error('external consumer smoke ended without a result')],
      `external consumer smoke failed\n\n${formatDiagnostics(diagnostics)}`,
    )
  }
  return result
}

/** Run the complete fresh public-registry DSH external-consumer lifecycle. */
export async function runPageAppExternalConsumer(repoRootInput = process.cwd()): Promise<PageAppExternalConsumerResult> {
  const repoRoot = resolve(repoRootInput)
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'dsh-workspace-manager-external-'))
  const consumer = join(temporaryRoot, 'consumer')
  const home = join(temporaryRoot, 'home')
  const packed = join(temporaryRoot, 'packed')
  const diagnostics: CommandDiagnostic[] = []
  const cleanupFailures: unknown[] = []
  let failure: unknown
  let result: PageAppExternalConsumerResult | undefined
  let browser: Browser | undefined
  let running: RunningWeb | undefined
  try {
    mkdirSync(consumer, { recursive: true })
    mkdirSync(home, { recursive: true })
    mkdirSync(packed, { recursive: true })
    writeFileSync(join(consumer, 'package.json'), '{"name":"dsh-external-consumer","private":true,"type":"module"}\n')
    const env = scrubbedEnvironment({ DSH_HOME: home })
    await runPnpm(['add', '--ignore-scripts', '--save-exact', DSH_PACKAGE], consumer, env, diagnostics)
    const dshBin = resolveConsumerDshBin(consumer)
    const overrideTarball = process.env.DSH_PAGE_APP_EXTERNAL_MANAGER_TARBALL
    const managerTarball = overrideTarball === undefined
      ? await buildManagerTarball(repoRoot, temporaryRoot, packed, env, diagnostics)
      : resolve(overrideTarball)
    if (!isAbsolute(managerTarball) || !existsSync(managerTarball)) {
      throw new Error(`external consumer manager tarball must be an existing absolute path: ${managerTarball}`)
    }
    await runCommand(process.execPath, [
      dshBin, 'plugin', '--profile', PROFILE, 'add', managerTarball,
    ], consumer, env, diagnostics)
    const profileDirectory = join(home, 'profiles', PROFILE)
    const fixtureTarball = await buildWorkspaceFixtureTarball(temporaryRoot, packed, env, diagnostics)
    await runPnpm(['add', '--save-exact', fixtureTarball], profileDirectory, env, diagnostics)
    writeFixtureRegistry(profileDirectory)
    await runPnpm([
      'install', '--frozen-lockfile', '--strict-peer-dependencies',
    ], profileDirectory, env, diagnostics)
    await runPnpm(['list', '--depth', 'Infinity'], profileDirectory, env, diagnostics)

    const playwrightRequire = createRequire(join(repoRoot, 'apps/web/package.json'))
    const { chromium } = playwrightRequire('playwright') as typeof import('../apps/web/node_modules/playwright/index.js')
    browser = await chromium.launch()

    running = startWeb(dshBin, consumer, env, diagnostics)
    let page = await openPage(browser, await running.url)
    await assertManagerRegistered(page)
    await page.close()
    await stopWeb(running, diagnostics)
    running = undefined

    writeManagerOverlay(profileDirectory, true)
    running = startWeb(dshBin, consumer, env, diagnostics)
    page = await openPage(browser, await running.url)
    await assertManagerAbsent(page)
    await page.close()
    await stopWeb(running, diagnostics)
    running = undefined

    writeManagerOverlay(profileDirectory, false)
    running = startWeb(dshBin, consumer, env, diagnostics)
    page = await openPage(browser, await running.url)
    await assertManagerRegistered(page)
    await page.close()
    await stopWeb(running, diagnostics)
    running = undefined

    await runCommand(process.execPath, [
      dshBin, 'plugin', '--profile', PROFILE, 'remove', MANAGER_PACKAGE,
    ], consumer, env, diagnostics)
    running = startWeb(dshBin, consumer, env, diagnostics)
    page = await openPage(browser, await running.url)
    await assertManagerAbsent(page)
    await page.close()

    result = {
      publishedDshInstalled: true,
      consumerBinResolved: true,
      strictPeerClosure: true,
      nonEmptyRegistryActive: true,
      managerServiceAndUiRegistered: true,
      disabledNativeBoot: true,
      reenabled: true,
      removedNativeBoot: true,
    }
  } catch (error) {
    failure = error
  } finally {
    if (browser !== undefined) {
      try { await browser.close() } catch (error) { cleanupFailures.push(error) }
    }
    if (running !== undefined) {
      try { await stopWeb(running, diagnostics) } catch (error) { cleanupFailures.push(error) }
    }
    try {
      unlinkNestedLinks(temporaryRoot)
      rmSync(temporaryRoot, { recursive: true, force: true })
    } catch (error) {
      cleanupFailures.push(error)
    }
  }
  return finishExternalConsumerSmoke(result, failure, cleanupFailures, diagnostics)
}

if (isEntry(import.meta.url)) {
  const result = await runPageAppExternalConsumer()
  console.log(`page-app-external-consumer: ${JSON.stringify(result)}`)
}
