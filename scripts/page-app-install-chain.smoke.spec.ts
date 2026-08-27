import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { stageWorkspaceManagerArtifacts } from './page-app-install-chain.smoke.ts'

const temporaryRoots: string[] = []

function artifactFixture(
  client: string,
  host = 'export const host = true\n',
): { repoRoot: string; clientBuildDirectory: string; extracted: string } {
  const repoRoot = mkdtempSync(join(tmpdir(), 'dsh-workspace-manager-artifacts-'))
  temporaryRoots.push(repoRoot)
  const hostLib = join(repoRoot, 'packages/host/page-app-manager/lib')
  const clientTypes = join(repoRoot, 'packages/client/ui-page-app-manager/lib/types/client')
  const clientBuildDirectory = join(repoRoot, 'client-build')
  const extracted = join(repoRoot, 'extracted')
  mkdirSync(hostLib, { recursive: true })
  mkdirSync(clientTypes, { recursive: true })
  mkdirSync(clientBuildDirectory, { recursive: true })
  mkdirSync(extracted, { recursive: true })
  writeFileSync(join(hostLib, 'index.js'), host)
  writeFileSync(join(clientTypes, 'index.d.ts'), 'export declare const client: true\n')
  writeFileSync(join(clientBuildDirectory, 'client.js'), client)
  return { repoRoot, clientBuildDirectory, extracted }
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('workspace manager install-chain packaging', () => {
  it('copies a path-free client build byte-for-byte into the extracted package', () => {
    const bytes = 'window.__ModuleLoader__.load({ id: "workspace-manager" })\n'
    const fixture = artifactFixture(bytes)

    stageWorkspaceManagerArtifacts(fixture)

    expect(readFileSync(join(fixture.extracted, 'lib/client.js'), 'utf8')).toBe(bytes)
  })

  it('rejects a path-bearing client build instead of rewriting it', () => {
    const fixture = artifactFixture(String.raw`//#region \0dsh-css:C:\Users\builder\Panel.css.mjs`)

    expect(() => { stageWorkspaceManagerArtifacts(fixture) }).toThrow('contains absolute path C:\\Users\\')
  })

  it('rejects a Host artifact that still requires the unpublished profile-core package', () => {
    const fixture = artifactFixture(
      'export const client = true\n',
      [
        "import { parsePageAppRegistry } from '@deepseek-ai/dsh-page-app-profile'",
        'export const host = parsePageAppRegistry',
        '',
      ].join('\n'),
    )

    expect(() => { stageWorkspaceManagerArtifacts(fixture) })
      .toThrow('@deepseek-ai/dsh-page-app-profile')
  })
})
