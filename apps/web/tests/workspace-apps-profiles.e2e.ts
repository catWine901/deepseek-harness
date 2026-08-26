/**
 * Two-profile Workspace Apps e2e: two real Web compositions share one
 * Harness home while selecting different launcher-validated profiles. A
 * fixture installed and managed in either profile must remain absent from or
 * independent of the other profile's registry and served client graph.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { readPageAppRegistry } from '@deepseek-ai/dsh-page-app-profile'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'
import {
  FIXTURE_PAGE_ID, FIXTURE_PACKAGE, fixtureInBootGraph, installFixtureViaSettings,
  openWorkspaceAppsTab,
} from './workspace-apps-e2e-support.ts'

const PROFILE_A = 'profile-a'
const PROFILE_B = 'profile-b'

describe('web e2e: Workspace Apps profile isolation', () => {
  let sharedHarnessHome: string
  let browser: Browser
  let profileA: WebScaffold
  let profileB: WebScaffold | undefined
  let pageA: Page
  let pageB: Page | undefined
  let tripwireA: ReturnType<typeof watchConsole>
  let tripwireB: ReturnType<typeof watchConsole> | undefined

  /** Boot one English browser page against a selected profile. */
  async function bootPage(scaffold: WebScaffold): Promise<{
    page: Page
    tripwire: ReturnType<typeof watchConsole>
  }> {
    const page = await newEnglishPage(browser)
    const tripwire = watchConsole(page)
    await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
    await page.waitForSelector('[data-page-app-shell]', { timeout: 30_000 })
    return { page, tripwire }
  }

  beforeAll(async () => {
    sharedHarnessHome = await mkdtemp(join(tmpdir(), 'dsh-web-e2e-profiles-'))
    profileA = await launchWebScaffold({
      enablePageAppManager: true,
      harnessHome: sharedHarnessHome,
      profileName: PROFILE_A,
    })
    browser = await chromium.launch()
    const booted = await bootPage(profileA)
    pageA = booted.page
    tripwireA = booted.tripwire
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await profileB?.close()
    await profileA?.close()
    await rm(sharedHarnessHome, { recursive: true, force: true })
  })

  it('installs in Profile A and proves Profile B sees no row or code', async () => {
    onTestFailed(() => saveFailureShot(pageA, 'workspace-apps-profile-a-install'))
    await installFixtureViaSettings(pageA)
    await pageA.reload({ waitUntil: 'load' })
    await expect.poll(() => fixtureInBootGraph(pageA), { timeout: 20_000 }).toBe(true)

    profileB = await launchWebScaffold({
      enablePageAppManager: true,
      harnessHome: sharedHarnessHome,
      profileName: PROFILE_B,
    })
    const booted = await bootPage(profileB)
    pageB = booted.page
    tripwireB = booted.tripwire

    const dialog = await openWorkspaceAppsTab(pageB)
    expect(await dialog.locator(`[data-page-app-row="${FIXTURE_PAGE_ID}"]`).count()).toBe(0)
    expect(await fixtureInBootGraph(pageB)).toBe(false)
    const manifest = JSON.parse(await readFile(join(profileB.profileDir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }
    expect(manifest.dependencies?.[FIXTURE_PACKAGE]).toBeUndefined()
    expect(await readPageAppRegistry(profileB.profileDir)).toBeNull()
    expect(profileA.profileName).toBe(PROFILE_A)
    expect(profileB.profileName).toBe(PROFILE_B)
    expect(tripwireA.pageErrors).toEqual([])
    expect(tripwireB.pageErrors).toEqual([])
  }, 240_000)

  it('manages the same package independently in both profiles without crossing revisions or orders', async () => {
    const secondPage = pageB
    const secondScaffold = profileB
    if (secondPage === undefined || secondScaffold === undefined) {
      throw new Error('Profile B must boot in the preceding isolation scenario')
    }
    onTestFailed(() => saveFailureShot(secondPage, 'workspace-apps-profile-b-manage'))
    await installFixtureViaSettings(secondPage)

    const installedA = await readPageAppRegistry(profileA.profileDir)
    const installedB = await readPageAppRegistry(secondScaffold.profileDir)
    expect(installedA).toMatchObject({
      revision: 1,
      entries: [{ packageName: FIXTURE_PACKAGE, order: 100, hidden: false }],
    })
    expect(installedB).toMatchObject({
      revision: 1,
      entries: [{ packageName: FIXTURE_PACKAGE, order: 100, hidden: false }],
    })

    await profileA.ctx.pageAppManager.reorder([FIXTURE_PAGE_ID])
    const reorderedA = await readPageAppRegistry(profileA.profileDir)
    const untouchedB = await readPageAppRegistry(secondScaffold.profileDir)
    expect(reorderedA).toMatchObject({ revision: 2, entries: [{ order: 1, hidden: false }] })
    expect(untouchedB).toMatchObject({ revision: 1, entries: [{ order: 100, hidden: false }] })

    await secondScaffold.ctx.pageAppManager.setHidden(FIXTURE_PAGE_ID, true)
    await secondScaffold.ctx.pageAppManager.setHidden(FIXTURE_PAGE_ID, false)
    const untouchedA = await readPageAppRegistry(profileA.profileDir)
    const managedB = await readPageAppRegistry(secondScaffold.profileDir)
    expect(untouchedA).toMatchObject({ revision: 2, entries: [{ order: 1, hidden: false }] })
    expect(managedB).toMatchObject({ revision: 3, entries: [{ order: 100, hidden: false }] })
    expect(tripwireA.pageErrors).toEqual([])
    expect(tripwireB?.pageErrors).toEqual([])
  }, 240_000)
})
