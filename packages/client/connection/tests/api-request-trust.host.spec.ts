/** Behavior of the /api browser-trust fence (rebinding + cross-site defense). */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { RpcId, type ClientRequest } from '@deepseek-ai/dsh-host-apiproxy/api'
import { assertTrustedAuthority, isTrustedApiRequest } from '../src/api-request-trust.ts'
import type { FetchHandler } from '../src/http-bridge.ts'
import { PRIVILEGED_METHODS } from '../src/privileged-methods.ts'
import { HostConnectionService } from '../src/rpc-host.ts'

function request(headers: Record<string, string | undefined>): { headers: Record<string, string | undefined> } {
  return { headers }
}

/** The seven page-app manager mutations, in Typert `${namespace}/${method}` wire form. */
const PAGE_APP_MANAGER_METHODS: readonly string[] = [
  'pageAppManager/install',
  'pageAppManager/setEnabled',
  'pageAppManager/setHidden',
  'pageAppManager/reorder',
  'pageAppManager/uninstall',
  'pageAppManager/ackClientActivation',
  'pageAppManager/recover',
]

/** One fetch request with a complete client-request envelope and a spoofed Host. */
function envelopeRequest(method: string, host: string): Request {
  const envelope: ClientRequest = { type: 'client-request', rpcId: RpcId('fence'), method, payload: {} }
  return new Request(`http://dsh.internal/api/${method}`, {
    method: 'POST',
    headers: { host, 'content-type': 'application/json' },
    body: JSON.stringify(envelope),
  })
}

describe('isTrustedApiRequest', () => {
  it('holds markerless requests to the same Host fence — a plain-HTTP browser read carries no markers', () => {
    // Over plain HTTP a browser attaches neither Origin nor Fetch-Metadata to
    // reads (EventSource, images, navigations), so a rebound-origin GET is
    // markerless and its response readable: no marker shortcut may exist.
    expect(isTrustedApiRequest(request({ host: '127.0.0.1:3080' }), [])).toBe(true)
    expect(isTrustedApiRequest(request({ host: '192.168.1.5:3080' }), ['192.168.1.5'])).toBe(true)
    expect(isTrustedApiRequest(request({ host: '192.168.1.5:3080' }), [])).toBe(false)
    expect(isTrustedApiRequest(request({ host: 'harness.example' }), [])).toBe(false)
    expect(isTrustedApiRequest(request({}), [])).toBe(false)
  })

  it('accepts loopback Hosts in every spelling, with and without ports, for browser requests', () => {
    for (const host of ['localhost', 'localhost:3080', '127.0.0.1', '127.0.0.1:3080', '127.8.9.10:80', '[::1]', '[::1]:3080', 'LOCALHOST:3080']) {
      expect(isTrustedApiRequest(request({ host, origin: `http://${host}` }), [])).toBe(true)
    }
  })

  it('refuses a rebound Host: the attacker domain names the socket it did not expect', () => {
    expect(isTrustedApiRequest(request({
      host: 'evil.example:3080',
      origin: 'http://evil.example:3080',
      'sec-fetch-site': 'same-origin',
    }), [])).toBe(false)
  })

  it('accepts a declared public authority: exact on host:port entries, any port on port-less entries', () => {
    const headers = { host: 'harness.internal:3080', origin: 'http://harness.internal:3080' }
    expect(isTrustedApiRequest(request(headers), ['harness.internal:3080'])).toBe(true)
    expect(isTrustedApiRequest(request(headers), ['harness.internal'])).toBe(true)
    expect(isTrustedApiRequest(request(headers), ['harness.internal:9999'])).toBe(false)
    expect(isTrustedApiRequest(request(headers), [])).toBe(false)
  })

  it('matches Host, Origin, and trusted entries through WHATWG normalization (case, default port)', () => {
    expect(isTrustedApiRequest(request({ host: 'Harness.INTERNAL:3080', origin: 'http://harness.internal:3080' }), ['harness.internal:3080'])).toBe(true)
    expect(isTrustedApiRequest(request({ host: 'harness.internal', origin: 'http://harness.internal' }), ['HARNESS.internal:80'])).toBe(true)
    // An unparsable entry never matches; it must not poison the rest of the list.
    expect(isTrustedApiRequest(request({ host: 'harness.internal', origin: 'http://harness.internal' }), ['bad entry', 'harness.internal'])).toBe(true)
    expect(isTrustedApiRequest(request({ host: 'harness.internal', origin: 'http://harness.internal' }), ['bad entry'])).toBe(false)
  })

  it('refuses cross-origin browser markers even on a loopback Host', () => {
    // Origin present and different → cross-site request that survived preflight rules.
    expect(isTrustedApiRequest(request({ host: '127.0.0.1:3080', origin: 'http://evil.example' }), [])).toBe(false)
    // Explicit cross-site label → refused regardless of Origin.
    expect(isTrustedApiRequest(request({ host: '127.0.0.1:3080', 'sec-fetch-site': 'cross-site' }), [])).toBe(false)
    // Opaque origin (sandboxed iframe, file: page) parses to no authority.
    expect(isTrustedApiRequest(request({ host: '127.0.0.1:3080', origin: 'null' }), [])).toBe(false)
  })

  it('accepts a same-origin browser request, with or without an Origin header', () => {
    expect(isTrustedApiRequest(request({
      host: 'localhost:3080',
      origin: 'http://localhost:3080',
      'sec-fetch-site': 'same-origin',
    }), [])).toBe(true)
    // Origin-less browser shapes (same-origin GETs) still carry sec-fetch-site.
    expect(isTrustedApiRequest(request({ host: 'localhost:3080', 'sec-fetch-site': 'same-origin' }), [])).toBe(true)
  })

  it('assertTrustedAuthority accepts bare authorities and throws on anything more', () => {
    for (const entry of ['harness.internal', 'harness.internal:3080', 'HARNESS.internal:80', '10.0.0.9', '[::1]:3080']) {
      expect(() => { assertTrustedAuthority(entry) }).not.toThrow()
    }
    // WHATWG parsing would quietly read a hostname out of each of these; the
    // config boundary must refuse them instead of authorizing the prefix.
    for (const entry of ['harness.internal/path', 'harness.internal/', 'user@harness.internal', 'harness.internal?x', 'harness.internal#f', 'harness.internal\\path', 'bad entry', '']) {
      expect(() => { assertTrustedAuthority(entry) }).toThrow(/not a bare host\[:port\] authority/)
    }
    // WHATWG trimming would silently strip these; the entry must fail instead.
    for (const entry of ['harness.internal:3080 ', ' harness.internal', 'harness.internal:30\t80']) {
      expect(() => { assertTrustedAuthority(entry) }).toThrow(/not a bare host\[:port\] authority/)
    }
    // WHATWG parsing would silently rewrite these — a dangling colon or
    // zero-padded port would broaden an intended exact-port grant to every
    // port, and non-canonical host spellings would not read back as written.
    for (const entry of ['harness.internal:', '[::1]:', 'harness.internal:0080', '0x7f.0.0.1', '[0:0:0:0:0:0:0:1]']) {
      expect(() => { assertTrustedAuthority(entry) }).toThrow(/not a bare host\[:port\] authority/)
    }
  })

  it('never lets stray whitespace broaden an exact-port entry to every port', () => {
    // Defense in depth below the load-time assert: the explicit-port judgment
    // reads the parsed URL, so a trimmed `host:port ` entry stays exact.
    const trusted = ['harness.internal:3080 ']
    expect(isTrustedApiRequest(request({ host: 'harness.internal:9999', origin: 'http://harness.internal:9999' }), trusted)).toBe(false)
    expect(isTrustedApiRequest(request({ host: 'harness.internal:3080', origin: 'http://harness.internal:3080' }), trusted)).toBe(true)
  })

  it('refuses malformed or untrusted authorities on browser requests', () => {
    const markers = { 'sec-fetch-site': 'same-origin' }
    expect(isTrustedApiRequest(request({ ...markers }), [])).toBe(false)
    expect(isTrustedApiRequest(request({ ...markers, host: '' }), [])).toBe(false)
    expect(isTrustedApiRequest(request({ ...markers, host: 'bad host' }), [])).toBe(false)
    expect(isTrustedApiRequest(request({ ...markers, host: '127.0.0.999' }), [])).toBe(false)
    expect(isTrustedApiRequest(request({ ...markers, host: '128.0.0.1' }), [])).toBe(false)
  })
})

describe('shared fetch handler dispatcher order (privileged fence first)', () => {
  /**
   * One honest shared dispatcher seam: a counting interceptor matcher that
   * claims every exact page-app manager endpoint, a counting gateway handler
   * that forwards to a separately counted manager executor, and a direct
   * fallback FetchHandler that claims every row it receives (it answers 200
   * for anything, unlike the legacy API Proxy carrier, whose route table has
   * no slash names and would 404 an unclaimed slash row before touching the
   * proxy). Every dispatch surface is therefore observable on its own.
   */
  function sharedDispatcher(): {
    handler: ReturnType<HostConnectionService['createSharedFetchHandler']>
    remove: () => Promise<void>
    matcherCalls: string[]
    gatewayCalls: string[]
    executorCalls: string[]
    fallbackCalls: string[]
  } {
    const ctx = new Context()
    const connection = new HostConnectionService(ctx, [])
    const matcherCalls: string[] = []
    const gatewayCalls: string[] = []
    const executorCalls: string[] = []
    const fallbackCalls: string[] = []
    // A genuinely separate manager executor: the fake gateway must invoke and
    // await this function, so an executor counter of zero independently proves
    // the gateway never forwarded the call.
    const executor = async (endpoint: string): Promise<{ ok: true; value: { accepted: true } }> => {
      executorCalls.push(endpoint)
      return { ok: true, value: { accepted: true } }
    }
    const remove = connection.rpc.intercept('/api', (endpoint) => {
      matcherCalls.push(endpoint)
      return PAGE_APP_MANAGER_METHODS.includes(endpoint)
    }, async (endpoint) => {
      // The Typert gateway dispatch: record the gateway call, then forward to
      // the separately counted manager executor and return its result.
      gatewayCalls.push(endpoint)
      return executor(endpoint)
    }, { authority: 'trusted-host' })
    const fallback: FetchHandler = {
      fetch: async (received) => {
        fallbackCalls.push(new URL(received.url).pathname)
        return new Response('fallback', { status: 200 })
      },
    }
    const handler = connection.createSharedFetchHandler('/api', fallback)
    return { handler, remove, matcherCalls, gatewayCalls, executorCalls, fallbackCalls }
  }

  it('rejects every non-loopback page-app manager mutation before matcher, gateway, fallback, or executor runs', async () => {
    const dispatch = sharedDispatcher()
    try {
      for (const method of PAGE_APP_MANAGER_METHODS) {
        expect(PRIVILEGED_METHODS.has(method)).toBe(true)
        const response = await dispatch.handler.fetch(envelopeRequest(method, 'harness.example'))
        expect([method, response.status]).toEqual([method, 403])
      }
      // The fence answered before any dispatch surface was consulted: the
      // interceptor matcher was never asked, the gateway never dispatched,
      // the fallback never ran, and the manager executor never fired.
      expect([dispatch.matcherCalls, dispatch.gatewayCalls, dispatch.fallbackCalls, dispatch.executorCalls])
        .toEqual([[], [], [], []])
    } finally {
      await dispatch.remove()
    }
  })

  it('lets a loopback page-app manager mutation through the interceptor, gateway, and executor', async () => {
    const dispatch = sharedDispatcher()
    try {
      const response = await dispatch.handler.fetch(envelopeRequest('pageAppManager/install', '127.0.0.1:3080'))
      expect(response.status).toBe(200)
      expect([dispatch.matcherCalls, dispatch.gatewayCalls, dispatch.executorCalls, dispatch.fallbackCalls])
        .toEqual([['pageAppManager/install'], ['pageAppManager/install'], ['pageAppManager/install'], []])
    } finally {
      await dispatch.remove()
    }
  })

  it('lets a non-privileged non-loopback row fall through to the fallback dispatcher', async () => {
    const dispatch = sharedDispatcher()
    try {
      // The matcher does not claim this Typert-shaped row, and the fence does
      // not pin it, so the fallback dispatcher answers — the pin is exact, not
      // a blanket slash-endpoint block.
      const response = await dispatch.handler.fetch(envelopeRequest('goals/create', 'harness.example'))
      expect(response.status).toBe(200)
      expect(await response.text()).toBe('fallback')
      expect([dispatch.matcherCalls, dispatch.fallbackCalls, dispatch.gatewayCalls, dispatch.executorCalls])
        .toEqual([['goals/create'], ['/api/goals/create'], [], []])
    } finally {
      await dispatch.remove()
    }
  })
})
