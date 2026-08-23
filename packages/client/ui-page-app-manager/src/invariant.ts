/** Package-owned invariant companion. @module @deepseek-ai/dsh-client-ui-page-app-manager/invariant */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-client-ui-page-app-manager'

/** Cordis companion plugin name. */
export const name = 'client-ui-page-app-manager-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** No runtime invariant yet: the authorization projection is pinned by tests. */
const install: InvariantInstaller = () => {
  // No runtime invariant: eligibility is the registry × immutable slot
  // provenance closed projection, covered by the authorization test suite.
}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
