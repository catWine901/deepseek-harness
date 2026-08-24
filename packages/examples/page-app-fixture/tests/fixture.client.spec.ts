/**
 * Fixture client skeleton spec: the client half registers a keyed workspace
 * surface through the contract entry `registerWorkspaceSurface` and the
 * disposer removes it. The registration is Cordis-free — the shared contract
 * package arrives with the Workbench Runtime (M7); until then the fixture owns
 * the entry locally so it stays self-contained and testable.
 */
import { describe, expect, it } from 'vitest'
import { registerWorkspaceSurface, workspaceSurface } from '../src/client/index.tsx'

const PACKAGE_NAME = '@deepseek-ai/dsh-page-app-fixture'

describe('page-app fixture client contract entry', () => {
  it('registers a keyed workspace surface through the contract entry and disposes it', () => {
    const dispose = registerWorkspaceSurface({
      pageId: 'dsh-page-app-fixture',
      packageName: PACKAGE_NAME,
      render: undefined,
    })
    expect(workspaceSurface('dsh-page-app-fixture')).toMatchObject({
      pageId: 'dsh-page-app-fixture',
      packageName: PACKAGE_NAME,
    })
    // Another page id is never confused with the registered key.
    expect(workspaceSurface('other-page')).toBeUndefined()
    dispose()
    expect(workspaceSurface('dsh-page-app-fixture')).toBeUndefined()
  })
})
