# DSH Workspace Manager Architecture Optimization — Formal Design Spec

- Status: Design self-review complete (2026-08-25); revised per the review findings; no code changes accompany this document
- Date: 2026-08-25
- Implementation owner: DSH / Coding GLM-5.3 (executes the derived Implementation Plan)
- Architecture and acceptance owner: Codex
- Final manual acceptance: User
- Audit baseline: branch `feature/workspace-apps` @ `e91e2c5bd1` (worktree `C:\Users\17948\Documents\Codex\2026-08-22\c-aaa-workboard-pluging-dsh-codex\work\deepseek-harness-source`); master @ `b150a551b8` (`dsh-v0.1.1-rc.2`)
- Governing brief: `DSH_Workspace_Manager_Architecture_Optimization_for_Codex.md` (2107 lines, hereafter "the brief" or "spec §N")
- Approved design being optimized: `2026-08-22-dsh-workspace-manager-design.md` (426 lines) + `2026-08-22-dsh-workspace-manager-self-review.md` (116 lines) + `../plans/2026-08-22-dsh-workspace-apps.md` (750 lines)
- Design self-review: [2026-08-25-dsh-workspace-manager-architecture-optimization-self-review.md](2026-08-25-dsh-workspace-manager-architecture-optimization-self-review.md) (independent adversarial pass; its findings F-1–F-12 are the source of the revisions marked in this document)

## 1. Scope and position in the execution order

This document is deliverable 3 of the brief's mandated order (spec §60): Existing Architecture Audit → Gap Matrix → **Formal Architecture Optimization Design Spec** → Design Spec Self-Review → Implementation Plan → TDD Migration → Verification. The four concurrent P0 audits are complete and their findings are consolidated here; the audit evidence itself lives in the audit sessions listed in §2 and is quoted by file/line so the plan can re-verify each claim.

The brief forbids wholesale rewrite, deletion of the working implementation, modification of DSH Core beyond a minimal generic extension point, and redesign of already-confirmed product rules (spec §0). This design therefore preserves every mechanism the audits confirmed correct (§5), converts every audit-confirmed gap into a decision (§7–§19), and orders the changes so that Native DSH remains renderable and the product surface keeps working at every step (§21). The document is a design specification: it does not modify code, does not execute any package operation, and is the only file written by this task.

## 2. Audit baseline and evidence index

All four audits audited this same worktree at `e91e2c5bd1` on `feature/workspace-apps`; master contains none of the Workspace Apps implementation (audit1 §0, audit2 §0, audit3 发现A, audit4 §0). Evidence quoted in this document uses paths relative to this worktree root and line numbers as read on 2026-08-25.

| Audit | Session | Seq | Coverage | Primary findings used here |
|---|---|---|---|---|
| A1 Cordis 依赖与运行时生命周期 | `session-4f69b6d5-d179-40fe-a9a8-93c6c2a31462` | 101909 | 8 domains: Cordis imports, ctx lifecycle calls, Loader/HMR, manual cascades, Feature wrapper/Fiber semantics, unmanaged side effects, runtime status/failure/dispose, legacy paths | cancellation gap, CLI classification gap, Native DSH fallback gap, launcher-owned semantics, in-flight transaction lifecycle |
| A2 Out-of-Tree / packaging / install chain | `session-2030e15f-4e84-4101-b713-a8637e1fb4c3` | 45535 + 61756 | Out-of-Tree boundary, npm pack/publish readiness, `dsh plugin` chain, public seams, Context7 cross-check | product absent from master; packaging base proven; tarball content-scan gap; pnpm version drift |
| A3 Root Shell / Surface Host / client UI lifecycle | `session-bd96fdf0-4577-4ab5-a404-b67a201a2f8c` | 61144 | Root/AppFrame/Sidebar mounting, Shell hot-plug, slot reuse, DOM hacks, Feature/Sidebar coupling, fallback semantics, state preservation, authorization, error boundaries | root seat single-occupant SPOF, crash-page permanence, Strict Mode absent, P6 zero coverage |
| A4 Registry / Ownership / transactions / profile isolation | `session-00e98cb2-bf1b-40a1-b089-cf1a17201f55` | 40916 | Registry SoT, no-adoption, hide/disable/uninstall, install/uninstall transactions, profile scope, Host/Client boundary, last-known-good | rollback missing `restoreManagerLayer`, ack no timeout, cancellation not wired, CLI lock/classification missing, two-profile e2e missing |

The audit sessions are read-only artifacts of the concurrent P0 pass; this document's gap table (§6) is the merged, deduplicated output of the four reports.

## 3. Terminology mapping

The brief and the approved design use different vocabularies for the same architecture; every decision below states which term it binds to.

| Brief term | Approved design / implementation term | Binding |
|---|---|---|
| Workspace Manager Plugin | Workspace Apps / page-app manager (`@deepseek-ai/dsh-page-app-manager`, `@deepseek-ai/dsh-client-ui-page-app-manager`) | User-facing label remains **Workspace Apps** and **Plugins → Workspace Apps** (approved R1, 2026-08-22). Internal identifiers keep page-app naming; no new `Workspace*` DSH-domain contract (approved design §5). |
| Workbench Contract | `dsh.workspace` manifest block + `page-app.shell.surface` slot contract; no dedicated contract package today | D2 creates the formal Workbench Contract v1 surface. |
| `contractVersion` | `dsh.workspace.schemaVersion: 1` (physical manifest key) | D2 locks the physical key and defines `supportedContractVersions = [1]`. |
| Managed Feature Plugin | managed page app (one package = one page = one Managed Root) | Unchanged. |
| Cordis Compatibility Adapter | absent (Manager calls Cordis/include/Loader directly across index/transaction/validation) | D3 introduces the adapter seam. |
| Workbench Runtime | `ProfileRuntime` (launcher-owned layer composition) + manager Host service; no provider service for Features | D4 introduces the `workbenchRuntime` provider and Feature Runtime Wrapper. |
| Managed Registry / ownership | `.workspace-manager/registry.json` (`PageAppRegistryV1`) | Unchanged; it remains the sole ownership authority. |
| Strict Mode | not enforced | D2 specifies the three admission boundaries and their honest limits. |

## 4. Upstream fact-check snapshot (Context7, 2026-08-25)

This section records the official upstream semantics verified through Context7 on 2026-08-25, the vendored/installed reality in this repository, and the design impact. The same facts were cross-checked independently by audit2's Context7 supplement (session `2030e15f…`, seq 61756); nothing below contradicts it.

### 4.1 Cordis — `/cordiverse/cordis` (official source `packages/core/src/fiber.ts`, `registry.ts`, `reflect.ts`)

| Upstream semantic (Context7) | Vendored 4.0.1 (`vendor/cordis/src/fiber.ts`, `reflect.ts`) | Design impact |
|---|---|---|
| Fiber states PENDING → LOADING → ACTIVE → UNLOADING/DISPOSED/FAILED; `ctx.effect(fn)` runs, collects disposables, returns a disposer; `_refresh` computes epoch from injected impls; `_setEpoch(INACTIVE)` → `_unload()`, epoch non-INACTIVE from INACTIVE → `_reload()`; `_unload` clears disposers before reload decision | `vendor/cordis/src/fiber.ts:142-153` defines the same `FiberState` enum; `_refresh` at 611-623, `_setEpoch` at 625-641, `_reload` at 646-673, `_unload` at 675-694, `await()` at 704; `reflect.ts` provide disposer at 298-300 deletes the service, notifies dependents, and `Promise.allSettled(fibers.map(f => f.await()))` | Semantics identical. The manager's surface contributions already ride `ctx.effect` (audit3 域2), and the future `workbenchRuntime` provider will inherit the same dependency-propagation guarantee: provider loss → dependent Feature fibers PENDING/UNLOADING, provider return → reload. |
| `ctx.provide` disposer removes the service and notifies dependent fibers, awaiting their re-evaluation | same | The D4 provider-dependency mechanism (brief §17/§38) is native Cordis; no second lifecycle graph is needed. |
| `inject` declares required services; a fiber without its injections stays PENDING | same | The wrapper rows introduced in D4 declare `workbenchRuntime` in `inject`, so a missing Manager leaves Features PENDING. |

### 4.2 pnpm — `/pnpm/pnpm.io` (versioned docs; the facts below apply to pnpm 10.x and 11.x alike)

| Upstream semantic (Context7) | Repository reality | Design impact |
|---|---|---|
| `file:` is a hard-link and installs the target package's dependencies, overriding its `node_modules`; `pnpm link` is a symlink and does not install the target's dependencies (`cli/link.md`); `workspace:` refuses registry fallback (`workspaces.md`) | `apps/cli/src/plugin.ts:104-112` preserves `file:`/`link:` prefixes; `pnpm-workspace.yaml:27-29` uses `link:` overrides for vendored forks; lockfile resolves `workspace:^` to `link:packages/...`; `scripts/publish-npm-baseline.ts` fails tarballs containing `workspace:` | Unchanged for v1 installs. The out-of-tree package and Manager install chain keep these exact semantics (D10). |
| Without `--frozen-lockfile`, pnpm revalidates `file:` targets on every install (`cli/install.md`) | `apps/cli/src/plugin.ts:129` forwards pnpm without `--frozen-lockfile`; root CI uses `--frozen-lockfile` | Unchanged: install-time `file:` revalidation is the expected local-source behavior; release uses the frozen path. |
| Build scripts are gated by `allowBuilds` / `strictDepBuilds` / `onlyBuiltDependencies` / `ignoredBuiltDependencies` (`pnpm-workspace.yaml`; `allowBuilds` introduced pnpm 10.26, unified in 11.0) | repo `pnpm-workspace.yaml:36-55` uses `allowBuilds` + `strictDepBuilds` (default true); Profile-generated `pnpm-workspace.yaml` has no `allowBuilds` (`packages/boot/app-boot/src/profile.ts:138-143`) | Unchanged: Manager never edits or broadens `allowBuilds` (brief §41); `PageAppBuildPermissionError` (`transaction.ts:43-51`) stays. |
| pnpm version reality | declared `pnpm@11.7.0` (`package.json` `packageManager`); CI `pnpm/action-setup@v4` (`.github/workflows/release.yml:39`) reads `packageManager` → 11.7.0; this worktree's binary measured `pnpm --version` = 11.7.0 and `node_modules/.modules.yaml` records 11.7.0; audit2 measured 11.19.0 in its session environment; lockfile `lockfileVersion: '9.0'` | Version drift between environments is real (audit2 §3). D10 pins a version-consistency CI gate so local, CI, and declared versions cannot silently diverge. |

### 4.3 npm — `/npm/cli` (official `docs/lib/content/configuring-npm/package-json.md`, `node_modules/npm-packlist/lib/index.js`, `lib/commands/publish.js`)

| Upstream semantic (Context7) | Repository reality | Design impact |
|---|---|---|
| `files` is the publish allowlist; npm pack/publish share packlist precedence `files` > `.npmignore` > `.gitignore`; `package.json`, README, LICENSE are always included; `.git`, `node_modules`, lockfiles, `.npmrc` always excluded | the repository deliberately decouples: tarballs are produced by **pnpm pack** (`scripts/release/pack.ts:27-35`) and uploaded by `npm publish <tarball>` (`scripts/release/publish.ts`), so the content arbiter is pnpm's packlist, not npm-packlist (audit2 §2) | The final tarball content must be validated on the tarball actually published, not assumed from npm-packlist rules (D10). |
| `private: true` prevents accidental publish | dsh family packages are `private: true` (repo convention) | The out-of-tree package must ship `private: false` and normal SemVer (brief §5). |
| `npm publish --dry-run` / `npm pack --dry-run` report without mutating; `--provenance` links published packages to the supported CI build source | repo uses a stronger equivalent chain (pack → tarball member listing → install smoke) | D10 keeps the stronger chain and adds content-level absolute-path scanning; provenance is optional follow-up, not v1. |

## 5. Preserved correct mechanisms (no-rewrite list)

The audits confirmed the following as correct and consistent with the approved design; this optimization does not rewrite them, and every later decision builds on them.

| # | Mechanism | Evidence | Why preserved |
|---|---|---|---|
| P-1 | Registry is the sole ownership authority; runtime layer and UI projections are derived; corrupt registry fails closed and is never silently rewritten | `packages/boot/page-app-profile/src/registry.ts` (parse/write/read), `packages/boot/app-boot/src/profile-runtime.ts` `deriveSafeRuntimeLayer`; audit4 Domain 1 | Brief §28/§35 hard requirements; already implemented and tested. |
| P-2 | Launcher-owned runtime layer with deterministic precedence bundles → manager layer → profile patch → home patch → overlays, and transactional recomposition with acknowledged success | `packages/boot/app-boot/src/profile-runtime.ts` `applyManagerLayer`/`restoreManagerLayer` (628-661), `applyGeneration` (686-701); `apps/cli/src/profile-boot.ts` compose path; audit1 域3/域4 | Approved design §8.2; the only acknowledged live-composition writer; prevents a second lifecycle system. |
| P-3 | No second lifecycle graph: Feature lifecycles, enable/disable, and unload all delegate to Cordis Loader/Include (`entry.update` + `loader.await()` + per-root ACTIVE audit) | `transaction.ts` `stageFromRegistry`/`applyRuntime`; audit1 域4; audit4 Domain 2/7 | Brief §17 forbids `for feature in allFeatures: disable(feature)`; current code has none. |
| P-4 | Immutable slot provenance: `StoredEntry.ownerPackage` derives only from the caller fiber's Loader entry; registration options cannot override it | `packages/client/runtime/src/client/slots.ts:369-402`; audit1 域2, audit3 域9, audit4 Domain 3 | Brief §30 closed authorization; a runner-authored dynamic contribution is naturally ineligible. |
| P-5 | Closed authorized projection: a contribution is eligible only when registry row exists, row enabled, slot key equals page id, `ownerPackage` equals package name, and pending activation matches package/page/revision | `packages/client/ui-page-app-manager/src/client/controller.ts` `authorizedProjection` (289-310); audit3 域9 | External plugins cannot enter the managed rail or surface. |
| P-6 | Transport-level privileged fence: all seven mutating `pageAppManager/*` endpoints are loopback-only, checked before Typert interceptor selection | `packages/client/connection/src/privileged-methods.ts`, `rpc-host.ts`; route tests 403; audit3 域9, audit4 Domain 10 | Brief §40/§13; browser can never invoke pnpm or mutate profile files directly. |
| P-7 | Journal + exclusive profile mutation lock protocol: journal published before any mutation, removed only after commit; orphan lock recovery via token-correlated claim chain; dead `plugin-cli` lock fails closed | `packages/boot/page-app-profile/src/journal.ts`, `lock.ts` (`withPageAppProfileLock`, `recoverOrphanedPageAppLock`, ownerKind `manager`/`plugin-cli`); audit1 域6/域7, audit4 Domain 1 | Brief §42/§43/§10; already crash-safe; CLI integration (D11) reuses it. |
| P-8 | Hide/disable/uninstall semantics and keep-mounted visited surface model: hide never unloads, disable unloads Host and Client roots, uninstall removes registry last, visited pages stay mounted via HTML `hidden` | `transaction.ts` `setHidden`/`setEnabled`/`uninstall`; `controller.ts` `rebuild`/`evict`; `PageAppShell.tsx` `SurfaceFrame`; audit3 域6-8, audit4 Domain 6 | Brief §25/§26/§37/§39; product rules already confirmed and tested. |
| P-9 | Profile-scoped persistence and immutable profile identity from the launcher, never inferred from cwd or browser | `packages/boot/page-app-profile/src/paths.ts`; `profile-runtime.ts` `identity`; audit4 Domain 9 | Brief §31/§8.1. |
| P-10 | Atomic client graph replacement and serialized HMR reconcile order (remove entries → invalidate factories/styles → publish validated graph → prefetch/add in graph order) | `packages/client/modules/src/client/system.ts` `replaceGraph`; `packages/client/hmr/src/client/index.ts` `reconcileGraph`; audit1 域3 | Brief §12; generic path, no manager special-case. |
| P-11 | One package = one page = one Managed Root = one lifecycle root, with three uniqueness axes and exact root/client row counts | `packages/host/page-app-manager/src/validation.ts:181-228`; audit4 Domain 4 | Brief §32; v1 lock. |
| P-12 | pnpm safety boundary: arg-array execa, no shell string, no `allowBuilds` edits, no source deletion, no global store cleanup, `file:`/`link:` uninstall removes only the profile reference | `packages/host/page-app-manager/src/executor.ts`, `transaction.ts`; audit4 Domain 10 | Brief §41 hard rules; unchanged. |
| P-13 | Per-surface slot error boundaries with abdication isolation | `packages/client/ui-renderer/src/client/scoped-slots.tsx` `SlotErrorBoundary`/`RootOutlet`; audit3 域10 | Brief §21; one Surface crash must not take down the manager. |

## 6. Audit-confirmed gap table

Every gap below is fixed by the named decision; severity follows the audits.

| # | Gap (severity, source) | Evidence | Decision |
|---|---|---|---|
| G-1 | Native DSH rendering depends on the manager's seat declaration: with `ui-page-app-manager` absent, `root` has no occupant, `renderSlot('root')` throws, and the whole client tree goes blank (P0, A1/A3/A4) | `packages/client/runtime/src/client/slots.ts:271-273` (fail-loud guard); `packages/client/ui-layout/src/client/index.ts:130` registers only into `page-app.shell.builtin`; audit1 域8, audit3 F1/F3, audit4 Domain 3 | D5 |
| G-2 | Install/enable/uninstall cancellation is not wired: Remote signatures carry no signal, Host passes a never-aborting `new AbortController().signal`, client controller voids the signal (P0, A1/A4) | `packages/host/page-app-manager/src/index.ts:156-201`; `controller.ts`; audit1 域6, audit4 Domain 7 F3 | D8 |
| G-3 | Rollback does not restore the live runtime tree: `ProfileRuntime.restoreManagerLayer` exists but nothing calls it, so after an activation-then-publish failure or a pnpm-remove failure the Include tree and the acknowledged snapshot diverge (P0, A4) | `transaction.ts` `rollback` (420-456); grep of `page-app-manager/src` for `restoreManagerLayer` = 0 hits; audit4 Domain 7 F1 / Domain 8 | D8 |
| G-4 | Activation acknowledgement has no Host timeout: a vanished client can hold the profile lock indefinitely in a live process (P0/P1, A1/A4) | `activation.ts` `awaitSettlement` (60-80); audit4 Domain 7 F2 | D8 |
| G-5 | CLI coexistence unimplemented: `dsh plugin` neither acquires the shared lock nor classifies `dsh.workspace` packages, so an external install can enter `dsh.profile.bundles` and run a managed root without ownership (P1, A1/A3/A4) | `apps/cli/src/plugin.ts` (zero diff vs master); `lock.ts` already reserves `plugin-cli`; audit1 域4, audit4 Domain 3 | D11 |
| G-6 | Manager is an in-tree bundle row, not an out-of-tree npm package installed through DSH Plugin Manager (P1, A2/A3/A4) | `packages/bundle/web-app/cordis.patch.yml` roster; audit2 域7, audit4 Domain 3 | D1 |
| G-7 | Manager hot-unplug semantics undefined: disabling the manager row does not deactivate Features (launcher-owned layer keeps composing them) and in-flight transactions are not tied to the manager fiber (P1, A1) | `profile-runtime.ts` launcher composition; `transaction.ts` `PageAppLifecycle` without dispose hook; audit1 域5/域7 | D4, D5, D8 |
| G-8 | Strict Mode / Workbench Contract / Adapter absent: Features are plain Loader rows and call `ctx.slots` directly (P2, A1/A3/A4) | `contracts.ts` `PAGE_APP_SURFACE_SLOT`; audit3 域3/域5 | D2, D3 |
| G-9 | Tarball content-level absolute-path scan missing; only member names are checked (P2, A2) | `scripts/publication-payload.ts:33-39` checks `src/` and `.map` members only | D10 |
| G-10 | Manager-side Cordis calls are not concentrated in one adapter file (P2, A1) | Cordis/include/Loader usage across `index.ts`, `transaction.ts`, `validation.ts`; audit1 域8 | D3 |
| G-11 | Runtime state is exposed as a raw fiber-state number without semantic labels (P3, A1/A4) | `index.ts` `factsOf`; audit4 Domain 5 | D6 |
| G-12 | `buildGraphWait`'s `setInterval` is not registered in the controller disposer chain (P3, A1/A3) | `packages/client/ui-page-app-manager/src/client/apply.ts:111` | D6 |
| G-13 | A crashed surface page stays a dead empty cell with no manager-owned failure surface and no retry path (P3, A3) | `scoped-slots.tsx` abdicate behavior; audit3 域10 F4 | D5 |
| G-14 | No two-profile real-composition test and no page-app web e2e (P2/P3, A4) | grep: no second-profile spec, no `workspace-apps` e2e; audit4 Domain 9/10 | §21 test matrix |
| G-15 | pnpm version drift risk between declared 11.7.0, CI 11.7.0, and observed 11.19.0 environments (P2, A2) | §4.2 version row | D10 |
| G-16 | `dsh.workspace` manifest block name differs from the brief's `workbench.contractVersion` (spec-assumption conflict, A1/A4) | `packages/boot/page-app-profile/src/manifest.ts:32-39` | D2 (with user decision R-3) |
| G-17 | Brief assumes Manager disabled → Feature subtree PENDING via Cordis dependency propagation; approved design chose launcher-owned layer (spec-assumption conflict, A1) | audit1 域5, audit4 §5 C2 | D4, D5 (with user decision R-4/R-5) |

## 7. Decision overview and target architecture

The optimization preserves the product layer and reworks the runtime dependency shape (brief §2). Target architecture:

```text
DSH (Cordis Runtime)
  └─ Workspace Manager Plugin (out-of-tree npm package, installed via DSH Plugin Manager)
       ├─ Cordis Compatibility Adapter        (D3: only layer that understands Cordis APIs)
       ├─ Workbench Runtime                   (D4: provides `workbenchRuntime`; Manager fiber lifecycle)
       ├─ Workbench Contract v1               (D2: normative Feature-facing contract, supportedContractVersions=[1])
       ├─ Managed Registry                    (unchanged, ownership SoT, profile-scoped)
       ├─ Workspace Shell                     (D5: rail + Surface Host; Native DSH fallback)
       └─ Plugin Manager Host                 (transactions, pnpm executor, recovery; D8)
            │
            │ Workbench Contract (versioned, Strict Mode)
            ▼
   Managed Feature Plugins (independent npm packages; never import Cordis; D2)
```

Decisions D1–D12 each fix one or more gaps: D1 fixes G-6; D2 fixes G-8/G-16; D3 fixes G-8/G-10; D4 fixes G-7/G-17; D5 fixes G-1/G-13; D6 fixes G-11/G-12; D8 fixes G-2/G-3/G-4; D10 fixes G-9/G-15; D11 fixes G-5; §21 fixes G-14; D12 defines the legacy removal criteria behind P8.

## 8. D1 — Delivery form: out-of-tree repository, npm package, DSH Plugin Manager install

**Decision.** The Workspace Manager ships as an independent out-of-tree repository `dsh-workspace-manager`, publishes a normal-SemVer npm package (actual name per the existing project, conceptually `@example/dsh-workspace-manager`), and is installed into a DSH profile exclusively through the DSH Plugin Manager chain (brief §4–§6). The in-tree implementation remains the migration source; the out-of-tree repository starts from a copy of the three page-app packages and the adapter/contract layers produced by D2–D4.

**Owner.** Implementation (DSH/GLM) owns the repository extraction and packaging; Codex owns the acceptance that no dev-only mechanism (`file:`, `link:`, local tarball, git) remains the only deployable path; the user owns the final manual install test.

**Data structures and layout.** The independent repository carries `package.json` (`name`, normal SemVer starting 1.0.0, `private: false`, `files` limited to `lib/` and required metadata, `exports` without `./src/*`, `LICENSE` file, `CHANGELOG.md`, README pair), `src/`, `tests/`, `docs/`, and the Manager manifest (`dsh.bundle.patch` + `dsh.client`). The Manager package never declares `dsh.workspace`: the D11 CLI classification keys off that block, so a `dsh.workspace` on the manager itself would make its own `dsh plugin` install print the Workspace Apps diagnostic and refuse to promote it (the current in-tree manager packages carry no `dsh.workspace` either). Peer dependency on `@deepseek-ai/cordis` (the vendored fork, §4.1) is declared by the Manager package and consumed only by the Adapter (D3); public `@deepseek-ai/dsh-*` seam packages that stay in the monorepo are depended on with normal semver ranges, never `workspace:` (audit2 域2).

**State machine (packaging/install chain).** `pack → artifact valid → fresh DSH Profile → dsh plugin --profile <p> add <tarball> → Manager starts → Manager disables → Manager re-enables → Manager uninstalls` (brief §48). Each arrow is a verifiable smoke step; the chain is proven before the manager's bundle row is touched. Manager disable is expressed as `disabled: true` on the manager row in the profile patch layer — `dsh plugin` has no enable/disable verb (audit 领域 14) — and the disable/re-enable smoke steps run through that overlay, with the D5 fallback rendering Native DSH while disabled.

**Call order.** Extraction keeps the product code identical first (no behavior change), then removes the manager rows from the shipped bundle roster only after (a) the Native DSH fallback (D5) and (b) the CLI classification (D11) are green, so every intermediate commit leaves a renderable DSH.

**Failure / cancellation / recovery.** A failing pack or install fails loudly in the release pipeline (existing `verify-packed-install.ts` pattern extended); an install that leaves the profile inconsistent is repaired through the existing journal/lock protocol (D8); `file:`/`link:` dev installs remain legal development forms but are never the only deployable form.

**Compatibility.** The user-facing label, product rules, and the approved design's semantics do not change; only the delivery carrier changes. The existing approved design §21 external author contract (Feature ships an already-built lazy-CJS client artifact; no published authoring preset) stays for v1.

**Non-goals.** No second package manager; no marketplace; no automatic update service; no adoption of packages installed by other means (brief §6/§58).

**Alternatives.** (a) Keep the manager in-tree (violates brief §4–§6 hard requirements; rejected). (b) Publish the in-tree packages individually without an independent repository (fails the out-of-tree repository requirement and keeps private monorepo coupling; rejected). (c) Runtime dynamic plugin packages (`cordis-host-runner`/`cordis-client-runner`) as the delivery carrier (approved design §6.2 rejected these for installed-package management; they are non-persistent and own no profile/pnpm; rejected).

## 9. D2 — Workbench Contract v1 and Strict Mode

**Decision.** A normative **Workbench Contract v1** is defined as the only Feature-facing API surface. `supportedContractVersions = [1]` is a Manager constant; a Feature whose manifest declares an unsupported contract version is refused at admission and at activation (brief §12). Strict Mode is enforced by three admission boundaries — source, dependency, and manifest/admission (brief §45) — with the honest limits below. The physical manifest block stays `dsh.workspace` (approved design §5, implemented and tested); `schemaVersion: 1` is the contract-version carrier for v1 (user decision R-3 offers the `workbench.*` rename as the v2 path).

**Owner.** Codex owns the contract document and field lock; implementation owns the admission validator changes; CI owns the source/dependency boundary checks in the out-of-tree Feature repositories.

**Data structures and interfaces.** The contract v1 normative surface (the Feature sees this, never Cordis):

```json
{
  "name": "@example/script-workspace",
  "version": "1.0.0",
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web" },
    "workspace": {
      "schemaVersion": 1,
      "id": "script",
      "name": "Script",
      "description": "Script creation workspace",
      "defaultOrder": 100,
      "rootEntryId": "script-page-root"
    }
  }
}
```

The Workbench Contract v1 document (living in the out-of-tree repository) fixes: the manifest fields above; the single surface entry point `registerWorkspaceSurface()` as the recommended domain-semantic API (brief §11) implemented over the adapter-owned slot registration (D3); the lifecycle obligations (every timer/listener/watcher/subscription/service created through the Workbench lifecycle, brief §20); and the compatibility promise that Cordis changes are absorbed by the Adapter (D3), never by Features.

**State machine.** Admission runs before any mutation: manifest parse → contract version check → dependency boundary check → uniqueness/collision check → activation. Unsupported version → reject with the version in the diagnostic; supported version → normal install flow (D8).

**Call order.** Manager admission validator (`validation.ts`) extends to: reject a direct `cordis` or `@deepseek-ai/cordis` dependency in the Feature `package.json` (G-8 dependency boundary, missing today per audit4 Domain 4), reject `import/require("cordis")` in source only where source is present, and keep the existing static rules. Source and dependency boundaries are also CI gates in Feature repositories (brief §45).

**Failure / cancellation / recovery.** The source-syntax and manifest preflight reject the operation before pnpm runs; the dependency boundary needs the installed `package.json`, so it rejects after pnpm staging but before any registry/ownership mutation — nothing owned changes and nothing needs rollback. The contract-version refusal is a hard preflight error, never a silent skip.

**Compatibility.** Contract v1 keeps the physical manifest and slot key of the approved design, so already-installed page apps remain readable; the formal contract document and the admission additions are additive until P8 removes the un-contracted path.

**Non-goals and honest limits.** The brief's source-boundary check cannot prove an arbitrary prebuilt third-party artifact never imported Cordis (audit4 §5 C3). v1 enforces: source boundary where the repository is available (official Features), dependency boundary on every install, and runtime isolation through provenance + authorized projection (P-4/P-5). A published authoring preset that would make source-level proof total is deferred (approved design §21). No capability permission sandbox (brief §58).

**Alternatives.** (a) Rename the manifest block to `workbench.*` immediately (breaks the implemented, tested, user-approved manifest; deferred to v2, R-3). (b) Skip the dependency-boundary check (leaves Strict Mode symbolic; rejected). (c) Attempt runtime sandboxing of Feature code (out of scope; brief §58).

## 10. D3 — Cordis Compatibility Adapter

**Decision.** The manager introduces one adapter seam — `adapter.ts` in the out-of-tree Manager — as the only code that imports `@deepseek-ai/cordis`, `cordis-plugin-loader`, or `cordis-plugin-include` (brief §14). All Manager product code goes through the adapter's typed surface; a Cordis major upgrade changes the adapter and its compatibility tests, never Feature code (brief §14).

**Owner.** Implementation owns the extraction and behavior-preserving refactor; Codex owns the acceptance that no Manager product file imports Cordis directly after P3.

**Data structures and interfaces.** The adapter exposes: `managedRootHash(root)` (canonical identity of a managed root, today `canonicalManagedRootHash` in validation), `applyEntryPatches` (Include composition), Loader read access (`entries`, fiber state), and the slot/contribution bridge used by the Workbench Runtime (D4). Each function maps one Workbench concern to one Cordis mechanism: lifecycle → fiber state, service → provide/inject, effect → `ctx.effect` disposer, dependency → dependency graph, load/unload → Loader lifecycle, surface lifetime → slot contribution lifecycle (brief §14).

**State machine.** No new state machine: the adapter is a pure mapping layer; all lifecycle states remain Cordis-owned (P-3).

**Call order.** Migration is behavior-preserving (brief §50): existing logic → adapter facade → behavior stays identical → old direct coupling removed, in small commits per call site.

**Failure / cancellation / recovery.** The adapter propagates Cordis errors with their original diagnostics; it adds no swallowing, no retry, and no second error model.

**Compatibility.** Vendored `@deepseek-ai/cordis` 4.0.1 semantics equal upstream (§4.1), so the adapter is written once against the vendored surface and its compatibility tests double as the upgrade tripwire for the next vendored bump.

**Non-goals.** The manager does not become a general DSH-ecosystem Cordis compatibility layer (brief §13); unmanaged third-party plugins are outside the compatibility promise.

**Alternatives.** (a) Keep Cordis calls spread across `index.ts`/`transaction.ts`/`validation.ts` (audit1 P2 drift; rejected for the optimization). (b) Re-export Cordis wholesale under new names (brief §11 forbids mechanical renames; rejected — the adapter is a domain-semantic mapping, not a rename).

## 11. D4 — Workbench Runtime provider and Feature Runtime Wrapper

**Decision.** The manager Host provides a stable capability `workbenchRuntime` whose lifecycle is the manager fiber's (brief §51 P4). Every managed Feature root becomes a wrapper root row that declares `workbenchRuntime` in its Cordis `inject`, so provider loss/return propagates natively: Manager row disabled → `workbenchRuntime` disappears → Cordis notifies dependents → Feature fibers PENDING/UNLOADING; Manager re-enabled → provider returns → Feature fibers reload (brief §17/§38). The wrapper is the parent row: the Feature's composed rows mount as its children, each child keeping its own Loader entry and therefore its own `ownerPackage` provenance (P-4) and `dsh.client` graph scanning (P-10) — the Feature module itself never imports Cordis or calls `ctx` APIs (brief §19 wrapper shape: Fiber → Feature Runtime Adapter → Feature Module → WorkbenchContext); the parent form does not remove the Feature's runtime Cordis access, so Strict Mode stays enforced at the admission/CI boundaries (D2) plus runtime isolation via provenance and closed projection (P-4/P-5).

**Owner.** Implementation owns the provider, the wrapper generator in the runtime-layer renderer, and the adapter bridge; Codex owns the hot-plug acceptance (P5); the user owns decision R-4 (introduce the wrapper now vs. keep the direct-root form for v1).

**Data structures and interfaces.** The WorkbenchContext handed to Features (contract v1, domain semantics, not Cordis-shaped):

```ts
interface WorkbenchLifecycle {
  onDispose(fn: () => void): () => void
}

interface WorkbenchContext {
  lifecycle: WorkbenchLifecycle
  surfaces: {
    registerWorkspaceSurface(registration: {
      pageId: string
      packageName: string
      render: unknown
    }): () => void
  }
  events: { on(name: string, fn: (payload: unknown) => void): () => void }
  storage: { get(key: string): unknown; set(key: string, value: unknown): Promise<void> }
  host: { call(method: string, args: unknown): Promise<unknown> }
}
```

The runtime-layer renderer (`renderPageAppRuntimeLayer` / `stageFromRegistry`) emits, per enabled statically-valid Feature, one wrapper root row carrying the Feature's package, page id, contract version, and the Feature's composed rows as its `insert` children, instead of the Feature's raw top-level row; the wrapper activates through `inject: ['workbenchRuntime']`. The safe-layer derivation (`deriveRoot`) additionally omits any root whose wrapper module cannot resolve from the profile — the manager package is not installed — and reports a `missing-manager` health state (folded into the existing omission path with the other reasons), so a manager uninstall with a surviving registry leaves Native DSH bootable with zero managed roots and a stale layer never reaches the Loader.

**State machine.** The provider lifecycle is exactly the manager fiber's (provide disposer semantics, §4.1). Feature state becomes: Manager ACTIVE + wrapper inject satisfied → LOADING → ACTIVE; Manager DISPOSED → provide disposer deletes `workbenchRuntime` and notifies → wrapper UNLOADING → PENDING (children follow the wrapper); Manager ACTIVE again → `_reload()` → ACTIVE; Manager uninstalled → the wrapper module is unresolvable, so the derivation omits the root entirely (missing-manager) and the registry keeps the row for a future reinstall. A single Feature disable still stages a layer without that root (existing path, P-3).

**Call order.** Wrapper activation: manager composes layer → Include update → loader awaits → wrapper fiber injects `workbenchRuntime` → the wrapper mounts its Feature children, hands each Feature module its `WorkbenchContext` through the contract's injection face, and registers the surface contribution through the adapter (D3); the Feature's client rows flow through the existing client graph/HMR path (P-10) with their own entries and provenance. Teardown is the reverse order, all disposer-owned.

**Failure / cancellation / recovery.** A wrapper that fails to inject stays PENDING and reports `activation-failed` via the derived health (existing `deriveHealth`); a wrapper module that cannot resolve (manager uninstalled) omits the root at derivation time with `missing-manager` health — pinned by a boot-after-uninstall test; a Feature module that throws inside its surface is contained by the per-surface slot error boundary (P-13) and the failure surface (D5). Uninstall/disable continue to unload the whole Managed Root (existing semantics, P-8).

**Compatibility.** Until P7 migrates the first real Feature, the direct-root form remains the runtime reality; the wrapper form and the direct form never coexist after P8 (brief §55). The approved design's v1 "bundle patch → single root entry" contract is extended, not contradicted: the Feature package shape is unchanged, only the generated wrapper row changes (user decision R-4 records this).

**Non-goals.** No second lifecycle graph; no hand-written enable/disable cascade; no copying Cordis API into the contract (brief §11/§17).

**Alternatives.** (a) Keep Features as bare Loader rows and simulate provider loss by regenerating the layer (launcher-owned semantics, approved design): this cannot express "Manager row disabled → Feature PENDING" without recomposition and does not satisfy brief §17/§38; it remains the fallback only if R-4 rejects the wrapper. (b) Have Features inject a manager-provided service directly (Feature still declares Cordis `inject`; violates Strict Mode; rejected).

## 12. D5 — Root Shell and Surface Host lifecycle with Native DSH fallback

**Decision.** The Workspace Shell (rail + Surface Host) remains manager-fiber-owned (already true: all registrations live in `ctx.effect`, audit3 域2). The missing half is the fallback: when the manager is absent or its shell crashes, Native DSH must render without a browser refresh (brief §22/§53 P6, DoD "Manager 不存在时 Native DSH 正常"). The design adopts dual-path registration in `ui-layout` — the priority-ordered fallback IS the crash fallback, with no renderer change — and adds the manager-owned failure surface for managed surfaces (G-13).

**Owner.** Implementation owns `ui-layout`/shell changes and the failure surface; Codex owns the P6 hot-plug acceptance (two manager start/stop cycles, DOM evidence, no refresh).

**Data structures and interfaces.** `ui-layout`'s `apply` (currently `packages/client/ui-layout/src/client/index.ts:130`) keeps one subscription over two paths: (i) when the builtin seat is declared by a live root occupant, it injects `AppFrame` into `page-app.shell.builtin` with the four child declarations (`sidebar`, `conversation`, `details`, `shell.overlay`) exactly as today; (ii) when the builtin seat is not declared, it registers `AppFrame` into the built-in `root` seat at priority 1 — strictly worse than the manager's default priority 0 — with the same four child declarations. The root cell then holds at most two registrants at different priorities, so the single-seat same-priority throw (`ui-slots/src/index.ts:812-815`) can never fire: the manager wins while live, and a missing or abdicated manager falls to the fallback because `entriesOfSlot` skips abdicated entries (`scoped-slots.tsx:861-868`). The transition (ii)→(i) yields synchronously: the fallback's disposer collapses its child declarations on the root-entries mutation, which the core commits before notifying child declarations (`ui-slots/src/index.ts:892-911`), so the builtin `AppFrame` re-registration never hits the duplicate-children throw (`ui-slots/src/index.ts:837-844`). No renderer-level Native DSH content exists — the shadowing fallback IS the crash fallback, and the renderer change is limited to nothing (RootOutlet already renders the surviving winner). The manager subscribes to the slot ledger's error events (`onEntryError`, `packages/client/runtime/src/client/slots.ts:336`) and renders a manager-owned failure surface per crashed managed surface with retry and uninstall actions (replacing the bare `<div data-slot-error>`); the root seat itself needs no failure surface because the fallback owns it.

**State machine.** Manager ACTIVE → shell + seats register → the subscription takes path (i) and `ui-layout` injects into the builtin seat; Manager DISPOSED or root crash → path (ii) owns `root` → Native DSH renders; Manager re-enabled → the builtin declaration reappears and the subscription switches back to path (i) (existing `slots.inject` reconcile behavior, audit3 域2). The DSH/Agent rail row stays a permanent constant entry inside the manager (approved rule, audit3 域6) and disappears together with the rail when the manager is gone.

**Call order.** Boot: `ui-renderer` renders `root`; the occupant is the manager shell when live, else the priority-1 fallback `AppFrame`. The subscription decides path (i) vs (ii) from the builtin seat's declaration state on every declaration change; the two paths never register the same child slots concurrently. Selection order is unchanged (controller fallback to DSH, P-8).

**Failure / cancellation / recovery.** Root crash → the fallback wins the cell and Native DSH renders; a surface crash → failure surface while rail and DSH remain usable; remote unavailable → existing degraded stub keeps DSH rendering (audit3 域6). No recovery depends on a browser refresh. The M3 tests pin the transition DOM sequence in both load orders (manager before `ui-layout` and after) and across one manager HMR reload cycle, so the yield protocol's synchronous ordering is proven, not assumed.

**Compatibility.** `root` keeps `kind: 'single'`; the fallback registers at a strictly worse priority, so the cell holds at most two registrants at distinct priorities and the manager is always the rendered winner while live — never two rendered occupants, never a same-priority throw. External plugins that register similar surfaces remain ineligible (P-5).

**Non-goals.** No `document.querySelector`/DOM injection/CSS `position: fixed` hacks (brief §23); no rail configuration; no manager-become-core (brief §16).

**Alternatives.** (a) `root` as `chain` kind with Native DSH as a permanent fallback occupant (changes the root slot kind for every consumer; heavier blast radius; rejected in favor of dual-path registration). (b) Renderer-level hardcoded fallback UI inside `ui-renderer` (approved design §6.2 rejected product UI in the renderer; rejected).

## 13. D6 — State model and error propagation

**Decision.** The four-dimension state split of brief §36 stays, with two additive refinements: the operation view gains explicit projected states (`installing`, `active`, `removing`, `install-failed`, `remove-failed`, `recovery-required`) derived from the journal phase and registry facts (journal remains the durable truth; no new durable fields), and the runtime state exposes semantic labels (`pending`/`loading`/`active`/`failed`/`unloading`) mapped from the Cordis `FiberState` instead of a raw number. Error propagation stays Cordis-native along the dependency subgraph (P-3) and per-surface via the slot error boundary (P-13).

**Owner.** Implementation owns the projections; Codex owns the mapping review against brief §36.

**Data structures and interfaces.**

```ts
type PageAppOperationState =
  | 'installing' | 'active' | 'removing'
  | 'install-failed' | 'remove-failed' | 'recovery-required'

type PageAppRuntimeStateLabel =
  | 'pending' | 'loading' | 'active' | 'failed' | 'unloading'
```

`PageAppManagerSnapshot.operation` projects the journal phase (`prepared`/`staged`/`committing`) and the registry revision into `PageAppOperationState`; `viewOf` maps `FiberState` through a label table: PENDING→`pending`, LOADING→`loading`, ACTIVE→`active`, FAILED→`failed`, UNLOADING→`unloading`, DISPOSED→`failed` (a disposed managed root is a failed root until the next generation); presentation state (`visible`/`hidden`/`activeSurface`) remains browser-side (approved design §4.2). The projected kebab labels satisfy the brief §36 snake_case names (`installing`/`install_failed`/`remove_failed`/`recovery_required` and the runtime states) via this mapping; no new durable fields exist.

**State machine.** No new machine: the labels are derived projections over existing durable state; illegal combinations (e.g. `installing` with a committed registry revision) are projection bugs caught by tests, not new runtime transitions.

**Call order.** `snapshot()`/`viewOf`/`readJournalOperation` remain the only projection call sites (P-1).

**Failure / cancellation / recovery.** The `buildGraphWait` interval (G-12) is moved under the controller's disposer (`createController`'s stop function), so controller disposal clears the timer immediately instead of waiting for the 30s cap (audit1 域6, audit3 域8).

**Compatibility.** Registry v1 and journal v1 schemas are unchanged; the additions are read-side only.

**Non-goals.** No new persisted operation-status column (the brief's `install_failed`/`remove_failed` are satisfied by the retained journal + projection); no second status authority.

**Alternatives.** (a) Persist explicit operation status fields (touches the journal schema and recovery decision table; rejected — journal phase already encodes commit boundaries). (b) Keep numeric fiber states (violates brief §36's explicit labels; rejected).

## 14. D7 — Registry, ownership, and profile isolation

**Decision.** The registry stays the sole ownership authority; runtime inventory stays observation-only; no scan-and-adopt anywhere; all ownership, version, source, enabled/visible/order, and manager state stay profile-scoped (brief §27–§31). The only structural change is D1's delivery form, after which "manager state per profile" becomes a real per-profile fact (installed/not installed) instead of a bundle-row constant.

**Owner.** Implementation owns the two-profile acceptance; Codex owns the no-adoption audit.

**Data structures.** Unchanged (`PageAppRegistryV1`, `paths.ts` profile-scoped files).

**State machine.** Unchanged (registry transitions in audit4 §2.2).

**Call order.** Unchanged.

**Failure / cancellation / recovery.** Corrupt registry → fail closed, preserve the file, expose recovery (P-1); missing dependency / version drift → omit the unsafe root and report health (existing `deriveSafeRuntimeLayer`), never auto-remove or auto-reinstall (brief §16).

**Compatibility.** Unchanged; Profile B never sees Profile A rows (file-scoped); the missing two-profile real-composition test (G-14) is added in §21.

**Non-goals.** No cross-profile sharing; no adoption UI in v1 (brief §29).

**Alternatives.** None — this decision re-locks the existing correct behavior; the only rejected alternative would be inferring ownership from Plugin Inventory (brief §28, already rejected by the implementation).

## 15. D8 — Lock, journal, rollback, and recovery

**Decision.** The existing lock/journal/backup/recovery protocol (P-7) is preserved and completed with three P0 fixes: cancellation is wired end-to-end through the Remote signatures (G-2), the activation acknowledgement gets a configurable Host timeout (G-4), and every rollback path restores the live runtime tree through `ProfileRuntime.restoreManagerLayer` before converging files (G-3, last-known-good).

**Owner.** Implementation owns the transaction/activation changes; Codex owns the tree/disk consistency acceptance; timeout default is a validated `Config` field, not a hardcoded constant (repo convention).

**Data structures and interfaces.** Remote signatures gain cancellation (Typert supports a final `signal` parameter; the generated namespaces must match the exact method names, brief §13):

```ts
type PageAppInstallSource = string
type PageAppClientInstanceId = string

interface PageAppManagerRemote {
  install(clientInstanceId: PageAppClientInstanceId, source: PageAppInstallSource, signal: AbortSignal): Promise<number>
  setEnabled(pageId: string, enabled: boolean, signal: AbortSignal): Promise<number>
  uninstall(pageId: string, signal: AbortSignal): Promise<number>
  // setHidden/reorder/ackClientActivation/recover/list unchanged
}
```

`PageAppManagerConfig.settlementTimeoutMs` (default in the shipped cordis.yml, e.g. 60_000) bounds `awaitSettlement`. The activation request carries the Host client-graph revision after the generation (`clientModules.graph().rev`), never the runtime-layer document: today `transaction.ts:139` sends `graphRevision: staged.layer` while the client graph rev is `shortHash(JSON.stringify(entries))` (`packages/client/modules/src/index.ts:414`) — the two can never be equal, and the client wait (`apply.ts:111-116`) resolves on any rev change, so the ack proves nothing. With the corrected handshake the client converges to an exact rev match before acknowledging, and the acknowledgement echoes the request's rev, so a stale or unrelated graph change cannot settle the gate.

**State machine.** Install (existing sequence, audit4 §3.1) gains: the Remote call's signal flows into the transaction (aborts pnpm via the executor's `cancelSignal` and aborts the acknowledgement wait), and the transaction's AbortSignal is additionally linked to the manager fiber lifetime (effect-owned disposer aborts the in-flight operation), so a manager reload cannot orphan a running transaction; a timeout rejects the wait the same way an abort does; any failure or cancellation enters the existing rollback, which now (1) restores the prior runtime layer via `restoreManagerLayer` and awaits its audit — with real expected-root hashes, `canonicalManagedRootHash(record.rootRow)` from the validator (today `transaction.ts:392` sends `hash: ''`, which makes the runtime audit report every root as `externally-overridden`; empty hashes are never sent) — then (2) restores the four file backups and runs profile-local `pnpm install` convergence; a non-zero convergence keeps the journal and projects `recovery-required` (existing rule). Uninstall's rollback restores the layer that still contains the root (audit4 Domain 8).

**Call order.** All mutations stay inside `withPageAppProfileLock` (P-7); the journal is written before the first mutation and removed only after commit; a mutation that finds an existing journal fails loud with `recovery-required` instead of overwriting it (today `writePageAppJournal` has no guard, so a new transaction silently discards a crashed transaction's decision — the approved design's "Startup recovery reads the journal before accepting new mutations" is enforced through this refusal, because boot derives the layer from the registry and is tree-consistent without running journal recovery); the operator `recover()` also acquires the shared lock (`ownerKind: 'manager'`) before it converges, so recovery's `pnpm install` never overlaps a concurrent transaction (today the `recover` Remote at `index.ts:231-237` runs without the lock); rollback runs inverse pnpm + restore + converge.

**Failure / cancellation / recovery.** Client disconnect/cancel → transport abort reaches Host → rollback (bounded by the settle timeout as a backstop, because transport disconnect-reject semantics need verification, §25). Process crash at any journal phase → boot derives the layer from the registry (tree-consistent) and refuses new mutations while the journal exists; the operator `recover()` (under the shared lock) decides complete-commit/restore-before-state/fail-closed from the registry-as-commit-marker (existing `recoverPageAppTransaction`), now including layer restoration. Lock orphan handling is unchanged (claim chain; dead `plugin-cli` lock fails closed).

**Compatibility.** Journal v1 and registry v1 unchanged; the Remote signature change is internal to the generated namespace and its consumers (controller and Settings), updated in the same commit; `ackClientActivation` stays targeted to the initiating client instance (P-5).

**Non-goals.** No new atomic-writer; no weakening of the lock; no delete of user sources or global store (P-12).

**Alternatives.** (a) Keep never-aborting controllers and rely on process restart for recovery (violates brief §13/§16 and can hold the lock in a live process; rejected). (b) Persist operation-status fields (rejected in D6). (c) Timeout as a hardcoded constant (violates repo configurability convention; rejected).

## 16. D9 — Host/Client authorization

**Decision.** The privileged fence (P-6) and the immutable provenance + closed projection (P-4/P-5) are the complete v1 authorization model; they are preserved unchanged and their route-level tests stay green. The Settings UI gains an explicit cancel affordance wired to the D8 signals, and the client continues to hold zero filesystem/pnpm capability.

**Owner.** Implementation owns the cancel affordance and the signal plumbing; Codex owns the route-level authority acceptance.

**Data structures and interfaces.** Unchanged plus the Settings cancel button binding to `AbortController` per operation.

**State machine / call order / failure semantics.** A cancel aborts the Remote call; Host rollback runs under D8; a second acknowledgement or a stale revision is rejected (existing rules). Non-loopback or cross-origin mutation requests receive 403 before Gateway dispatch and before any pnpm spawn (route tests).

**Compatibility.** The exact privileged endpoint spellings (`pageAppManager/install` etc.) stay byte-identical with the generated Typert endpoints; the route-test matrix stays.

**Non-goals.** No capability permission sandbox (brief §58); no per-Feature permission model in v1.

**Alternatives.** None — re-lock of existing correct behavior; the only rejected alternative is authorizing by UI affordance alone (approved design §13 explicitly rejected).

## 17. D10 — Out-of-tree packaging, publication, and install chain

**Decision.** The out-of-tree repository publishes through the proven chain (pnpm pack → validate tarball → npm publish tarball), with two additions: a content-level absolute-path scan over the tarball actually published (G-9), and a pnpm version-consistency gate (G-15). The final artifact must be free of `workspace:` specifiers, `src/`, maps, and absolute local paths (brief §56 first row).

**Owner.** Implementation owns the gates in both the monorepo and the out-of-tree repo; Codex owns the packed-artifact acceptance.

**Data structures and interfaces.** `scripts/publication-payload.ts` gains a per-member content scan (regex over file contents for Windows drive paths `[A-Za-z]:\` and POSIX roots `/Users/`, `/home/`) in addition to the existing member-name checks (audit2 域4); the out-of-tree repo ships an equivalent gate in its own CI. A version gate runs `pnpm --version` against the declared `packageManager` in CI and fails on mismatch; the monorepo CI pins or verifies the same way.

**State machine / call order.** pack → member scan + content scan + `workspace:` scan → install smoke in a fresh profile (extended `verify-packed-install.ts` chain: pack → fresh profile → `dsh plugin add` → start → disable → re-enable → uninstall, brief §48) → publish.

**Failure / cancellation / recovery.** Any scan hit fails the release before upload; an install smoke failure fails the pipeline and leaves no profile mutation (fresh temp profile only).

**Compatibility.** The repository's deliberate decoupling (pnpm decides content, npm only uploads, audit2 §2) is documented as the reason the final-tarball validation is mandatory and cannot rely on npm-packlist rules.

**Non-goals.** No `npm pack` replacement of the pnpm chain; no provenance in v1 (optional follow-up); no authoring preset publication (approved design §21).

**Alternatives.** (a) Rely on npm-packlist semantics because npm publishes (audit2 §2: npm uploads an existing tarball and does not re-run packlist; rejected). (b) Adopt `npm publish --dry-run` as the only check (weaker than the install-smoke chain; rejected).

## 18. D11 — CLI coexistence

**Decision.** `dsh plugin` acquires the shared profile mutation lock (`withPageAppProfileLock`, ownerKind `plugin-cli` — already reserved in `lock.ts:22`) and classifies packages declaring `dsh.workspace` as manager-only page apps: they are never appended to `dsh.profile.bundles`, and an external install prints a diagnostic directing the user to Plugins → Workspace Apps (brief §17, G-5). The CLI never calls manager adoption APIs.

**Owner.** Implementation owns `apps/cli/src/plugin.ts`; Codex owns the contention and classification acceptance.

**Data structures and interfaces.** `runPlugin`'s read → pnpm → reconcile sequence wraps in the shared lock; `reconcilePlugins` filters `dsh.workspace`-declaring dependencies out of `dsh.profile.bundles` with a typed diagnostic. Because `withPageAppProfileLock` is promise-based and `runPlugin` is currently synchronous (`spawnSync`, `apps/cli/src/plugin.ts:120-158`), the CLI call chain and exit handling are restructured deliberately (the approved plan Task 13 restructure is required, never a synchronous spin on the promise). The classification can never catch the manager's own install because the Manager package never declares `dsh.workspace` (D1).

**State machine / call order.** Generic plugin mutations serialize with manager transactions on the same profile; the lock's existing backoff and 15-minute deadline apply; a dead `plugin-cli` lock remains operator-repair (P-7).

**Failure / cancellation / recovery.** Lock contention waits (no pnpm overlap); out-of-lock profile changes during a manager journal remain recovery conflicts (existing rule); classification failure fails loudly with the exact diagnostic style.

**Compatibility.** Ordinary plugin behavior is unchanged; the manager's admission collision check (`validation.ts:129-131` rejecting bundle-listed packages) stops rejecting legitimate manager installs once the CLI stops promoting them.

**Non-goals.** No CLI-side adoption; no second install flow for page apps; no manager-aware `update` promotion (brief §17).

**Alternatives.** (a) Leave the CLI as a raw pnpm forwarder (audit1/audit4 confirm this lets an external install run a managed root without ownership and race the manager; rejected). (b) Have the CLI call the manager's Remote recover APIs (crosses the privileged fence and couples the CLI to a running Host; rejected).

## 19. D12 — Legacy path removal criteria

**Decision.** Nothing is deleted until its replacement is verified by the tests named below; after P8 the repository contains exactly one runtime path per concern (brief §55). The following legacy items have defined removal criteria.

| Legacy item | Current location | Removal criterion (all must hold) | Verification |
|---|---|---|---|
| `watchUserPatches` (dead code) | `packages/boot/app-boot/src/index.ts:253-286` | `ProfileRuntime` composition covers every path the three existing specs reference; no inbound reference remains (the test references in `include-rollback.spec.ts`, `profile-runtime.spec.ts`, and `user-patches.spec.ts` migrate to the `ProfileRuntime` watcher path first) | focused app-boot tests + grep for references |
| Feature → Cordis direct access (raw `ctx.slots.register` by Features) | Feature contract path (`contracts.ts`) | Workbench Contract v1 adopted by every managed Feature (P7 migration complete) | contract admission tests + fixture source-boundary CI |
| Direct-root runtime form (no wrapper) | runtime-layer generator | D4 wrapper generation green and the real Feature migrated | P4/P5/P7 tests |
| Manager permanent bundle rows | `packages/bundle/web-app/cordis.patch.yml` | D1 install chain proven and D5 fallback green; profile-level removal/disable exercises | P1/P6 assembled tests |
| Duplicate runtime state | none exists (single derived layer, P-2) | remains true after D4 | composition tests |
| Manual dependency cascade | none exists (P-3) | remains true after D4 | hot-plug tests |
| Legacy runtime bridge | none exists | n/a | n/a |

Each removal is its own commit with its own test anchor; no removal happens in the same commit as the replacement.

## 20. Failure matrix

The matrix covers every failure the audits and the brief name, with propagation boundary, resulting state, and recovery.

| Scenario | Trigger | Propagation boundary | Resulting state | Recovery | Test anchor |
|---|---|---|---|---|---|
| Manager row absent/disabled | user patch or profile change | Native DSH fallback renders (D5); Features PENDING via provider loss (D4) | Native DSH ACTIVE; Feature subtree PENDING/inactive | re-enable manager → Features reload | P6 shell hot-plug |
| Manager shell (root entry) crash | render throw in PageAppShell | root fallback boundary (D5) | Native DSH renders | no refresh required | root-crash test |
| Single Surface crash | render throw in one Feature | per-surface slot error boundary | rail + DSH usable; failure surface with retry/uninstall (D5) | retry or uninstall | surface-crash test |
| Install pnpm failure (incl. allowBuilds) | pnpm non-zero | transaction rollback | prior state restored; `PageAppBuildPermissionError` diagnostic | re-run after operator decision | transaction.spec allowBuilds |
| Host activation failure | Include update/audit fails | `applyManagerLayer` rejects; rollback restores layer (D8) | prior committed tree | automatic | loader-composition spec |
| Publish (registry write) failure | disk/write error after activation | rollback restores files + live layer (D8) | tree and disk consistent | automatic; journal retained on converge failure | publish-failure rollback test |
| Client disconnect / cancel during install | transport abort | Host signal → rollback (D8) | prior state; lock released | automatic | cancellation test |
| Client never acknowledges | activation wait | settlement timeout (D8) | automatic rollback; lock released | automatic | ack-timeout test |
| pnpm remove failure on uninstall | pnpm non-zero | rollback restores layer with root + files | registry row still present and enabled | re-run uninstall | uninstall rollback test |
| Registry corrupt | on-disk corruption | fail closed; managed roots omitted | Native DSH ACTIVE; recovery-required visible | operator `recover()`; file never rewritten | corrupt-registry test |
| Runtime layer missing/corrupt | startup | regenerate from valid registry (P-2) | normal boot | automatic | startup rebuild test |
| Version drift | installed version ≠ registry | unsafe root omitted | `version-drift` health; code not auto-run | explicit manager decision | version-drift test |
| Missing dependency | node_modules lacks package | unsafe root omitted | `missing-dependency` health | explicit reinstall/decision | missing-dep test |
| User patch overrides managed root | effective entry identity differs | launcher compares and reports | `externally-overridden`; user patch never rewritten | user resolves | user-layer precedence test |
| External plugin registers similar surface | unmanaged contribution | provenance/closed projection rejects | never projected | none | authorization matrix |
| `dsh plugin` races manager | concurrent pnpm | shared lock serializes (D11) | no overlap; journal conflicts fail closed | retry | contention test |
| Dead lock | crash | claim chain / fail-closed (P-7) | manager: token recovery; plugin-cli: operator | restart recovery | orphan-lock tests |
| Process crash at journal phase | kill | registry-as-commit-marker decision (P-8/D8) | complete/restore/fail-closed | startup recovery | recovery-table tests |
| External manager-installed package in Profile B | install in Profile A only | file-scoped isolation | Profile B never sees it | none | two-profile e2e |

## 21. Migration order (dependency-ordered, TDD)

Every step is TDD with small commits, exact files, and exact tests; Codex checkpoints after each group (mirroring the approved plan's checkpoint discipline). Steps P0.x fix the audit-confirmed P0 defects in place before any delivery-form change, so each commit keeps a renderable, testable system.

| Step | Content | Decisions | Primary tests | Checkpoint |
|---|---|---|---|---|
| M0 | Pin preconditions: `git rev-parse HEAD` = `e91e2c5bd1`; existing `include-rollback.spec.ts` (Include `entry.update` rollback contract) green | — | `include-rollback.spec.ts`, `config-reload.spec.ts` | Foundation |
| M1 | Cancellation wiring: Remote `signal` parameters, Host propagation, controller/Settings abort, `settlementTimeoutMs` config | D8 (G-2/G-4) | transaction cancellation, ack-timeout, route-level tests | Foundation |
| M2 | Rollback live-tree restoration: `rollback` calls `restoreManagerLayer` and awaits audit; publish-failure and uninstall-remove-failure paths | D8 (G-3) | tree/disk consistency for publish-fail, remove-fail, audit-fail | Foundation |
| M3 | Native DSH fallback: `ui-layout` dual-path registration + root crash fallback; manager failure surface | D5 (G-1/G-13) | no-manager boot, root-crash, surface-crash, P6 shell hot-plug | Foundation |
| M4 | CLI coexistence: shared lock + `dsh.workspace` classification | D11 (G-5) | CLI classification e2e, contention, built-bin | Runtime |
| M5 | Workbench Contract v1: contract document, `supportedContractVersions=[1]`, dependency-boundary admission check | D2 (G-8/G-16) | validation boundary suite, admission fixtures | Runtime |
| M6 | Adapter extraction: `adapter.ts` absorbs Cordis/include/Loader usage; behavior preserved | D3 (G-10) | existing suites unchanged + adapter compatibility tests | Runtime |
| M7 | Workbench Runtime provider + wrapper generation in the layer renderer | D4 (G-7/G-17) | provider-loss/return hot-plug, wrapper lifecycle | Runtime |
| M8 | State projections: operation states, runtime labels, disposer-owned graph-wait timer | D6 (G-11/G-12) | projection specs, timer disposal | UI |
| M9 | Real Feature migration (P7): one Feature moves to contract + wrapper end-to-end | D2/D4 | brief §54 full chain: install/sidebar/disable/re-enable/uninstall/manager suspend/restore | UI |
| M10 | Out-of-tree packaging baseline (P1): extract repository, tarball content scan, version gate, install-chain smoke | D1/D10 (G-6/G-9/G-15) | packed-artifact scan, fresh-profile chain, pnpm version gate | Composition |
| M11 | Legacy removal (P8) per D12 criteria | D12 | each removal's named anchor | Composition |
| M12 | Assembled acceptance: two-profile e2e, web real-composition e2e, keyless snapshots, docs, Agent Note, final gates | §22, §26 | full matrix below | Composition |

## 22. TDD acceptance and exit criteria

Definition of Done is brief §57; each item maps to an executable anchor. The required test matrix is brief §56; rows marked "existing" are already green on the baseline and must stay green.

| Acceptance (brief §57) | Anchor |
|---|---|
| Out-of-tree independent repository | M10; repo layout check |
| npm pack/publish works | M10 pack + publish dry-run + tarball scan |
| Install into fresh Profile via DSH Plugin Manager | M10 fresh-profile chain smoke |
| Manager enable/disable/re-enable/uninstall | M10 chain steps + P6 hot-plug |
| Native DSH normal without Manager | M3 no-manager boot test |
| Feature never imports Cordis | M5 source/dependency boundary (Feature CI) |
| Workbench Contract v1 versioned | M5 `supportedContractVersions` constant + admission |
| Cordis calls concentrated in Adapter | M6 grep gate: no Cordis import outside `adapter.ts` |
| Feature lifecycle maps to Cordis Fiber | M7 provider-loss/return tests |
| Manager provider loss → Feature subtree inactive | M7; brief §17 sequence asserted on real composition |
| Manager provider return → Feature recovers | M7; same test reversed |
| Single Feature removal isolated | existing disable tests + M9 |
| Feature side effects fully cleaned on dispose | M9 disposer audit + existing runner teardown |
| Managed Registry remains ownership authority | existing registry tests + M12 two-profile |
| External plugins cannot bypass Registry | existing authorization matrix |
| Profile isolation complete | M12 two-profile real-composition e2e |
| Hide/Disable/Uninstall semantics distinct | existing transaction/controller tests |
| Install/uninstall rollback + recovery | M1/M2 tests |
| Disable/uninstall never delete user data | existing P-12 tests |
| Original DSH navigation state preserved | existing `shell.client.spec.tsx` DOM-identity tests + M12 |
| No unintended product regression | full regression set (existing suites) |
| No second lifecycle system | P-3 composition tests + M7 |

Brief §56 rows map 1:1: `npm pack` success/no absolute path → M10 scan; fresh Profile Manager install → M10; disable/re-enable Manager → M3/M7; disable/re-enable Script → M9; Feature imports Cordis → CI FAIL → M5; unsupported contract version rejected → M5; Feature dispose releases everything → M9; Manager surface crash recoverable → M3; external plugin not admitted → existing authorization; Profile A vs B → M12; hide ≠ unload → existing; disable ≠ delete package → existing; uninstall keeps user data → existing; Script→Board→Script state → existing; DSH→Script→DSH state → existing; install rollback failure shows `recovery-required` → M1/M2; uninstall failure keeps ownership → M2.

## 23. Explicit non-goals

The brief's §58 list is adopted verbatim and extended by this design: no Plugin Marketplace; no global DSH Plugin Manager; no multi-workspace package; no auto Adoption/Import; no capability permission sandbox; no new project-data protocol; no new agent scheduling; no new Feature product features; no complex Badge/Command/Shortcut system; no automatic deletion of business data; no full logging platform; no published authoring build preset in v1; no per-Feature permission model; no `root` slot kind change; no second package manager; no provenance publishing in v1.

## 24. User decision items

Locked by this design (no user arbitration needed): R-2 — the user-facing label stays **Workspace Apps** and internal identifiers stay page-app (already approved 2026-08-22); R-3 — the physical manifest block stays `dsh.workspace` with `schemaVersion` for v1 and the `workbench.*` rename is the v2 path (the brief §33 delegates the field lock to P0 + Formal Design Spec, and the implemented, tested, user-approved manifest is the least-risk choice). The following remain true user decisions because they reverse or arbitrate user-approved 2026-08-22 choices:

| # | Question | Recommendation |
|---|---|---|
| R-4 | Introduce the Feature Runtime Wrapper (brief §19) now, or keep the direct-root v1 form and defer the wrapper | Introduce the parent-form wrapper in M7; it is the only way brief §17/§38 provider propagation holds without a second lifecycle; this reverses the approved 2026-08-22 no-wrapper contract, so the user arbitrates |
| R-5 | Manager row disable semantics: plugin-row disable → Feature PENDING via provider propagation (launcher-owned layer stays) | Adopt provider propagation (D4); document that the launcher-owned layer and the provider dependency coexist; this arbitrates the brief §17/§38 vs approved design §8.2 conflict (audit C2), so the user decides |

## 25. Risks to verify during self-review

These are the points this design asserts but did not fully verify; the self-review and the plan must close them before implementation depends on them.

1. Transport disconnect-reject semantics: whether a browser disconnect rejects in-flight Typert calls (so the D8 signal fires) or only aborts at the HTTP layer; the settle timeout is the deliberate backstop but the exact reject path must be confirmed in `connection`/Gateway tests.
2. `slots.inject` redeclaration timing after manager re-enable (audit3 域2 asserts rerun exists); the D5 yield protocol pins the DOM sequence in both load orders and across a manager HMR cycle in the M3 tests.
3. Graph-reconcile vs activation-ack race: D8 now carries the Host graph rev and requires exact convergence, so a stale or unrelated change cannot settle the gate; the HMR `graph` frame and `rebuilt` frame interleaving (P-10) must still be proven by a rev-exact ack test and a stale-ack rejection test.
4. The wrapper's Feature-module loading and `WorkbenchContext` handoff for already-built lazy-CJS Features; D4 pins the parent form (Feature rows mount as children) so host rows, `dsh.client` scanning, and per-row provenance survive, but M7 must pick the injection face and prove `ownerPackage` still equals the Feature package through the wrapper.
5. pnpm version drift: measured 11.7.0 here but 11.19.0 in the audit session; the version gate must fail on either side of the pin.
6. Windows-specific rollback cleanup (`EBUSY`/`EPERM` bounded retries) already specified in the approved plan (Task 8) stays a Windows acceptance item.
7. `dsh.workspace` blocks on packages installed by generic `dsh plugin` before M4: pre-existing external bundle-listed packages remain rejected by admission (no auto-adoption) and the CLI stops promoting them only after M4; interim users must remove via the original mechanism (brief §29).
8. Web-app bundle roster changes during M1–M9 keep `ui-page-app-manager` as the `root` occupant until M3's fallback is green; the interim period still has the single-occupant SPOF (accepted, mitigated by M3 being early in the order).
9. Wrapper resolvability after a manager uninstall: the D4 omission rule (`missing-manager`) must be proven by a boot-after-uninstall test so a stale layer naming an unresolvable wrapper never reaches the Loader.

## 26. Agent Note and documentation obligations

Repo rule: every non-trivial change ships an Agent Note in the same PR (root AGENTS.md; `docs/AGENTS.md`). This design document is planning output and is not itself an implemented-note; the derived Implementation Plan must include the note task (M12): `.agents/notes/implemented/architecture/2026-08-25-workspace-apps-architecture-optimization.md`, authored per the implemented-note format once the migration ships, recording the locked decisions D1–D12, the audit-to-decision mapping, and the named verification contracts. The plan must also update the current-state package READMEs and the owning `docs/subsystems/*.md` page at the lowest owning level, and regenerate affected catalogs, in the same change as the code (approved plan Task 16 pattern). No Agent Note file is written by this task.

## 27. Appendix A — Context7 official source links (verified 2026-08-25)

Cordis: https://github.com/cordiverse/cordis/blob/main/packages/core/src/fiber.ts, https://github.com/cordiverse/cordis/blob/main/packages/core/src/registry.ts, https://github.com/cordiverse/cordis/blob/main/packages/core/src/reflect.ts.

pnpm: https://github.com/pnpm/pnpm.io/blob/main/versioned_docs/version-10.x/cli/link.md, https://github.com/pnpm/pnpm.io/blob/main/versioned_docs/version-10.x/cli/install.md, https://github.com/pnpm/pnpm.io/blob/main/docs/workspaces.md, https://github.com/pnpm/pnpm.io/blob/main/blog/releases/10.26.md, https://github.com/pnpm/pnpm.io/blob/main/blog/releases/11.0.md, https://github.com/pnpm/pnpm.io/blob/main/blog/releases/11.7.md.

npm: https://github.com/npm/cli/blob/latest/docs/lib/content/configuring-npm/package-json.md, https://github.com/npm/cli/wiki/Files-&-Ignores, https://github.com/npm/cli/blob/latest/node_modules/npm-packlist/lib/index.js, https://github.com/npm/cli/blob/latest/lib/commands/publish.js, https://github.com/npm/cli/blob/latest/workspaces/config/lib/definitions/definitions.js.

## 28. Appendix B — Audit evidence index

All line numbers refer to this worktree at `e91e2c5bd1` as read on 2026-08-25. A1 = audit session `session-4f69b6d5…` seq 101909; A2 = `session-2030e15f…` seq 45535 (+61756 Context7 supplement); A3 = `session-bd96fdf0…` seq 61144; A4 = `session-00e98cb2…` seq 40916. The full evidence tables live in those sessions; this document quotes only the rows its decisions depend on.
