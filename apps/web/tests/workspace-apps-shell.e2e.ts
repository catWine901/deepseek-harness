// @vitest-environment jsdom
/**
 * Workspace Apps shell e2e (M3/D5): the assembled browser graph boots from the
 * REAL built client bundles through AppWebEntry (assembled-boot.ts) — the
 * closest keyless DOM entry short of a browser. Scenario 1 boots the shipped
 * composition after external Workspace Manager extraction and asserts Native
 * DSH renders: the priority-1 fallback owns the built-in root seat, so the page
 * is not blank and no manager shell exists. Scenario 2 walks two Native DSH
 * start/stop cycles in the same document (no reload) to prove that fallback
 * ownership remains repeatable without reintroducing the external package.
 */
import { expect, it } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import {
  disposeAssembledApp, installAssembledBootEnv, mountAssembledApp,
} from './assembled-boot.ts'

installAssembledBootEnv()

it('boots shipped Native DSH without an external manager (fallback renders, root not blank)', async () => {
  mountAssembledApp('?fixture')
  // The manager shell is absent: no data-page-app-shell root occupant.
  await waitFor(() => {
    expect(document.querySelector('[data-page-app-shell]')).toBeNull()
  })
  // Native DSH renders through the fallback: the Sessions tree and the
  // branded sidebar reach the document.
  const tree = await screen.findByRole('tree', { name: 'Sessions' }, { timeout: 10_000 })
  expect(tree).toBeTruthy()
  expect(document.querySelector('[data-slot="sidebar"]')).not.toBeNull()
  expect(document.querySelector('[data-slot="sidebar.brand.mark"]')).not.toBeNull()
  expect(document.querySelector('[data-page-app-rail]')).toBeNull()
})

it('boots shipped Native DSH across two start/stop cycles without an external manager', async () => {
  // Cycle 1: shipped Native DSH owns the fallback root.
  mountAssembledApp('?fixture')
  await waitFor(() => {
    expect(document.querySelector('[data-page-app-shell]')).toBeNull()
  })
  expect(await screen.findByRole('tree', { name: 'Sessions' }, { timeout: 10_000 })).toBeTruthy()
  expect(document.querySelector('[data-slot="sidebar"]')).not.toBeNull()
  // Stop: the whole client tree disposes.
  await disposeAssembledApp()
  expect(document.querySelector('[data-page-app-shell]')).toBeNull()
  // Cycle 2: the fallback owns root and Native DSH renders again — same
  // document, no reload.
  mountAssembledApp('?fixture')
  await waitFor(() => {
    expect(document.querySelector('[data-page-app-shell]')).toBeNull()
  })
  const tree = await screen.findByRole('tree', { name: 'Sessions' }, { timeout: 10_000 })
  expect(tree).toBeTruthy()
  expect(document.querySelector('[data-slot="sidebar"]')).not.toBeNull()
  expect(document.querySelector('[data-slot="sidebar.brand.mark"]')).not.toBeNull()
  // Cleanup for the second mount is the shared env teardown; keep the first
  // mount's dispose idempotent-safe by disposing again after the assertions.
  await disposeAssembledApp()
})
