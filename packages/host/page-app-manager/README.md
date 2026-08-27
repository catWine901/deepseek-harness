# @deepseek-ai/dsh-page-app-manager

English | [中文](README.zh.md)

Host-side Workspace Apps manager: the read-only ownership projection, install-source parsing and static Workspace Contract validation, and the journaled lifecycle transactions (install, enable/disable, hide, reorder, uninstall). The `.workspace-manager/registry.json` is the sole ownership authority; the launcher-owned `ProfileRuntime` is the only acknowledged live-recomposition writer, so management-API readiness never gates the built-in DSH shell.

`snapshot.operation` projects the in-flight mutation from the durable journal phase plus registry recovery facts: prepared/staged → `installing`, committing → `active`, a visible recovery → `recovery-required` (a closed `PageAppOperationState` union; no persisted fields are added). Each row's `runtimeState` is the semantic label of its Cordis fiber state (`pending`/`loading`/`active`/`failed`/`unloading`, with the terminal `DISPOSED` collapsed into `failed`), never the numeric fiber value.

`PageAppManager` extends the Typert Remote service `pageAppManager`. Every mutation runs inside the shared profile mutation lock and writes a prepared journal plus private before-state backups before any owned file changes; a failed transaction rolls back by restoring the prior live Include tree through `ProfileRuntime.restoreManagerLayer` (with real expected-root hashes) before converging files, and a failed restore retains the journal as `recovery-required`. The operator `recover()` Remote resolves it under the same shared lock: a commit is finished when the registry changed at `committing`, otherwise the live layer is restored from the journal before-state and pnpm converges. A new transaction is refused while a journal exists — the operator must recover first. The generated Host and Client Remote artifacts are exposed by `./typert` and `./remote`.

## Cordis adapter and public rc.2 compatibility

Manager product code touches the ordinary Cordis surface through `src/adapter.ts`. The adapter runtime-imports Include, while its Cordis Context and Loader entry shapes are type-only; the live Loader service is obtained structurally from the Host context. The standalone artifact therefore requires Cordis and `cordis-plugin-include` peers but does not require `cordis-plugin-loader` as a package peer. The adapter exposes the state the manager reads and delegates to the vendored surfaces it wraps: expected-root hashing, patch composition and parsing, Loader-row lookup, semantic fiber-state projection, and Feature Runtime Wrapper child mounting.

The one deliberately separate framework boundary is `src/legacy-rc2-compat.ts`. It activates only for the exact public `@deepseek-ai/dsh-app-boot@0.1.1-rc.2` fingerprint, only when the Host lacks the native `ProfileRuntime` service, and only after strict root Include validation. It serializes the legacy watcher and Manager generations through one FIFO, preserves bundle/profile/home/overlay priority, and removes its listener on disposal. A future native Host makes this bridge a verified no-op.

Compatibility promise: adapter delegations are behavior-preserving and pinned against their vendored surfaces; the compatibility bridge is pinned for FIFO ordering, priority, restoration, disposal, and native no-op behavior. The import gate permits only these two audited framework boundaries. No optional-runtime contract exists to preserve.

## Workbench Runtime and the Feature Runtime Wrapper

The manager provides the `workbenchRuntime` service with the manager fiber's lifetime: `ctx.provide` deletes the service and re-evaluates every dependent fiber when the fiber unloads, so a manager loss parks every wrapper fiber PENDING and a returning provider reloads them. The runtime exposes only the contract-v1 domain surface to Features — lifecycle disposal, workspace-surface registration, events, storage get/set, and a host-call seam — never the raw context. A manager uninstall therefore suspends every Feature through the real Loader lifecycle (no second lifecycle system), and re-enable or re-install restores it.

Every enabled, statically valid managed root mounts under the Feature Runtime Wrapper (`page-app-manager.wrapper`, loaded as `@deepseek-ai/dsh-page-app-manager/wrapper`): the wrapper row id is the deterministic `page-app.wrapper.<pageId>`, it injects `workbenchRuntime`, mounts the feature's composed rows as Loader entries (each keeping its own entry and fiber), and registers the feature's surface seat with its owning package. The runtime layer derivation, transaction staging, and the manager's health lookup all share the app-boot wrapper renderer, so the staged document, the loaded tree, and the health facts can never drift.

Strict Mode consequence: a Feature still runs as a Cordis loader entry — the wrapper is the seam that composes it, while the Feature's own source stays Cordis-free (its dependency boundary is enforced at install). The contract's client render wiring lands with the fixture migration; until then the wrapper records the surface seat and provenance.

A root whose wrapper module cannot resolve — the manager package is not installed in the profile, so boot after a manager uninstall with a surviving registry — is omitted as `missing-manager`: boot succeeds with zero managed roots and the registry stays owned.

## Cancellation and the activation handshake

The mutating Remote methods `installPackage`, `setEnabled`, and `uninstall` carry a final `signal: AbortSignal` (the install wire name cannot reuse `install` — the gateway namespace service reserves that member on its prototype). The signal flows into the transaction and aborts profile-local pnpm and the targeted client activation wait; the transaction signal is additionally merged with the manager fiber's lifecycle controller, so a manager reload aborts an in-flight transaction instead of orphaning it. `setHidden`, `reorder`, `ackClientActivation`, `recover`, and `list` are unchanged.

The install activation request carries the Host client-graph revision (`clientModules.graph().rev`) — never the runtime-layer document — and the acknowledgement must echo that exact revision, so a stale or unrelated graph change cannot settle the gate. The Host settlement wait is bounded by the validated plugin config `settlementTimeoutMs` (default `60000` milliseconds), so a vanished client can never hold the profile lock indefinitely in a live process.

## Model Experience

### Workspace Apps management

#### What the model sees

Nothing directly — the manager registers no prompt or tool schema; it serves the operator Settings add-flow and the `pageAppManager` Remote surface (`installPackage`, `setEnabled`, `uninstall`).

#### Token effect

None; the manager never contributes tokens to a model request.

#### KV Cache effect

None; the manager never assembles model input.

## Known Limitations and Deferred Work

- **Install requires the Host client-modules registry** — the exact-revision activation handshake reads `clientModules.graph().rev`, and an install fails loud when the registry is unavailable instead of settling on an unverifiable acknowledgement.
- **No pnpm `allowBuilds` broadening** — a pnpm build-script refusal surfaces as `PageAppBuildPermissionError` for the operator to resolve; the manager never edits the profile workspace's `allowBuilds`.
