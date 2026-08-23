/**
 * The page-app manager's contribution to the Remote assembly: the two lifecycle
 * events are allowlisted for verbatim forwarding, and the allowlist satisfies
 * the TypertForwardableEvent shape gate (compile-time; the Host index runs the
 * assertion). The generated `pageAppManager` namespace methods are verified by
 * the manager package's remote tests; this file pins the assembly wiring.
 */
import { describe, expect, it } from 'vitest'
import { API_REMOTE_FORWARDED_EVENTS } from '../src/remote-events.ts'

describe('page-app manager Remote assembly', () => {
  it('forwards both manager lifecycle events verbatim', () => {
    expect(API_REMOTE_FORWARDED_EVENTS).toContain('page-app-manager/changed')
    expect(API_REMOTE_FORWARDED_EVENTS).toContain('page-app-manager/activation-requested')
  })

  it('keeps the two events adjacent and distinct from the settings event', () => {
    const list = [...API_REMOTE_FORWARDED_EVENTS]
    const changed = list.indexOf('page-app-manager/changed')
    const requested = list.indexOf('page-app-manager/activation-requested')
    expect(changed).toBeGreaterThanOrEqual(0)
    expect(requested).toBe(changed + 1)
  })
})
