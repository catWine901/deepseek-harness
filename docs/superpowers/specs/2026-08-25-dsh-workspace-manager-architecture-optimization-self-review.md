# DSH Workspace Manager Architecture Optimization — Design Spec Self-Review

- Status: Complete (independent adversarial review; design revised per §6)
- Reviewed artifact: `2026-08-25-dsh-workspace-manager-architecture-optimization-design.md` (revised in this pass)
- Reviewer: independent Codex session, adversarial stance — no author self-claims accepted
- Baseline: branch `feature/workspace-apps` @ `e91e2c5bd1` (same worktree, clean except the four 2026-08-25 spec files)
- Date: 2026-08-25
- Scope: every load-bearing claim in the design was re-verified against the source at `e91e2c5bd1` by reading the files, not by trusting the audit; upstream Context7 statements were kept separate from vendored/installed reality per the brief's instruction
- Method: read the governing brief (§1–§62), the approved 2026-08-22 design + self-review + plan, the P0 audit, the gap matrix, and the design; then re-read the source files listed in §2 and re-derived the D1–D12 closure, the lifecycle graph, the fallback, Strict Mode honesty, and the legacy/transaction/concurrency claims

## 1. Verdict

The design is decision-complete and preserves every mechanism the audits confirmed correct: all thirteen preserved-mechanism claims (P-1–P-13) and the §4 upstream fact-check were re-verified against source and hold, including the parts most likely to be self-serving (vendored Fiber semantics, Typert cancellation support, slot shadowing rules, the shared lock protocol, journaling, and the launcher-owned recomposition). The three audit P0 gaps (G-1 root SPOF, G-3 rollback without live-tree restore, G-4 ack without timeout) are correctly assigned to D5/D8, and the decisions are implementable on seams that exist today.

Two P0-level gaps and five P1 gaps remain in the design as written. They do not change the architecture — every one is a mechanism the design leaves ambiguous or self-contradictory, and each has a minimal correction that fits the existing seams:

1. D5's root fallback can double-occupy the single `root` seat and throw, and the design contradicts itself by also proposing a renderer-level fallback it rejects in its own alternatives.
2. D4's wrapper form can make Native DSH unbootable after a manager uninstall, because the derived layer would reference a wrapper module that no longer resolves.
3. D1 and D11 contradict each other: the Manager manifest per D1 declares `dsh.workspace`, which D11's classification rule would refuse to install via `dsh plugin`.
4. The transaction sends empty expected-root hashes, so the runtime's activation audit reports every root as `externally-overridden`; D8's "await audit" rollback inherits the polluted report.
5. The activation ack handshake compares the client graph revision against the runtime-layer document, so the ack never proves convergence and can settle on any unrelated graph change.
6. A new transaction silently overwrites a crashed transaction's journal, and the operator `recover()` path runs without the shared profile lock.
7. D4's wrapper-to-Feature-rows relationship (parent vs replacement) is ambiguous, leaving Feature host-side loading undefined.

Verdict: **approve with revisions**. The findings, their evidence, and the exact design changes applied are in §4–§6; residual risks and implementation-time probes are in §7; check results are in §8.

## 2. Independent evidence re-verification

Every evidence anchor below was read in this session at `e91e2c5bd1` (paths relative to the worktree root); line numbers are as read on 2026-08-25.

| Claim in the design | Independent verification | Result |
|---|---|---|
| §4.1 vendored FiberState enum and `_refresh`/`_setEpoch`/`_reload`/`_unload`/`await` semantics | `vendor/cordis/src/fiber.ts:147-154` (enum), 611-623 (`_refresh`), 625-639 (`_setEpoch`), 646-673 (`_reload`), 675-696 (`_unload`), 704-710 (`await`) | Holds (design's line refs drift by ≤2 lines; not material) |
| §4.1 `ctx.provide` disposer deletes the service, notifies dependents, awaits them | `vendor/cordis/src/reflect.ts:277-304`, `Promise.allSettled(fibers.map(f => f.await()))` at 300 | Holds |
| §4.2 pnpm `file:`/`link:`/`workspace:` semantics and repo `allowBuilds` reality | `apps/cli/src/plugin.ts:104-112` (prefix preservation), `pnpm-workspace.yaml:40-55` (`allowBuilds`), `packages/boot/app-boot/src/profile.ts:138-143` (profile workspace file has no `allowBuilds`) | Holds |
| §4.2 pnpm version declaration | `package.json:7` `packageManager: pnpm@11.7.0` | Holds |
| §4.3 pnpm pack → npm publish tarball chain and member-name-only validation | `scripts/release/pack.ts:27-35` (`pnpm pack` + `validatePayload`), `scripts/release/publish.ts` present; `scripts/publication-payload.ts:33-39` checks `src/` and `.map` member names only — no content scan | Holds; G-9 confirmed |
| P-2 launcher-owned recomposition and acknowledged apply | `packages/boot/app-boot/src/profile-runtime.ts:628-642` (apply/restore), 644-669 (queue), 686-701 (generation), 713-749 (audit); `apps/cli/src/profile-boot.ts:180-188` (compose order), 226-268 (boot) | Holds |
| P-4 immutable `ownerPackage` provenance | `packages/client/runtime/src/client/slots.ts:369-402` (`_register` derives from `this.ctx.fiber.entry?.options?.name`, never reads an option), `vendor/loader/src/index.ts:118-122` (fiber inherits entry) | Holds |
| P-5 closed authorized projection | `packages/client/ui-page-app-manager/src/client/controller.ts:289-310` (`authorizedProjection`: key + ownerPackage + enabled + activation match, duplicates never projected) | Holds |
| P-6 seven privileged endpoints | `packages/client/connection/src/privileged-methods.ts:62-68` (all seven `pageAppManager/*` slash endpoints) | Holds |
| P-7 journal + lock protocol, `plugin-cli` owner kind reserved | `packages/boot/page-app-profile/src/lock.ts:20-26` (ownerKind enum), 72-121 (lock), 398-447 (orphan recovery); `journal.ts` phases prepared/staged/committing | Holds |
| P-8 hide/disable/uninstall + keep-mounted model | `packages/host/page-app-manager/src/transaction.ts:190-203` (hide), 162-181 (disable), 238-266 (uninstall); `packages/client/ui-page-app-manager/src/client/PageAppShell.tsx:40-90` (HTML `hidden`, stable `SurfaceFrame`) | Holds |
| P-10 atomic graph replacement and reconcile order | `packages/client/modules/src/client/system.ts` `replaceGraph`; `packages/client/hmr/src/client/index.ts:114-141` (validate → removals via `loader.remove` → invalidate → styles → prefetch in graph order → create → `fiber.await()`) | Holds |
| G-1 root SPOF | `packages/client/runtime/src/client/slots.ts:271-273` (fail-loud guard); `packages/client/ui-renderer/src/client/scoped-slots.tsx:853-889` (RootOutlet throws `SlotAssemblyError` / `data-slot-error="root"`); `packages/client/ui-layout/src/client/index.ts:130-147` (inject into `page-app.shell.builtin` only) | Holds |
| G-2 cancellation not wired | `packages/host/page-app-manager/src/index.ts:156-201` (`new AbortController().signal` never aborts); `controller.ts:167-216` (`void signal`); Remote signatures carry no signal | Holds |
| G-3 rollback never restores the live tree | `transaction.ts:420-456` (`rollback` restores files + converges, no `restoreManagerLayer`); grep of `page-app-manager/src` for `restoreManagerLayer` = 0 production hits; `profile-runtime.ts:857-859` defines it | Holds |
| G-4 ack wait has no timeout | `packages/host/page-app-manager/src/activation.ts:60-80` (`awaitSettlement` waits on signal only) | Holds |
| G-5 CLI classification/lock absent | `apps/cli/src/plugin.ts:59-91` (`reconcilePlugins` promotes any `dsh.bundle`-declaring dependency into `dsh.profile.bundles`, no lock), 120-158 (`runPlugin` has no lock) | Holds |
| G-9/G-15 packaging and version gaps | §4.3 row above; version drift between environments is real (design §4.2) | Holds |
| G-11 raw fiber-state number | `index.ts:84` `runtimeState: String(facts.loaderRow.fiberState)` | Holds |
| G-12 unmanaged interval | `packages/client/ui-page-app-manager/src/client/apply.ts:111-116` (`setInterval` in `buildGraphWait`, no disposer) | Holds |
| G-14 no assembled e2e | `git ls-files apps/web/tests` has no `workspace-apps` spec (only the unrelated `workspace-management.e2e.ts`) | Holds |
| Typert supports a final `signal` Remote parameter (D8 premise) | `packages/typert/generator/src/analyzer.ts:1011-1020` (final `signal: AbortSignal`), `packages/typert/generator/src/emitter.ts:468` (`signal?: AbortSignal`), `packages/typert/registry/src/service.ts:669-670` | Holds — the design's D8 cancellation premise is real |
| Root seat is built-in and single | `packages/client/ui-slots/src/index.ts:706-712` (root hole seeded), 726-732 (single: second registration at the same priority throws) | Holds — basis for finding F-1 |
| Child rows keep their own Loader entries | `vendor/loader/src/index.ts:118-122` + `vendor/loader/src/config/entry.ts:92-95,253` (upward walks over distinct parent entries) | Holds — basis for the D4 parent-wrapper provenance note |

## 3. Coverage traceability

### 3.1 The 20 P0 audit domains (brief §47)

| Domain | Design coverage | Verdict |
|---|---|---|
| 1 Cordis direct imports | D2 (Strict Mode boundaries), D3 (adapter concentrates all Cordis imports), D12 (Feature direct access removal criteria) | Covered |
| 2 ctx.effect/provide/plugin/inject ownership | P-2/P-4 preserved; D4 provider is the only new provide | Covered |
| 3 Loader/HMR direct calls | P-2/P-10 preserved; D12 `watchUserPatches` removal criteria | Covered |
| 4 manual enable/disable cascade | P-3 preserved; D4 keeps no-cascade (provider propagation only) | Covered |
| 5 Root/AppFrame hardcoding | G-1 → D5 (fallback protocol) | Covered (F-1 fixes the mechanism) |
| 6 DOM/CSS hacks | P-8 (HTML `hidden` model); D5 non-goals (no `querySelector`/injection) | Covered |
| 7 Feature→Sidebar UI coupling | P-5 closed projection; rail rows are controller projections only | Covered |
| 8 Registry schema | P-1 preserved; D7 re-locks | Covered |
| 9 Runtime layer | P-2 preserved; D7 re-locks; D4 wrapper generation is the only renderer change | Covered (F-2/F-7) |
| 10 install/disable/uninstall lifecycle | P-8 preserved; D8 (G-2/G-3/G-4) completes it | Covered |
| 11 package.json / dsh.bundle contract | D1 (out-of-tree manifest), D2 (contract v1), D12 (bundle-row removal) | Covered (F-3) |
| 12 Out-of-Tree boundary | D1 (G-6) | Covered |
| 13 npm pack readiness | D10 (G-9: content-level scan) | Covered |
| 14 DSH Plugin Manager install | D1 (G-6), D11 (CLI classification) | Covered (F-3) |
| 15 DSH private imports | D1 (out-of-tree repo, semver deps, no private imports) | Covered |
| 16 unmanaged timer/listener/watcher | D6 (G-12 disposer-owned graph wait) | Covered |
| 17 Surface Error Boundary | D5 (G-13 manager-owned failure surface) | Covered |
| 18 Profile isolation | D7 (file-scoped persistence); §21 M12 two-profile e2e (G-14) | Covered |
| 19 runtime status model | D6 (G-11 semantic labels) | Covered (F-8) |
| 20 rollback/recovery | D8 (G-3 live-tree restore, G-4 timeout, recovery) | Covered (F-4/F-6) |

### 3.2 Gap Matrix rows → decisions

| Gap Matrix row | Decision | Verdict |
|---|---|---|
| §7 Core extension / root fallback (P0) | D5 | Covered (F-1) |
| §8 two plugin classes | D2/D3 (Strict Mode boundaries, adapter) | Covered |
| §12 contract versioning (C3) | D2 (`supportedContractVersions = [1]`, R-3 locked) | Covered |
| §16 Manager hot-plug | D1 (out-of-tree package + full lifecycle) | Covered |
| §17 Manager hot-plug semantics (B2) | D4 (provider propagation) + D5 (shell) | Covered |
| §18 Feature independent hot-plug | preserved `setEnabled` single-root path + §21 M9 | Covered |
| §20 Hot-Plug side effects (A7) | D6 (G-12) | Covered |
| §21 failure propagation (B1/B5) | D5 | Covered (F-1) |
| §23 slot lifecycle reuse | preserved; no mechanism change | Covered |
| §24 DSH/Agent fallback | preserved `DSH_ROW`; D5 fallback | Covered |
| §25/§26 state preservation | preserved hidden-not-unmounted; §21 M12 | Covered |
| §27 management-domain isolation (A3) | D11 (CLI classification) | Covered (F-3) |
| §28 registry authority | D7 re-lock | Covered |
| §29 no auto-adoption | D7 re-lock | Covered |
| §30 surface authorization | D9 re-lock | Covered |
| §31 profile scope | D7 + M12 two-profile e2e | Covered |
| §32 one package = one workspace | preserved validation counts | Covered |
| §34 manager manifest | D1 (out-of-tree manifest) | Covered (F-3) |
| §35 managed runtime layer | preserved derive; D4 wrapper rendering | Covered (F-2/F-7) |
| §36 state model (A6) | D6 (operation states, runtime labels) | Covered (F-8) |
| §37 hide/disable/uninstall | preserved transaction paths | Covered |
| §39 user data lifecycle | preserved (no delete path) | Covered |
| §40 host/client boundary | D9 re-lock | Covered |
| §41 pnpm safety | preserved (P-12) | Covered |
| §42/§43 transactions (A1/A2) | D8 (G-2/G-3/G-4) | Covered (F-4/F-6/F-10) |
| §44 last-known-good (A2) | D8 (restore + audit) | Covered (F-4) |
| §46 out-of-tree dependency boundary | D10 (content scan, files/exports baseline) | Covered |
| §52 P5 feature hot-plug | preserved + §21 M9 | Covered |
| §4/§5/§6 out-of-tree, npm package, DSH Plugin Manager (P0) | D1 + D10 | Covered (F-3) |
| §9 Strict Mode (C4) | D2 (three boundaries + honest limits) | Covered |
| §11 Workbench Contract | D2 | Covered |
| §13 compatibility scope | D2 | Covered |
| §14 Cordis Adapter (A5) | D3 | Covered |
| §15 Workbench Runtime Provider (B2/C2) | D4 (workbenchRuntime provider) | Covered (F-2/F-7) |
| §19 Feature Runtime Wrapper (C1) | D4 | Covered (F-7) |
| §33 manifest workbench-facing (C3) | D2 | Covered |
| §38 Manager disable vs uninstall | D4/D5 | Covered |
| §45 Strict Mode CI gate (A4) | D2 (CI ownership) | Covered |
| §48 P1 packaging baseline | D1/D10 | Covered |
| §49/§50/§51 P2/P3/P4 contract, adapter, provider | D2/D3/D4 | Covered |
| §53 P6 shell hot-plug | D5 + M3 | Covered (F-1) |
| §54 P7 real feature migration | §21 M9 | Covered |
| §55 P8 legacy removal | D12 | Covered |
| §7-seam root shell public extension point | D5 | Covered (F-1) |

### 3.3 Brief §56 Required Test Matrix

Every row has an executable anchor in the design (§22 and the M-step table): `npm pack`/no absolute path → M10 scan; fresh-profile Manager install → M10 chain; disable/re-enable Manager → M3/M7; disable/re-enable Script → M9; Feature imports Cordis → CI FAIL → M5; Feature depends on Cordis → CI FAIL → M5 (the out-of-tree Feature CI gate; the dependency boundary also runs in manager admission); unsupported contract version → M5; dispose releases side effects → M9; Manager surface crash → M3; external plugin not admitted → existing authorization matrix; Profile A vs B → M12; hide ≠ unload → existing transaction tests; disable ≠ delete package → existing; uninstall keeps user data → existing; Script→Board→Script state → existing shell tests; DSH→Script→DSH state → existing shell tests; install rollback failure → M1/M2; uninstall failure keeps ownership → M2. The rows marked "existing" map to tests whose mechanisms were re-verified in §2 (transaction.ts setHidden/setEnabled/uninstall, PageAppShell hidden model, authorizedProjection).

### 3.4 Brief §57 Definition of Done

All 22 DoD items map to anchors in the design's §22 acceptance table. Four items depend on decisions fixed in this review rather than on new architecture: "Manager Provider 消失 → Feature 子树自动失活" and "恢复 → 自动恢复" (D4 provider propagation, F-2 must hold), "Manager 不存在时 Native DSH 正常" (D5 fallback, F-1 must hold), and "Cordis API 调用集中在 Adapter" (D3, with the M6 grep gate). No DoD item is unmapped.

## 4. Findings

Severity: P0 = would break the stated guarantee (Native DSH always usable, no double occupant, boot after uninstall) or is self-contradictory; P1 = correctness gap in a P0/P1 decision or a contradiction between decisions; P2 = underspecification or evidence-path error that does not change the architecture.

### 4.1 P0

**F-1 — D5 root fallback double-occupancy and renderer contradiction.** Evidence: `packages/client/ui-slots/src/index.ts:706-712` seeds `root` as a built-in single seat; 812-815 throws on a second registration at the same priority; 837-844 throws when a registration declares an already-declared child key; 881-892 sorts winners by ascending priority with ties by registration order; `slots.ts:271-273` fail-loud when `root` has no registration. The design's D5 says ui-layout "registers into `page-app.shell.builtin` only when that seat is declared; when the declaration is absent it falls back to registering `AppFrame` into the built-in `root` seat", that "root keeps `kind: 'single'`; the fallback is a different registrant, never a second concurrent occupant", and in the same section that "the render layer (`RootOutlet`/root entry in `scoped-slots.tsx`) additionally carries an outer boundary: if the root entry (PageAppShell) abdicates after a crash, the boundary renders the Native DSH shell" — while its own alternatives (b) reject "renderer-level hardcoded fallback UI inside `ui-renderer`". Impact: as written the fallback can be the second occupant of the single `root` cell at the same priority and throw at register time (manager loads after the fallback, or a manager HMR reload), and the builtin-path AppFrame can hit the duplicate-children throw when the fallback still holds `sidebar`/`conversation`/`details`/`shell.overlay`; the renderer-boundary sentence contradicts the rejected alternative. Revision: D5 now specifies the fallback as a root registration at priority 1 (strictly worse than the manager's default 0) behind one subscription that yields to the builtin path, removes the renderer-level fallback sentence, and pins both load orders with M3 tests (§6, D5).

**F-2 — D4 wrapper rows become unresolvable after a manager uninstall and can fail boot.** Evidence: the design keeps the registry on manager uninstall (§38), the launcher derives the layer from the registry at every boot (`profile-runtime.ts:228-331`, `apps/cli/src/profile-boot.ts:282`), and the wrapper row names a module inside the manager package. The layer's name rules (`packages/boot/page-app-profile/src/layer.ts:46-67`) allow bare package specifiers, so a wrapper `name` is serializable; but when the manager package is uninstalled the Loader cannot resolve it and `loader.await()` rethrows startup errors (`vendor/cordis/src/fiber.ts:704-710`), failing boot — violating DoD "Manager 不存在时 Native DSH 正常" and brief §22. `deriveRoot` (`profile-runtime.ts:363-401`) has no wrapper-resolvability check. Impact: Native DSH unbootable after manager uninstall with a surviving registry. Revision: D4 now requires the derivation to omit any root whose wrapper module cannot resolve from the profile (folded into an omission reason with a `missing-manager` health label), and pins a boot-after-uninstall test (§6, D4).

### 4.2 P1

**F-3 — D1 × D11 contradiction: the Manager manifest declares `dsh.workspace`, which D11 refuses to install.** Evidence: D1 says the out-of-tree Manager manifest is "`dsh.bundle.patch` + `dsh.client` + `dsh.workspace`"; D11 classifies every package declaring `dsh.workspace` as a manager-only page app that is "never appended to `dsh.profile.bundles`", printing the Plugins → Workspace Apps diagnostic. `reconcilePlugins` (`apps/cli/src/plugin.ts:59-91`) promotes `dsh.bundle`-declaring dependencies into bundles — the only channel that makes an out-of-tree plugin compose at boot. The current in-tree manager packages declare no `dsh.workspace` (host manager manifest has no `dsh` key; client manager carries `dsh.client` only). Impact: under D1+D11 as written, `dsh plugin add <manager-package>` prints the diagnostic and never promotes the manager, so the manager cannot be installed at all. Revision: D1 now states the Manager manifest is `dsh.bundle.patch` + `dsh.client` and never `dsh.workspace`, so D11's classification can never catch the manager; D11 states the classification exemption follows from that (§6, D1/D11).

**F-4 — Empty expected-root hashes pollute the activation audit and D8's rollback audit.** Evidence: `transaction.ts:382-399` builds `expectedRoots` with `hash: ''`; the runtime audit (`profile-runtime.ts:728-730`) pushes any row whose `canonicalManagedRootHash(row.options) !== expected.hash` into `externallyOverridden` — with an empty hash every found row is reported overridden. The runtime's own spec computes real hashes (`packages/boot/app-boot/tests/profile-runtime.spec.ts:214`). The design's §20 "user patch overrides" row and D8's "rollback restores the layer and awaits its audit" inherit the polluted report; a real override is indistinguishable from a normal apply. Impact: the apply-time override signal is meaningless today, and D8's audit-await carries that defect forward. Revision: D8 now requires apply and restore to compute `canonicalManagedRootHash(record.rootRow)` (the validator already returns the composed root row) and never send empty hashes (§6, D8).

**F-5 — ack/graph handshake never proves convergence and can settle on any unrelated graph change.** Evidence: the activation request carries `graphRevision: staged.layer` (`transaction.ts:134-140`), i.e. the runtime-layer YAML document; the client graph rev is `shortHash(JSON.stringify(entries))` (`packages/client/modules/src/index.ts:414`); the client convergence wait compares `modules.manifest.rev === graphRevision` and also resolves on ANY rev change or after 30 s (`packages/client/ui-page-app-manager/src/client/apply.ts:102-118`). The two domains can never be equal, so the ack fires on the first unrelated graph mutation or the timeout, and `authorizedProjection` (`controller.ts:294-300`) compares `convergedRevision === activation.graphRevision` against the same mismatched token. Impact: an install can be acknowledged and published before the new package's graph rows actually converge; the design's §25 risk 3 names the race but not the mechanism. Revision: D8 now specifies that the request carries the Host graph rev after the generation (`clientModules.graph().rev`), the client waits for an exact rev match, and the ack echoes the request's rev so a stale or unrelated change cannot settle the gate (§6, D8).

**F-6 — journal overwrite without a guard; operator recovery runs without the shared lock and is not invoked at boot.** Evidence: `writePageAppJournal` (`packages/boot/page-app-profile/src/journal.ts:169-173`) has no existing-journal check, so a new transaction silently replaces a crashed transaction's journal, discarding its before-state hashes and recovery decision — violating the approved design's "Startup recovery reads the journal before accepting new mutations" (§16). `recoverPageAppTransaction` is called only from the operator `recover()` Remote (`packages/host/page-app-manager/src/index.ts:231-237`) and does not acquire `withPageAppProfileLock` (its docstring at `recovery.ts:17-19` claims the lock; the call site lacks it), so recovery's `pnpm install` convergence can overlap a concurrent manager transaction. Boot (`prepareManagerRuntimeLayer`) runs only orphan-lock recovery, never journal recovery. Impact: a crashed transaction can be silently overwritten, and recovery can race pnpm. Revision: D8 now requires (a) `withTransaction` to fail loud with `recovery-required` while a journal exists, (b) the operator `recover()` to run under `withPageAppProfileLock` (ownerKind `manager`), and (c) a stated decision that boot derives from the registry (tree-consistent) while the journal is resolved by the operator path — closing the approved design's "before accepting new mutations" guarantee through the guard rather than through boot-time auto-recovery (§6, D8).

**F-7 — D4 wrapper-to-Feature-rows relationship is ambiguous; host-side Feature loading is undefined.** Evidence: D4 says the renderer emits "one wrapper root row ... instead of the Feature's raw root row" and "the wrapper asks the Workbench Runtime to load the Feature module (via the existing client graph/HMR path, P-10)". §25 risk 4 covers only the client bundle path. The Feature contract today is one Managed Root whose subtree contains host and client rows; a replacement reading leaves Feature host code with no load path, while a parent reading (wrapper as the new top-level row, Feature rows as children) keeps host rows, `dsh.client` scanning, and per-row provenance working (`vendor/loader/src/index.ts:118-122`, `vendor/loader/src/config/entry.ts:92-95,253`). Impact: as written the mechanism cannot be implemented without a choice, and the parent form's Strict Mode consequence (Feature code still runs as Cordis plugin entries with full ctx access) is not stated. Revision: D4 now pins the parent form for v1 — the wrapper row is the top-level row, the Feature's composed rows mount as its children (host and client, each with its own entry and provenance), the wrapper gates the subtree on `workbenchRuntime`, and Strict Mode remains enforced at the admission/CI boundaries (D2) plus runtime isolation via provenance/closed projection (P-4/P-5); the replacement form stays deferred with §25 risk 4 widened to host loading (§6, D4).

### 4.3 P2

**F-8 — D6 label set has no DISPOSED mapping.** Evidence: `vendor/cordis/src/fiber.ts:147-154` defines `DISPOSED`; the design's label set is `pending | loading | active | failed | unloading` (D6 block). Impact: a disposed managed root has no label. Revision: D6 now maps `DISPOSED → failed` ("a disposed root is a failed root until the next generation") and notes the brief §36 snake_case names (`install_failed`/`remove_failed`/`recovery_required`) are satisfied by the projected kebab labels via the mapping table.

**F-9 — D11's lock wrap conflicts with the synchronous CLI.** Evidence: `runPlugin` is synchronous (`spawnSync`, returns an exit code, `apps/cli/src/plugin.ts:120-158`) while `withPageAppProfileLock` is promise-based (`lock.ts:72-121`). Impact: the D11 "wrap runPlugin's read → pnpm → reconcile sequence in the shared lock" needs a deliberate call-chain change; the design does not record it. Revision: D11 now states that `runPlugin` becomes async (or awaits the lock with explicit exit handling) and references the approved plan Task 13 restructure as required, not optional.

**F-10 — in-flight transactions are not tied to the manager fiber (audit B3 / design G-7).** Evidence: `PageAppLifecycle` has no dispose hook (`transaction.ts:88-99`); D8's cancellation flows from the client signal only, so a manager reload (HMR) mid-install leaves the transaction running under a half-dead manager. Impact: the orphan transaction keeps writing registry state and holding the lock until it finishes or the settle timeout fires. Revision: D8 now adds that the transaction's AbortSignal is additionally linked to the manager fiber lifetime (effect-owned disposer aborts the in-flight operation), with the settle timeout as the ack-wait backstop.

**F-11 — D2's "rejects the operation before pnpm runs" is inaccurate for the dependency boundary.** Evidence: the dependency boundary needs the installed `package.json`, which exists only after `pnpm add` (`stageAfterInstall`, `transaction.ts:297-338`). Impact: the wording promises a pre-pnpm rejection that is only true for the source-syntax/manifest preflight. Revision: D2 now distinguishes the pre-pnpm preflight (source syntax, manifest parse) from the post-staging dependency boundary, which rejects before any registry/ownership mutation (nothing owned changes, so nothing needs rollback).

**F-12 — §5 P-13 evidence path cites the wrong file.** Evidence: `SlotErrorBoundary`/`RootOutlet` live in `packages/client/ui-renderer/src/client/scoped-slots.tsx:317-380,853-889`, not `packages/client/ui-slots/src/index.ts`. Revision: §5 P-13 evidence corrected.

## 5. Contradiction / ambiguity resolutions

| Item | Resolution |
|---|---|
| Renderer-level fallback vs rejected alternative (inside D5) | Removed the renderer-boundary sentence; the priority-ordered fallback registration is the crash fallback (RootOutlet already renders the surviving winner; `scoped-slots.tsx:861-868` keeps the all-abdicated failure face) |
| D1 manifest (`dsh.workspace`) vs D11 classification | Manager manifest never declares `dsh.workspace`; classification keys off that block and can never catch the manager (F-3) |
| Launcher-owned layer vs provider dependency (R-5 recommendation) | Precise coexistence: the layer keeps composing wrapper rows from the registry; the wrapper's `workbenchRuntime` inject makes the subtree PENDING while the provider is gone; the layer is tree-consistent regardless, and wrapper rows are omitted when the manager package is unresolvable (F-2) |
| User decision R-2 | Locked: already approved 2026-08-22 (Workspace Apps / page-app identifiers); not an open question |
| User decision R-3 | Locked by the design: brief §33 delegates the field lock to P0 + Formal Design Spec; keep `dsh.workspace.schemaVersion` for v1, `workbench.*` rename is the v2 path (D2) |
| User decision R-4 | Retained as a true user decision: it reverses the user-approved 2026-08-22 no-wrapper contract; the design recommends the wrapper (parent form) in M7 but cannot lock it |
| User decision R-5 | Retained as a true user decision: the brief §17/§38 semantics conflict with the user-approved launcher-owned choice (audit C2); the design recommends provider propagation but the user must arbitrate |
| D8's "startup recovery decides" vs the actual call sites | Boot derives from the registry (tree-consistent) and never auto-runs journal recovery; new mutations are refused while a journal exists and the operator `recover()` (under the lock) resolves it (F-6) |

## 6. Design changes applied

The following revisions were applied to `2026-08-25-dsh-workspace-manager-architecture-optimization-design.md` in this pass (section → change):

| Section | Change |
|---|---|
| §5 P-13 | Evidence path corrected to `packages/client/ui-renderer/src/client/scoped-slots.tsx` (F-12) |
| §8 D1 | Manager manifest is `dsh.bundle.patch` + `dsh.client` and never `dsh.workspace`; manager disable is expressed as `disabled: true` on the manager row in the profile patch layer (no `dsh plugin` disable verb exists); install chain smoke covers that overlay path (F-3) |
| §9 D2 | Failure/cancellation wording distinguishes the pre-pnpm preflight from the post-staging dependency boundary (F-11); contract-version refusal stays a hard preflight error |
| §11 D4 | Wrapper pinned as the parent row (Feature rows mount as children with their own entries/provenance); wrapper-resolvability omission added to the safe-layer derivation with a `missing-manager` health label; boot-after-uninstall test added; Strict Mode consequence of the parent form stated; replacement form deferred (F-2, F-7) |
| §12 D5 | Fallback re-specified as a root registration at priority 1 behind one subscription that yields to the builtin path synchronously on the root-entries mutation (before child-declaration notification); renderer-level "outer boundary" sentence removed; M3 tests pin both load orders and a manager HMR cycle; no double occupant is possible because priorities differ and the fallback yields before the builtin AppFrame re-registers (F-1) |
| §13 D6 | `DISPOSED → failed` mapping added; brief §36 snake_case names mapped to the projected labels (F-8) |
| §15 D8 | Journal-exists refusal in `withTransaction`; operator `recover()` under the shared lock; boot keeps registry-derived composition with the journal resolved by the operator path; expected-root hashes computed from the validator's root row (never empty); ack handshake carries the Host graph rev and requires exact convergence; transaction signal linked to the manager fiber lifetime (F-4, F-5, F-6, F-10) |
| §18 D11 | `runPlugin` async restructure recorded as required (approved plan Task 13); classification exemption follows from the Manager manifest never declaring `dsh.workspace` (F-3, F-9) |
| §19 D12 | `watchUserPatches` removal criterion now explicitly covers the three spec files' test references (they must migrate to the `ProfileRuntime` watcher path) |
| §24 | R-2 and R-3 locked with the reasons; R-4 and R-5 remain user decisions (see §5) |
| §25 | Risk 3 sharpened to the rev-mismatch mechanism (F-5); risk 4 widened to host-side loading (F-7); risk 8 reworded to name M3's dual-order and HMR-cycle tests (F-1); risk 9 added for wrapper-resolvability on manager uninstall (F-2) |

## 7. Residual risks and implementation-time probes

1. **Typert disconnect-reject semantics** (design §25 risk 1): whether a browser disconnect rejects an in-flight Remote call so the D8 signal fires, or only aborts at the HTTP layer, is still unverified in `connection`/Gateway tests; the settle timeout is the deliberate backstop. M1 must pin the disconnect, cancel, and timeout paths.
2. **D5 transition DOM sequence**: the yield protocol's synchronous ordering (root-entries mutation before child-declaration notification, `ui-slots/src/index.ts:892-911`) must be proven by M3 tests in both load orders (manager before ui-layout and after) and across a manager HMR reload.
3. **Ack exact convergence**: D8 now requires the graph-rev handshake; the graph-frame vs `rebuilt`-frame interleaving proof (P-10) and a stale-ack rejection test are M1/M7 obligations.
4. **Wrapper host-side loading**: the parent form keeps host rows as Loader children, so the only remaining choice is how the wrapper hands `WorkbenchContext` to the Feature module; M7 must pick the injection face and prove the Feature's `dsh.client` row still enters the client graph with `ownerPackage` equal to the Feature package (P-4/P-5 must hold through the wrapper).
5. **pnpm version gate**: declared 11.7.0 here but 11.19.0 observed in the audit environment; the D10 gate must fail on either side of the pin and the CI pin must be verified, not assumed.
6. **Windows EBUSY/EPERM rollback cleanup**: bounded retries for profile-owned paths (approved plan Task 8) remain a Windows acceptance item (design §25 risk 6).
7. **Interim SPOF window**: until M3 lands, the manager row stays the only `root` occupant; accepted and mitigated by M3's early position in the order (design §25 risk 8).
8. **Pre-existing bundle-listed external packages before M4**: they remain rejected by admission (no auto-adoption); users must remove them via the original mechanism (brief §29).
9. **A bundled Cordis copy inside a Feature's lazy-CJS artifact** cannot be detected by the dependency or source boundaries; the honest limits of D2 already state this, and the authoring-preset gap (approved design §21) covers the mitigation.
10. **Journal guard semantics**: `withTransaction` failing loud while a journal exists changes the operator flow (recover first); the design pins it, but the Settings copy and diagnostics for this state are an M1/M8 implementation detail.

## 8. Verification results

Baseline: `git status --short --branch` shows `feature/workspace-apps` @ `e91e2c5bd1` with only the four 2026-08-25 spec files untracked; `git rev-parse --short HEAD` = `e91e2c5bd1`. All checks below were run on the FINAL state (self-review + design revisions applied).

| Check | Result | Attribution |
|---|---|---|
| `verify-md-links` (2040 files) | PASS | new and existing links resolve (self-review ⇄ design cross-link included) |
| `verify-md-wrap` (2003 files) | PASS | no hard-wrapped prose paragraphs |
| `verify-doc-budgets` (9 budgeted docs) | PASS | the spec files are unbudgeted; budgets unchanged |
| `git diff --check` (worktree and index) | PASS | no whitespace errors |
| `doc-typecheck` (all Markdown `ts` fences) | FAIL repo-wide | failures only in pre-existing files: `docs/superpowers/plans/2026-08-22-dsh-workspace-apps.md` and `packages/boot/page-app-profile/README.md`; none of the 2026-08-25 spec files (design, audit, gap matrix, self-review) has a failing block — the design's three `ts` fences compile |

The doc-typecheck red items are branch-existing (the 2026-08-22 plan and the page-app-profile README shipped before this round); this review introduces no new red item and does not modify those files.

## 9. Conclusion

The revised design is decision-complete and preserves the working implementation: no second lifecycle system, launcher-owned composition, registry authority, immutable provenance, closed projection, the shared lock, journaled transactions, and the keep-mounted surface model all survive unchanged. The findings changed the design's mechanism descriptions, not its architecture; the plan derived from this design must carry the M1/M3/M7 probes in §7 as first-class test obligations.
