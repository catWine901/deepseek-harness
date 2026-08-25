# @deepseek-ai/dsh-client-ui-page-app-manager

English | [中文](README.zh.md)

Workspace Apps client: the keep-mounted shell (built-in DSH seat plus the keyed managed-surface seat), the React-free controller over the generated `pageAppManager` remote, and the Settings → Plugins → Workspace tab. The built-in DSH seat never depends on remote readiness — without the generated remote namespace the shell still registers and the controller degrades to a read-only empty projection, so composition ordering cannot block the Original DSH Surface.

## Shell seats

The manager's `apply` owns the built-in `root` seat and declares both child seats: the single built-in DSH seat (`page-app.shell.builtin`) and the keyed managed-surface seat (`page-app.shell.surface`, one cell per page id). The shell mounts the built-in seat unconditionally and hides (never unmounts) it while a managed surface is active. Managed packages contribute into the surface seat only after runtime activation; the controller's closed authorization projection (spec §7) keeps unrelated, wrong-provenance, duplicate, and mismatched-revision contributions invisible.

## Controller lifecycle

One `PageAppController` per apply serves both the shell and the Settings tab, so state and mutations stay consistent across both surfaces. The controller starts with the registration (event subscriptions, slot-ledger observation, initial snapshot) and stops with the apply fiber: `controller.stop()` unsubscribes everything and immediately cancels every pending graph-wait interval. Stop is idempotent — repeated cleanup is a no-op.

## Graph convergence wait

Pending targeted activations wait for the client graph to converge to the announced revision (`awaitGraphRevision`, wired to the HMR graph reconcile). The 30-second cap is a convergence timeout, not a cleanup path: the wait exposes an idempotent `cancel` that the controller stop path calls, so a stopped controller never leaks timers and React 18 StrictMode's setup→cleanup→setup double-run leaves no residual intervals.

## Settings tab

The Workspace tab (order 20, after the read-only `all` tab) lists every managed row — disabled, hidden, unhealthy, and recovery-required rows stay listed — and offers install, show/hide, enable/disable, reorder, uninstall with confirmation, and operator recovery. The operation banner renders `snapshot.operation.state` with localized labels for the closed six-member `PageAppOperationState` union (installing/active/removing/install-failed/remove-failed/recovery-required); the durable journal `phase` is never the user-facing state, so a recovery-visible operation that carries no phase can never render `undefined`.

## Model Experience

### Workspace Apps management

#### What the model sees

Nothing directly — the client manager registers no prompt or tool schema; it serves the operator Settings add-flow and renders the generated `pageAppManager` Remote projection (`installPackage`, `setEnabled`, `uninstall`).

#### Token effect

None; the client manager never contributes tokens to a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **The convergence wait is unverified without the modules service** — the wait resolves immediately when `ctx.get('modules')` is absent, so the acknowledgement then reports convergence the controller cannot verify; the Host client-modules registry normally guarantees the service exists.
- **Without the generated remote namespace the surfaces are read-only** — the degraded stub lists an empty projection and every mutation resolves as a no-op; the shell and Settings tab stay mounted.
- **`setHidden` and `reorder` carry no abort signal** — they are presentation-only mutations and are not cancellable mid-flight.
