# @deepseek-ai/dsh-page-app-manager

English | [中文](README.zh.md)

Host-side Workspace Apps manager: the read-only ownership projection, install-source parsing and static Workspace Contract validation, and the journaled lifecycle transactions (install, enable/disable, hide, reorder, uninstall). The `.workspace-manager/registry.json` is the sole ownership authority; the launcher-owned `ProfileRuntime` is the only acknowledged live-recomposition writer, so management-API readiness never gates the built-in DSH shell.

`PageAppManager` extends the Typert Remote service `pageAppManager`. Every mutation runs inside the shared profile mutation lock and writes a prepared journal plus private before-state backups before any owned file changes; a failed transaction rolls back by restoring the prior live Include tree through `ProfileRuntime.restoreManagerLayer` (with real expected-root hashes) before converging files, and a failed restore retains the journal as `recovery-required`. The operator `recover()` Remote resolves it under the same shared lock: a commit is finished when the registry changed at `committing`, otherwise the live layer is restored from the journal before-state and pnpm converges. A new transaction is refused while a journal exists — the operator must recover first. The generated Host and Client Remote artifacts are exposed by `./typert` and `./remote`.

## Cancellation and the activation handshake

The mutating Remote methods `install`, `setEnabled`, and `uninstall` carry a final `signal: AbortSignal`. The signal flows into the transaction and aborts profile-local pnpm and the targeted client activation wait; the transaction signal is additionally merged with the manager fiber's lifecycle controller, so a manager reload aborts an in-flight transaction instead of orphaning it. `setHidden`, `reorder`, `ackClientActivation`, `recover`, and `list` are unchanged.

The install activation request carries the Host client-graph revision (`clientModules.graph().rev`) — never the runtime-layer document — and the acknowledgement must echo that exact revision, so a stale or unrelated graph change cannot settle the gate. The Host settlement wait is bounded by the validated plugin config `settlementTimeoutMs` (default `60000` milliseconds), so a vanished client can never hold the profile lock indefinitely in a live process.

## Model Experience

### Workspace Apps management

#### What the model sees

Nothing directly — the manager registers no prompt or tool schema; it serves the operator Settings add-flow and the `pageAppManager` Remote surface (`install`, `setEnabled`, `uninstall`).

#### Token effect

None; the manager never contributes tokens to a model request.

#### KV Cache effect

None; the manager never assembles model input.

## Known Limitations and Deferred Work

- **Install requires the Host client-modules registry** — the exact-revision activation handshake reads `clientModules.graph().rev`, and an install fails loud when the registry is unavailable instead of settling on an unverifiable acknowledgement.
- **No pnpm `allowBuilds` broadening** — a pnpm build-script refusal surfaces as `PageAppBuildPermissionError` for the operator to resolve; the manager never edits the profile workspace's `allowBuilds`.
