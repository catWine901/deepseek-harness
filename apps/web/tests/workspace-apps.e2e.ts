/**
 * Workspace Apps keyless e2e chain (M9): boot the REAL web composition with
 * the page-app manager activated through the launcher-owned profile runtime,
 * install the Cordis-free fixture through the real Settings add-flow, and
 * prove the full §54 chain end to end: host+client activation, React state
 * preservation across DSH round-trips, keep-mounted hide, disable/re-enable
 * (host+client+React unload and remount), manager-row suspension and
 * recovery, uninstall preserving user data, and workbench-lifecycle side-effect
 * release. Keyless: no scenario issues a model call (the route-only adapter
 * answers the provider catalog), so replay mode needs no recorded fixture.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { FiberState } from '@deepseek-ai/cordis'
import { managedRootWrapperId } from '@deepseek-ai/dsh-app-boot'
import { resolvePageAppProfilePaths } from '@deepseek-ai/dsh-page-app-profile'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'
import {
  DSH_RAIL_LABEL, FIXTURE_LABEL, FIXTURE_PAGE_ID, FIXTURE_PACKAGE,
  fixtureInBootGraph, fixtureSurface, installFixtureViaSettings,
  managerDisabledOverlayPath, openWorkspaceAppsTab, railRow, waitForFixtureRow,
} from './workspace-apps-e2e-support.ts'

/** Browser-visible accounting for the fixture's one-second lifecycle timer. */
interface IntervalProbe {
  /** Every observed one-second interval created after this document booted. */
  readonly created: number
  /** Observed intervals that were cleared at least once. */
  readonly cleared: number
  /** One-second intervals still live in this document. */
  readonly active: number
}

describe('web e2e: workspace apps keyless chain', () => {
  let scaffold: WebScaffold | undefined
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let sharedHarnessHome: string

  /** Boot a fresh page on the current scaffold and wait for the app frame. */
  async function bootPage(target: WebScaffold): Promise<{ page: Page; tripwire: ReturnType<typeof watchConsole> }> {
    const fresh = await newEnglishPage(browser)
    // Install before every document script. The fixture owns the only
    // one-second interval created after its fresh re-enable selection; the
    // probe lets the e2e assert that disable releases that actual timer before
    // navigation discards the document.
    await fresh.addInitScript(() => {
      const probe = { created: 0, cleared: 0, active: new Set<unknown>() }
      const setIntervalOriginal = window.setInterval.bind(window)
      const clearIntervalOriginal = window.clearInterval.bind(window)
      window.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
        const handle = setIntervalOriginal(handler, timeout, ...args)
        if (timeout === 1000) {
          probe.created++
          probe.active.add(handle)
        }
        return handle
      }) as typeof window.setInterval
      window.clearInterval = ((handle?: number) => {
        if (probe.active.delete(handle)) probe.cleared++
        clearIntervalOriginal(handle)
      }) as typeof window.clearInterval
      Object.defineProperty(window, '__DSH_WORKSPACE_APP_INTERVAL_PROBE__', {
        value: probe,
        configurable: false,
      })
    })
    const wire = watchConsole(fresh)
    await fresh.goto(target.baseUrl, { waitUntil: 'load' })
    await fresh.waitForSelector('[data-page-app-shell]', { timeout: 30_000 })
    return { page: fresh, tripwire: wire }
  }

  /** Snapshot this document's one-second interval lifecycle probe. */
  async function intervalProbe(target: Page): Promise<IntervalProbe> {
    return await target.evaluate(() => {
      const probe = (window as unknown as {
        __DSH_WORKSPACE_APP_INTERVAL_PROBE__?: {
          created: number
          cleared: number
          active: Set<unknown>
        }
      }).__DSH_WORKSPACE_APP_INTERVAL_PROBE__
      if (probe === undefined) throw new Error('workspace-app interval probe was not installed before document boot')
      return { created: probe.created, cleared: probe.cleared, active: probe.active.size }
    })
  }

  beforeAll(async () => {
    // Manager suspension needs a second Host over the same durable profile.
    // Keep that home outside each scaffold's own workspace so closing the
    // first Host releases its server without deleting the installed fixture.
    sharedHarnessHome = await mkdtemp(join(tmpdir(), 'dsh-web-e2e-home-'))
    scaffold = await launchWebScaffold({
      enablePageAppManager: true,
      harnessHome: sharedHarnessHome,
    })
    browser = await chromium.launch()
    const booted = await bootPage(scaffold)
    page = booted.page
    tripwire = booted.tripwire
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
    await rm(sharedHarnessHome, { recursive: true, force: true })
  })

  it('installs the fixture and awaits host and client activation', async () => {
    onTestFailed(() => saveFailureShot(page, 'workspace-apps-install'))
    // Host activation: the manager publishes the registry and the fixture row
    // reaches `ready` (dependency installed, manifest valid, wrapper active).
    // Keep this initiating client online: its bounded convergence path sends
    // the targeted acknowledgement before a later reload verifies the graph.
    await installFixtureViaSettings(page)
    // Client activation: the served client graph includes the fixture bundle
    // on the next page load (shared HMR is disabled in the shipped Web
    // composition), and the shell mounts the fixture surface on selection.
    await page.reload({ waitUntil: 'load' })
    await expect.poll(() => fixtureInBootGraph(page), { timeout: 20_000 }).toBe(true)
    await railRow(page, FIXTURE_LABEL).waitFor({ timeout: 20_000 })
    await railRow(page, FIXTURE_LABEL).click()
    await fixtureSurface(page).waitFor({ timeout: 20_000 })
    expect(await fixtureSurface(page).locator('[data-fixture-package]').textContent()).toBe(FIXTURE_PACKAGE)
    expect(tripwire.pageErrors).toEqual([])
  }, 180_000)

  it('selects the fixture and preserves its React state across DSH round-trips', async () => {
    onTestFailed(() => saveFailureShot(page, 'workspace-apps-state'))
    const surface = fixtureSurface(page)
    await surface.waitFor({ timeout: 15_000 })
    await surface.locator('[data-fixture-increment]').click()
    await surface.locator('[data-fixture-increment]').click()
    expect(await surface.locator('[data-fixture-count]').textContent()).toBe('2')
    const note = 'round-trip-note'
    await surface.locator('[data-fixture-note]').fill(note)
    // Round-trip: switch to the built-in DSH page, then back. The shell keeps
    // the visited surface mounted under its stable keyed seat.
    await railRow(page, DSH_RAIL_LABEL).click()
    expect(await page.locator('[data-page-id="dsh"]').isVisible()).toBe(true)
    await railRow(page, FIXTURE_LABEL).click()
    expect(await surface.locator('[data-fixture-count]').textContent()).toBe('2')
    expect(await surface.locator('[data-fixture-note]').inputValue()).toBe(note)
  }, 60_000)

  it('hide keeps the runtime mounted and falls back to DSH', async () => {
    onTestFailed(() => saveFailureShot(page, 'workspace-apps-hide'))
    let dialog = await openWorkspaceAppsTab(page)
    await dialog.getByRole('button', { name: 'Hide', exact: true }).click()
    // The shell falls back to the built-in DSH page while the fixture frame
    // stays mounted (keep-mounted + visibility, React 18 has no Activity API).
    expect(await page.locator('[data-page-id="dsh"]').isVisible()).toBe(true)
    const frame = page.locator(`[data-page-id="${FIXTURE_PAGE_ID}"]`)
    expect(await frame.getAttribute('hidden')).toBe('')
    // The mounted surface kept its state through the hide.
    expect(await frame.locator('[data-fixture-count]').textContent()).toBe('2')
    // Show restores the rail row; selecting it makes the kept frame visible.
    dialog = await openWorkspaceAppsTab(page)
    await dialog.getByRole('button', { name: 'Show', exact: true }).click()
    await page.keyboard.press('Escape')
    await railRow(page, FIXTURE_LABEL).click()
    expect(await page.locator(`[data-page-id="${FIXTURE_PAGE_ID}"]`).getAttribute('hidden')).toBeNull()
  }, 60_000)

  it('disable unloads host, client, and the React subtree', async () => {
    onTestFailed(() => saveFailureShot(page, 'workspace-apps-disable'))
    const dialog = await openWorkspaceAppsTab(page)
    await dialog.getByRole('button', { name: 'Disable', exact: true }).click()
    // In-session: the shell evicts the disabled page and the React subtree
    // unmounts; the rail row disappears with it.
    await expect.poll(() => page.locator('[data-page-app-fixture]').count(), { timeout: 20_000 }).toBe(0)
    expect(await railRow(page, FIXTURE_LABEL).count()).toBe(0)
    // Client unload: the served graph no longer carries the fixture bundle.
    await page.reload({ waitUntil: 'load' })
    await expect.poll(() => fixtureInBootGraph(page), { timeout: 20_000 }).toBe(false)
    expect(await page.locator('[data-page-app-fixture]').count()).toBe(0)
    // Native DSH renders through the shell.
    expect(await page.getByRole('tree', { name: 'Sessions' }).isVisible()).toBe(true)
  }, 120_000)

  it('re-enable remounts the fixture', async () => {
    onTestFailed(() => saveFailureShot(page, 'workspace-apps-reenable'))
    const dialog = await openWorkspaceAppsTab(page)
    await dialog.getByRole('button', { name: 'Enable', exact: true }).click()
    await waitForFixtureRow(page, 'ready')
    await page.reload({ waitUntil: 'load' })
    await expect.poll(() => fixtureInBootGraph(page), { timeout: 20_000 }).toBe(true)
    await railRow(page, FIXTURE_LABEL).click()
    await fixtureSurface(page).waitFor({ timeout: 20_000 })
    // This is the new generation's real one-second fixture timer, installed
    // by its React effect through the injected Workbench lifecycle face.
    await expect.poll(() => intervalProbe(page), { timeout: 10_000 })
      .toMatchObject({ created: expect.any(Number), active: expect.any(Number) })
    const mountedInterval = await intervalProbe(page)
    expect(mountedInterval.created).toBeGreaterThan(0)
    expect(mountedInterval.active).toBeGreaterThan(0)
    // Fresh remount: the previous generation's React state is gone.
    expect(await page.locator('[data-fixture-count]').textContent()).toBe('0')
  }, 120_000)

  it('fixture disposal releases its side effects', async () => {
    onTestFailed(() => saveFailureShot(page, 'workspace-apps-disposal'))
    // The fixture is active again. Its tick interval is created through the
    // Workbench lifecycle; while the surface is mounted it ticks.
    const tick = page.locator('[data-fixture-tick]')
    await tick.waitFor({ timeout: 15_000 })
    const before = Number(await tick.textContent())
    await expect.poll(async () => Number(await tick.textContent()) > before, { timeout: 5_000 }).toBe(true)
    const mountedInterval = await intervalProbe(page)
    expect(mountedInterval.active).toBeGreaterThan(0)
    // Disable releases the fixture: in-session unmount, then the served graph
    // drops the client bundle after reload — nothing of the old generation
    // survives to leak into the next.
    const dialog = await openWorkspaceAppsTab(page)
    await dialog.getByRole('button', { name: 'Disable', exact: true }).click()
    await expect.poll(() => page.locator('[data-page-app-fixture]').count(), { timeout: 20_000 }).toBe(0)
    // Assert release in the live document, before reload would discard a
    // leaked timer along with every other browser resource.
    await expect.poll(() => intervalProbe(page), { timeout: 10_000 }).toMatchObject({ active: 0 })
    const releasedInterval = await intervalProbe(page)
    expect(releasedInterval.cleared).toBeGreaterThanOrEqual(mountedInterval.active)
    expect(releasedInterval.created).toBe(releasedInterval.cleared)
    await page.reload({ waitUntil: 'load' })
    await expect.poll(() => fixtureInBootGraph(page), { timeout: 20_000 }).toBe(false)
    // Re-enable: a fresh apply remounts the surface with reset React state.
    await openWorkspaceAppsTab(page)
    await page.getByRole('button', { name: 'Enable', exact: true }).click()
    await waitForFixtureRow(page, 'ready')
    await page.reload({ waitUntil: 'load' })
    await railRow(page, FIXTURE_LABEL).click()
    await fixtureSurface(page).waitFor({ timeout: 20_000 })
    expect(await page.locator('[data-fixture-count]').textContent()).toBe('0')
  }, 120_000)

  it('manager row disable suspends the fixture (PENDING) and re-enable restores it', async () => {
    onTestFailed(() => saveFailureShot(page, 'workspace-apps-manager-suspend'))
    // The main scaffold's home still carries the installed fixture. Suspend
    // the manager through a boot-time overlay: the fixture wrapper waits on
    // the missing workbenchRuntime provider, so nothing of the fixture mounts.
    const main = scaffold
    if (main === undefined) throw new Error('main scaffold missing')
    const home = main.harnessHome
    const profileDir = join(home, 'profiles', 'scaffold')
    const assertFixtureRegistration = async (boundary: string): Promise<void> => {
      const registry = JSON.parse(await readFile(resolvePageAppProfilePaths(profileDir).registry, 'utf8')) as {
        entries?: { packageName: string }[]
      }
      expect(
        registry.entries?.some(entry => entry.packageName === FIXTURE_PACKAGE),
        `fixture registration must survive ${boundary}`,
      ).toBe(true)
    }
    await scaffold?.close()
    scaffold = undefined
    // Closing the host must release only its transient server. The registry is
    // the durable ownership authority used to reconstruct the manager layer.
    await assertFixtureRegistration('the initial host shutdown')
    const overlay = await managerDisabledOverlayPath()
    const suspended = await launchWebScaffold({
      harnessHome: home,
      enablePageAppManager: true,
      extraOverlayPath: overlay,
    })
    try {
      const booted = await bootPage(suspended)
      const suspendedPage = booted.page
      // The managed wrapper row is still composed from the durable registry,
      // but its required workbenchRuntime provider is absent because the
      // manager row is disabled. This is a real Loader PENDING state, not a
      // UI-only absence assertion.
      const wrapperId = managedRootWrapperId(FIXTURE_PAGE_ID)
      const wrapper = [...suspended.ctx.loader.entries()]
        .find(entry => entry.options.id === wrapperId)
      expect(wrapper, `managed wrapper ${wrapperId} must remain in the Loader tree`).toBeDefined()
      expect(wrapper?.fiber?.state).toBe(FiberState.PENDING)
      // The manager shell is present but sees no fixture: no rail row, no
      // surface, no managed surface seat rendered.
      expect(await suspendedPage.locator('[data-page-app-shell]').count()).toBe(1)
      expect(await railRow(suspendedPage, FIXTURE_LABEL).count()).toBe(0)
      expect(await suspendedPage.locator('[data-page-app-fixture]').count()).toBe(0)
      expect(await suspendedPage.getByRole('tree', { name: 'Sessions' }).isVisible()).toBe(true)
      expect(booted.tripwire.pageErrors).toEqual([])
      await suspendedPage.close()
    } finally {
      await suspended.close()
    }
    await assertFixtureRegistration('the manager-disabled host shutdown')
    // Re-enable the manager on the same home: the fixture recovers.
    scaffold = await launchWebScaffold({ harnessHome: home, enablePageAppManager: true })
    const booted = await bootPage(scaffold)
    page = booted.page
    tripwire = booted.tripwire
    await railRow(page, FIXTURE_LABEL).waitFor({ timeout: 30_000 })
    await railRow(page, FIXTURE_LABEL).click()
    await fixtureSurface(page).waitFor({ timeout: 20_000 })
    expect(await fixtureSurface(page).locator('[data-fixture-package]').textContent()).toBe(FIXTURE_PACKAGE)
  }, 240_000)

  it('uninstall removes the profile dependency and the registry row while user data survives', async () => {
    onTestFailed(() => saveFailureShot(page, 'workspace-apps-uninstall'))
    const main = scaffold
    if (main === undefined) throw new Error('scaffold missing for uninstall')
    const dialog = await openWorkspaceAppsTab(page)
    await dialog.getByRole('button', { name: 'Uninstall', exact: true }).click()
    await dialog.getByRole('alertdialog', { name: 'Uninstall this plugin?' }).getByRole('button', { name: 'Uninstall', exact: true }).click()
    // The row disappears once the transaction commits and removes the registry row.
    await expect.poll(() => page.locator(`[data-page-app-row="${FIXTURE_PAGE_ID}"]`).count(), { timeout: 30_000 }).toBe(0)
    // The profile dependency is gone.
    const profileDir = join(main.harnessHome, 'profiles', 'scaffold')
    const manifest = JSON.parse(await readFile(join(profileDir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    expect(manifest.dependencies?.[FIXTURE_PACKAGE]).toBeUndefined()
    // The registry survives as the ownership authority without the fixture row.
    const registry = JSON.parse(await readFile(resolvePageAppProfilePaths(profileDir).registry, 'utf8')) as {
      entries?: { packageName: string }[]
    }
    expect(registry.entries?.some(entry => entry.packageName === FIXTURE_PACKAGE)).toBe(false)
    // User data survives: the settings document (the welcome-notice ack the
    // scaffold wrote at boot) is untouched.
    const settings = await readFile(join(main.harnessHome, 'settings.yaml'), 'utf8')
    expect(settings).toContain('welcomeNoticeVersion')
  }, 120_000)
})
