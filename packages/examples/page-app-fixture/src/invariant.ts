/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-page-app-fixture`.
 * @module @deepseek-ai/dsh-page-app-fixture/invariant
 */

/* jscpd:ignore-start */
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-page-app-fixture'

/** Cordis companion plugin name. */
export const name = 'page-app-fixture-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the fixture is a Cordis-free skeleton; its manifest
 * and source boundaries are pinned by the fixture spec and the source-boundary
 * gate.
 */
const install: InvariantInstaller = () => {
  // No runtime invariant: the fixture composes no independent event stream or
  // mutable data; the contract shape is pinned by the fixture spec and the
  // Strict-Mode source-boundary gate.
}

/**
 * Register this package's invariant companion. The context is structurally
 * typed so the fixture never imports Cordis (Strict Mode source boundary).
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: {
  invariants: { register(packageName: string, installer: InvariantInstaller): () => void }
}): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
