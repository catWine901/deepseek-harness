/**
 * Host-safe page-app profile core: manifest/registry parsing, exact profile
 * paths, deterministic runtime-layer serialization, journaled transactions,
 * and the shared profile mutation lock. Profile boot imports this package
 * without depending on the page-app manager's Typert service package.
 * @module @deepseek-ai/dsh-page-app-profile
 */

export * from './types.ts'
export { resolvePageAppProfilePaths } from './paths.ts'
export {
  assertPageAppSourceNoCredentials,
  assertSafeOpaqueToken,
  parsePageAppManifest,
  parsePageAppSourceDisplay,
} from './manifest.ts'
export { parsePageAppRegistry, readPageAppRegistry, writePageAppRegistry } from './registry.ts'
export { renderPageAppRuntimeLayer } from './layer.ts'
export {
  advancePageAppJournalPhase,
  parsePageAppJournal,
  readPageAppJournal,
  removePageAppJournal,
  snapshotPageAppJournalFiles,
  writePageAppJournal,
} from './journal.ts'
export { recoverOrphanedPageAppLock, withPageAppProfileLock } from './lock.ts'
