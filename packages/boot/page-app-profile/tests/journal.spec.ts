import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  advancePageAppJournalPhase,
  parsePageAppJournal,
  readPageAppJournal,
  removePageAppJournal,
  snapshotPageAppJournalFiles,
  writePageAppJournal,
} from '../src/journal.ts'
import { resolvePageAppProfilePaths } from '../src/paths.ts'

async function scratch(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dsh-page-app-journal-'))
}

function journal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    phase: 'prepared',
    lockOwnerToken: 'token-1',
    files: { 'registry.json': { present: true, sha256: 'a'.repeat(64) } },
    ...overrides,
  }
}

describe('parsePageAppJournal', () => {
  it('parses a valid v1 journal', () => {
    const parsed = parsePageAppJournal(journal())
    expect(parsed.schemaVersion).toBe(1)
    expect(parsed.phase).toBe('prepared')
    expect(parsed.lockOwnerToken).toBe('token-1')
    expect(parsed.files['registry.json']).toEqual({ present: true, sha256: 'a'.repeat(64) })
  })

  it('rejects unknown journal schema versions', () => {
    for (const schemaVersion of [0, 2, '1']) {
      expect(() => parsePageAppJournal({ ...journal(), schemaVersion })).toThrow(/schemaVersion/)
    }
  })

  it('rejects unknown phases and unknown keys', () => {
    for (const phase of ['aborted', 'committed', 'done']) {
      expect(() => parsePageAppJournal({ ...journal(), phase })).toThrow(/phase/)
    }
    expect(() => parsePageAppJournal({ ...journal(), extra: true })).toThrow(/Unrecognized key/)
    expect(() => parsePageAppJournal(journal({ files: { 'registry.json': { present: true, sha256: 'a'.repeat(64), extra: true } } })))
      .toThrow(/Unrecognized key/)
  })

  it('requires the lock owner token and well-formed file states', () => {
    expect(() => parsePageAppJournal({ ...journal(), lockOwnerToken: '' })).toThrow(/lockOwnerToken/)
    expect(() => parsePageAppJournal({ ...journal(), lockOwnerToken: undefined })).toThrow(/lockOwnerToken/)
    expect(() => parsePageAppJournal({ ...journal(), files: { x: { present: true } } })).toThrow(/sha256/)
    expect(() => parsePageAppJournal({ ...journal(), files: { x: { present: false, sha256: 'a'.repeat(64) } } })).toThrow()
    expect(() => parsePageAppJournal({ ...journal(), files: { x: { present: true, sha256: 'not-hex' } } })).toThrow(/sha256/)
  })

  it('rejects unsafe lock owner tokens that could escape the manager directory', () => {
    for (const token of ['../evil', 'a/b', 'a\\b', '..', '.', 'token with space', 'https://x']) {
      expect(() => parsePageAppJournal({ ...journal(), lockOwnerToken: token })).toThrow(/lockOwnerToken|token/i)
    }
  })

  it('returns deeply immutable data', () => {
    const parsed = parsePageAppJournal(journal())
    expect(Object.isFrozen(parsed)).toBe(true)
    expect(Object.isFrozen(parsed.files)).toBe(true)
    expect(Object.isFrozen(parsed.files['registry.json'])).toBe(true)
    expect(() => { (parsed as { phase: string }).phase = 'committing' }).toThrow(TypeError)
  })
})

describe('advancePageAppJournalPhase', () => {
  it('advances prepared -> staged -> committing', () => {
    const prepared = parsePageAppJournal(journal())
    const staged = advancePageAppJournalPhase(prepared, 'staged')
    expect(staged.phase).toBe('staged')
    expect(staged.lockOwnerToken).toBe('token-1')
    const committing = advancePageAppJournalPhase(staged, 'committing')
    expect(committing.phase).toBe('committing')
  })

  it('rejects backward, skipped, and repeated transitions', () => {
    const prepared = parsePageAppJournal(journal())
    const staged = advancePageAppJournalPhase(prepared, 'staged')
    const committing = advancePageAppJournalPhase(staged, 'committing')
    expect(() => advancePageAppJournalPhase(prepared, 'committing')).toThrow(/prepared|committing/)
    expect(() => advancePageAppJournalPhase(staged, 'prepared')).toThrow(/staged|prepared/)
    expect(() => advancePageAppJournalPhase(committing, 'staged')).toThrow(/committing|staged/)
    expect(() => advancePageAppJournalPhase(committing, 'committing')).toThrow(/committing/)
  })
})

describe('journal persistence', () => {
  it('snapshots before-file hashes and writes 0600 private backup files', async () => {
    const profile = await scratch()
    const paths = resolvePageAppProfilePaths(profile)
    await mkdir(paths.directory, { recursive: true, mode: 0o700 })
    await writeFile(paths.registry, 'registry-content', { mode: 0o600 })

    const files = await snapshotPageAppJournalFiles(profile, ['registry.json', 'missing.json'])

    expect(Object.isFrozen(files)).toBe(true)
    expect(files['registry.json']).toEqual({ present: true, sha256: createHash('sha256').update('registry-content').digest('hex') })
    expect(files['missing.json']).toEqual({ present: false })
    expect(await readFile(`${paths.registry}.backup`, 'utf8')).toBe('registry-content')
    if (process.platform !== 'win32') {
      expect((await stat(`${paths.registry}.backup`)).mode & 0o777).toBe(0o600)
    }
  })

  it('refuses traversal and absolute paths and never writes outside the profile', async () => {
    const profile = await scratch()
    const paths = resolvePageAppProfilePaths(profile)
    await mkdir(paths.directory, { recursive: true, mode: 0o700 })
    const outside = resolve(dirname(profile), 'escaped-secret')
    await writeFile(outside, 'outside-content', { mode: 0o600 })

    const escaping = join('..', '..', 'outside-target')
    await expect(snapshotPageAppJournalFiles(profile, [escaping])).rejects.toThrow(/profile|escape/i)
    await expect(stat(resolve(profile, escaping))).rejects.toMatchObject({ code: 'ENOENT' })
    const absolute = process.platform === 'win32' ? 'C:\\evil\\registry.json' : '/evil/registry.json'
    await expect(snapshotPageAppJournalFiles(profile, [absolute])).rejects.toThrow(/absolute|profile/i)
    // The escaped source file was never touched and no backup appeared beside it.
    await expect(stat(`${outside}.backup`)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(outside, 'utf8')).toBe('outside-content')
  })

  it('snapshots the profile manifest through a contained ../ relative path', async () => {
    const profile = await scratch()
    const paths = resolvePageAppProfilePaths(profile)
    await mkdir(paths.directory, { recursive: true, mode: 0o700 })
    await writeFile(join(profile, 'package.json'), '{"name":"profile"}', { mode: 0o600 })

    const files = await snapshotPageAppJournalFiles(profile, ['../package.json'])

    expect(files['../package.json']).toEqual({
      present: true,
      sha256: createHash('sha256').update('{"name":"profile"}').digest('hex'),
    })
    expect(await readFile(join(profile, 'package.json.backup'), 'utf8')).toBe('{"name":"profile"}')
  })

  it('refuses a symlinked directory that escapes the profile and never backs up outside', async (ctx) => {
    const profile = await scratch()
    const paths = resolvePageAppProfilePaths(profile)
    await mkdir(paths.directory, { recursive: true, mode: 0o700 })
    const outsideDir = join(await scratch(), 'target')
    await mkdir(outsideDir, { recursive: true })
    await writeFile(join(outsideDir, 'secret.txt'), 'secret-content', { mode: 0o600 })
    try {
      await symlink(outsideDir, join(paths.directory, 'evil'), process.platform === 'win32' ? 'junction' : 'dir')
    } catch (error) {
      if (['EPERM', 'EACCES', 'UNKNOWN'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        ctx.skip()
        return
      }
      throw error
    }

    await expect(snapshotPageAppJournalFiles(profile, ['evil/secret.txt']))
      .rejects.toThrow(/outside|profile|symlink/i)
    await expect(stat(join(outsideDir, 'secret.txt.backup'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(outsideDir, 'secret.txt'), 'utf8')).toBe('secret-content')
  })

  it('refuses a symlinked source file pointing outside and never writes its backup', async (ctx) => {
    const profile = await scratch()
    const paths = resolvePageAppProfilePaths(profile)
    await mkdir(paths.directory, { recursive: true, mode: 0o700 })
    const outsideDir = join(await scratch(), 'target')
    await mkdir(outsideDir, { recursive: true })
    await writeFile(join(outsideDir, 'secret.json'), 'secret-json', { mode: 0o600 })
    try {
      await symlink(join(outsideDir, 'secret.json'), join(paths.directory, 'link.json'))
    } catch (error) {
      if (['EPERM', 'EACCES', 'UNKNOWN'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        ctx.skip()
        return
      }
      throw error
    }

    await expect(snapshotPageAppJournalFiles(profile, ['link.json']))
      .rejects.toThrow(/outside|profile|symlink/i)
    await expect(stat(join(paths.directory, 'link.json.backup'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('refuses to persist a journal with an unsafe owner token and creates nothing', async () => {
    const profile = await scratch()
    const paths = resolvePageAppProfilePaths(profile)
    await expect(writePageAppJournal(profile, { ...journal(), lockOwnerToken: '../evil' } as never))
      .rejects.toThrow(/token/i)
    await expect(stat(paths.journal)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('writes, reads, and removes the transaction journal atomically', async () => {
    const profile = await scratch()
    const paths = resolvePageAppProfilePaths(profile)
    const value = parsePageAppJournal(journal())

    await writePageAppJournal(profile, value)

    expect(await readFile(paths.journal, 'utf8')).toBe(`${JSON.stringify(value, null, 2)}\n`)
    if (process.platform !== 'win32') {
      expect((await stat(paths.journal)).mode & 0o777).toBe(0o600)
    }
    const roundTrip = await readPageAppJournal(profile)
    expect(roundTrip).toEqual(value)
    expect(roundTrip?.lockOwnerToken).toBe('token-1')

    await removePageAppJournal(profile)
    expect(await readPageAppJournal(profile)).toBeNull()
  })

  it('refuses to persist an invalid journal', async () => {
    const profile = await scratch()
    const paths = resolvePageAppProfilePaths(profile)
    await expect(writePageAppJournal(profile, { ...journal(), phase: 'aborted' } as never)).rejects.toThrow(/phase/)
    await expect(stat(paths.journal)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
