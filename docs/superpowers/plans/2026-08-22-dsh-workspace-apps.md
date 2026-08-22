# DSH Workspace Apps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver profile-scoped Workspace Apps that can be installed, enabled, hidden, reordered, disabled, and uninstalled live while preserving the built-in DSH page and providing transactional rollback.

**Architecture:** A Host-safe profile package owns schemas, paths, locks, journals, and deterministic layers; launcher-owned `profileRuntime` is the only live-composition writer; a Host `pageAppManager` service owns validation and transactions; the generic client module/HMR path reconciles graph additions and removals; and a client manager package owns the outer root shell, authorized page projection, rail, Settings tab, and activation acknowledgement.

**Tech Stack:** TypeScript 6, Node.js filesystem/process APIs, Cordis Loader/Include/HMR, Typert Remote, React 18, DSH slots and observable stores, Vitest, Testing Library, pnpm 11.

**Spec:** `docs/superpowers/specs/2026-08-22-dsh-workspace-manager-design.md`

**Status:** Codex and DSH review complete; awaiting user approval.

## Global Constraints

- Baseline is `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e` (`dsh-v0.1.1-rc.2`). Rebase the plan if implementation starts from another revision.
- User-facing copy is **Workspace Apps** and **Plugins → Workspace Apps**. Internal identifiers use `pageApp`, `page-app`, and `page-app.*`; do not introduce a second DSH Workspace domain.
- DSH / Coding GLM-5.3 implements one task at a time. Codex reviews the diff and fresh focused test output at every checkpoint before assigning the next group.
- Every behavior task follows red → green → focused regression → commit. Do not batch unreviewed tasks into one commit.
- Do not hand-edit generated Typert artifacts under `lib/`; author types and Remote methods in `src/`, then run the build generator.
- Do not add compatibility readers for rejected registry or journal versions. v1 fails closed.
- Do not broaden `pnpm-workspace.yaml` `allowBuilds`, delete local sources, clean the pnpm store, scan global plugins, or infer ownership from Plugin Inventory.
- Browser code never imports Node APIs, writes profile files, or invokes pnpm.
- All registrations and subscriptions are effect-owned. Components receive plain data/callbacks and renderer-bound hooks; components never receive `ctx` or call `useSyncExternalStore` directly.
- Use `@deepseek-ai/dsh-atomic-write` for atomic replacement. The long-running pnpm lock is a specialized `operation.lock` acquired by exclusive `wx` create; its owner token is also recorded in the transaction journal so startup recovery can distinguish a dead transaction owner from live contention.
- For every new package, add its TypeScript aggregate reference, package dependencies, invariant companion, README/README.zh pairing, and publication files in the same task that makes the package loadable.
- A non-trivial implementation requires an Agent Note in `.agents/notes/implemented/architecture/` and current-state package documentation before final acceptance.

---

## Planned File Structure

### New Host-safe profile core

- `packages/boot/page-app-profile/package.json`
- `packages/boot/page-app-profile/tsconfig.json`
- `packages/boot/page-app-profile/src/index.ts`
- `packages/boot/page-app-profile/src/types.ts`
- `packages/boot/page-app-profile/src/paths.ts`
- `packages/boot/page-app-profile/src/manifest.ts`
- `packages/boot/page-app-profile/src/registry.ts`
- `packages/boot/page-app-profile/src/layer.ts`
- `packages/boot/page-app-profile/src/journal.ts`
- `packages/boot/page-app-profile/src/lock.ts`
- `packages/boot/page-app-profile/src/invariant.ts`
- `packages/boot/page-app-profile/tests/*.spec.ts`

The package resolves these exact profile-owned files and no others:

- `.workspace-manager/registry.json`
- `.workspace-manager/runtime-layer.yml`
- `.workspace-manager/transaction.json`
- `.workspace-manager/operation.lock`

### New Host manager

- `packages/host/page-app-manager/package.json`
- `packages/host/page-app-manager/tsconfig.json`
- `packages/host/page-app-manager/src/index.ts`
- `packages/host/page-app-manager/src/types.ts`
- `packages/host/page-app-manager/src/source.ts`
- `packages/host/page-app-manager/src/validation.ts`
- `packages/host/page-app-manager/src/executor.ts`
- `packages/host/page-app-manager/src/transaction.ts`
- `packages/host/page-app-manager/src/recovery.ts`
- `packages/host/page-app-manager/src/invariant.ts`
- `packages/host/page-app-manager/tests/*.spec.ts`

### New client manager

- `packages/client/ui-page-app-manager/package.json`
- `packages/client/ui-page-app-manager/tsconfig.json`
- `packages/client/ui-page-app-manager/tsdown.config.ts`
- `packages/client/ui-page-app-manager/src/index.ts`
- `packages/client/ui-page-app-manager/src/invariant.ts`
- `packages/client/ui-page-app-manager/src/css-modules.d.ts`
- `packages/client/ui-page-app-manager/src/client/index.ts`
- `packages/client/ui-page-app-manager/src/client/controller.ts`
- `packages/client/ui-page-app-manager/src/client/stores.ts`
- `packages/client/ui-page-app-manager/src/client/contracts.ts`
- `packages/client/ui-page-app-manager/src/client/PageAppShell.tsx`
- `packages/client/ui-page-app-manager/src/client/PageAppRail.tsx`
- `packages/client/ui-page-app-manager/src/client/PageAppSettingsTab.tsx`
- `packages/client/ui-page-app-manager/src/client/locales.ts`
- `packages/client/ui-page-app-manager/src/client/*.module.css`
- `packages/client/ui-page-app-manager/tests/*.client.spec.ts*`

### Integration changes

- `packages/boot/app-boot/src/profile-runtime.ts`
- `packages/boot/app-boot/src/index.ts`
- `apps/cli/src/profile-boot.ts`
- `apps/cli/src/plugin.ts`
- `packages/client/connection/src/index.ts`
- `packages/client/ui-slots/src/index.ts`
- `packages/client/runtime/src/client/slots.ts`
- `packages/client/modules/src/index.ts`
- `packages/client/modules/src/client/manifest.ts`
- `packages/client/modules/src/client/system.ts`
- `packages/client/hmr/src/events.ts`
- `packages/client/hmr/src/index.ts`
- `packages/client/hmr/src/client/index.ts`
- `packages/client/ui-layout/src/client/index.ts`
- `packages/client/ui-layout/src/client/AppFrame.tsx`
- `packages/api/remotes/src/index.ts`
- `packages/api/remotes/src/client/index.ts`
- `packages/api/remotes/src/remote-events.ts`
- `packages/api/remotes/package.json`
- `packages/bundle/web-app/cordis.patch.yml`
- `packages/bundle/web-app/package.json`
- `apps/cli/package.json`
- `tsconfig.host.json`
- `tsconfig.client.json`

### Fixture and assembled acceptance

- `packages/examples/page-app-fixture/**`
- `apps/web/tests/workspace-apps.e2e.ts`
- `apps/web/tests/workspace-apps-profiles.e2e.ts`
- `apps/web/tests/snapshots/workspace-apps/**`
- `.agents/notes/implemented/architecture/2026-08-22-workspace-apps.md`

---

## Task 0: Freeze Preconditions and Pin Existing Loader Rollback Behavior

**Files:**

- Create: `packages/boot/app-boot/tests/include-rollback.spec.ts`
- Verify: `packages/boot/app-boot/tests/config-reload.spec.ts`
- Verify: `docs/superpowers/specs/2026-08-22-dsh-workspace-manager-design.md`

- [ ] Confirm `git rev-parse HEAD` equals the baseline and `git status --short` contains only approved planning documents.
- [ ] Write a characterization test that mounts the same root Include used by `watchUserPatches`, successfully applies generation A, then makes generation B fail during child apply and asserts generation A remains active with its previous options and effects.
- [ ] Run `pnpm exec vitest run packages/boot/app-boot/tests/include-rollback.spec.ts packages/boot/app-boot/tests/config-reload.spec.ts`.
- [ ] The new test may be green immediately because it pins an existing vendored guarantee. If it fails, stop: redesign `ProfileRuntime` around explicit full-stack restoration before writing transaction code.
- [ ] Commit the passing contract pin: `test(app-boot): pin include update rollback`

## Task 1: Add the Host-safe Page-app Profile Core

**Files:**

- Create: every file under `packages/boot/page-app-profile/` listed above
- Modify: `tsconfig.host.json`
- Modify: `apps/cli/package.json`
- Test: `packages/boot/page-app-profile/tests/manifest.spec.ts`
- Test: `packages/boot/page-app-profile/tests/registry.spec.ts`
- Test: `packages/boot/page-app-profile/tests/layer.spec.ts`
- Test: `packages/boot/page-app-profile/tests/lock.spec.ts`
- Test: `packages/boot/page-app-profile/tests/journal.spec.ts`

**Produces:** Parsed `PageAppManifest`, validated `PageAppRegistryV1`, deterministic runtime-layer serialization, exact profile paths, atomic registry/journal operations, and one shared mutation lock.

**Core public types:**

```ts
export type PageAppSourceKind = 'registry' | 'file' | 'link' | 'tarball' | 'git'

export interface PageAppRegistryV1 {
  readonly schemaVersion: 1
  readonly revision: number
  readonly entries: readonly PageAppRegistryEntry[]
}

export interface PageAppProfilePaths {
  readonly directory: string
  readonly registry: string
  readonly runtimeLayer: string
  readonly journal: string
  readonly operationKey: string
}

export function resolvePageAppProfilePaths(profileDir: string): PageAppProfilePaths
export function parsePageAppManifest(packageName: string, value: unknown): PageAppManifest
export function parsePageAppRegistry(value: unknown): PageAppRegistryV1
export function renderPageAppRuntimeLayer(entries: readonly ValidatedManagedRoot[]): string
export interface PageAppLockOwner {
  readonly kind: 'manager' | 'plugin-cli'
  readonly token: string
}

export function withPageAppProfileLock<T>(
  profileDir: string,
  owner: PageAppLockOwner,
  operation: () => Promise<T>,
): Promise<T>
export function recoverOrphanedPageAppLock(profileDir: string): Promise<void>
```

- [ ] Write manifest tests for exact schema version, required non-empty fields, integer order, redacted source rules, and rejection of credential-bearing URLs.
- [ ] Write registry tests for strict version/type validation, duplicate package/page/root ids, stable ordering, and immutable returned data.
- [ ] Write layer tests asserting byte-identical YAML for equivalent input, enabled-only insertion, no `!!js`, no relative Loader names, and no mutation of input objects.
- [ ] Write lock tests proving two contenders serialize and the created path is exactly `.workspace-manager/operation.lock`. Acquire with `wx`/0600 in a 0700 manager directory and store schema version, owner kind, pid, opaque owner token, and acquisition timestamp.
- [ ] Write orphan tests: recovery may atomically rename a dead manager lock to a token-specific quarantine name when its token matches the journal. A dead manager lock with no journal is safe only because the transaction protocol forbids all mutations before journal publication and removes the journal only after commit. A dead `plugin-cli` lock with no journal fails closed for operator repair because generic pnpm may have stopped mid-mutation. Live pid, mismatched token, unreadable payload, or indeterminate liveness also fail closed. The rename's single-winner behavior plus a new `wx` acquire must prevent two simultaneous recoverers from both entering.
- [ ] Write journal tests for prepared/staged/committing phases, lock owner token, before-file hashes, absent-file markers, 0600 private backup files, and rejection of unknown versions/phases.
- [ ] Run `pnpm exec vitest run packages/boot/page-app-profile/tests`; expect failure because the package does not exist.
- [ ] Implement the smallest parser/path/serialization/lock/journal code that makes the tests pass. Reuse `@deepseek-ai/dsh-atomic-write`; do not add another atomic writer.
- [ ] Add package manifest, invariant, tsconfig, host aggregate reference, and `apps/cli` dependency.
- [ ] Run `pnpm exec vitest run packages/boot/page-app-profile/tests` and `pnpm exec tsc -b packages/boot/page-app-profile/tsconfig.json`.
- [ ] Commit: `feat(page-apps): add profile persistence core`

## Task 2: Add Launcher-owned Profile Runtime and Layer Order

**Files:**

- Create: `packages/boot/app-boot/src/profile-runtime.ts`
- Modify: `packages/boot/app-boot/src/index.ts`
- Modify: `packages/boot/app-boot/package.json`
- Modify: `packages/boot/app-boot/tests/profile.spec.ts`
- Create: `packages/boot/app-boot/tests/profile-runtime.spec.ts`
- Modify: `apps/cli/src/profile-boot.ts`
- Create: `apps/cli/tests/profile-boot.spec.ts`

**Consumes:** Task 1 paths, registry parser, and layer renderer.

**Produces:** Immutable profile identity plus the sole acknowledged live-recomposition API.

```ts
export interface ActiveProfileIdentity {
  readonly name: string
  readonly directory: string
}

export interface ProfileRuntimeApplyRequest {
  readonly registryRevision: number
  readonly runtimeLayer: string
  readonly expectedRoots: readonly ExpectedManagedRoot[]
}

export interface ProfileRuntimeApplyResult {
  readonly generation: number
  readonly activeRoots: readonly string[]
  readonly externallyOverridden: readonly string[]
}

export class ProfileRuntime extends Service {
  readonly identity: ActiveProfileIdentity
  applyManagerLayer(request: ProfileRuntimeApplyRequest): Promise<ProfileRuntimeApplyResult>
  restoreManagerLayer(request: ProfileRuntimeApplyRequest): Promise<ProfileRuntimeApplyResult>
}
```

- [ ] Write a failing order test that composes conflicting rows and proves precedence is bundles → manager runtime layer → profile patch → home patch → overlays/telemetry.
- [ ] Write failing startup tests: valid registry + missing/corrupt derived layer regenerates; corrupt registry boots base rows with no managed roots and exposes a recovery error; missing dependency/version drift omits the unsafe root.
- [ ] Write failing live tests proving `applyManagerLayer` resolves only after the Include update and root activation audit succeed, rejects activation failure, and reports an effective user override by root id/hash.
- [ ] Run `pnpm exec vitest run packages/boot/app-boot/tests/profile-runtime.spec.ts packages/boot/app-boot/tests/profile.spec.ts`; expect the new assertions to fail.
- [ ] Implement `ProfileRuntime` as a launcher-provided Cordis service. `profile-boot` provides it in `boot(..., prepare)` beside launch environment and cmdline facts.
- [ ] Bind the root Include entry to that pre-provided service immediately after `mountRootInclude` resolves it. A manager-layer call before binding fails loudly; the manager plugin may inject the service during boot but cannot mutate until the initial tree has settled.
- [ ] Replace both initial and live composition arrays in `apps/cli/src/profile-boot.ts` with one function that reads the current manager layer between bundle and user layers. Keep fresh structured clones per generation.
- [ ] Ensure manager updates and both existing user-patch watchers call the same serialized recomposition path; no independent `entry.update` writers may race.
- [ ] Run focused tests plus `pnpm exec vitest run packages/boot/app-boot/tests/config-reload.spec.ts packages/boot/app-boot/tests/user-patches.spec.ts`.
- [ ] Commit: `feat(page-apps): add acknowledged profile runtime layer`

## Task 3: Hoist the Privileged API Fence Ahead of Every Dispatcher

**Files:**

- Modify: `packages/client/connection/src/index.ts`
- Create: `packages/client/connection/src/privileged-methods.ts`
- Modify: `packages/client/connection/src/rpc-host.ts`
- Modify: `packages/client/connection/tests/node-half.host.spec.ts`
- Modify: `packages/client/connection/tests/api-request-trust.host.spec.ts`

**Produces:** Transport-level loopback-only authorization for every mutation before Typert Gateway, legacy API Proxy, or any manager executor can run.

The exact privileged additions are:

```ts
'pageAppManager/install'
'pageAppManager/setEnabled'
'pageAppManager/setHidden'
'pageAppManager/reorder'
'pageAppManager/uninstall'
'pageAppManager/ackClientActivation'
'pageAppManager/recover'
```

Typert Gateway forms endpoints as `${namespace}/${method}`. Existing dotted names in the privileged set belong to the legacy API Proxy and remain unchanged; do not normalize one transport's spelling into the other or use prefix matching.

- [ ] Add a table-driven route test that submits each exact slash endpoint (for example `/api/pageAppManager/install` with envelope method `pageAppManager/install`) from a non-loopback request while both the Typert interceptor and fallback API proxy are capable of claiming it.
- [ ] Assert HTTP 403, zero Gateway calls, zero API Proxy calls, and zero executor calls for every row.
- [ ] Run `pnpm exec vitest run packages/client/connection/tests/node-half.host.spec.ts packages/client/connection/tests/api-request-trust.host.spec.ts`; expect the Typert-claimed cases to fail before the hoist.
- [ ] Move the exact-name set to `privileged-methods.ts`. In `HostConnectionService.createSharedFetchHandler`, extract the endpoint and apply the empty-trust-list check before reading or matching the Typert interceptor; only then select interceptor versus fallback. Remove the fallback-only copy from `index.ts`. Retain the ordinary trusted-host fence for the route as a whole.
- [ ] Run the focused tests and `pnpm exec tsc -b packages/client/connection/tsconfig.host.json`.
- [ ] Commit: `fix(connection): gate page app mutations before dispatch`

## Task 4: Stamp Immutable Slot Owner Provenance

**Files:**

- Modify: `packages/client/ui-slots/src/index.ts`
- Modify: `packages/client/ui-slots/tests/core.client.spec.ts`
- Modify: `packages/client/runtime/src/client/slots.ts`
- Modify: `packages/client/runtime/tests/slots-service.client.spec.ts`
- Modify: `packages/extensions/cordis-client-runner/tests/runner.client.spec.ts`

**Produces:** Read-only `StoredEntry.ownerPackage`, derived from the caller Loader entry rather than registration options.

- [ ] Add compile/runtime tests that public `register` options cannot set `ownerPackage` and stored entries expose it only as output metadata.
- [ ] Add service tests for: a direct Loader entry, its child fiber, no Loader entry, and a contribution executed by `@deepseek-ai/dsh-cordis-client-runner`.
- [ ] Expected values are the normalized Loader package name (remove only a trailing `/client`), inherited child owner, `undefined`, and the runner package respectively.
- [ ] Run `pnpm exec vitest run packages/client/ui-slots/tests/core.client.spec.ts packages/client/runtime/tests/slots-service.client.spec.ts packages/extensions/cordis-client-runner/tests/runner.client.spec.ts`; expect missing provenance failures.
- [ ] In `SlotRegistry._register`, read the caller-bound `this.ctx.fiber.entry?.options.name`; never read `options.ownerPackage`. Pass the derived value to `SlotCore` as internal metadata.
- [ ] Keep existing `registrant` diagnostics separate from authorization provenance.
- [ ] Run the focused tests and `pnpm exec tsc -b packages/client/runtime/tsconfig.json`.
- [ ] Commit: `feat(slots): stamp immutable package provenance`

## Task 5: Make the Client Module Graph Replaceable

**Files:**

- Modify: `packages/client/modules/src/client/manifest.ts`
- Modify: `packages/client/modules/src/client/system.ts`
- Modify: `packages/client/modules/src/client/index.ts`
- Modify: `packages/client/modules/src/index.ts`
- Modify: `packages/client/modules/tests/loader.client.spec.ts`
- Modify: `packages/client/modules/tests/node-half.client.spec.ts`

**Produces:** An atomic, validated graph replacement below all feature-specific code.

```ts
export interface ClientGraphDiff {
  readonly added: readonly string[]
  readonly removed: readonly string[]
  readonly changed: readonly string[]
}

export interface ClientModuleLoader {
  readonly manifest: BootManifest
  replaceGraph(wire: unknown): ClientGraphDiff
  // existing import, prefetch, invalidate members remain
}
```

- [ ] Write browser tests proving `replaceGraph` validates the entire wire graph before mutation; rejects duplicate ids, malformed rows, and dependency cycles while retaining the previous manifest/rows.
- [ ] Write tests proving added/removed/changed ids are returned in graph order, unchanged materialized records keep identity, and a removed record remains available until the caller unloads then calls `invalidate`.
- [ ] Write a Node-half test where a package name was negatively cached before installation, then a live Loader entry for that now-resolvable package arrives and becomes a graph row.
- [ ] Add a Node-half test proving an invalid arriving graph leaves `ClientModuleRegistry.graph()` at its last valid object and reports the package error exactly once.
- [ ] Run `pnpm exec vitest run packages/client/modules/tests/loader.client.spec.ts packages/client/modules/tests/node-half.client.spec.ts`; expect the replacement and late-package cases to fail.
- [ ] Implement `replaceGraph` by parsing to a candidate `BootManifest`, building candidate maps, validating dependency order, calculating the diff, and only then swapping current manifest/row tables.
- [ ] Replace the class's fixed `readonly manifest` field with a stable getter over the current validated manifest.
- [ ] On a newly active Loader package not already in the table, invalidate its cached `null` metadata before `resolveMeta`; do not flush all metadata on ordinary fiber restarts.
- [ ] Run the focused tests and `pnpm exec tsc -b packages/client/modules/tsconfig.json`.
- [ ] Commit: `feat(client-modules): replace live module graphs atomically`

## Task 6: Reconcile Graph Additions and Removals Through HMR

**Files:**

- Modify: `packages/client/hmr/src/events.ts`
- Modify: `packages/client/hmr/src/index.ts`
- Modify: `packages/client/hmr/src/client/index.ts`
- Modify: `packages/client/hmr/tests/node-half.client.spec.ts`
- Create: `packages/client/hmr/tests/graph-reconcile.client.spec.ts`

**Consumes:** Task 5 `replaceGraph`.

**Produces:** One serialized client lifecycle queue for graph changes and same-row rebuilds.

- [ ] Write a Host test proving `onGraphChanged` broadcasts a fresh `graph` frame only when `graph.rev` changes, while `rebuilt` still carries same-package content changes.
- [ ] Write browser tests with a real vendored Loader and fake bundle transport for this exact order:
  1. removed Loader entries drain and disappear;
  2. removed module factories/records and owned styles are invalidated;
  3. the validated candidate graph becomes current;
  4. added rows prefetch in graph order;
  5. added Loader entries are created;
  6. fibers settle before activation is reported.
- [ ] Add tests proving unchanged entries, fibers, styles, and mounted component state retain identity; graph and rebuilt frames cannot interleave; failure does not create a partial added set.
- [ ] Assert a removed Loader entry disappears without persisting `options.disabled = true`; this pins the safe `loader.remove(entry.id)` path rather than a bare fiber disposal.
- [ ] Add a reconnect test proving a graph frame received after client-hmr self-reload converges from the current client graph even if an earlier frame was lost during the EventSource gap.
- [ ] Run `pnpm exec vitest run packages/client/hmr/tests`; expect graph-frame tests to fail because the current client ignores them.
- [ ] Implement `reconcileGraph(graph)` inside the same promise queue used by `reload`. Find entries by normalized package name; call `loader.remove(entry.id)` before `modules.invalidate(id)` for removals, then prefetch/create additions in graph order.
- [ ] Do not special-case Workspace Apps in HMR. The manager waits on the generic graph result and slot projection.
- [ ] Run focused HMR and module tests together.
- [ ] Commit: `feat(client-hmr): reconcile added and removed graph rows`

## Task 7: Build Static Validation and Read-only Manager Projection

**Files:**

- Create: package skeleton and `src/types.ts`, `src/source.ts`, `src/validation.ts`, `src/index.ts`, `src/invariant.ts` under `packages/host/page-app-manager/`
- Create: `packages/host/page-app-manager/tests/source.spec.ts`
- Create: `packages/host/page-app-manager/tests/validation.spec.ts`
- Create: `packages/host/page-app-manager/tests/manager.spec.ts`
- Modify: `tsconfig.host.json`
- Modify: `packages/bundle/web-app/package.json`
- Modify: `apps/cli/package.json`

**Consumes:** Tasks 1–2 plus Cordis Loader, app-boot composition helpers, and client module validation.

**Produces:** A Host `pageAppManager` service that can safely list committed rows and validate a staged dependency without mutating ownership.

```ts
export type PageAppHealth =
  | 'ready' | 'disabled' | 'missing-dependency' | 'version-drift'
  | 'invalid-manifest' | 'activation-failed' | 'externally-overridden'
  | 'recovery-required'

export interface PageAppManagerSnapshot {
  readonly profile: ActiveProfileIdentity
  readonly revision: number
  readonly entries: readonly PageAppView[]
  readonly operation: PageAppOperationView | null
  readonly recovery: PageAppRecoveryView | null
}
```

- [ ] Write source tests covering typed registry/Git specs, absolute picker-backed directory/`file:`/`link:`/tarball paths, ambiguous relative path rejection, URL credential rejection, and redacted display output.
- [ ] Write validation fixtures for every rule in spec §11: package name/version, direct dependency key equality, in-package patch path, exact `dsh.workspace` v1 fields, one top-level root, matching root id, no ignored patches/warnings, no `!!js`, no relative names, three uniqueness axes, base-id collision, external-management collision, valid Web artifact, exactly one package client row, resolvable acyclic externals.
- [ ] Write list tests proving the registry is the only ownership source and health is derived from current dependency/version/runtime facts; Plugin Inventory and unrelated Loader rows never create entries.
- [ ] Run `pnpm exec vitest run packages/host/page-app-manager/tests`; expect missing-package failures.
- [ ] Implement package resolution from the immutable active-profile directory with `createRequire(profile/package.json)`. Do not resolve source paths against Host cwd.
- [ ] Keep the manager root registration independent of Remote readiness: construct the service from `profileRuntime` and Loader facts; Remote generation comes later.
- [ ] Add package/aggregate/dependency/invariant wiring and focused typecheck.
- [ ] Declare `execa` in the Host manager's production `dependencies` because `executor.ts` imports it at runtime; do not rely on the root-only development dependency.
- [ ] Commit: `feat(page-apps): validate and project managed packages`

## Task 8: Implement Journaled Transactions, Rollback, and Recovery

**Files:**

- Create: `packages/host/page-app-manager/src/executor.ts`
- Create: `packages/host/page-app-manager/src/transaction.ts`
- Create: `packages/host/page-app-manager/src/recovery.ts`
- Modify: `packages/host/page-app-manager/src/index.ts`
- Create: `packages/host/page-app-manager/tests/transaction.spec.ts`
- Create: `packages/host/page-app-manager/tests/recovery.spec.ts`
- Create: `packages/host/page-app-manager/tests/loader-composition.spec.ts`

**Consumes:** Profile lock/journal and acknowledged profile runtime.

**Produces:** Single-operation install, enable, disable, hide, reorder, uninstall, and recovery operations.

```ts
export interface PageAppPackageExecutor {
  run(args: readonly string[], options: { cwd: string; signal: AbortSignal }): Promise<PackageCommandResult>
}

export interface ClientActivationRequest {
  readonly transactionId: PageAppTransactionId
  readonly clientInstanceId: PageAppClientInstanceId
  readonly packageName: string
  readonly pageId: string
  readonly graphRevision: string
}
```

- [ ] Write transaction tests with a fake executor and real temp profile for the exact install, enable, disable, hide, reorder, and uninstall state machines in spec §10.
- [ ] At every fallible boundary assert the journal phase and backups are durable before the next mutation: manifest, lockfile present/absent content, registry, runtime layer, and hashes.
- [ ] Write cancellation tests for pnpm add/remove, Host activation, client acknowledgement, and disconnect. Every case restores the previous live layer and runs the required inverse/convergence path.
- [ ] Write rollback tests proving package/lockfile backups are restored before profile-local `pnpm install`; a non-zero convergence result retains the journal and projects `recovery-required`.
- [ ] Write an `allowBuilds` refusal test that preserves pnpm's exact dependency-key diagnostic and proves the manager does not edit `pnpm-workspace.yaml`.
- [ ] Write real Loader composition tests for insert, failed activation rollback, disable unload, user override reporting, corrupt-layer regeneration, dependency-missing safe boot, and version-drift fail-closed.
- [ ] Write recovery-table tests by constructing each durable journal/file-state pair. Verify complete-commit, restore-before-state, and conflict outcomes; never guess if both recorded sides changed.
- [ ] Run `pnpm exec vitest run packages/host/page-app-manager/tests/transaction.spec.ts packages/host/page-app-manager/tests/recovery.spec.ts packages/host/page-app-manager/tests/loader-composition.spec.ts`; expect failures before orchestration exists.
- [ ] Implement the executor with `execa('pnpm', args, ...)`, profile cwd, bounded diagnostic capture, and AbortSignal. Verify the `.cmd` resolution path on Windows without concatenating user input into a shell command.
- [ ] Use bounded `EBUSY`/`EPERM` retries only for known profile-owned rollback cleanup paths on Windows; exhaust retries into `recovery-required`, never delete outside the validated profile paths.
- [ ] Publish the registry only after Host activation and the first valid targeted client acknowledgement. Reject stale transaction, wrong client instance, wrong package/page/revision, and second acknowledgements.
- [ ] Hold the shared profile lock across every pnpm and owned-file mutation. Re-check profile manifest/lockfile hashes before publication to detect external writes.
- [ ] Run the focused transaction suite, then all `packages/host/page-app-manager/tests`.
- [ ] Commit: `feat(page-apps): add recoverable lifecycle transactions`

## Task 9: Generate and Assemble the Page-app Remote API

**Files:**

- Modify: `packages/host/page-app-manager/src/index.ts`
- Modify: `packages/host/page-app-manager/src/types.ts`
- Modify: `packages/host/page-app-manager/package.json`
- Create: `packages/host/page-app-manager/tests/remote.spec.ts`
- Modify: `packages/api/remotes/src/index.ts`
- Modify: `packages/api/remotes/src/client/index.ts`
- Modify: `packages/api/remotes/src/remote-events.ts`
- Modify: `packages/api/remotes/package.json`
- Create: `packages/api/remotes/tests/page-app-manager.spec.ts`

**Produces:** Strict generated methods under `pageAppManager` and two forwarded lifecycle events.

- [ ] Author branded ids and JSON-safe request/result types in `src/types.ts`; include cancellation-aware method signatures and strict result fields.
- [ ] Add `@Remote` methods named exactly `list`, `install`, `setEnabled`, `setHidden`, `reorder`, `uninstall`, `ackClientActivation`, and `recover` on the `TypertRemoteService` subclass.
- [ ] Declare typed Host events with `@mode`/`@param` JSDoc: `page-app-manager/changed` and `page-app-manager/activation-requested`.
- [ ] Write Host/Client tests for strict codecs, stale revision refusal, cancellation propagation, target-client acknowledgement, and event payloads.
- [ ] Run the new tests before generation; expect missing namespace/type failures.
- [ ] Add the standard `./types`, `./typert`, and `./remote` exports and publication file entries to the Host package manifest.
- [ ] Mount the generated `pageAppManagerRemote` contribution explicitly in `packages/api/remotes/src/client/index.ts`; add types imports/exports and both event names to the one forwarded-event allowlist.
- [ ] Add matching peer/dev dependencies in API Remotes and aggregate references.
- [ ] Run `pnpm run build:lib:host` to generate Typert artifacts, then `pnpm run typecheck:contracts-ready` and the focused tests. Review generated output; do not edit it.
- [ ] Compare every generated descriptor with Gateway's `${namespace}/${method}` `endpointOf` output; the seven privileged strings and route-test paths must match those slash endpoints byte-for-byte.
- [ ] Re-run Task 3 route tests against generated exact method names.
- [ ] Commit: `feat(page-apps): expose typed manager remote`

## Task 10: Build the React-free Client Controller and Authorization Projection

**Files:**

- Create: client package skeleton plus `src/client/controller.ts`, `stores.ts`, and `contracts.ts`
- Create: `packages/client/ui-page-app-manager/tests/controller.client.spec.ts`
- Create: `packages/client/ui-page-app-manager/tests/authorization.client.spec.ts`
- Create: `packages/client/ui-page-app-manager/tests/stores.client.spec.ts`
- Modify: `tsconfig.client.json`

**Consumes:** Generated Remote API, slot provenance, slot ledger subscriptions, and HMR graph reconciliation.

**Produces:** Stable `HostObservable<PageAppClientSnapshot>` and mutation methods, with no React import.

```ts
export interface PageAppClientSnapshot {
  readonly registry: PageAppManagerSnapshot
  readonly eligible: ReadonlyMap<string, StoredEntry>
  readonly activePageId: string | null
  readonly visitedPageIds: readonly string[]
  readonly activation: PageAppActivationView | null
}

export class PageAppController {
  readonly observable: HostObservable<PageAppClientSnapshot>
  start(): () => void
  select(pageId: string | null): void
  install(source: PageAppInstallSource, signal: AbortSignal): Promise<void>
  setEnabled(pageId: string, enabled: boolean, signal: AbortSignal): Promise<void>
  setHidden(pageId: string, hidden: boolean): Promise<void>
  reorder(pageIds: readonly string[]): Promise<void>
  uninstall(pageId: string, signal: AbortSignal): Promise<void>
  recover(): Promise<void>
}
```

- [ ] Write snapshot tests proving `getSnapshot()` returns the same reference until committed registry or eligible-slot facts change, and subscriptions are stable/disposable.
- [ ] Write a closed authorization matrix. A contribution is eligible only if registry ownership exists, row enabled, slot key equals page id, `ownerPackage` equals package name, and any pending activation matches package/page/revision.
- [ ] Prove unrelated plugins, wrong package provenance, duplicate contributions, no-provenance fibers, and runner-owned contributions are diagnosed but never projected.
- [ ] Write state tests for first visit, stable visited order, hidden-active fallback to DSH without eviction, disable/uninstall eviction, and registry invalidation of current selection.
- [ ] Write activation tests: all clients reconcile an activation event, only the matching stable `crypto.randomUUID()` client instance sends acknowledgement, first terminal result wins, and controller disposal cancels in-flight calls.
- [ ] Run `pnpm exec vitest run packages/client/ui-page-app-manager/tests/controller.client.spec.ts packages/client/ui-page-app-manager/tests/authorization.client.spec.ts packages/client/ui-page-app-manager/tests/stores.client.spec.ts`; expect missing-package failures.
- [ ] Implement with bare observable/store primitives only. React binding belongs to the slot renderer through the `inject.hooks` compartment.
- [ ] Add package manifest, client build config, invariant, aggregate reference, and exact peer/dev dependencies.
- [ ] Run the focused tests and `pnpm exec tsc -b packages/client/ui-page-app-manager/tsconfig.json`.
- [ ] Commit: `feat(page-apps): add authorized client controller`

## Task 11: Move the Root Handoff and Add the Keep-mounted Outer Shell

**Files:**

- Create: `packages/client/ui-page-app-manager/src/client/PageAppShell.tsx`
- Create: `packages/client/ui-page-app-manager/src/client/PageAppRail.tsx`
- Create: `packages/client/ui-page-app-manager/src/client/PageAppShell.module.css`
- Create: `packages/client/ui-page-app-manager/src/client/PageAppRail.module.css`
- Modify: `packages/client/ui-page-app-manager/src/client/index.ts`
- Create: `packages/client/ui-page-app-manager/tests/shell.client.spec.tsx`
- Create: `packages/client/ui-page-app-manager/tests/rail.client.spec.tsx`
- Create: `packages/client/ui-page-app-manager/tests/apply.client.spec.ts`
- Modify: `packages/client/ui-layout/src/client/index.ts`
- Modify: `packages/client/ui-layout/src/client/AppFrame.tsx`
- Modify: `packages/client/ui-layout/tests/app-frame.client.spec.tsx`
- Modify: `packages/client/ui-layout/tests/apply.client.spec.ts`

**Produces:** The manager owns built-in `root`; ui-layout occupies `page-app.shell.builtin`; managed packages occupy keyed `page-app.shell.surface`.

```ts
declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    'page-app.shell.builtin': { kind: 'single'; scope: 'root'; owner: PageAppBuiltinOwner }
    'page-app.shell.surface': { kind: 'keyed'; scope: 'root'; owner: PageAppSurfaceOwner; key: string }
  }
}
```

- [ ] Write apply tests proving the manager registers exactly one `root` contribution and declares both child seats. Remote/controller injection may arrive later and cannot block the built-in seat.
- [ ] Update ui-layout tests first so they fail until `AppFrame` injects into `page-app.shell.builtin` instead of registering directly into `root`.
- [ ] Write shell component tests proving DSH mounts immediately, an unvisited managed page does not mount, first visit mounts it once, switching uses `hidden` without unmount, and stable page ids retain local React state.
- [ ] Write tests proving hide falls back while preserving the subtree; disable/uninstall unmount; DSH stays mounted throughout.
- [ ] Write crash tests using the existing slot error boundary/abdication signal: the failed surface is replaced by manager-owned failure UI while rail and DSH remain operable.
- [ ] Write rail tests for the four-way visibility predicate, accessible current-page state, keyboard navigation, labels, and stable ordering. A disabled/unhealthy row must not appear in the rail.
- [ ] Run `pnpm exec vitest run packages/client/ui-page-app-manager/tests packages/client/ui-layout/tests/app-frame.client.spec.tsx packages/client/ui-layout/tests/apply.client.spec.ts`; expect root-handoff and component failures.
- [ ] Implement the shell with stable keyed wrappers for every visited enabled page. Toggle the wrapper's HTML `hidden` state and CSS only; do not conditionally drop inactive/hidden children.
- [ ] Preserve `AppFrame`'s existing sidebar/conversation/details/overlay declarations inside its new built-in registration.
- [ ] Run focused tests plus `pnpm run test:gui`.
- [ ] Commit: `feat(page-apps): add keep-mounted workspace app shell`

## Task 12: Add the Workspace Apps Settings Tab

**Files:**

- Create: `packages/client/ui-page-app-manager/src/client/PageAppSettingsTab.tsx`
- Create: `packages/client/ui-page-app-manager/src/client/PageAppSettingsTab.module.css`
- Create: `packages/client/ui-page-app-manager/src/client/locales.ts`
- Modify: `packages/client/ui-page-app-manager/src/client/index.ts`
- Create: `packages/client/ui-page-app-manager/tests/settings.client.spec.tsx`
- Create: `packages/client/ui-page-app-manager/tests/locales.client.spec.ts`

**Produces:** Lazy `settings.plugins.tab` entry `workspace-apps`; Plugin Inventory remains independent and read-only.

- [ ] Write component tests for profile identity, source entry, directory picker handoff, rows, health, enabled/hidden controls, ordering, uninstall confirmation, progress, rollback failure, and recovery action.
- [ ] Assert Settings continues to show disabled, hidden, unhealthy, and recovery-required rows even when the rail does not.
- [ ] Assert local picker output is passed as an absolute picker-backed source; typed text cannot masquerade as a relative local path.
- [ ] Add accessibility tests for tab/rail labels, switch names/states, destructive confirmation, busy state, error announcement, and keyboard reorder controls.
- [ ] Run `pnpm exec vitest run packages/client/ui-page-app-manager/tests/settings.client.spec.tsx packages/client/ui-page-app-manager/tests/locales.client.spec.ts`; expect failures.
- [ ] Register through `ctx.slots.inject('settings.plugins.tab', ...)` with id `workspace-apps`, after the existing read-only `all` tab. Do not modify the Plugins tab owner.
- [ ] Supply Chinese product copy and paired English locale data. Use theme tokens and CSS Modules only.
- [ ] Run package tests and `pnpm run test:gui`.
- [ ] Commit: `feat(page-apps): add workspace apps settings`

## Task 13: Share the Mutation Lock With `dsh plugin`

**Files:**

- Modify: `apps/cli/src/plugin.ts`
- Modify: `apps/cli/package.json`
- Create: `apps/cli/tests/plugin.spec.ts`
- Modify: `apps/cli/tests/built-bin.e2e.ts`

**Consumes:** Task 1 shared lock and manifest parser/classifier.

**Produces:** Generic plugin mutations serialize with manager operations and never adopt page apps.

- [ ] Write a contention test where `dsh plugin` and manager mutation target the same profile; assert pnpm invocations never overlap.
- [ ] Write install/update tests for a dependency declaring `dsh.workspace`: `dsh plugin` may leave the dependency installed but must not append it to `dsh.profile.bundles` and must print the Plugins → Workspace Apps diagnostic.
- [ ] Write tests proving ordinary plugins retain current reconciliation behavior and an external page-app dependency is not added to the manager registry.
- [ ] Run `pnpm exec vitest run apps/cli/tests/plugin.spec.ts`; expect missing lock/classification failures.
- [ ] Wrap `runPlugin`'s read → pnpm → reconcile sequence in the shared profile lock. Because the callback is async, change the CLI call chain and exit handling deliberately; do not block on a promise with a synchronous spin.
- [ ] Parse installed `dsh.workspace` only for classification/diagnostics. The CLI must not call manager adoption APIs.
- [ ] Run focused source tests and the relevant built-bin filter after a build.
- [ ] Commit: `feat(cli): serialize plugin and workspace app mutations`

## Task 14: Wire the Official Composition and Add a Real Fixture App

**Files:**

- Modify: `packages/bundle/web-app/cordis.patch.yml`
- Modify: `packages/bundle/web-app/package.json`
- Modify: `packages/bundle/web-app/tests/web-app.spec.ts`
- Modify: `packages/bundle/web-app/tests/startup.spec.ts`
- Modify: `tsconfig.host.json`
- Modify: `tsconfig.client.json`
- Create: `packages/examples/page-app-fixture/package.json`
- Create: `packages/examples/page-app-fixture/tsconfig.json`
- Create: `packages/examples/page-app-fixture/tsdown.config.ts`
- Create: `packages/examples/page-app-fixture/cordis.patch.yml`
- Create: `packages/examples/page-app-fixture/src/index.ts`
- Create: `packages/examples/page-app-fixture/src/client/index.tsx`
- Create: `packages/examples/page-app-fixture/src/invariant.ts`
- Create: `packages/examples/page-app-fixture/tests/fixture.spec.ts`
- Create: `packages/examples/page-app-fixture/README.md`
- Create: `packages/examples/page-app-fixture/README.zh.md`

**Produces:** Shipped manager rows and one already-built lazy-CJS example satisfying the external author contract.

- [ ] Add composition tests that fail until `page-app-manager` Host and `ui-page-app-manager` Client rows exist, are named by the web bundle manifest, and activate with required services.
- [ ] Put the outer UI manager before `ui-layout` in the readable roster, but rely on actual Cordis service/slot injection semantics rather than row order for correctness.
- [ ] Build a fixture package with `dsh.bundle`, `dsh.client`, and `dsh.workspace` exactly as spec §5 requires. Its one Managed Root registers one stateful keyed full-page contribution.
- [ ] The fixture README must document that v1 consumers ship `lib/client.js` in DSH lazy-CJS format; do not claim the unpublished `clientBundle` preset is an external toolchain.
- [ ] Run `pnpm exec vitest run packages/bundle/web-app/tests packages/examples/page-app-fixture/tests` before wiring; expect missing rows/package failures.
- [ ] Add web bundle dependencies for both new shipped manager packages and all direct resolution edges. Add the fixture only to test/dev consumers, never the shipped bundle roster.
- [ ] Run focused tests, `pnpm run verify-cordis-config`, `pnpm run verify-client-packages`, and `pnpm run build`.
- [ ] Commit: `feat(page-apps): ship manager composition and fixture`

## Task 15: Prove Real Profile, Browser, Isolation, Recovery, and Product Output

**Files:**

- Create: `apps/web/tests/workspace-apps.e2e.ts`
- Create: `apps/web/tests/workspace-apps-profiles.e2e.ts`
- Create/update: `apps/web/tests/snapshots/workspace-apps/**`
- Modify: `apps/web/tests/scaffold.ts`
- Modify: `apps/web/tests/assembled-boot.ts`
- Modify: `apps/web/tests/settings-chrome.e2e.ts` only where the new tab intentionally changes the shipped snapshot

**Produces:** Keyless assembled evidence for the full feature and its profile isolation.

- [ ] Extend the real-profile scaffold with a temp DSH home, picker-backed fixture source, controllable package executor, and hooks that observe Host/Client Loader disposal without replacing either Loader.
- [ ] Write the main E2E: boot DSH, install fixture, await Host and client activation, select fixture, mutate fixture-local React state, select DSH, return and prove state remains, hide and prove fallback/preservation, disable and prove Host + Client + React disposal, re-enable, then uninstall and prove dependency/registry removal.
- [ ] Write the two-profile E2E: install in Profile A, prove no row/code in Profile B, then install/manage the same package independently and prove revisions/orders do not cross.
- [ ] Add negative E2E paths for invalid manifest, activation failure, cancelled install, failed rollback convergence, startup journal recovery, and version drift. Use constructed durable crash points rather than real process-kill injection.
- [ ] Add product-visible snapshots for rail, Settings states, operation progress, and recovery-required diagnostics. Confirm existing Workspace/session snapshots remain unchanged.
- [ ] Run the new tests first; expect failures until full composition exists.
- [ ] Run `pnpm run build` then `pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/workspace-apps.e2e.ts apps/web/tests/workspace-apps-profiles.e2e.ts`.
- [ ] In PowerShell run `$env:DSH_SNAPSHOT='replay'; pnpm run test:web; Remove-Item Env:DSH_SNAPSHOT`.
- [ ] Commit: `test(page-apps): prove lifecycle and profile isolation`

## Task 16: Finish Documentation, Invariants, and Acceptance Gates

**Files:**

- Create: `.agents/notes/implemented/architecture/2026-08-22-workspace-apps.md`
- Create/update: README/README.zh/README.i18n.yaml for all three new production packages and the fixture
- Modify: `docs/architecture.md`
- Modify: `docs/user/develop/basic/publish.zh.md`
- Modify: the lowest owning `docs/subsystems/*.md` pages selected by the repository documentation rules
- Modify: package invariant companions and their tests
- Regenerate: Cordis/client/config/module-graph catalogs required by the changed APIs and package graph

- [ ] Write current-state docs covering ownership truth, profile file locations, transaction/recovery semantics, security scope, author artifact requirement, and the UI lifecycle table. Keep one home per fact and pair English/Chinese docs.
- [ ] Add executable invariants for owned relationships: shipped composition rows, Remote contribution mounted, privileged exact-name coverage, root ownership handoff, and client graph supplier/request closure.
- [ ] Run focused invariant tests and package tests.
- [ ] Run `pnpm run gen-cordis-catalog`, `pnpm run gen-client-catalog`, `pnpm run gen-config-catalog`, and `pnpm run gen-module-graph` where freshness checks report changes.
- [ ] Confirm `rg --version` succeeds, then run placeholder scan: `rg -n "TODO|FIXME|XXX|placeholder|not implemented|throw new Error\(['\"]todo" packages/boot/page-app-profile packages/host/page-app-manager packages/client/ui-page-app-manager apps/web/tests -g 'workspace-apps*'` and resolve every implementation placeholder introduced by this work.
- [ ] Run spec-coverage review against every item in spec §§2, 4, 7, 10–18, and 20; link each item to a test name in the Agent Note.
- [ ] Run type consistency review: generated Remote signatures, branded ids, registry/journal parser outputs, client observable snapshots, and slot owner metadata must use the same authored types across faces.
- [ ] Run the final proportionate gate set with fresh output:
  - `pnpm exec vitest run packages/boot/page-app-profile/tests packages/boot/app-boot/tests packages/host/page-app-manager/tests packages/client/connection/tests/node-half.host.spec.ts packages/client/modules/tests packages/client/hmr/tests packages/client/ui-page-app-manager/tests packages/client/ui-layout/tests`
  - `pnpm run test:gui`
  - `pnpm run typecheck`
  - `pnpm run lint`
  - `pnpm run build`
  - `pnpm run hygiene`
  - PowerShell: `$env:DSH_SNAPSHOT='replay'; pnpm run test:web; Remove-Item Env:DSH_SNAPSHOT`
  - `pnpm run doc-sync`
- [ ] Run `git diff --check` and inspect `git status --short` for generated or accidental files.
- [ ] Commit: `docs(page-apps): document architecture and acceptance`

---

## Codex Review Checkpoints

Codex must stop DSH after each checkpoint, inspect every changed file, rerun the named focused tests independently, and return all P0/P1 findings before work continues.

1. **Foundation checkpoint:** Tasks 1–4. Accept only if profile persistence, live layer authority, pre-dispatch security, and immutable provenance are individually proven.
2. **Runtime checkpoint:** Tasks 5–9. Accept only if graph replacement is atomic, add/remove order is correct, transaction rollback converges, and generated Remote methods match the privileged set exactly.
3. **UI checkpoint:** Tasks 10–12. Accept only if registry + provenance jointly authorize rendering, React identity survives switching/hiding, disable unmounts, and Settings remains accessible during failures.
4. **Composition checkpoint:** Tasks 13–16. Accept only with real profile/browser evidence, two-profile isolation, product-visible snapshots, complete docs, and fresh gates.

At each checkpoint DSH supplies:

- commit ids and changed-file list;
- red-before/green-after commands and outputs;
- known limitations or deliberately deferred items;
- no claim that the user has manually accepted the product.

## Final Acceptance Matrix

| Spec requirement | Primary evidence |
|---|---|
| Registry is sole ownership truth | Tasks 1, 7, 10 authorization tests |
| Patch precedence and live acknowledgement | Task 2 profile-runtime tests |
| Loopback-only mutations before dispatch | Task 3 table-driven route tests |
| Immutable caller provenance | Task 4 four-origin tests |
| Atomic graph add/remove | Tasks 5–6 module/HMR tests |
| Journaled pnpm lifecycle and recovery | Task 8 transaction/recovery tests |
| Strict Remote and targeted acknowledgement | Task 9 Remote tests; Task 10 controller tests |
| DSH and visited pages stay mounted | Task 11 React identity tests |
| Hide/disable/uninstall meanings | Tasks 8, 10–12, 15 |
| CLI coexistence | Task 13 contention/classification tests |
| External author artifact contract | Task 14 fixture and README |
| Real lifecycle and profile isolation | Task 15 assembled Web tests |
| Existing Workspace/session behavior unchanged | Task 15 replay suite |
| Documentation and repository invariants | Task 16 gates |

## Implementation Handoff Gate

This plan does not authorize implementation by itself. After Codex and DSH finish plan review, the user must approve it. Once approved, DSH / Coding GLM-5.3 implements Tasks 0–16 in order, Codex performs the four checkpoints above, and the user performs final manual product testing only after Codex reports the automated and code-review gates green.
