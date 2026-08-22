/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-page-app-profile`.
 * @module @deepseek-ai/dsh-page-app-profile/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-page-app-profile'

/** Cordis companion plugin name. */
export const name = 'page-app-profile-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: this Host-safe persistence core owns no Cordis event
 * stream or mutable runtime data; its file, schema, journal, and lock
 * contracts are enforced by unit tests.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
