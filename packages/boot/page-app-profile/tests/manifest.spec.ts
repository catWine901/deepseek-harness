import { describe, expect, it } from 'vitest'
import { assertPageAppSourceNoCredentials, parsePageAppManifest, parsePageAppSourceDisplay } from '../src/manifest.ts'

const validWorkspace = {
  schemaVersion: 1,
  id: 'example.page',
  name: 'Example',
  description: 'Example full-page app',
  defaultOrder: 100,
  rootEntryId: 'example-page-root',
}

describe('parsePageAppManifest', () => {
  it('parses an exact v1 workspace block and returns the package name with every field', () => {
    expect(parsePageAppManifest('@scope/example-page', { dsh: { workspace: validWorkspace } })).toEqual({
      packageName: '@scope/example-page',
      schemaVersion: 1,
      id: 'example.page',
      name: 'Example',
      description: 'Example full-page app',
      defaultOrder: 100,
      rootEntryId: 'example-page-root',
    })
  })

  it('accepts the sibling dsh keys a real package carries beside the workspace block', () => {
    const value = {
      dsh: {
        bundle: { patch: './cordis.patch.yml' },
        client: { platform: 'web' },
        workspace: validWorkspace,
      },
    }
    expect(parsePageAppManifest('@scope/example-page', value).id).toBe('example.page')
  })

  it('rejects a missing dsh.workspace block', () => {
    expect(() => parsePageAppManifest('@scope/example-page', {})).toThrow(/dsh/)
    expect(() => parsePageAppManifest('@scope/example-page', { dsh: {} })).toThrow(/dsh\.workspace/)
  })

  it('requires the exact schema version 1', () => {
    for (const schemaVersion of [0, 2, '1']) {
      expect(() => parsePageAppManifest('@scope/example-page', {
        dsh: { workspace: { ...validWorkspace, schemaVersion } },
      })).toThrow(/schemaVersion/)
    }
  })

  it('rejects unknown keys inside the workspace block', () => {
    expect(() => parsePageAppManifest('@scope/example-page', {
      dsh: { workspace: { ...validWorkspace, extra: true } },
    })).toThrow(/Unrecognized key/)
  })

  it('requires every text field to be a non-empty string', () => {
    for (const field of ['id', 'name', 'description', 'rootEntryId']) {
      for (const value of ['', 1, null, undefined]) {
        expect(() => parsePageAppManifest('@scope/example-page', {
          dsh: { workspace: { ...validWorkspace, [field]: value } },
        })).toThrow()
      }
    }
  })

  it('requires defaultOrder to be an integer', () => {
    for (const defaultOrder of [1.5, '100', NaN, null]) {
      expect(() => parsePageAppManifest('@scope/example-page', {
        dsh: { workspace: { ...validWorkspace, defaultOrder } },
      })).toThrow(/defaultOrder/)
    }
  })
})

describe('parsePageAppSourceDisplay', () => {
  it('keeps credential-free registry and git URLs unchanged', () => {
    expect(parsePageAppSourceDisplay('registry', 'https://registry.npmjs.org/@scope/example-page').display)
      .toBe('https://registry.npmjs.org/@scope/example-page')
    expect(parsePageAppSourceDisplay('git', 'https://github.com/deepseek-ai/example-page.git').display)
      .toBe('https://github.com/deepseek-ai/example-page.git')
  })

  it('redacts userinfo credentials from URLs so they never persist', () => {
    expect(parsePageAppSourceDisplay('git', 'https://user:secret@github.com/deepseek-ai/example-page.git').display)
      .toBe('https://github.com/deepseek-ai/example-page.git')
    expect(parsePageAppSourceDisplay('registry', 'https://token@npm.pkg.github.com/@scope/example-page').display)
      .toBe('https://npm.pkg.github.com/@scope/example-page')
    expect(parsePageAppSourceDisplay('git', 'https:user:secret@example.com/path').display)
      .toBe('https://example.com/path')
  })

  it('rejects credential-bearing URLs outright, including valid non-// absolute forms', () => {
    expect(() => { assertPageAppSourceNoCredentials('https://user:secret@github.com/deepseek-ai/example-page.git') })
      .toThrow(/credential/i)
    expect(() => { assertPageAppSourceNoCredentials('https://token@npm.pkg.github.com/@scope/example-page') })
      .toThrow(/credential/i)
    expect(() => { assertPageAppSourceNoCredentials('https://token@example.com/pkg.tgz') }).toThrow(/credential/i)
    expect(() => { assertPageAppSourceNoCredentials('https:user:secret@example.com/path') }).toThrow(/credential/i)
    expect(() => { assertPageAppSourceNoCredentials('http:token@example.com/path') }).toThrow(/credential/i)
    expect(() => { assertPageAppSourceNoCredentials('https://github.com/deepseek-ai/example-page.git') }).not.toThrow()
  })

  it('never misclassifies local paths and scp-style specs as credential-bearing URLs', () => {
    expect(() => { assertPageAppSourceNoCredentials('C:\\dev\\pkg') }).not.toThrow()
    expect(() => { assertPageAppSourceNoCredentials('/abs/path/pkg') }).not.toThrow()
    expect(() => { assertPageAppSourceNoCredentials('git@github.com:deepseek-ai/example-page.git') }).not.toThrow()
    expect(() => { assertPageAppSourceNoCredentials('npm:pkg') }).not.toThrow()
    expect(parsePageAppSourceDisplay('link', 'C:\\dev\\pkg').display).toBe('C:\\dev\\pkg')
    expect(parsePageAppSourceDisplay('file', '/abs/path/pkg').display).toBe('/abs/path/pkg')
    expect(parsePageAppSourceDisplay('registry', 'npm:pkg').display).toBe('npm:pkg')
  })

  it('leaves local paths and scp-style git specs unchanged', () => {
    expect(parsePageAppSourceDisplay('file', '/abs/path/to/pkg').display).toBe('/abs/path/to/pkg')
    expect(parsePageAppSourceDisplay('link', 'C:\\dev\\pkg').display).toBe('C:\\dev\\pkg')
    expect(parsePageAppSourceDisplay('tarball', 'https://example.com/pkg.tgz').display).toBe('https://example.com/pkg.tgz')
    expect(parsePageAppSourceDisplay('git', 'git@github.com:deepseek-ai/example-page.git').display)
      .toBe('git@github.com:deepseek-ai/example-page.git')
  })

  it('returns the kind verbatim', () => {
    expect(parsePageAppSourceDisplay('file', '/x').kind).toBe('file')
  })
})
