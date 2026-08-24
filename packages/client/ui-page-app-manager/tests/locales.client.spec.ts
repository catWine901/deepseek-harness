// Workspace Apps settings locale pair: English and Chinese dictionaries stay
// key-aligned (the Chinese dictionary is the key source of truth).
import { describe, expect, it } from 'vitest'
import { en, zh } from '../src/client/locales.ts'

describe('settings.pageApp locale pair', () => {
  it('keeps English keys aligned with the Chinese key source of truth', () => {
    const zhKeys = Object.keys(zh).sort()
    const enKeys = Object.keys(en).sort()
    expect(enKeys).toEqual(zhKeys)
  })

  it('provides non-empty copy for every key in both locales', () => {
    for (const [key, value] of Object.entries(zh)) {
      expect(value.length, `zh.${key}`).toBeGreaterThan(0)
    }
    for (const [key, value] of Object.entries(en)) {
      expect(value.length, `en.${key}`).toBeGreaterThan(0)
    }
  })

  it('carries the explicit cancel-install copy in both locales', () => {
    // The Settings add-flow cancel action is user-visible: the zh source and
    // the en alignment stay pinned together.
    expect(zh.cancelInstall).toBe('取消安装')
    expect(en.cancelInstall).toBe('Cancel install')
  })
})
