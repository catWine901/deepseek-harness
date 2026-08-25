/**
 * Workbench Contract v1 version surface (design D2 / G-8): the Manager
 * constant and the hard admission check Features must satisfy. The constant is
 * the single source of truth for which `dsh.workspace.schemaVersion` values
 * the manager accepts; an unsupported version is a hard preflight error, never
 * a silent skip.
 * @module @deepseek-ai/dsh-page-app-manager/contract
 */

/** Contract versions this Manager admits (v1 only, locked by R-3). */
export const SUPPORTED_CONTRACT_VERSIONS = Object.freeze([1] as const)

/**
 * Assert one declared contract version is admitted.
 * @param version - the declared `dsh.workspace.schemaVersion` to admit.
 * @param supported - the admitted version list (pass `SUPPORTED_CONTRACT_VERSIONS`).
 * @throws {Error} naming the unsupported version.
 */
export function assertSupportedContractVersion(version: number, supported: readonly number[]): void {
  if (!supported.includes(version)) throw new Error(`unsupported contract version ${version}`)
}
