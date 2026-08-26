/** Experimental-package publication and dependency constraints. */

import { describe, expect, it } from 'vitest'
import {
  checkExperimentalDependencyIsolation,
  checkExperimentalManifest,
  checkWorkspace,
  checkWorkspaceFeatureManifest,
  type WorkspaceManifest,
} from './check-workspace-constraints.ts'

const experimental: WorkspaceManifest = {
  dir: 'packages/experimental/prototype',
  manifest: { name: '@deepseek-ai/dsh-experimental-prototype', private: true },
}

describe('experimental workspace constraints', () => {
  it('requires the experimental package-name prefix', () => {
    expect(checkExperimentalManifest({
      ...experimental,
      manifest: { ...experimental.manifest, name: '@deepseek-ai/dsh-prototype' },
    })).toEqual([
      '@deepseek-ai/dsh-prototype: experimental package name must start with "@deepseek-ai/dsh-experimental-"',
    ])
  })

  it('requires private manifests without publication metadata', () => {
    expect(checkExperimentalManifest(experimental)).toEqual([])
    expect(checkExperimentalManifest({
      ...experimental,
      manifest: { ...experimental.manifest, private: false, publishConfig: { access: 'public' } },
    })).toEqual([
      '@deepseek-ai/dsh-experimental-prototype: experimental package must set "private": true',
      '@deepseek-ai/dsh-experimental-prototype: experimental package must omit publishConfig',
    ])
  })

  it.each(['dependencies', 'optionalDependencies', 'peerDependencies'] as const)(
    'rejects release %s on an experimental package',
    (section) => {
      expect(checkExperimentalDependencyIsolation([experimental, {
        dir: 'packages/core/consumer',
        manifest: {
          name: '@deepseek-ai/dsh-consumer',
          [section]: { '@deepseek-ai/dsh-experimental-prototype': 'workspace:^' },
        },
      }])).toEqual([
        `@deepseek-ai/dsh-consumer: ${section}.@deepseek-ai/dsh-experimental-prototype must not reference an experimental package`,
      ])
    },
  )

  it('allows development and experimental consumers but rejects the Python release runtime', () => {
    const manifests: WorkspaceManifest[] = [experimental, {
      dir: 'packages/core/test-only',
      manifest: {
        name: '@deepseek-ai/dsh-test-only',
        devDependencies: { '@deepseek-ai/dsh-experimental-prototype': 'workspace:^' },
      },
    }, {
      dir: 'packages/experimental/consumer',
      manifest: {
        name: '@deepseek-ai/dsh-experimental-consumer',
        dependencies: { '@deepseek-ai/dsh-experimental-prototype': 'workspace:^' },
      },
    }, {
      dir: 'python/sdk-runtime',
      manifest: {
        name: '@deepseek-ai/dsh-python-runtime',
        dependencies: { '@deepseek-ai/dsh-experimental-prototype': 'workspace:^' },
      },
    }]

    expect(checkExperimentalDependencyIsolation(manifests)).toEqual([
      '@deepseek-ai/dsh-python-runtime: dependencies.@deepseek-ai/dsh-experimental-prototype must not reference an experimental package',
    ])
  })
})

describe('Workspace Apps feature constraints', () => {
  it('classifies only schemaVersion 1 as a Cordis-free Workspace Feature', () => {
    expect(checkWorkspaceFeatureManifest({ dsh: { workspace: { schemaVersion: 1 } } }, 'feature'))
      .toEqual({ isWorkspaceFeature: true, errors: [] })
  })

  it.each([{}, { schemaVersion: 2 }, null])('rejects invalid workspace metadata: %j', (workspace) => {
    expect(checkWorkspaceFeatureManifest({ dsh: { workspace } }, 'feature')).toEqual({
      isWorkspaceFeature: false,
      errors: ['feature: dsh.workspace must be an object with schemaVersion 1'],
    })
  })

  it.each([
    ['dependencies', 'cordis'],
    ['peerDependencies', '@deepseek-ai/cordis'],
    ['devDependencies', 'cordis'],
    ['optionalDependencies', '@deepseek-ai/cordis'],
  ] as const)('rejects %s.%s on a valid Workspace Feature', (section, dependency) => {
    expect(checkWorkspaceFeatureManifest({
      dsh: { workspace: { schemaVersion: 1 } },
      [section]: { [dependency]: '^4.0.0' },
    }, 'feature').errors).toEqual([
      `feature: Workspace Feature must not declare ${dependency} in ${section}`,
    ])
  })

  it('keeps the ordinary Cordis peer requirement for non-Feature packages', () => {
    const failures = checkWorkspace({ dir: 'packages/examples/ordinary', manifest: {
      name: '@deepseek-ai/dsh-ordinary',
    } })
    expect(failures.some(failure => failure.endsWith(
      '@deepseek-ai/dsh-ordinary: @deepseek-ai/cordis must be a peerDependency',
    ))).toBe(true)
  })
})
