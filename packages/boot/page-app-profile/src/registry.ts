/**
 * Page-app registry schema v1: strict parsing, uniqueness, stable ordering,
 * and deeply immutable results, plus atomic registry file IO. The registry is
 * the sole ownership authority; every other projection is derived from it.
 * @module @deepseek-ai/dsh-page-app-profile/registry
 */

import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { assertPageAppSourceNoCredentials, parseStrict } from './manifest.ts'
import { resolvePageAppProfilePaths } from './paths.ts'
import type { PageAppRegistryV1 } from './types.ts'

const registrySourceSchema = z.object({
  kind: z.enum(['registry', 'file', 'link', 'tarball', 'git']),
  display: z.string().min(1),
}).strict().readonly()

const pageFieldsSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  defaultOrder: z.number().int(),
  rootEntryId: z.string().min(1),
}).strict().readonly()

const registryEntrySchema = z.object({
  packageName: z.string().min(1),
  source: registrySourceSchema,
  resolvedVersion: z.string().min(1),
  page: pageFieldsSchema,
  order: z.number().int(),
  enabled: z.boolean(),
  hidden: z.boolean(),
  installedAt: z.string().min(1),
  updatedAt: z.string().min(1),
}).strict().readonly()

const registrySchema = z.object({
  schemaVersion: z.literal(1),
  revision: z.number().int().nonnegative(),
  entries: z.array(registryEntrySchema).readonly(),
}).strict().readonly()

/**
 * Parse and validate registry schema v1. Unknown versions, wrong types,
 * unknown keys, credential-bearing source displays, and duplicate package
 * names, page ids, or root entry ids are all rejected; v1 fails closed and
 * never reads a newer format. Entries come back in stable order (`order`
 * ascending, then package name), and every returned level is frozen: the
 * schema applies zod `readonly` at each nested level, and the sorted entry
 * array plus result object are frozen explicitly.
 * @param value - unvalidated registry content from the durable boundary.
 * @returns the immutable parsed registry.
 */
export function parsePageAppRegistry(value: unknown): PageAppRegistryV1 {
  const parsed = parseStrict(registrySchema, value, 'page-app registry')
  const packageNames = new Set<string>()
  const pageIds = new Set<string>()
  const rootIds = new Set<string>()
  for (const entry of parsed.entries) {
    assertPageAppSourceNoCredentials(entry.source.display)
    if (packageNames.has(entry.packageName)) {
      throw new Error(`page-app registry: duplicate package name ${entry.packageName}`)
    }
    if (pageIds.has(entry.page.id)) {
      throw new Error(`page-app registry: duplicate page id ${entry.page.id}`)
    }
    if (rootIds.has(entry.page.rootEntryId)) {
      throw new Error(`page-app registry: duplicate root entry id ${entry.page.rootEntryId}`)
    }
    packageNames.add(entry.packageName)
    pageIds.add(entry.page.id)
    rootIds.add(entry.page.rootEntryId)
  }
  const entries = [...parsed.entries].sort((a, b) => a.order - b.order
    || (a.packageName < b.packageName ? -1 : a.packageName > b.packageName ? 1 : 0))
  Object.freeze(entries)
  return Object.freeze({ ...parsed, entries })
}

/**
 * Read and parse the profile registry, returning null when no registry has
 * been published yet. A corrupt or unparsable file throws rather than being
 * silently rewritten — the manager preserves it and exposes recovery.
 * @param profileDir - absolute profile directory.
 * @returns the parsed registry, or null when the file is absent.
 */
export async function readPageAppRegistry(profileDir: string): Promise<PageAppRegistryV1 | null> {
  const paths = resolvePageAppProfilePaths(profileDir)
  let raw: string
  try {
    raw = await readFile(paths.registry, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  return parsePageAppRegistry(JSON.parse(raw))
}

/**
 * Atomically publish the profile registry with owner-only permissions. The
 * complete value is re-validated through the full v1 schema — including
 * credential-bearing display rejection and uniqueness — so no invalid or
 * secret-bearing registry can reach disk; nothing is written on rejection.
 * The caller owns revision incrementing and journaling; this is the single
 * write path for the ownership file.
 * @param profileDir - absolute profile directory.
 * @param registry - the complete next registry value.
 */
export async function writePageAppRegistry(profileDir: string, registry: PageAppRegistryV1): Promise<void> {
  const validated = parsePageAppRegistry(registry)
  const paths = resolvePageAppProfilePaths(profileDir)
  await writeFileAtomic(paths.registry, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600, dirMode: 0o700 })
}
