# Agent Note: Workspace Apps run through a versioned workbench runtime

Status: implemented

English | [中文](2026-08-25-workspace-apps-architecture-optimization.zh.md)

## Problem

Workspace Apps had a sound profile registry, transactional package operations, client provenance checks, and keep-mounted surfaces, but its delivery and lifecycle did not match those guarantees. The manager was a permanent Web bundle row, managed Features could import Cordis directly, manager loss did not suspend their runtime rows, the built-in DSH surface depended on the manager shell, and package publication lacked an end-to-end version and artifact proof. Cancellation, rollback, activation settlement, CLI coexistence, runtime-state labels, and two-profile isolation also had gaps that could leave the live tree, disk state, or operator view inconsistent.

## Decision

The following decisions define the shipped system; the owning current-state reference is [Workspace Apps](../../../../docs/subsystems/workspace-apps.md).

- **D1 — delivery:** the manager is extracted as an out-of-tree npm package and installed per Profile through `dsh plugin`; the Web bundle does not carry permanent manager rows.
- **D2 — Workbench Contract v1:** `dsh.workspace.schemaVersion: 1` is the admitted manifest version. Managed Feature source and dependency manifests remain Cordis-free within declared source scopes; unavailable third-party source cannot be proven by this check.
- **D3 — Cordis boundaries:** ordinary manager product code delegates Cordis, Include, Loader, hashing, fiber projection, and wrapper mounting through `src/adapter.ts`. The only additional audited boundary is the explicitly named legacy rc.2 compatibility bridge: it activates for the exact public app-boot 0.1.1-rc.2 fingerprint only when native `ProfileRuntime` is absent, coordinates legacy watcher and manager writes through one FIFO, and is a no-op on the native path. Runtime Cordis imports elsewhere are rejected.
- **D4 — runtime provider and wrapper:** the manager provides `workbenchRuntime`; every enabled managed root is nested under a deterministic wrapper that injects it. Provider loss parks dependent Feature fibers, provider return reloads them, and the wrapper preserves each Feature row and package provenance.
- **D5 — shell fallback:** the manager owns the Workspace rail and managed Surface Host, while `ui-layout` keeps one priority-1 `AppFrame` registration and atomically retargets that same live entry between the Native DSH fallback and the manager's built-in seat. Late manager takeover and release preserve the entry, child declarations, loaded descendants, store state, metadata, and disposer; a failed managed surface remains isolated behind the manager-owned retry/uninstall face.
- **D6 — state projection:** operation state derives from journal phase and recovery facts, runtime state uses semantic Cordis labels, and the client graph wait timer belongs to the controller disposer.
- **D7 — ownership and isolation:** `.workspace-manager/registry.json` remains the sole ownership authority; runtime inventory is observation only, and every registry, transaction, installed package, revision, and order remains Profile-scoped.
- **D8 — transaction completion:** cancellation reaches Host operations and pnpm, client activation has a configurable settlement timeout, and rollback restores the acknowledged live runtime layer before converging files. A failed restore retains the journal as `recovery-required`.
- **D9 — authorization:** loopback mutation routing and immutable client contribution provenance remain the authority checks; the browser has no filesystem or pnpm capability and can cancel only through the Host operation signal.
- **D10 — packaging:** the published tarball is scanned for forbidden members and absolute local paths, contains no `workspace:` specifiers, and passes a fresh npm consumer install/start/disable/re-enable/uninstall chain against `@deepseek-ai/dsh@0.1.1-rc.2`. The release inlines only manager-owned profile/atomic-write code plus the source-authoritative rc.2 bridge helper subgraph; official DSH, Cordis, Include, Typert, API Remote, and client runtimes remain external seams. CI requires the active pnpm version to equal `packageManager`.
- **D11 — CLI coexistence:** generic plugin mutations share the Profile lock. Packages declaring `dsh.workspace` are classified as Workspace Apps and are not promoted into `dsh.profile.bundles` by `dsh plugin`.
- **D12 — legacy removal:** a legacy path is deleted only after its replacement's named proof passes. The native runtime has one Profile watcher, one wrapper form for managed roots, one Cordis adapter, and no permanent manager rows in `dsh-web-app`; the exact public rc.2 path uses the audited bridge to serialize its existing watcher with Manager generations rather than adding an independent writer.

## Audit mapping

The decisions group the audit gaps by the authority that closes them: D1/D10 close in-tree delivery, packed-content, and pnpm drift gaps; D2–D4 close direct Cordis access, dispersed framework calls, and missing provider propagation; D5/D6 close the blank-root, failed-surface, raw-state, and timer-ownership gaps; D8/D11 close cancellation, live rollback, unbounded settlement, and CLI mutation races. D7 and D9 retain the registry, transport, and provenance mechanisms that were already correct. D12 prevents removal from preceding its replacement evidence.

## Verification

- The source check and its focused spec reject static, dynamic, re-exported, required, and manifest-declared Cordis access inside the official Feature scope.
- Adapter, wrapper, provider-loss/return, rollback, timeout, cancellation, CLI contention/classification, no-manager fallback, and surface-failure suites pin the package-level decisions. Focused slot and layout suites additionally prove retarget preflight has no partial mutation, observers see both ledgers in their final state, and a loaded descendant survives late manager takeover and release.
- The packed install-chain smoke validates extraction and final tarball bytes. The release gate goes further through a fresh npm consumer: it installs the exact public DSH rc.2 package and the locally packed Manager, resolves the CLI only from that consumer, opens the real Settings UI, proves Native DSH after disable and uninstall, and proves Workspace Apps returns after re-enable.
- Keyless Web acceptance installs the same package into two Profiles sharing one Harness home and proves that registry rows, code, revisions, and orders never cross; the full source, GUI, Web replay, documentation, build, hygiene, and coverage checks guard assembled behavior.

## Alternatives considered

- **Keep the manager permanently in `dsh-web-app`:** this makes installation state a bundle constant and bypasses the product install chain, so Profiles cannot independently own the manager.
- **Let Features declare Cordis injection or mount direct roots:** this couples Feature source to framework APIs and cannot suspend all Feature fibers when the manager provider disappears without a second lifecycle graph.
- **Put Native DSH fallback logic in the renderer:** the renderer would gain product-specific policy; priority registration in `ui-layout` preserves the ordinary slot lifecycle and gives manager absence and root failure one recovery path.
- **Infer ownership from installed packages or Loader rows:** scanning would adopt untrusted or stale runtime facts. The registry remains the only commit marker and ownership authority.
- **Remove legacy paths with their replacements:** a single change would lack a green pre-removal anchor and make rollback ambiguous; replacement and removal remain separate commits.

## Consequences

- A Profile without the manager boots Native DSH, while managed Feature wrappers stay inactive until the manager provides `workbenchRuntime`.
- Framework changes concentrate in the adapter, the exact-version legacy bridge, and the contract implementation; official Feature sources use the versioned workbench API instead of Cordis. Hosts with native `ProfileRuntime` bypass the bridge entirely.
- Package installation and operator actions take the shared lock and publish registry state only after the live tree and disk converge; unrecoverable divergence remains visible.
- Out-of-tree delivery adds artifact and version checks, and removal of the default rows means a Profile must explicitly install the manager to expose Workspace Apps management.
