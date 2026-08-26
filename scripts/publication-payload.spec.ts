import { describe, expect, it } from 'vitest'
import {
  hasTypertRemoteNavigation,
  isForbiddenPublicationFile,
  validateTarballPayloadContent,
  validateTarballPayload,
} from './publication-payload.ts'

function validateFixtureTarball(files: readonly string[]): () => void {
  return () => {
    validateTarballPayload(files, 'fixture.tgz')
  }
}

describe('publication payload policy', () => {
  it.each([
    'lib/index.js',
    'lib/types/index.d.ts',
    'lib/styles/base.css',
  ])('accepts %s', (file) => {
    expect(isForbiddenPublicationFile(file)).toBe(false)
  })

  it.each([
    'src',
    './src',
    'src/',
    'src/index.ts',
    './src/index.ts',
    String.raw`src\index.ts`,
    'lib/types/index.d.ts.map',
    './lib/types/index.d.ts.map',
    'lib/typert.remote-client.d.ts.map',
    'lib/client.js.map',
    './lib/client.js.map',
  ])('rejects static manifest path %s', (file) => {
    expect(isForbiddenPublicationFile(file)).toBe(true)
  })

  it('rejects source members in packed tarballs', () => {
    expect(validateFixtureTarball([
      'package/package.json',
      'package/src/index.ts',
    ])).toThrow('fixture.tgz publishes source file package/src/index.ts')
  })

  it('rejects source maps in packed tarballs', () => {
    expect(validateFixtureTarball([
      'package/package.json',
      'package/lib/types/index.d.ts.map',
    ])).toThrow('fixture.tgz publishes source map package/lib/types/index.d.ts.map')
    expect(validateFixtureTarball([
      'package/package.json',
      'package/lib/typert.remote-client.d.ts.map',
    ])).toThrow('fixture.tgz publishes source map package/lib/typert.remote-client.d.ts.map')
    expect(validateFixtureTarball([
      'package/package.json',
      'package/lib/client.js.map',
    ])).toThrow('fixture.tgz publishes source map package/lib/client.js.map')
  })

  it('accepts a clean packed tarball', () => {
    expect(validateFixtureTarball([
      'package/package.json',
      'package/lib/index.js',
      'package/lib/types/index.d.ts',
      'package/lib/styles/base.css',
    ])).not.toThrow()
  })

  it('flags a member containing a Windows drive path', () => {
    expect(() => {
      validateTarballPayloadContent(
        ['package/lib/index.js'],
        () => String.raw`const cache = "C:\Users\builder\workspace"`,
        'fixture.tgz',
      )
    }).toThrow('fixture.tgz member package/lib/index.js contains absolute path C:\\Users\\')
  })

  it('flags a member containing a POSIX root', () => {
    expect(() => {
      validateTarballPayloadContent(
        ['package/lib/index.js'],
        () => 'const cache = "/home/builder/workspace"',
        'fixture.tgz',
      )
    }).toThrow('fixture.tgz member package/lib/index.js contains absolute path /home/')
  })

  it('passes a payload with no absolute paths', () => {
    const members = new Map([
      ['package/package.json', '{"main":"./lib/index.js"}'],
      ['package/lib/index.js', 'export const relative = "../assets/icon.svg"'],
    ])
    expect(() => {
      validateTarballPayloadContent(
        [...members.keys()],
        member => members.get(member) ?? '',
        'fixture.tgz',
      )
    }).not.toThrow()
  })

  it('does not treat a URL scheme suffix as a Windows drive path', () => {
    expect(() => {
      validateTarballPayloadContent(
        ['package/lib/index.js'],
        () => 'const protocol = "npm:/registry-package"',
        'fixture.tgz',
      )
    }).not.toThrow()
  })

  it('member-name checks still reject src and maps', () => {
    expect(validateFixtureTarball(['package/src/index.ts'])).toThrow(/publishes source file/)
    expect(validateFixtureTarball(['package/lib/index.js.map'])).toThrow(/publishes source map/)
  })

  it('recognizes only the canonical Host-for-Client export pair', () => {
    expect(hasTypertRemoteNavigation({
      exports: {
        './remote': {
          types: './lib/typert.remote-client.d.ts',
          default: './lib/typert.remote-client.js',
        },
      },
    })).toBe(true)
    expect(hasTypertRemoteNavigation({ exports: { './remote': './lib/remote.js' } })).toBe(false)
  })
})
