import { describe, expect, it } from 'vitest'
import { renderPageAppRuntimeLayer } from '../src/layer.ts'
import type { ValidatedManagedRoot } from '../src/types.ts'

function root(overrides: Partial<ValidatedManagedRoot> = {}): ValidatedManagedRoot {
  return {
    packageName: '@scope/example-page',
    pageId: 'example.page',
    rootEntryId: 'example-page-root',
    enabled: true,
    entries: [
      { id: 'example-page-root', name: '@scope/example-page', config: { enabled: true, label: 'Example' } },
    ],
    ...overrides,
  }
}

/** The pinned byte format the launcher composition consumes: one `insert` patch per enabled root. */
const GOLDEN = [
  '- insert:',
  '    - config:',
  '        enabled: true',
  '        label: Example',
  '      id: example-page-root',
  "      name: '@scope/example-page'",
  '',
].join('\n')

describe('renderPageAppRuntimeLayer', () => {
  it('renders one enabled root as the exact pinned insert patch', () => {
    expect(renderPageAppRuntimeLayer([root()])).toBe(GOLDEN)
  })

  it('produces byte-identical YAML for equivalent input regardless of key order', () => {
    const first = renderPageAppRuntimeLayer([root()])
    const reordered = root({
      entries: [
        { id: 'example-page-root', name: '@scope/example-page', config: { label: 'Example', enabled: true } },
      ],
    })
    const second = renderPageAppRuntimeLayer([reordered])
    expect(second).toBe(first)
    expect(renderPageAppRuntimeLayer([root(), root({ packageName: '@scope/other', pageId: 'other.page' })])).toBe(
      renderPageAppRuntimeLayer([root({ packageName: '@scope/other', pageId: 'other.page' }), root()]),
    )
  })

  it('inserts only enabled roots and renders an empty patch list when none are enabled', () => {
    const disabled = root({ enabled: false })
    expect(renderPageAppRuntimeLayer([disabled])).toBe('[]\n')
    expect(renderPageAppRuntimeLayer([root(), disabled])).toBe(GOLDEN)
    expect(renderPageAppRuntimeLayer([])).toBe('[]\n')
  })

  it('refuses to serialize any !!js expression', () => {
    const tagged = root({
      entries: [
        { id: 'example-page-root', name: '@scope/example-page', config: { mode: '!!js process.env.MODE' } },
      ],
    })
    expect(() => renderPageAppRuntimeLayer([tagged])).toThrow(/!!js/)
    const midString = root({
      entries: [
        { id: 'example-page-root', name: '@scope/example-page', config: { pattern: 'a !!js/function b' } },
      ],
    })
    expect(() => renderPageAppRuntimeLayer([midString])).toThrow(/!!js/)
  })

  it('rejects relative Loader names', () => {
    for (const name of ['./local.js', '../up.js', '/abs/path.js', 'C:\\dev\\pkg\\index.js', 'file:../x']) {
      const relative = root({
        entries: [{ id: 'example-page-root', name, config: { enabled: true } }],
      })
      expect(() => renderPageAppRuntimeLayer([relative])).toThrow(/relative|specifier/i)
    }
  })

  it('serializes nested group structure and validates its names recursively', () => {
    const nested = root({
      entries: [{
        id: 'example-page-root',
        name: '@scope/example-page',
        insert: [{ id: 'child-group', name: '@scope/example-page/child' }],
      }],
    })
    const rendered = renderPageAppRuntimeLayer([nested])
    expect(rendered).toBe([
      '- insert:',
      '    - id: example-page-root',
      '      insert:',
      '        - id: child-group',
      "          name: '@scope/example-page/child'",
      "      name: '@scope/example-page'",
      '',
    ].join('\n'))
    expect(renderPageAppRuntimeLayer([nested])).toBe(rendered)
    const badChild = root({
      entries: [{
        id: 'example-page-root',
        name: '@scope/example-page',
        insert: [{ id: 'child-group', name: '../escaped.js' }],
      }],
    })
    expect(() => renderPageAppRuntimeLayer([badChild])).toThrow(/relative|specifier/i)
  })

  it('never mutates its input objects', () => {
    const frozen = root({
      entries: [
        Object.freeze({
          id: 'example-page-root',
          name: '@scope/example-page',
          config: Object.freeze({ enabled: true, label: 'Example' }),
        }),
      ],
    })
    const before = JSON.stringify(frozen)
    expect(renderPageAppRuntimeLayer([Object.freeze(frozen)])).toBe(GOLDEN)
    expect(JSON.stringify(frozen)).toBe(before)
  })
})
