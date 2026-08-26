# Workspace Apps

English | [中文](workspace-apps.zh.md)

The Workspace Apps subsystem lets a DSH Profile install, manage, and run full-page workspace plugins through an optional manager. The manager is an out-of-tree npm package installed per Profile through `dsh plugin`; it contributes the far-left launcher, Surface Host, and Settings → Plugins → Workspace flow instead of shipping as permanent `dsh-web-app` rows. The subsystem manages **only** Feature packages installed through that Settings flow — external DSH plugins never appear, are never adopted, and are never enumerated.

Source: [`packages/host/page-app-manager/src/index.ts`](../../packages/host/page-app-manager/src/index.ts), [`packages/client/ui-page-app-manager/src/client/apply.ts`](../../packages/client/ui-page-app-manager/src/client/apply.ts)

## Ownership model

- The **managed registry** (`$DSH_HOME/profiles/<profile>/.workspace-manager/registry.json`) is the sole ownership authority. A package is managed only when the registry says so.
- The **managed runtime layer** (`runtime-layer.yml`) is generated projection data derived from the registry; if it disappears it is regenerated, and it is never treated as a second authority.
- The **built-in DSH surface** is a shell-owned fallback, never a registry row — it cannot be hidden, disabled, or uninstalled.
- Hide (presentation), disable (runtime unload), and uninstall (dependency + registry removal) are three distinct operations.
- Install and uninstall are transactional, with a durable journal and backups; any failure before commit rolls back, and a failed rollback exposes `recovery-required` rather than pretending the system is clean.

Two Profiles under one Harness home have independent manager dependencies, registries, runtime layers, revisions, and orders. Installing a manager or Feature in one Profile never makes its row or code visible in another.

## Workbench Contract v1

A managed Feature declares `dsh.workspace.schemaVersion: 1`, one package, one page, and one Managed Root. Admission rejects unsupported versions, invalid root/client composition, ownership collisions, and direct Cordis dependencies. The repository source check additionally rejects static imports, re-exports, dynamic imports, `require`, and direct dependency declarations for `cordis` or `@deepseek-ai/cordis` inside declared Feature source scopes. This source check cannot prove a prebuilt third-party artifact whose source is unavailable.

Manager product code concentrates Cordis, Include, and Loader operations in the Cordis Compatibility Adapter. Each admitted root is rendered beneath a deterministic Feature Runtime Wrapper that injects the manager-provided `workbenchRuntime` service and mounts the Feature's original rows with their package provenance intact. Features register lifecycle callbacks and their workspace surface through the versioned Workbench API; they never receive a raw Cordis context.

The manager fiber owns the provider. When it unloads, Cordis removes `workbenchRuntime` and parks every dependent wrapper fiber; when it returns, Cordis reloads those wrappers. This uses the Loader's ordinary dependency lifecycle and does not maintain a second Feature lifecycle graph.

## The client surface

With the manager active, its client package owns the built-in `root` seat and declares two child seats: the built-in DSH seat (`page-app.shell.builtin`, occupied by the ordinary DSH layout) and the keyed managed-surface seat (`page-app.shell.surface`). The shell keeps visited surfaces mounted (HTML `hidden` toggle only, so editor/draft/scroll state survives switching), unmounts disabled/uninstalled surfaces, and always keeps DSH reachable. A failed managed surface is isolated behind a retry/uninstall face while the rail and DSH remain usable.

Without the manager, or after its root entry abdicates on a render failure, `ui-layout` renders Native DSH without a browser refresh. It owns one priority-1 `AppFrame` registration and atomically retargets that same live entry between `root` and `page-app.shell.builtin`: the move preflights compatible single/root seats, commits both ledgers before publishing mutations, and preserves entry identity, child declarations, already-loaded descendants, store state, metadata, and disposer authority. A manager that arrives late can therefore take over and later leave without collapsing or reloading the Native DSH subtree. Manager Settings mutations call the Host-owned service — the browser never runs pnpm or touches the filesystem.

## Installation and CLI coexistence

The extracted manager package is packed, scanned for source files, source maps, `workspace:` specifiers, and absolute local paths, then exercised through a fresh-Profile install/disable/re-enable/uninstall chain. The repository requires the active pnpm version to equal its `packageManager` pin.

Generic `dsh plugin` mutations and manager transactions use the same Profile lock. A package declaring `dsh.workspace` is classified as a managed Feature and is never appended to `dsh.profile.bundles`; install it through the Workspace Apps Settings flow so the registry remains the ownership authority.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxpageappmanager--pageappmanager"></a>

### `ctx.pageAppManager` — `PageAppManager`

Build the Host page-app manager service. Extends `TypertRemoteService` so the generated `pageAppManager` namespace exposes the mutation API; the read projection and staged validation are plain methods on the same service.

```ts cordis-catalog
/** Abort the in-flight transaction; wired to the manager fiber's effect. */
public dispose(): void

/**
 * The full read-only projection of the managed set. The registry is the
 * ownership authority; health is derived from current dependency, version,
 * and runtime facts. Plugin Inventory and unrelated Loader rows never create
 * entries.
 * @returns the immutable snapshot.
 */
@Remote('list') public list(): PageAppManagerSnapshot

/**
 * Install one managed package (exposed as the `installPackage` Remote of the
 * Settings add-flow; the gateway namespace service reserves the `install`
 * member on its prototype, so the wire method cannot reuse that spelling
 * while the internal lifecycle method keeps the `install` name).
 * @param source - the validated install source.
 * @param clientInstanceId - the opaque initiating client instance.
 * @param signal - cancellation; aborts pnpm and the activation wait.
 * @returns the committed registry revision.
 */
@Remote('installPackage') public install(source: PageAppInstallSource, clientInstanceId: PageAppClientInstanceId, signal: AbortSignal): Promise<number>

/**
 * Enable or disable one managed page.
 * @param pageId - the managed page id.
 * @param enabled - the new enabled state.
 * @param signal - cancellation; honored by the shared lock.
 * @returns the committed registry revision.
 */
@Remote('setEnabled') public setEnabled(pageId: string, enabled: boolean, signal: AbortSignal): Promise<number>

/**
 * Hide or show one managed page (presentation only).
 * @param pageId - the managed page id.
 * @param hidden - the new hidden state.
 * @returns the committed registry revision.
 */
@Remote('setHidden') public setHidden(pageId: string, hidden: boolean): Promise<number>

/**
 * Reorder managed pages.
 * @param pageIds - page ids in the desired order.
 * @returns the committed registry revision.
 */
@Remote('reorder') public reorder(pageIds: readonly string[]): Promise<number>

/**
 * Uninstall one managed page from the current profile.
 * @param pageId - the managed page id.
 * @param signal - cancellation; aborts pnpm and the activation wait.
 * @returns the committed registry revision.
 */
@Remote('uninstall') public uninstall(pageId: string, signal: AbortSignal): Promise<number>

/**
 * Acknowledge a pending targeted client activation. Only the first valid
 * acknowledgement from the initiating client instance settles the install.
 * @param transactionId - the transaction the acknowledgement names.
 * @param clientInstanceId - the acknowledging client instance.
 * @param packageName - the acknowledged package.
 * @param pageId - the acknowledged page id.
 * @param graphRevision - the graph revision the client converged to.
 * @returns whether this attempt settled the transaction.
 */
@Remote('ackClientActivation') public ackClientActivation( transactionId: PageAppTransactionId, clientInstanceId: PageAppClientInstanceId, packageName: string, pageId: string, graphRevision: string, ): { accepted: boolean; reason?: string }

/**
 * Run the startup/operator recovery over the profile journal.
 * @returns the recovery outcome.
 */
@Remote('recover') public recover(): Promise<{ action: string; message?: string }>

/**
 * The full read-only projection of the managed set (the `list` Remote
 * delegates here; the raw method stays available to host-side consumers).
 * @returns the immutable snapshot.
 */
public snapshot(): PageAppManagerSnapshot

/**
 * Parse and classify one Settings add-flow source spec. Local directory
 * sources are additionally preflighted against the on-disk package; registry,
 * git, link, and tarball sources await the pnpm staging step (Task 8) before
 * the full static validation runs. Never mutates ownership.
 * @param source - the raw specifier (or an already-typed source).
 * @returns the validated install source plus a preflight note.
 * @throws {Error} when the spec is rejected (kind grammar, credentials, relative path).
 */
public validateInstall(source: string | PageAppInstallSource): { source: PageAppInstallSource; preflight: string | null }
```

Source: [`packages/host/page-app-manager/src/index.ts`](../../packages/host/page-app-manager/src/index.ts)

<a id="ctxworkbenchruntime--workbenchruntime"></a>

### `ctx.workbenchRuntime` — `WorkbenchRuntime`

The Feature-facing domain API the manager provides.

Source: [`packages/host/page-app-manager/src/workbench-runtime.ts`](../../packages/host/page-app-manager/src/workbench-runtime.ts)

<a id="page-app-manager-events"></a>

### `page-app-manager/*` events

<a id="page-app-manageractivation-requested--emit"></a>

#### `page-app-manager/activation-requested` — emit

An install staged its runtime layer and now waits for the targeted client instance to acknowledge the activation.

```ts cordis-catalog
/**
 * An install staged its runtime layer and now waits for the targeted
 * client instance to acknowledge the activation.
 * @param request - transaction, client instance, package, page, and graph revision.
 * @mode emit
 */
'page-app-manager/activation-requested'(request: PageAppActivationRequestedEvent): void
```

Source: [`packages/host/page-app-manager/src/types.ts`](../../packages/host/page-app-manager/src/types.ts)

<a id="page-app-managerchanged--emit"></a>

#### `page-app-manager/changed` — emit

The manager committed a registry change (install/enable/disable/hide/ reorder/uninstall published a new revision). Consumers re-read the snapshot.

```ts cordis-catalog
/**
 * The manager committed a registry change (install/enable/disable/hide/
 * reorder/uninstall published a new revision). Consumers re-read the
 * snapshot.
 * @param revision - the newly committed registry revision.
 * @mode emit
 */
'page-app-manager/changed'(revision: number): void
```

Source: [`packages/host/page-app-manager/src/types.ts`](../../packages/host/page-app-manager/src/types.ts)
<!-- END GENERATED cordis-surface -->
