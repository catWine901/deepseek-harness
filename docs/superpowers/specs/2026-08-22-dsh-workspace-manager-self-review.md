# DSH Workspace Manager Design Self-Review

- Status: Complete; user review approved
- Reviewed spec: `2026-08-22-dsh-workspace-manager-design.md`
- Baseline: `b150a551b8d465e31e418e1b2eaf5e79bbb7d28e` (`dsh-v0.1.1-rc.2`)
- Reviewer: Codex

## 1. Review method

The review compared every architecture claim with the updated checkout, the 17 open items in the supplied Memory, the repository and package AGENTS rules, the current architecture notes, and official React 18 guidance for state identity and external-store snapshots. DSH / Coding GLM-5.3 independently inspected the same revision and reviewed the draft without editing it.

## 2. Gate result

No P0 or unresolved P1 design finding remains. The user approved the recommended **Workspace Apps** terminology on 2026-08-22. No code implementation may begin until:

1. the approved design is converted into a writing-plans implementation plan;
2. Codex and DSH review that plan;
3. the user approves the plan for DSH execution.

## 3. Codex findings already resolved in the draft

### SR-01 — P0 — `Workspace` collides with an existing DSH domain

Latest DSH uses Workspace for directory/session grouping across Host, Client, wire types, and sidebar UI. The draft now uses `page-app` implementation terminology and leaves only the user-facing label for review.

### SR-02 — P1 — current profile boot cannot live-apply a third layer with acknowledgement

Only profile and home user patches are watched today. The draft now requires a launcher-owned profile runtime capability, inserts the manager layer between bundle and user layers, and makes successful transactional recomposition—not a file write—the commit acknowledgement.

### SR-03 — P1 — current browser module graph cannot add or remove packages live

The Host graph changes incrementally, but the SSE client ignores graph frames and the browser module table is fixed at construction. The draft now includes general Host graph broadcast, browser graph replacement, serialized Loader add/remove, and stale negative metadata invalidation.

### SR-04 — P1 — an ordinary slot does not prove manager ownership

Slot declarations authorize rendering but do not restrict registrants. The draft now requires immutable Loader-derived `ownerPackage` provenance and a registry-authorized closed projection. Unmatched contributions remain invisible and cannot be adopted.

### SR-05 — P1 — filesystem snapshots alone cannot roll back pnpm

pnpm mutates the profile manifest, lockfile, and `node_modules`. The draft now requires private before-state backups, inverse pnpm operations, manifest/lockfile restoration, and pnpm convergence, with a retained journal when rollback cannot finish.

### SR-06 — P1 — UI-entered local paths have no safe relative base

The draft now requires local picker results to be absolute and rejects ambiguous relative filesystem specs. Registry/Git specs may remain textual.

### SR-07 — P1 — source specs may contain credentials

The registry now persists only a redacted display and source kind. Credential-bearing URLs are rejected and secrets are not journaled or stored.

### SR-08 — P1 — copying an arbitrary bundle patch can change resolution semantics

The draft now restricts v1 managed roots to portable declarative insertions: no relative Loader module names and no `!!js` expressions. It also requires the primary package's direct dependency key, package name, client row, and page contribution to agree.

### SR-09 — P1 — management API readiness must not gate the DSH root

The manager root now depends only on the Slot service. Remote and registry readiness attach later, so management failure cannot prevent the built-in DSH page from rendering.

## 4. Coverage of the Memory's 17 open items

| Item | Design section | Result |
|---|---|---|
| Exact packages/files | §19 | Covered |
| Root seam | §6 | Covered |
| Slot name/kind | §6 | Covered |
| Non-managed contribution prevention | §7 | Covered by closed projection |
| Host API | §13 | Covered |
| Registry schema/path | §9 | Covered |
| Runtime layer path/order | §8–9 | Covered |
| Transaction rollback | §10, §16 | Covered |
| Profile identity | §8 | Covered |
| React subscription | §14 | Covered |
| Settings seam | §15 | Covered |
| Error boundary | §14, §16 | Covered |
| Duplicate handling | §7, §11 | Covered |
| Missing dependency recovery | §16 | Covered |
| Missing/corrupt runtime layer | §8, §16 | Covered |
| Hidden visited mounting | §4, §14 | Covered |
| Memory policy | §3, §14 | Covered: no v1 eviction |

## 5. Remaining user decision

R1 is the only product choice left: use **Workspace Apps** (recommended) or **Apps** as the user-facing label. Internal code uses page-app terminology either way.

## 6. DSH independent review

DSH reviewed the draft against `b150a551b8` and found no P0. Its four P1 findings and twelve P2 findings were resolved as follows:

| Finding | Resolution in Formal Spec |
|---|---|
| Disabled page incorrectly remained in rail | Disabled is rail-hidden and Settings-visible; the four-condition rail visibility rule is explicit. |
| pnpm rollback did not guarantee `node_modules` convergence | Every restore branch now runs profile-local `pnpm install` and treats a non-zero exit as recovery-required. |
| UI confirmation did not enforce mutation authority | Connection's existing privileged check is hoisted around the composite `/api` handler so it runs before Typert interceptor selection; every mutating page-app endpoint joins that loopback same-origin set. |
| Slot provenance mechanism was underspecified | §7 now uses the existing caller-context-bound `SlotRegistry` prototype method and Loader entry inheritance; runner-authored dynamic slots are explicitly ineligible. |
| `allowBuilds` treated as static validation | Moved to pnpm failure handling with exact-key diagnostics and no automatic policy edits. |
| Root id checked only inside registry | Validation now checks the effective base composition below the manager layer. |
| External package update could drift version | Added fail-closed `version-drift`. |
| CLI and manager could race pnpm | Both use one shared profile mutation lock; out-of-lock changes during a journal become recovery conflicts. |
| User-patch override detection had no owner | Launcher profile runtime compares effective entry identity/hash after each generation. |
| React subscription wording crossed layers | Components receive renderer-bound `use<Name>` hooks from a bare observable compartment. |
| Pre-boot recovery core ownership unclear | Added `@deepseek-ai/dsh-page-app-profile`, shared by profile boot and Host manager. |
| Activation acknowledgement target ambiguous | Events broadcast, but only the opaque initiating client instance may acknowledge. |
| Unproven `packages/client/web` change | Removed from expected change areas. |
| External build-preset gap omitted | Added an explicit v1 author contract and deferred published authoring preset. |
| Profile isolation E2E missing | Added a two-profile real-composition test. |
| Include rollback assumption unpinned | Added a first-step contract test for failed `entry.update` preserving the active tree. |
| Crash test wording implied real kill injection | Durable crash boundaries are verified through constructed journal/file states. |

DSH also confirmed that the selected root handoff, keyed surface, live Include layer, graph-reconciliation direction, Typert namespace, keep-mounted behavior, error-boundary reuse, CLI classification, and internal `page-app` naming all have viable seams in the latest source.

After the final privilege-gate correction, DSH rechecked the current file and confirmed that the check is now placed before Typert interceptor selection, the non-loopback route test is sufficient, no new issue was introduced, and no P0/P1 remains.

The implementation-plan review also made crash-lock takeover explicit: manager recovery requires a conclusively dead owner and either a matching journal token or the manager protocol's journal-absent safe boundary; a dead generic CLI lock remains an operator-repair condition. This closes the startup-recovery gap without weakening live contention.

## 7. Final self-review conclusion

The Formal Design Spec covers all 17 open items and all locked invariants. The user approved **Workspace Apps** for R1. No implementation code has been written; implementation remains gated on plan review and user approval.
