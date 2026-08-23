import { mkdir, mkdtemp, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parsePageAppRegistry, readPageAppRegistry, writePageAppRegistry } from '../src/registry.ts'
import { resolvePageAppProfilePaths } from '../src/paths.ts'
import type { PageAppRegistryV1 } from '../src/types.ts'

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dsh-page-app-registry-'))
}

function entry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    packageName: '@scope/example-page',
    source: { kind: 'git', display: 'https://github.com/deepseek-ai/example-page.git' },
    resolvedVersion: '1.2.3',
    page: {
      id: 'example.page',
      name: 'Example',
      description: 'Example full-page app',
      defaultOrder: 100,
      rootEntryId: 'example-page-root',
    },
    order: 100,
    enabled: true,
    hidden: false,
    installedAt: '2026-08-22T00:00:00.000Z',
    updatedAt: '2026-08-22T00:00:00.000Z',
    ...overrides,
  }
}

function registry(entries: unknown[], revision: unknown = 1): Record<string, unknown> {
  return { schemaVersion: 1, revision, entries }
}

describe('parsePageAppRegistry', () => {
  it('parses a valid v1 registry', () => {
    const parsed = parsePageAppRegistry(registry([entry()]))
    expect(parsed.schemaVersion).toBe(1)
    expect(parsed.revision).toBe(1)
    expect(parsed.entries).toHaveLength(1)
    expect(parsed.entries[0]?.packageName).toBe('@scope/example-page')
  })

  it('accepts an empty entry list', () => {
    expect(parsePageAppRegistry(registry([])).entries).toEqual([])
  })

  it('rejects unknown registry schema versions', () => {
    for (const schemaVersion of [0, 2, '1', null]) {
      expect(() => parsePageAppRegistry({ ...registry([entry()]), schemaVersion })).toThrow(/schemaVersion/)
    }
  })

  it('rejects a non-integer or negative revision', () => {
    for (const revision of [1.5, -1, '1', NaN, null]) {
      expect(() => parsePageAppRegistry(registry([entry()], revision))).toThrow(/revision/)
    }
  })

  it('rejects wrong entry field types', () => {
    const page = (entry() as { page: Record<string, unknown> }).page
    expect(() => parsePageAppRegistry(registry([entry({ order: '100' })]))).toThrow(/order/)
    expect(() => parsePageAppRegistry(registry([entry({ enabled: 'yes' })]))).toThrow(/enabled/)
    expect(() => parsePageAppRegistry(registry([entry({ source: { kind: 'disk', display: 'x' } })]))).toThrow(/source/)
    expect(() => parsePageAppRegistry(registry([entry({ resolvedVersion: 12 })]))).toThrow(/resolvedVersion/)
    expect(() => parsePageAppRegistry(registry([entry({ installedAt: 123 })]))).toThrow(/installedAt/)
    expect(() => parsePageAppRegistry(registry([entry({ page: { ...page, defaultOrder: 1.5 } })]))).toThrow(/defaultOrder/)
  })

  it('rejects unknown keys at every registry level', () => {
    const page = (entry() as { page: Record<string, unknown> }).page
    expect(() => parsePageAppRegistry({ ...registry([entry()]), extra: true })).toThrow(/Unrecognized key/)
    expect(() => parsePageAppRegistry(registry([entry({ extra: true })]))).toThrow(/Unrecognized key/)
    expect(() => parsePageAppRegistry(registry([entry({ source: { kind: 'git', display: 'x', extra: true } })])))
      .toThrow(/Unrecognized key/)
    expect(() => parsePageAppRegistry(registry([entry({ page: { ...page, extra: true } })]))).toThrow(/Unrecognized key/)
  })

  it('rejects duplicate package names, page ids, and root entry ids', () => {
    const base = entry() as { page: { id: string; rootEntryId: string } }
    const dupPackage = entry({ page: { ...base.page, id: 'other.page', rootEntryId: 'other-root' } })
    expect(() => parsePageAppRegistry(registry([entry(), dupPackage]))).toThrow(/package name/i)
    const dupPageId = entry({ packageName: '@scope/other', page: { ...base.page, rootEntryId: 'other-root' } })
    expect(() => parsePageAppRegistry(registry([entry(), dupPageId]))).toThrow(/page id/i)
    const dupRootId = entry({ packageName: '@scope/other', page: { ...base.page, id: 'other.page' } })
    expect(() => parsePageAppRegistry(registry([entry(), dupRootId]))).toThrow(/root/i)
  })

  it('rejects credential-bearing source displays so secrets never persist', () => {
    expect(() => parsePageAppRegistry(registry([
      entry({ source: { kind: 'git', display: 'https://user:secret@github.com/deepseek-ai/example-page.git' } }),
    ]))).toThrow(/credential/i)
    expect(() => parsePageAppRegistry(registry([
      entry({ source: { kind: 'registry', display: 'https://token@npm.pkg.github.com/@scope/example-page' } }),
    ]))).toThrow(/credential/i)
    expect(() => parsePageAppRegistry(registry([
      entry({ source: { kind: 'git', display: 'https:user:secret@example.com/path' } }),
    ]))).toThrow(/credential/i)
  })

  it('returns entries in stable order: order ascending, then package name', () => {
    const base = entry() as { page: { id: string; rootEntryId: string } }
    const beta = entry({ packageName: '@scope/beta', page: { ...base.page, id: 'beta.page', rootEntryId: 'beta-root' }, order: 10 })
    const alpha = entry({ packageName: '@scope/alpha', page: { ...base.page, id: 'alpha.page', rootEntryId: 'alpha-root' }, order: 10 })
    const charlie = entry({ packageName: '@scope/charlie', page: { ...base.page, id: 'charlie.page', rootEntryId: 'charlie-root' }, order: 5 })
    const parsed = parsePageAppRegistry(registry([beta, alpha, charlie]))
    expect(parsed.entries.map(row => row.packageName)).toEqual(['@scope/charlie', '@scope/alpha', '@scope/beta'])
  })

  it('returns deeply immutable data that refuses mutation', () => {
    const parsed = parsePageAppRegistry(registry([entry()]))
    expect(Object.isFrozen(parsed)).toBe(true)
    expect(Object.isFrozen(parsed.entries)).toBe(true)
    const row = parsed.entries[0]!
    expect(Object.isFrozen(row)).toBe(true)
    expect(Object.isFrozen(row.source)).toBe(true)
    expect(Object.isFrozen(row.page)).toBe(true)
    expect(() => { (parsed as { revision: number }).revision = 2 }).toThrow(TypeError)
    expect(() => { (row as { enabled: boolean }).enabled = false }).toThrow(TypeError)
    expect(() => { (row.source as { display: string }).display = 'x' }).toThrow(TypeError)
    expect(() => { (row.page as { name: string }).name = 'x' }).toThrow(TypeError)
    expect(() => { (parsed.entries as unknown as unknown[]).push(row) }).toThrow(TypeError)
  })
})

describe('writePageAppRegistry', () => {
  it('persists a validated registry at the exact path with round-trippable content', async () => {
    const profile = await scratch()
    const paths = resolvePageAppProfilePaths(profile)
    await mkdir(paths.directory, { recursive: true, mode: 0o700 })
    const value = parsePageAppRegistry(registry([entry()]))

    await writePageAppRegistry(profile, value)

    if (process.platform !== 'win32') {
      expect((await stat(paths.registry)).mode & 0o777).toBe(0o600)
    }
    expect(await readPageAppRegistry(profile)).toEqual(value)
  })

  it('refuses to persist a credential-bearing registry and creates nothing', async () => {
    const profile = await scratch()
    const paths = resolvePageAppProfilePaths(profile)
    const credentialed = {
      schemaVersion: 1,
      revision: 1,
      entries: [entry({ source: { kind: 'git', display: 'https://user:secret@github.com/deepseek-ai/example-page.git' } })],
    } as unknown as PageAppRegistryV1

    await expect(writePageAppRegistry(profile, credentialed)).rejects.toThrow(/credential/i)
    await expect(stat(paths.registry)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses to persist a non-// credential-bearing display and creates nothing', async () => {
    const profile = await scratch()
    const paths = resolvePageAppProfilePaths(profile)
    const credentialed = {
      schemaVersion: 1,
      revision: 1,
      entries: [entry({ source: { kind: 'git', display: 'https:user:secret@example.com/path' } })],
    } as unknown as PageAppRegistryV1

    await expect(writePageAppRegistry(profile, credentialed)).rejects.toThrow(/credential/i)
    await expect(stat(paths.registry)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses to persist an invalid registry and creates nothing', async () => {
    const profile = await scratch()
    const paths = resolvePageAppProfilePaths(profile)
    const invalid = { schemaVersion: 1, revision: -1, entries: [entry()] } as unknown as PageAppRegistryV1

    await expect(writePageAppRegistry(profile, invalid)).rejects.toThrow(/revision/i)
    await expect(stat(paths.registry)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
