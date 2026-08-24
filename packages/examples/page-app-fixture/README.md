# @deepseek-ai/dsh-page-app-fixture

English | [中文](README.zh.md)

Real Cordis-free Workspace Apps Feature fixture: a contract-v1 workspace package (`dsh.workspace.schemaVersion: 1`), a bundle patch composing one managed root over an empty root, and a client half that registers a keyed workspace surface through the contract entry. The fixture is the Strict-Mode source/dependency boundary subject (`scripts/verify-page-app-source-boundary.ts`) and the migration target for the full Feature chain (M9).

## Manifest

The package declares `dsh.bundle.patch` (`./cordis.patch.yml`), `dsh.client.platform: web`, and the `dsh.workspace` v1 block with `schemaVersion: 1`, `id: dsh-page-app-fixture`, and `rootEntryId: dsh-page-app-fixture-root`. The patch composes exactly one top-level root row carrying that id, so the manager validation counts one managed root and one client row for the package. The package declares no Cordis dependency in any dependency section, and its sources never import Cordis — the fixture stays on the Feature side of the Adapter (design D3).

## Surface entry

The client half (`src/client/index.tsx`) registers a keyed workspace surface through `registerWorkspaceSurface({ pageId, packageName, render })` — the single surface entry of the Workbench Contract v1 — and returns a disposer that removes it. The shared contract package arrives with the Workbench Runtime (M7); until then the fixture owns this local copy of the entry so it stays Cordis-free and self-contained. M9 replaces it with the wrapper-injected `WorkbenchContext`.

## Build

The tsdown config emits the host half (`lib/index.js`, `lib/invariant.js`) and the browser surface bundle (`lib/client.js`); `exports["./client"]` serves the surface. The Node half is an empty mount — the wrapper composes it and exposes only the contract surface to the Feature.

## Model Experience

The fixture is never mounted into a model request: it registers no prompt, tool, or KV-cache contribution, so it has no token or KV-cache effect.

## Known Limitations and Deferred Work

- **Skeleton, not a runnable Feature yet** — the full install → surface → hide/disable/re-enable/uninstall chain is the M9 migration; until then the fixture only proves the contract-v1 manifest, the Cordis-free source/dependency boundary, and the keyed registration entry.
- **Registration is module-local** — until the wrapper injects the WorkbenchContext (M7), `registerWorkspaceSurface` keeps its keyed registrations in the fixture's own module; M9 moves the entry behind the contract's injection face.
