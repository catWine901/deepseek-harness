import { describe, expect, it } from 'vitest'
import { stripArtifactPathComments } from './page-app-install-chain.smoke.ts'

describe('workspace manager install-chain packaging', () => {
  it('removes generated CSS region source paths without rewriting executable content', () => {
    const built = [
      'const retained = "C:\\Users\\runtime-value"',
      String.raw`//#region \0dsh-css:C:\Users\builder\repo\src\Panel.module.css.mjs`,
      String.raw`/** Windows drive example (C:\... or C:/...). */`,
      'export { retained }',
      '',
    ].join('\n')
    expect(stripArtifactPathComments(built)).toBe([
      'const retained = "C:\\Users\\runtime-value"',
      'export { retained }',
      '',
    ].join('\n'))
  })
})
