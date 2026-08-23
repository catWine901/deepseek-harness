/**
 * Install-source parsing: kind classification, typed validation, ambiguous
 * relative rejection, URL credential rejection, and redacted display.
 */
import { describe, expect, it } from 'vitest'
import { parsePageAppSourceDisplay } from '@deepseek-ai/dsh-page-app-profile'
import { parsePageAppInstallSource } from '../src/source.ts'

describe('install source classification', () => {
  it('classifies bare and scoped package names as registry sources', () => {
    expect(parsePageAppInstallSource('@example/script-workspace')).toMatchObject({
      kind: 'registry',
      spec: '@example/script-workspace',
      display: { kind: 'registry', display: '@example/script-workspace' },
    })
    expect(parsePageAppInstallSource('workspace-pkg')).toMatchObject({ kind: 'registry' })
    expect(parsePageAppInstallSource('npm:workspace-pkg')).toMatchObject({ kind: 'registry', spec: 'npm:workspace-pkg' })
  })

  it('classifies git specifier forms as git sources', () => {
    expect(parsePageAppInstallSource('github:foo/script-workspace#abc123')).toMatchObject({ kind: 'git' })
    expect(parsePageAppInstallSource('git+https://github.com/foo/script-workspace.git')).toMatchObject({ kind: 'git' })
    expect(parsePageAppInstallSource('git@github.com:foo/script-workspace.git')).toMatchObject({ kind: 'git' })
  })

  it('classifies absolute local paths as file, link, or tarball sources', () => {
    expect(parsePageAppInstallSource('D:\\plugins\\script-workspace')).toMatchObject({ kind: 'file' })
    expect(parsePageAppInstallSource('file:D:\\plugins\\script-workspace')).toMatchObject({ kind: 'file' })
    expect(parsePageAppInstallSource('link:D:\\plugins\\script-workspace')).toMatchObject({ kind: 'link' })
    expect(parsePageAppInstallSource('D:\\packages\\script-workspace.tgz')).toMatchObject({ kind: 'tarball' })
    expect(parsePageAppInstallSource('/home/dev/script-workspace')).toMatchObject({ kind: 'file' })
    expect(parsePageAppInstallSource('/home/dev/script-workspace.tar.gz')).toMatchObject({ kind: 'tarball' })
  })

  it('accepts an explicitly typed registry spec', () => {
    expect(parsePageAppInstallSource('@example/script-workspace', 'registry')).toMatchObject({ kind: 'registry' })
  })

  it('rejects an ambiguous relative filesystem spec', () => {
    expect(() => parsePageAppInstallSource('plugins\\script-workspace')).toThrow(/ambiguous relative filesystem spec/)
    expect(() => parsePageAppInstallSource('./script-workspace')).toThrow(/ambiguous relative filesystem spec/)
    expect(() => parsePageAppInstallSource('dev/script-workspace')).toThrow(/ambiguous relative filesystem spec/)
  })

  it('rejects an empty spec', () => {
    expect(() => parsePageAppInstallSource('   ')).toThrow(/spec is empty/)
  })

  it('rejects a spec that embeds credentials in a URL', () => {
    expect(() => parsePageAppInstallSource('git+https://user:secret@github.com/foo/bar.git'))
      .toThrow(/embeds credentials/)
    expect(() => parsePageAppInstallSource('https://user@example.com/foo.git')).toThrow(/embeds credentials/)
  })

  it('rejects a kind/spec mismatch when the kind is typed', () => {
    expect(() => parsePageAppInstallSource('D:\\plugins\\pkg', 'registry')).toThrow(/not a bare package name/)
    expect(() => parsePageAppInstallSource('@example/pkg', 'git')).toThrow(/not a supported git specifier/)
    expect(() => parsePageAppInstallSource('plugins\\pkg', 'file')).toThrow(/must be an absolute path/)
    expect(() => parsePageAppInstallSource('D:\\plugins\\pkg', 'tarball')).toThrow(/not a tarball path/)
  })

  it('redacts URL userinfo from the persisted display', () => {
    // Credential-bearing specs are REJECTED at the parser boundary; the
    // display redaction is the second line of defense on the persisted record,
    // exercised directly through the profile-core helper.
    const display = parsePageAppSourceDisplay('git', 'git+https://user:secret@github.com/foo/bar.git')
    expect(display.display).not.toContain('user')
    expect(display.display).not.toContain('secret')
    expect(display.display).toContain('github.com/foo/bar.git')
  })
})
