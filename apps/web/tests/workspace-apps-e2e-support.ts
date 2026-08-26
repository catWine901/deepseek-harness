/**
 * B-private test helpers for the Workspace Apps keyless e2e chain
 * (workspace-apps.e2e.ts): driving the real Settings add-flow, the fixture
 * surface and rail locators, the served client-graph inspection, and the
 * manager-row-disable overlay. Never shipped into a production package.
 */
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Locator, Page } from 'playwright'
import { REPO_ROOT } from './support.ts'

/** The fixture's package name (the registry row's packageName). */
export const FIXTURE_PACKAGE = '@deepseek-ai/dsh-page-app-fixture'
/** The fixture's managed page id (rail/surface seat key). */
export const FIXTURE_PAGE_ID = 'dsh-page-app-fixture'
/** The fixture's manifest page name (the rail row label). */
export const FIXTURE_LABEL = 'Page App Fixture'
/** The built-in DSH rail row label. */
export const DSH_RAIL_LABEL = 'DSH / Agent'
/** The bundle-patch row id of the Host page-app manager. */
export const PAGE_APP_MANAGER_ROW_ID = 'page-app-manager'
/** The link: install spec the Settings add-flow installs the fixture with. */
export const FIXTURE_INSTALL_SPEC = `link:${join(REPO_ROOT, 'packages/examples/page-app-fixture').replace(/\\/g, '/')}`

/** The fixture surface root locator. */
export function fixtureSurface(page: Page): Locator {
  return page.locator('[data-page-app-fixture]')
}

/** The rail row locator of one page id. */
export function railRow(page: Page, label: string): Locator {
  return page.getByRole('button', { name: label, exact: true })
}

/**
 * Open Settings → Plugins → the Workspace Apps tab and return the settings
 * dialog. The tab is registered by the page-app manager client, so this works
 * with the manager row inert (the stub projection) and active alike.
 * @param page - the page under test.
 */
export async function openWorkspaceAppsTab(page: Page): Promise<Locator> {
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  if (await dialog.count() > 0) {
    await page.keyboard.press('Escape')
    await expectDialogClosed(page)
  }
  const settings = page.getByRole('button', { name: 'Settings', exact: true })
  // Settings lives in the built-in DSH surface, which the page-app shell keeps
  // mounted but hides while a managed surface is active. Return to DSH before
  // opening it; this is navigation through the product rail, not a test-only
  // escape hatch, and the fixture's keyed seat remains mounted for its state
  // assertions.
  if (await settings.count() === 0) {
    await railRow(page, DSH_RAIL_LABEL).click()
    await settings.waitFor({ timeout: 15_000 })
  }
  await settings.click()
  await dialog.waitFor({ timeout: 15_000 })
  await dialog.getByRole('button', { name: 'Plugins', exact: true }).click()
  const tab = dialog.getByRole('tab', { name: 'Workspace Apps', exact: true })
  await tab.waitFor({ timeout: 15_000 })
  await tab.click()
  return dialog
}

/** Wait for the settings dialog to close (escaped before reopening). */
async function expectDialogClosed(page: Page): Promise<void> {
  const dialog = page.getByRole('dialog', { name: 'Settings' })
  for (let attempt = 0; attempt < 50; attempt++) {
    if (await dialog.count() === 0) return
    await page.waitForTimeout(100)
  }
}

/**
 * Install the fixture through the real Settings add-flow and wait for its row
 * to reach the given health. The initiating page must stay mounted through the
 * transaction: it owns the targeted client acknowledgement, and Web's disabled
 * shared HMR uses the controller's bounded convergence path before that ack.
 * @param page - the page under test.
 * @param health - the row health to wait for (default `ready`).
 * @param timeoutMs - wait budget, including the real local package operation.
 */
export async function installFixtureViaSettings(page: Page, health = 'ready', timeoutMs = 160_000): Promise<void> {
  const dialog = await openWorkspaceAppsTab(page)
  const input = dialog.getByRole('textbox', { name: 'npm package, git URL, or local path' })
  await input.fill(FIXTURE_INSTALL_SPEC)
  await dialog.getByRole('button', { name: 'Install', exact: true }).click()
  await waitForFixtureRow(page, health, timeoutMs)
}

/**
 * Wait until the fixture's Settings row shows one health state. The row exists
 * once the manager published the registry; the health is projected from the
 * installed dependency, manifest, wrapper resolvability, and loader fiber.
 * @param page - the page under test.
 * @param health - the expected projected health value.
 * @param timeoutMs - wait budget.
 */
export async function waitForFixtureRow(page: Page, health: string, timeoutMs = 60_000): Promise<void> {
  // Assert the user-visible state inside the fixture's uniquely keyed row.
  // `data-health` is an implementation detail of the source component and
  // is not part of the served bundle's DOM contract.
  const label = health === 'ready' ? 'Ready' : health
  await page.locator(`[data-page-app-row="${FIXTURE_PAGE_ID}"]`)
    .getByText(label, { exact: true })
    .waitFor({ timeout: timeoutMs })
}

/** The client graph ids the served page booted with. */
export async function bootEntryIds(page: Page): Promise<string[]> {
  return await page.evaluate(() => {
    const boot = (window as unknown as { __DSH_BOOT__?: { entries: { id: string }[] } }).__DSH_BOOT__
    return boot?.entries.map(entry => entry.id) ?? []
  })
}

/** Whether the booted client graph carries the fixture bundle. */
export async function fixtureInBootGraph(page: Page): Promise<boolean> {
  return (await bootEntryIds(page)).includes(FIXTURE_PACKAGE)
}

/**
 * Write a patch overlay that disables the Host page-app manager row, for a
 * scaffold boot against a profile where the manager must stay inert (the
 * fixture then never mounts — provider suspension without a second lifecycle).
 * @returns the overlay path (caller owns the temp dir lifetime).
 */
export async function managerDisabledOverlayPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-web-e2e-manager-off-'))
  const file = join(dir, 'manager-disabled.patch.yml')
  await writeFile(file, `- id: ${PAGE_APP_MANAGER_ROW_ID}\n  disabled: true\n`)
  return file
}
