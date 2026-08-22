/**
 * Exact profile-scoped locations of the page-app manager. The directory name
 * stays `.workspace-manager` for compatibility with the accepted product
 * brief while TypeScript and slot identifiers use page-app terminology.
 * @module @deepseek-ai/dsh-page-app-profile/paths
 */

import { join } from 'node:path'
import type { PageAppProfilePaths } from './types.ts'

/** The manager directory name inside one profile directory. */
export const PAGE_APP_MANAGER_DIRECTORY_NAME = '.workspace-manager'

/** Registry file name inside the manager directory. */
export const PAGE_APP_REGISTRY_FILE_NAME = 'registry.json'

/** Derived runtime-layer file name inside the manager directory. */
export const PAGE_APP_RUNTIME_LAYER_FILE_NAME = 'runtime-layer.yml'

/** Active transaction journal file name inside the manager directory. */
export const PAGE_APP_JOURNAL_FILE_NAME = 'transaction.json'

/** Exclusive profile mutation lock file name inside the manager directory. */
export const PAGE_APP_OPERATION_KEY_FILE_NAME = 'operation.lock'

/**
 * Resolve the exact page-app manager files inside one profile directory. The
 * caller owns the profile directory; this function never touches the
 * filesystem and never infers the profile from process state.
 * @param profileDir - absolute profile directory (`$DSH_HOME/profiles/<profile>`).
 * @returns every profile-scoped path the manager resolves.
 */
export function resolvePageAppProfilePaths(profileDir: string): PageAppProfilePaths {
  const directory = join(profileDir, PAGE_APP_MANAGER_DIRECTORY_NAME)
  return {
    directory,
    registry: join(directory, PAGE_APP_REGISTRY_FILE_NAME),
    runtimeLayer: join(directory, PAGE_APP_RUNTIME_LAYER_FILE_NAME),
    journal: join(directory, PAGE_APP_JOURNAL_FILE_NAME),
    operationKey: join(directory, PAGE_APP_OPERATION_KEY_FILE_NAME),
  }
}
