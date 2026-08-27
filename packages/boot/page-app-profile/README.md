# dsh-page-app-profile

English | [中文](README.zh.md)

Host-safe page-app profile core shared by the page-app manager and the `dsh` CLI: strict manifest/registry parsing, exact profile paths, deterministic runtime-layer serialization, journaled transactions, and the one shared profile mutation lock.

The package is profile-scoped and pure Host: it never infers the profile from process state, never touches pnpm, and exposes no browser surface. Profile boot imports it without depending on the page-app manager's Typert service package.

## Surface

```ts
import {
  parsePageAppManifest,
  readPageAppRegistry,
  renderPageAppRuntimeLayer,
  resolvePageAppProfilePaths,
  type ValidatedManagedRoot,
  withPageAppProfileLock,
} from '@deepseek-ai/dsh-page-app-profile'

declare const profileDir: string
declare const packageName: string
declare const parsedPackageJson: unknown
declare const roots: readonly ValidatedManagedRoot[]
declare const token: string

const paths = resolvePageAppProfilePaths(profileDir)
// directory: <profileDir>/.workspace-manager
// registry:  .../registry.json
// runtimeLayer: .../runtime-layer.yml
// journal:   .../transaction.json
// operationKey: .../operation.lock

const manifest = parsePageAppManifest(packageName, parsedPackageJson)
const registry = await readPageAppRegistry(profileDir)
const layer = renderPageAppRuntimeLayer(roots)

await withPageAppProfileLock(profileDir, { kind: 'manager', token }, async () => {
  // one mutation per profile: pnpm and owned-file writes stay under the lock
})
```

The contract, in the order the spec exploits it:

- **Strict v1 parsing fails closed** — unknown registry/journal schema versions, wrong types, unknown keys, duplicate package names/page ids/root entry ids, and credential-bearing source displays are all rejected; v1 never reads a newer format.
- **Credentials never persist** — a source spec embedding URL userinfo is rejected outright, and the persisted display strips userinfo as a second line of defense.
- **The registry is the sole ownership truth** — every returned object is deeply frozen (zod `readonly` at each nested level plus explicit freezing), entries come back in stable order (`order` ascending, then package name), and the atomic write re-validates the complete value before anything reaches disk.
- **The runtime layer is derived, never authoritative** — only enabled roots are inserted, sorted by package name for byte-identical output across equivalent input; `!!js` expressions, relative filesystem names, and non-builtin schemes are refused because the Loader dialect would otherwise evaluate them.
- **One shared profile mutation lock** — `operation.lock` is created with exclusive `wx` and 0600 mode inside a 0700 manager directory (narrowed on POSIX even when the directory already exists), recording schema version, owner kind, pid, opaque owner token, and acquisition timestamp; contenders serialize and release only the payload they own.
- **Startup recovery never guesses** — a dead `manager` lock whose token matches the journal is quarantined by exactly one recoverer: recovery claims form an append-only chain of `wx`-created generations per token (the legacy fixed-path claim counts as generation 0), and every recoverer validates the whole chain before acting — contiguous generations from 0, readable claims, and provably dead ancestors; a live, indeterminate, or unreadable tail fails closed, a provably dead tail is superseded by the next generation, and losers fail rather than proceed. A dead `manager` lock without a journal is safe to remove because no mutation precedes journal publication, and every other state — live pid, token mismatch, unreadable payload, indeterminate liveness, or any dead `plugin-cli` lock — fails closed for operator repair.
- **Journaled transactions are durable before mutation** — the journal records the lock owner token, the phase (`prepared` → `staged` → `committing`), and before-file sha256 hashes plus 0600 private backups; snapshot paths are manager-relative and cannot escape the profile directory.

## Standalone release boundary

The standalone Workspace Manager release inlines this package and `dsh-atomic-write` as manager-owned implementation. It also inlines only the source-authoritative `profile-runtime-bridge` helper subgraph needed to coordinate the public DSH 0.1.1-rc.2 watcher. That helper is not a second general app-boot runtime: the official `dsh-app-boot` package remains the Host fingerprint and native-capability seam, while Cordis and Include always come from the consuming DSH installation.

The resulting release has only `js-yaml` and `zod` as ordinary runtime dependencies. Cordis, Include, Typert, API Remotes, and the browser runtime packages remain peers and are never bundled into the manager.

## Model Experience

None, as this is a pure Host persistence primitive; nothing here reaches a model request.

#### KV Cache effect

None; nothing here enters a request prefix.

## Known Limitations and Deferred Work

- **Not crash-durable on its own** — atomic replacement and backups are not `fsync`-durable; the manager's transaction protocol (journal phases plus startup recovery) owns crash semantics.
- **Lock wait is fixed, not tunable** — contenders back off for a pnpm-sized deadline; recovery of a dead owner is an explicit startup step, never an implicit wait shortcut.
- **Quarantine and claim files are retained** — recovered dead locks stay under `<token>.quarantine` names, and the append-only recovery claim generations stay in place as forensic evidence; no automatic cleanup exists yet.
- **A malformed recovery chain needs manual repair** — recovery fails closed when the claim chain is discontinuous, has a malformed claim-like name or out-of-range generation, contains an unreadable claim, or buries a live or indeterminate ancestor; an operator must delete or fix the offending files.
- **Windows mode bits are not enforced** — the 0700 manager directory and 0600 private files rely on Windows ACLs; only POSIX paths are chmod-narrowed.
