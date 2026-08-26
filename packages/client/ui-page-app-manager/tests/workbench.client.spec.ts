// @vitest-environment jsdom
// The manager-owned Workbench bridge must bind every registration to the
// Feature caller, rather than lending the Feature the raw slots service. A
// real Loader entry is required here because SlotRegistry derives immutable
// owner provenance from that entry.
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { describe, expect, it } from 'vitest'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-runtime/client'
import { apply, inject } from '../src/client/apply.ts'
import { PAGE_APP_SURFACE_SLOT } from '../src/client/contracts.ts'
import {
  PAGE_ID, PACKAGE_NAME, apply as applyFixture, inject as fixtureInject,
} from '../../../examples/page-app-fixture/src/client/index.tsx'

const FIXTURE_CLIENT_ENTRY = `${PACKAGE_NAME}/client`

describe('manager Workbench bridge', () => {
  it('injects one caller-bound workbench into the Feature and releases its owned surface and lifecycle', async () => {
    const ctx = new Context()
    await ctx.plugin(Loader)
    const slotsFiber = ctx.plugin(SlotRegistry)
    await slotsFiber.await()
    ctx.provide('locale', new LocaleRuntime(ctx))

    const loader = ctx.loader as unknown as {
      internal: unknown
      create(options: { name: string }): Promise<string>
      remove(id: string): Promise<void>
      await(): Promise<void>
    }
    loader.internal = {
      import: async (name: string) => {
        if (name !== FIXTURE_CLIENT_ENTRY) throw new Error(`unexpected entry ${name}`)
        return { inject: fixtureInject, apply: applyFixture }
      },
    }

    const managerFiber = ctx.plugin({ inject: [...inject], apply })
    await managerFiber.await()
    // The fixture is only granted the narrow workbench contract; it never
    // receives the raw slot ledger.
    expect(fixtureInject).toEqual(['workbench'])

    const entryId = await loader.create({ name: FIXTURE_CLIENT_ENTRY })
    await loader.await()
    const [surface] = ctx.slots.entries(PAGE_APP_SURFACE_SLOT)
    expect(surface).toMatchObject({
      ownerPackage: PACKAGE_NAME,
      options: { key: PAGE_ID },
    })

    const injected = (surface!.inject as () => { workbench: {
      lifecycle: { onDispose(callback: () => void): () => void }
    } })()
    let disposed = 0
    injected.workbench.lifecycle.onDispose(() => { disposed++ })

    await loader.remove(entryId)
    await loader.await()
    expect(ctx.slots.entries(PAGE_APP_SURFACE_SLOT)).toEqual([])
    expect(disposed).toBe(1)

    await managerFiber.dispose()
  })
})
