/**
 * Workbench Contract v1 version surface (design D2 / G-8): the Manager
 * constant and the hard admission check. The constant is the single source of
 * truth for which `dsh.workspace.schemaVersion` values the manager accepts; an
 * unsupported version is a hard preflight error, never a silent skip.
 */
import { describe, expect, it } from 'vitest'
import { SUPPORTED_CONTRACT_VERSIONS, assertSupportedContractVersion } from '../src/contract.ts'

describe('workbench contract version', () => {
  it('assertSupportedContractVersion accepts version 1 and rejects 2', () => {
    expect(() => { assertSupportedContractVersion(1, SUPPORTED_CONTRACT_VERSIONS) }).not.toThrow()
    expect(() => { assertSupportedContractVersion(2, SUPPORTED_CONTRACT_VERSIONS) })
      .toThrow(/unsupported contract version 2/)
  })

  it('SUPPORTED_CONTRACT_VERSIONS is frozen and contains exactly 1', () => {
    expect(Object.isFrozen(SUPPORTED_CONTRACT_VERSIONS)).toBe(true)
    expect(SUPPORTED_CONTRACT_VERSIONS).toEqual([1])
    expect(SUPPORTED_CONTRACT_VERSIONS).toHaveLength(1)
  })
})
