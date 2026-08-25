# Workspace Apps Workbench Contract v1

The normative Feature-facing contract of DSH Workspace Apps (design [D2 — Workbench Contract v1 and Strict Mode](./2026-08-25-dsh-workspace-manager-architecture-optimization-design.md#9-d2--workbench-contract-v1-and-strict-mode)): the manifest a Feature package must declare, the single surface entry it registers through, the lifecycle duties it owns, the compatibility promise the Manager makes, and the honest limits of Strict Mode. Implementation authority is the [Workspace Manager Architecture Optimization implementation plan](../plans/2026-08-25-dsh-workspace-manager-architecture-optimization.md), milestone M5–M9; the plan fixes each normative surface below and the exact admission behaviors.

## Scope

This contract is the only Feature-facing API surface. A Feature is an installed workspace package the Manager admits; it never imports Cordis, never declares a Cordis dependency, and never calls `ctx` APIs. The Manager's Cordis Compatibility Adapter (design D3, implementation milestone M6) is the only code that understands Cordis, and it absorbs Cordis changes for every Feature.

## Manifest fields

A Feature package.json carries the `dsh` block that the Manager's static validation (`validateInstalledPageAppPackage`) and the shared manifest parser (`parsePageAppManifest` in `@deepseek-ai/dsh-page-app-profile`) require. The physical manifest block stays `dsh.workspace`; `schemaVersion: 1` is the contract-version carrier for v1.

| Field | Requirement |
|---|---|
| `name` | Package name equals the direct profile dependency key; pnpm alias installs are rejected in v1. |
| `version` | Non-empty installed version; the registry commits it as `resolvedVersion`. |
| `dsh.bundle.patch` | A `./`-anchored patch path inside the installed package; the patch composes exactly one top-level root with the manifest `rootEntryId` over an empty root. |
| `dsh.client.platform` | `"web"`; the package must export a `./client` artifact that exists in the installed package. |
| `dsh.workspace.schemaVersion` | `1` (the only admitted version; the Manager constant `SUPPORTED_CONTRACT_VERSIONS = [1]`). |
| `dsh.workspace.id` | The managed page id, unique against the registry and the base composition. |
| `dsh.workspace.name`, `description`, `defaultOrder`, `rootEntryId` | Non-empty strings / integer / non-empty root row id, parsed strictly. |

## Version admission order

The Manager diagnoses a numeric unsupported `schemaVersion` with the version-bearing error before the shared `z.literal(1)` manifest parse runs. The constant is the single source of truth for admission, so a future supported version list change is diagnosed explicitly instead of surfacing as a manifest shape error; a missing or non-numeric `schemaVersion` keeps the manifest shape error. This ordering is behavior-pinned by the validation spec and documented here so the two authorities cannot silently drift.

## The single surface entry

`registerWorkspaceSurface(registration): () => void` is the one entry through which a Feature contributes its workspace surface. The registration carries the managed `pageId` (the surface seat is keyed by it), the owning `packageName` (provenance lineage), and the surface `render`. The entry is exposed to the Feature through the WorkbenchContext that the Feature Runtime Wrapper injects (design D4, milestone M7); the returned disposer removes the registration. Until the Workbench Runtime lands, the Feature fixture owns a local, Cordis-free copy of the entry (milestone M5) and milestone M9 migrates it behind the wrapper's injection face.

## Lifecycle duties

Every timer, listener, watcher, subscription, and service a Feature creates must be created through the Workbench lifecycle so disposal releases it: the wrapper's teardown runs the reverse order of mount, all disposer-owned. A Feature that leaks side effects outside the lifecycle violates the contract; milestone M9's disposal test pins that a Feature dispose releases its side effects.

## Compatibility promise

Cordis changes are absorbed by the Adapter, never by Features: a Feature written against contract v1 keeps working across Cordis major upgrades because the Manager re-implements the adapter surface and its compatibility tests, and the Feature source stays Cordis-free. Contract v1 keeps the physical manifest block and the surface slot key of the approved design, so already-installed page apps remain readable; the contract document and the admission additions are additive until the legacy direct path is removed.

## Honest limits

The source-boundary gate cannot prove that an arbitrary prebuilt third-party artifact never imported Cordis: it bounds the official Feature sources where source is present, the dependency boundary runs on every install, and runtime isolation is enforced through provenance and the closed authorization projection. There is no capability permission sandbox for Feature code. The full chain — install, surface activation, hide/disable/re-enable/uninstall, provider suspension — is proven end-to-end in milestone M9 against the real fixture.

## Supporting artifacts

The Strict-Mode admission and its subjects: `scripts/verify-page-app-source-boundary.ts` (source/dependency boundary gate, default scope `packages/examples/page-app-fixture`), the fixture `packages/examples/page-app-fixture` (real Cordis-free contract-v1 Feature skeleton), `SUPPORTED_CONTRACT_VERSIONS` and `assertSupportedContractVersion` in `packages/host/page-app-manager/src/contract.ts`, and the dependency boundary in `packages/host/page-app-manager/src/validation.ts`.
