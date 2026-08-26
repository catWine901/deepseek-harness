# @deepseek-ai/dsh-page-app-fixture

English | [中文](README.zh.md)

Real Cordis-free Workspace Apps Feature fixture: a contract-v1 workspace package (`dsh.workspace.schemaVersion: 1`), a bundle patch composing one managed root over an empty root, and a client half that consumes the Workbench Contract v1 surface entry from the injected, caller-bound `workbench` bridge. The fixture is the Strict-Mode source/dependency boundary subject (`scripts/verify-page-app-source-boundary.ts`) and the real Feature of the keyless end-to-end chain (`apps/web/tests/workspace-apps.e2e.ts`).

## Manifest

The package declares `dsh.bundle.patch` (`./cordis.patch.yml`), `dsh.client.platform: web`, and the `dsh.workspace` v1 block with `schemaVersion: 1`, `id: dsh-page-app-fixture`, and `rootEntryId: dsh-page-app-fixture-root`. The patch composes exactly one top-level root row carrying that id, so the manager validation counts one managed root and one client row for the package. The package declares no Cordis dependency in any dependency section, and its sources never import Cordis — the fixture stays on the Feature side of the Adapter (design D3).

## The v1 consumer contract

The fixture consumes the single surface entry of the Workbench Contract v1, `registerWorkspaceSurface({ pageId, packageName, render })`, from the manager's caller-bound `workbench` service — never from a Cordis context. The host wrapper provides the Workbench Runtime on the host side; on the client side the manager provides the bridge and the Loader invokes `apply` only after injecting it. The bridge owns slot access, derives immutable owner provenance from the Feature Loader entry, and releases contributions with that Feature fiber. The source contains no `ctx.slots` call and no Cordis import; the narrow contract face is the only seam the surface logic reaches.

The surface (`PageAppFixture`) is a real React surface with state (a counter, a note field, and a live tick created through the Workbench lifecycle). The shell keep-mounts it under a stable keyed seat, so React state survives DSH round-trips and hide without the React 19 Activity/Offscreen API; StrictMode cleanup/setup releases exactly what setup created.

## Build

The tsdown config emits the host half (`lib/index.js`, `lib/invariant.js`) and the lazy-CJS browser surface artifact (`lib/client.js`, the `clientBundle` preset); `exports["./client"]` serves the surface to the client module table. The Node half is an empty mount — the wrapper composes it and provides the workbench service.

## Model Experience

### Fixture surface

#### What the model sees

The fixture registers no prompt, tool, or KV-cache contribution. Nothing the `PageAppFixture` surface renders — the counter, the note field, and the lifecycle tick — ever reaches a model request; the surface is browser chrome only.

#### Token effect

None. The fixture adds no prompt text, no tool schema, and no model-visible state to any session.

#### KV Cache effect

None. The fixture neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

- **Client activation needs a page reload after install** — the shipped Web composition keeps shared HMR disabled, so a newly installed Feature's client bundle joins `window.__DSH_BOOT__` on the next page load; host activation is live. The end-to-end chain drives this reload explicitly.
- **The client Workbench bridge is manager-owned** — the fixture depends on the manager's injected `workbench` service and keeps only its narrow consumer contract. A standalone, out-of-tree contract package remains deferred to the packaging milestone.
- **No authoring preset** — the fixture has no agent preset, so it contributes no tools, prompts, or delegation backends to a session; it exists to prove the Feature chain only.
- **Strict Mode bounds official sources** — the source-boundary gate cannot prove that an arbitrary prebuilt third-party artifact never imported Cordis; runtime isolation is enforced through provenance and the closed authorization projection.
