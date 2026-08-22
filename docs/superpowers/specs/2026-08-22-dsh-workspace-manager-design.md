# DSH Workspace Manager Formal Design Spec

- Status: Approved for implementation planning
- Baseline: `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e` (`dsh-v0.1.1-rc.2`)
- Date: 2026-08-22
- Implementation owner: DSH / Coding GLM-5.3
- Architecture and acceptance owner: Codex
- Final manual acceptance: User

## 1. Decision summary

Build a profile-scoped manager for full-page DSH extensions. A permanent far-left rail selects either the built-in DSH/Agent page or one manager-installed page app. The built-in DSH tree and every visited enabled page stay mounted while inactive; disabling or uninstalling performs a real Loader unload.

The manager reuses DSH profile dependencies, `dsh.bundle`, Cordis Loader, the client module graph, Typert Remote, slots, HMR, and existing error boundaries. It does not create a second plugin runtime, scan global plugins, or adopt packages installed outside the manager.

`Workspace` is already an unrelated DSH domain for directory/session grouping. To prevent collisions, implementation identifiers use `pageApp`, `page-app`, and `page-app.*`. The approved user-facing label is **Workspace Apps**, and the Settings location is **Plugins → Workspace Apps**.

## 2. Goals

1. Install, list, order, hide, enable, disable, and uninstall full-page extension packages for the active DSH profile.
2. Make the manager registry the sole ownership authority.
3. Keep the original DSH/Agent page permanently available and mounted.
4. Preserve local React state when switching among enabled pages.
5. Make disable and uninstall unload the complete managed Loader root on Host and Client.
6. Apply profile changes live without requiring a DSH restart.
7. Make installation and removal recoverable across errors, cancellation, and process crashes.
8. Keep all filesystem and pnpm mutations on Host.

## 3. Non-goals

- Marketplace, discovery catalog, ratings, or automatic update service.
- General management of every DSH plugin.
- Adoption of packages installed by `dsh plugin`, manual profile edits, or other tools.
- A security sandbox. Managed packages execute with the same cooperative trust assumptions as other installed DSH packages.
- Multiple pages from one package, partial-page widgets, or multiple Managed Roots.
- Deleting source directories, cleaning the pnpm global store, or broadening `allowBuilds`.
- v1 page eviction or memory-pressure unloading.

## 4. Locked product semantics

### 4.1 Page switching

- The permanent rail is outside every selectable page.
- Selecting a page replaces the entire surface to the right of the rail.
- `DSH / Agent` is a built-in fallback, not a registry row.
- The DSH page mounts at application start and is hidden, never unmounted, during page-app selection.
- A managed page mounts on first visit and remains mounted while enabled, even when inactive or hidden from the rail.
- Hiding an active page switches the visible page to DSH but retains the page subtree.
- Disabling or uninstalling removes the page from the visited set and unloads its Host and Client roots.

### 4.2 State meanings

| Operation | Rail entry | Host root | Client root | Visited React subtree | Package dependency |
|---|---:|---:|---:|---:|---:|
| Inactive | shown | loaded | loaded | mounted after first visit | installed |
| Hidden | hidden | loaded | loaded | mounted after first visit | installed |
| Disabled | hidden; visible in Settings | unloaded | unloaded | unmounted | installed |
| Uninstalled | absent | unloaded | unloaded | unmounted | removed |

`activePageId` and the visited set are browser-shell state. They are not written to the registry. Registry changes that invalidate the active selection fall back to DSH.

A managed rail item is visible only when ownership exists in the manager registry, the row is enabled, `hidden` is false, and the expected runtime contribution is registered. Disabled and unhealthy rows remain visible in Settings, not in the rail.

## 5. Terminology and manifest contract

The product may describe the feature as Workspace Apps. Code must not introduce another `Workspace`, `WorkspaceId`, `workspaceRegistry`, or `workspace.*` contract.

A managed package must contain:

```json
{
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web" },
    "workspace": {
      "schemaVersion": 1,
      "id": "example.page",
      "name": "Example",
      "description": "Example full-page app",
      "defaultOrder": 100,
      "rootEntryId": "example-page-root"
    }
  }
}
```

`dsh.workspace` remains the external manifest spelling required by the product brief. Internally it is parsed into `PageAppManifest`; it does not extend the existing DSH Workspace domain.

The bundle patch must compose over an empty entry list into exactly one top-level entry whose id equals `rootEntryId`. That entry is the Managed Root. It may contain any internal Host/Client group structure, but the manager treats it as one lifecycle unit.

For v1, the managed patch is a portable declarative insertion: Loader `name` values must be built-ins or bare package/subpath specifiers, not relative filesystem specifiers, and the patch may not contain `!!js` expressions. This makes the derived layer independent of the installed bundle patch's original directory and safely serializable.

## 6. Architecture decision

### 6.1 Selected approach: manager-owned outer shell

A new client UI package owns the existing built-in `root` slot and declares two child seats:

- `page-app.shell.builtin`: `single`, `root` scope; occupied by the current DSH `AppFrame`.
- `page-app.shell.surface`: `keyed`, `root` scope; managed packages contribute one page keyed by manifest id.

`ui-layout` stops registering `AppFrame` directly into `root`. It injects into `page-app.shell.builtin` and continues to declare and render its existing `sidebar`, `conversation`, `details`, and `shell.overlay` children. Because the manager always renders the built-in seat, all existing DSH child slots remain declared even while the DSH page is visually hidden.

The manager root registration depends only on the Slot service. Remote readiness, registry loading, and mutation controls attach through later effect-owned injections, so an unavailable management API cannot prevent the built-in DSH shell from rendering.

The outer `PageAppShell` renders the built-in seat plus every visited, enabled, authorized page in stable React positions. Visibility changes use the HTML `hidden` state and CSS; they do not conditionally remove the subtrees.

### 6.2 Rejected alternatives

1. **Add the rail inside `ui-layout`.** This leaks extension ownership into the generic three-column DSH layout and makes the existing layout responsible for package lifecycle and registry state.
2. **Wrap `root` in `ui-renderer` or the web kernel.** The renderer is intentionally limited to rendering the single root slot. Composing product UI outside that slot violates the current client architecture.
3. **Use `cordis-host-runner` / `cordis-client-runner`.** Those packages run process-local, model-authored closures. They are non-persistent and do not own pnpm, profiles, or `dsh.bundle`; they are not an installed-package manager.

## 7. Ownership and render authorization

Slot declaration is render authority, not registration authorization. The manager therefore uses a closed projection:

1. Extend slot entry provenance with an immutable `ownerPackage`, derived by the Slot Registry from the caller's Loader entry. A registrant cannot supply or overwrite it.
2. A managed contribution is eligible only when all are true:
   - its slot key equals the manifest page id;
   - its immutable `ownerPackage` equals the registry row's package name;
   - that registry row is enabled;
   - the current pending activation, if any, names the same package, page id, and revision.
3. The shell ignores and diagnoses every unmatched contribution. It never displays or adopts it.
4. Duplicate page ids, package names, or Managed Root ids are rejected before the runtime layer changes.

This preserves the repository's single `ctx.slots.register()` composition path while making the manager registry the sole acceptance authority.

The mechanism uses the existing runtime Slot service proxy, not a new registration API. `SlotRegistry.register` remains a prototype method, so Cordis binds `this.ctx` to the caller's context and its existing `ctx.effect` already belongs to the caller fiber. `_register` reads that caller fiber's inherited Loader entry and derives the package name from `entry.options.name`, normalizing a trailing `/client`. The public options type no longer accepts writable provenance. Child fibers inherit the same Loader entry. A contribution created by `cordis-client-runner` is therefore attributed to the runner entry and is naturally ineligible unless that runner package itself is registry-owned, which the static contract forbids.

## 8. Host packages and services

### 8.1 `@deepseek-ai/dsh-page-app-manager`

A new Host service owns:

- manifest and bundle validation;
- registry reads and atomic writes;
- one-operation-at-a-time transaction control;
- pnpm child-process execution in the active profile;
- deterministic runtime-layer generation;
- activation and unload reconciliation;
- Typert Remote methods and change events;
- recovery-state projection.

The service receives immutable active-profile identity from a launcher-owned context service. It never infers the profile from process cwd or a browser argument.

Schema parsing, paths, deterministic layer generation, journal formats, and the shared profile mutation lock live in a separate Host-safe core package. Profile boot imports that core without depending on the Typert service package.

### 8.2 Launcher profile composition capability

`profile-boot` provides an immutable profile snapshot containing profile name and absolute directory. It also owns the complete live patch composition.

The patch order becomes:

1. shipped and profile bundle layers;
2. manager runtime layer;
3. profile `cordis.patch.yml`;
4. home `cordis.patch.yml`;
5. launcher overlays and telemetry.

The runtime layer participates in the same transactional Include update used by existing live user patches. The manager can await a successful generation or receive the activation error; filesystem observation alone is not treated as a commit acknowledgement.

Before initial composition, profile boot rebuilds a missing or corrupt runtime layer from a valid registry. If the registry is invalid, managed roots fail closed while base DSH boots and the manager exposes a recovery error. It does not silently rewrite the registry.

## 9. Persistent data

All files are profile-scoped:

- Registry: `$DSH_HOME/profiles/<profile>/.workspace-manager/registry.json`
- Derived runtime layer: `$DSH_HOME/profiles/<profile>/.workspace-manager/runtime-layer.yml`
- Active operation journal: `$DSH_HOME/profiles/<profile>/.workspace-manager/transaction.json`
- Exclusive operation lock: `$DSH_HOME/profiles/<profile>/.workspace-manager/operation.lock`

The directory name remains `.workspace-manager` for compatibility with the accepted product brief. New TypeScript and slot identifiers use page-app terminology.

Registry schema v1:

```ts
interface PageAppRegistryV1 {
  schemaVersion: 1
  revision: number
  entries: Array<{
    packageName: string
    source: {
      kind: 'registry' | 'file' | 'link' | 'tarball' | 'git'
      display: string
    }
    resolvedVersion: string
    page: {
      id: string
      name: string
      description: string
      defaultOrder: number
      rootEntryId: string
    }
    order: number
    enabled: boolean
    hidden: boolean
    installedAt: string
    updatedAt: string
  }>
}
```

Operational status is derived and is not persisted as ownership truth: `ready`, `disabled`, `missing-dependency`, `version-drift`, `invalid-manifest`, `activation-failed`, `externally-overridden`, or `recovery-required`.

The runtime layer contains only deterministic insertions of enabled, statically valid Managed Roots. It is never edited as an authority.

## 10. Install and lifecycle transactions

Only one mutation runs per profile. The manager and `dsh plugin` acquire the same shared profile mutation lock before invoking pnpm, so the two mutation paths cannot race. Each manager operation writes a journal plus private backup files containing the prior registry, runtime layer, profile manifest, lockfile presence/content, and integrity hashes before mutating anything. The registry stores a redacted source display only; credentials embedded in a URL are rejected and are never persisted.

The lock is created exclusively at `operation.lock` and records owner kind, process id, and an opaque owner token. A manager transaction stores the same token in its journal before any mutation. Startup recovery may atomically rename a dead manager lock to a token-specific quarantine name when its token matches the journal, then must win a fresh exclusive lock acquisition before recovery. A dead manager lock without a journal is safe only because no mutation may precede journal publication and the journal is removed only after commit. A dead generic `dsh plugin` lock without a journal fails closed for operator repair because pnpm may have stopped mid-mutation. A live process, token mismatch, unreadable lock, or indeterminate liveness fails closed; file age alone never authorizes lock removal.

### 10.1 Install

1. Validate source syntax and acquire the profile lock.
2. Snapshot owned files and write the prepared journal.
3. Run profile-local `pnpm add` with the exact validated source spec. Registry and Git specs may be typed; local directory, `file:`, `link:`, and tarball sources must come from the picker as absolute paths. Ambiguous relative filesystem specs are rejected rather than resolved against Host cwd.
4. Resolve the actual package name and installed version.
5. Perform static validation.
6. Stage the next registry and derived runtime layer.
7. Apply the runtime layer through transactional profile recomposition and wait for Host root activation.
8. Announce a pending client activation, targeted by an opaque client-instance id supplied with the install request. Every connected browser may reconcile the graph, but only the targeted initiating controller may acknowledge the transaction.
9. The first valid client acknowledgement wins. On acknowledgement, atomically publish the new registry, emit the committed snapshot, and remove the journal.
10. On any failure or cancellation, restore the prior runtime composition, run the inverse pnpm operation, restore the saved manifest and lockfile, and then run profile-local `pnpm install` to make `node_modules` converge to the restored files. A non-zero convergence exit makes rollback incomplete; retain the journal and expose `recovery-required`.

### 10.2 Enable

Enable follows steps 6–10 of install. It does not run pnpm unless the dependency is missing, in which case it refuses with a recovery state rather than guessing a source.

### 10.3 Disable

1. Stage the registry row as disabled and generate a runtime layer without its Managed Root.
2. Apply the layer and await Host unload.
3. Reconcile the browser graph; the Client Loader entry, slot contributions, styles, and visited subtree are disposed.
4. Publish the registry snapshot.

### 10.4 Uninstall

1. Perform the disable/unload sequence without publishing the final row yet.
2. Run profile-local `pnpm remove <actual-package-name>`.
3. Remove the registry row and publish the regenerated layer.
4. If pnpm removal fails, restore the previous runtime layer and registry. The manager never deletes the original local source or pnpm global-store content.

### 10.5 Hide and reorder

Hide and reorder change registry presentation only. They do not change the runtime layer and do not unload code.

## 11. Validation rules

Static validation rejects the operation unless:

- package.json is a valid object with a package name and version;
- the direct profile dependency key equals that package name; pnpm alias installs are rejected in v1;
- `dsh.bundle.patch` exists and resolves inside the installed package;
- `dsh.workspace.schemaVersion` is exactly `1`;
- every required workspace field has the required type and non-empty value;
- the bundle composes over an empty root with no ignored target patches or warnings;
- the result contains exactly one top-level root with id `rootEntryId`;
- the complete inserted tree is declarative, serializable, and contains no relative Loader module names or `!!js` expressions;
- page id, package name, and root id are unique in the manager registry;
- `rootEntryId` does not collide with any id in the effective base composition below the manager layer;
- the package was not already installed as an externally managed profile dependency or bundle;
- its client declaration and exported client artifact are valid for Web;
- the Managed Root contains exactly one active Loader row for that package's `dsh.client` entry;
- its dynamic `dsh.client.external` graph is resolvable and acyclic;

Runtime validation requires:

- the Managed Root reaches active Host state;
- the client graph publishes and loads the expected package revision;
- exactly one eligible `page-app.shell.surface` contribution appears;
- contribution key, immutable owner package, manifest page id, and pending transaction all match.

If pnpm refuses a Git or source build under `allowBuilds`, the operation fails before publication and returns the same exact-key diagnostic style as `dsh plugin`. The manager never edits or broadens `allowBuilds` automatically.

## 12. Client module graph changes

Live install/uninstall requires a general graph-reconciliation path, not manager-specific script injection.

1. The Host HMR endpoint broadcasts a fresh `graph` frame when client rows are added or removed. Existing `rebuilt` frames continue to own same-package content reloads.
2. `ClientModuleSystem` gains a validated graph-replacement operation that updates row metadata and returns added and removed package ids.
3. Client HMR serializes graph changes with rebuilds:
   - remove Loader entries before invalidating removed factories and styles;
   - register added graph rows before creating Loader entries in graph order;
   - keep unchanged entries and React state intact.
4. The Node `ClientModuleRegistry` invalidates stale negative package metadata when a Loader package appears after profile installation.
5. A graph change that cannot compose leaves the last valid graph active and reports the package failure; it does not partially publish a broken graph.

## 13. Remote API and events

The Host service extends `TypertRemoteService` under namespace `pageAppManager`. API Remotes explicitly mounts its generated contribution.

Required methods:

- `list()`
- `install(clientInstanceId, sourceSpec, signal)`
- `setEnabled(pageId, enabled, signal)`
- `setHidden(pageId, hidden)`
- `reorder(pageIds)`
- `uninstall(pageId, signal)`
- `ackClientActivation(clientInstanceId, transactionId, result)`
- `recover()`

Forwarded events:

- `page-app-manager/changed`: committed registry revision changed;
- `page-app-manager/activation-requested`: broadcast to connected clients with the target client-instance id; all may reconcile, but only the target may acknowledge.

Mutations execute only on Host and validate the active profile, registry revision, transaction ownership, client-instance binding, and exact package identity inside the operation that performs the mutation. Today Connection checks `PRIVILEGED_METHODS` only inside the legacy fallback, after a Typert interceptor may already claim the request. The implementation must hoist that exact-name check around the complete shared `/api` handler, before interceptor selection, and add every mutating `pageAppManager/*` endpoint to the set. The transport then rejects non-loopback or cross-origin requests before Gateway dispatch and before any Host mutation or pnpm spawn. This restriction is enforced at dispatch, not only by UI affordances. Read-only listing and state events retain the ordinary trusted-host policy.

## 14. Client state and React contract

A React-free controller owns remote calls, cached immutable snapshots, slot-ledger projection, and activation acknowledgement. Components receive a bare `HostObservable` through the slot inject `hooks` compartment; the renderer binds it to a `use<Name>` hook. Business components do not import or call subscription machinery.

- `getSnapshot()` returns the same immutable object until the registry revision or eligible slot ledger changes.
- subscription functions are stable and effect-owned.
- business components do not create Cordis subscriptions.
- page components retain identity through stable page ids and stable render positions.
- unvisited pages do not mount.
- no v1 eviction policy exists.

The existing slot error boundary isolates render crashes. If an active contribution abdicates after a crash, the shell shows a manager-owned failure surface and keeps the rail and DSH fallback usable.

## 15. Settings integration

The client manager contributes one lazy `settings.plugins.tab` entry. It does not modify the Plugins tab owner.

The page contains:

- active profile identity;
- install-source input and local picker entry;
- registry rows with enabled, hidden, order, version, source, and derived health;
- enable/disable, show/hide, reorder, uninstall, and recovery actions;
- explicit operation progress and rollback/recovery errors.

Plugin Inventory remains a read-only diagnostic tab. It is never joined with or used to reconstruct manager ownership.

## 16. Failure and recovery policy

- Registry valid, runtime layer missing/corrupt: regenerate the layer before composition.
- Registry corrupt: boot base DSH with no managed roots, preserve the corrupt registry, and expose recovery-required.
- Registry row dependency missing: omit that root from the safe derived layer and report `missing-dependency`; never auto-remove or auto-reinstall it.
- Installed version differs from the committed registry version: omit that root and report `version-drift`; require an explicit manager recovery/update decision rather than running newly changed code automatically.
- Host activation failure: transactional Include rollback, then pnpm/profile rollback.
- Client activation failure or request cancellation: Host rollback; retain a journal if any rollback step fails.
- Browser disconnect or caller cancellation after Host staging: the initiating controller aborts its cancellation-aware Remote call; the Host signal owns rollback. Startup journal recovery covers a process or transport failure that prevents delivery of that cancellation.
- User patch overrides a Managed Root: the launcher-owned profile runtime compares the effective composed entry against the derived root identity/hash after each generation and reports `externally-overridden`; the manager does not rewrite the user's patch.
- Runtime contribution mismatch or duplicate: refuse activation and rollback.
- Profile manifest or lockfile changes outside the shared mutation lock while a manager journal is active: stop publication and report a recovery conflict.

Startup recovery reads the journal before accepting new mutations. It compares recorded hashes with current files and either completes the recorded commit, restores the recorded before-state and runs profile-local `pnpm install` convergence, or reports a conflict requiring user action. It never guesses when both sides changed.

## 17. CLI coexistence

`dsh plugin` must acquire the shared profile mutation lock and classify packages declaring `dsh.workspace` as manager-only page apps. Its bundle reconciliation must not append them to `dsh.profile.bundles`. An externally invoked installation receives a diagnostic directing the user to Plugins → Workspace Apps; it is not adopted into the manager registry.

This prevents a later generic `dsh plugin update` from accidentally promoting manager dependencies into the global bundle layer.

## 18. Testing and acceptance

Implementation must be test-driven and include:

1. Pure tests for manifest parsing, one-root composition, registry schema, uniqueness, derived layer determinism, transaction journal recovery, and source anchoring.
2. Real Loader composition tests for live insert, failed activation rollback, disable unload, user-layer precedence, missing dependency safe boot, and corrupt-layer regeneration.
3. Client tests for immutable snapshot caching, origin filtering, first-visit mounting, hidden state preservation, disable unmount, fallback selection, render crash handling, and graph add/remove ordering.
4. Typert Host/Client tests for strict generated codecs, cancellation, stale revision refusal, and activation acknowledgement.
5. A real Web composition test that boots a test-only profile, installs a fixture page app, switches DSH → fixture → DSH, verifies state preservation, disables it, and proves Host and Client disposal.
6. A two-profile real-composition test: install in Profile A, prove absence in Profile B, then manage the same package independently in both profiles.
7. Product-visible keyless snapshots and accessibility checks for rail and Settings controls.
8. Existing DSH workspace/session behavior must remain unchanged.
9. A first-step contract test that proves failed Include `entry.update` retains the previously active tree before transaction code relies on that guarantee.
10. Crash recovery tests construct journals and file states at each commit boundary; real process-kill injection is not required when every durable crash point is represented.
11. Route-level authority tests prove a non-loopback request to every mutating `pageAppManager/*` Typert endpoint receives 403 before Gateway dispatch and before a pnpm executor can run.
12. Slot provenance tests cover a direct managed entry, an inherited child fiber, a fiber with no Loader entry, and a `cordis-client-runner` contribution.

Codex acceptance requires fresh test output, review of every changed file, no unresolved high-severity review findings, and evidence that the runtime was tested through a real profile composition. The user performs the final manual product test after Codex acceptance.

## 19. Expected change areas

The implementation plan will refine individual source filenames. Package ownership is fixed as follows:

- `packages/boot/page-app-profile` → `@deepseek-ai/dsh-page-app-profile`: Host-safe schema, paths, deterministic layer generation, journal formats, and shared profile mutation lock.
- `packages/host/page-app-manager` → `@deepseek-ai/dsh-page-app-manager`: Host service, transactions, Typert Remote, activation, and recovery orchestration.
- `packages/client/ui-page-app-manager` → `@deepseek-ai/dsh-client-ui-page-app-manager`: outer shell, rail, Settings tab, controller, and activation acknowledgement.
- `packages/boot/app-boot/src/profile-runtime.ts`: launcher-owned profile identity and live-composition contract, exported by `@deepseek-ai/dsh-app-boot`.

The design also expects changes in:

- new Host page-app manager package and generated Typert faces;
- new client UI page-app manager package;
- `apps/cli/src/profile-boot.ts` and launcher-owned profile context;
- `apps/cli/src/plugin.ts` classification;
- `packages/api/remotes` assembly and forwarded events;
- `packages/client/ui-layout` root handoff;
- `packages/client/runtime` / slot provenance;
- `packages/client/modules` and `packages/client/hmr` graph reconciliation;
- web-app bundle roster, package dependencies, TypeScript aggregates, docs, invariants, and tests.

## 20. Critical invariants

1. Only manager-installed packages appear as page apps.
2. External plugins remain invisible and are never adopted.
3. Registry ownership is authoritative; runtime layer and UI projections are derived.
4. One package exposes one page and one Managed Root.
5. All ownership and files are profile-scoped.
6. DSH/Agent is always available and mounted.
7. Switching and hiding do not unload enabled pages.
8. Disable and uninstall unload the Managed Root and visited React subtree.
9. Hide is not disable; disable is not uninstall.
10. Browser code never mutates filesystem or invokes pnpm directly.
11. Install and uninstall are journaled transactions.
12. Failure preserves either the prior committed state or an explicit recovery state.
13. A corrupt derived layer never becomes ownership truth.
14. No global scan, marketplace, source deletion, store cleanup, or automatic adoption occurs.
15. Existing DSH Workspace semantics and APIs remain untouched.

## 21. External author contract

v1 supports packages that ship an already-built DSH lazy-CJS client artifact and a valid `dsh.client` declaration. The repository's `clientBundle` preset is not currently published, so the manager does not promise an authoring toolchain for arbitrary npm packages. A fixture/example must document the required output contract; publishing a reusable build preset is follow-up work, not silently part of installation.

## 22. User-review decision

**R1 — user-facing terminology (approved 2026-08-22).** Use **Workspace Apps** and **Plugins → Workspace Apps**. It preserves the original intent while distinguishing full-page extensions from DSH's existing Workspace directory/session feature. Internal code uses page-app terminology.
