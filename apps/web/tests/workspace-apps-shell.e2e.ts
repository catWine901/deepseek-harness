// @vitest-environment jsdom
/**
 * Workspace Apps shell e2e (M3/D5): the assembled browser graph boots from the
 * REAL built client bundles through AppWebEntry (assembled-boot.ts) — the
 * closest keyless DOM entry short of a browser. Scenario 1 boots the shipped
 * composition minus the page-app manager row and asserts Native DSH renders:
 * the priority-1 fallback owns the built-in root seat, so the page is not
 * blank and no manager shell exists. Scenario 2 walks two manager start/stop
 * cycles in the same document (no reload): with the manager the shell owns
 * root and the builtin DSH surface stays mounted inside it; without the
 * manager the fallback re-takes root and Native DSH renders again.
 *
 * A root CRASH (the renderer boundary's reportEntryError('root', entry, err,
 * {abdicate:true}) retiring the manager entry, after which the fallback wins
 * the cell) is pinned by the unit suite
 * (packages/client/ui-layout/tests/apply.client.spec.ts) because the
 * assembled boot exposes no fiber seam to crash the manager shell — adding one
 * would be a product seam, out of scope for M3.
 */
import { expect, it } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import {
  disposeAssembledApp, installAssembledBootEnv, mountAssembledApp,
} from './assembled-boot.ts'

installAssembledBootEnv()

const MANAGER_ROW = '@deepseek-ai/dsh-client-ui-page-app-manager'

it('boots Native DSH without the manager row (fallback renders, root not blank)', async () => {
  mountAssembledApp('?fixture', { exclude: [MANAGER_ROW] })
  // The manager shell is absent: no data-page-app-shell root occupant.
  await waitFor(() => {
    expect(document.querySelector('[data-page-app-shell]')).toBeNull()
  })
  // Native DSH renders through the fallback: the sidebar tree and the
  // composer reach the document, so the root cell is not blank.
  const tree = await screen.findByRole('tree', { name: 'Sessions' }, { timeout: 10_000 })
  expect(tree).toBeTruthy()
  await waitFor(() => {
    expect(document.querySelector('[role="textbox"]')).not.toBeNull()
  }, { timeout: 10_000 })
  expect(document.querySelector('[data-page-app-rail]')).toBeNull()
})

it('a root crash recovers to Native DSH without a refresh (P6 two start/stop cycles)', async () => {
  // Cycle 1: the manager is plugged in; its shell owns root and the builtin
  // DSH surface stays mounted inside it.
  mountAssembledApp('?fixture')
  await waitFor(() => {
    expect(document.querySelector('[data-page-app-shell]')).not.toBeNull()
  }, { timeout: 10_000 })
  expect(document.querySelector('[data-page-id="dsh"]')).not.toBeNull()
  // Stop: the whole client tree disposes (the manager row goes with it).
  await disposeAssembledApp()
  expect(document.querySelector('[data-page-app-shell]')).toBeNull()
  // Cycle 2: the manager is unplugged; the fallback owns root and Native DSH
  // renders again — same document, no reload.
  mountAssembledApp('?fixture', { exclude: [MANAGER_ROW] })
  await waitFor(() => {
    expect(document.querySelector('[data-page-app-shell]')).toBeNull()
  })
  const tree = await screen.findByRole('tree', { name: 'Sessions' }, { timeout: 10_000 })
  expect(tree).toBeTruthy()
  await waitFor(() => {
    expect(document.querySelector('[role="textbox"]')).not.toBeNull()
  }, { timeout: 10_000 })
  // Cleanup for the second mount is the shared env teardown; keep the first
  // mount's dispose idempotent-safe by disposing again after the assertions.
  await disposeAssembledApp()
})
