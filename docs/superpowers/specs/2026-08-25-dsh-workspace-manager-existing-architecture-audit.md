# DSH Workspace Manager Existing Implementation Audit（P0 汇总）

- Status: 完成（供总协调会话汇总、Design Spec 修订与迁移规划裁决）
- 审计基线: `e91e2c5bd1`（`feature/workspace-apps` worktree，32 commits ahead of `master`，工作树干净）
- Master checkout: `b150a551b8`（`dsh-v0.1.1-rc.2`；该目录无任何 Workspace Manager 产品实现）
- Date: 2026-08-25
- 依据: 四路并发 P0 审计报告（Cordis/运行时、Out-of-Tree/打包安装、Root Shell/UI、Registry/ownership/事务/profile）+ 本会话对关键证据的代码复核（git status/rev-parse、git grep、grep、文件读取）
- 主规格: `DSH_Workspace_Manager_Architecture_Optimization_for_Codex.md`（§47 定义 20 个 P0 审计领域）
- 已批准基线文档: [2026-08-22-dsh-workspace-manager-design.md](2026-08-22-dsh-workspace-manager-design.md)、[2026-08-22-dsh-workspace-manager-self-review.md](2026-08-22-dsh-workspace-manager-self-review.md)、[../plans/2026-08-22-dsh-workspace-apps.md](../plans/2026-08-22-dsh-workspace-apps.md)

## 1. 审计对象勘误：实现位于 feature worktree，不在 master checkout

主规格 §0 要求"先审计当前实现"。仓库存在两个 checkout：用户指定根目录 `C:\AAA-workboard\DSH\deepseek-harness-source` 是 `master`（`b150a551b8`），其中不存在任何实现——全仓 grep `workspace_manager / Workbench / ManagedFeature / SurfaceHost / rootEntryId` 均无命中；`packages/workspace` 与 `packages/client/ui-workspace` 是 DSH 既有的"目录/会话分组"域（`ctx.workspaceRegistry`、`WorkspaceManager` 客户端类、`sidebar.workspaces` 席位），与待审计产品无关。

全部实现位于当前 feature worktree `C:\Users\17948\Documents\Codex\2026-08-22\c-aaa-workboard-pluging-dsh-codex\work\deepseek-harness-source`，分支 `feature/workspace-apps`（HEAD `e91e2c5bd1`，相对 `master` 32 个提交，工作树干净）。本审计所有文件与行号均指该 worktree 内文件；四路并发审计与本次复核一致以该分支为唯一审计对象。

产品命名：规范/产品语用 *Workspace Manager*，代码用 **page-app / Workspace Apps**（approved design spec §1 已锁定，避免与 DSH 既有 Workspace 域冲突）。主规格中 "Workbench Contract / contractVersion / Managed Feature Plugin / Strict Mode / Cordis Compatibility Adapter" 与实现中的 "page-app / `dsh.workspace.schemaVersion` / DSH Loader+Slot 契约 / 无 Adapter 层" 是术语与形态差异，见 §6 规范假设冲突。

## 2. 实现事实快照

实现为三个 in-tree monorepo 包（version 均为 `0.1.1-rc.2`，随 `dsh-v0.1.1-rc.2` 版本线发布）+ 五处 DSH Core 泛化 seam。

| 包 | 路径 | 角色 |
|---|---|---|
| `@deepseek-ai/dsh-page-app-profile` | `packages/boot/page-app-profile/` | Host-safe core：manifest/registry 解析、精确路径、确定性 runtime-layer 序列化、journal、共享 mutation lock；零 Cordis 依赖 |
| `@deepseek-ai/dsh-page-app-manager` | `packages/host/page-app-manager/` | Host 服务：`TypertRemoteService` 子类（ns `pageAppManager`）、事务、activation gate、recovery、pnpm executor |
| `@deepseek-ai/dsh-client-ui-page-app-manager` | `packages/client/ui-page-app-manager/` | 客户端：`PageAppShell`（Surface Host）、`PageAppRail`、`PageAppSettingsTab`、React-free controller |

DSH Core 泛化 seam：`packages/boot/app-boot/src/profile-runtime.ts`（`ProfileRuntime`，launcher-owned 重组 API）；`apps/cli/src/profile-boot.ts`（组合顺序）；`packages/client/runtime/src/client/slots.ts`（`ownerPackage` 不可变 provenance）；`packages/client/connection/src/privileged-methods.ts`（loopback 403 围栏）；`packages/client/hmr` + `packages/client/modules`（client graph 增删收敛）；`packages/client/ui-layout`（root 交接）；`packages/api/remotes`（Remote 装配）。

持久文件（每 profile）：`$DSH_HOME/profiles/<profile>/.workspace-manager/{registry.json, runtime-layer.yml, transaction.json, operation.lock}`（`packages/boot/page-app-profile/src/paths.ts:12-41`）。

组合顺序（`apps/cli/src/profile-boot.ts:178-186`）：bundle layers → manager runtime layer → profile `cordis.patch.yml` → home `cordis.patch.yml` → `--patch` overlays / telemetry。

注册面：`packages/bundle/web-app/cordis.patch.yml:198-199` 常驻 `ui-page-app-manager` 行（Host `page-app-manager` 行同文件）；`ui-page-app-manager` 拥有 built-in `root` seat（`packages/client/ui-page-app-manager/src/client/apply.ts:165-183`）；`ui-layout` 经 `ctx.slots.inject('page-app.shell.builtin', ...)` 挂 `AppFrame`（`packages/client/ui-layout/src/client/index.ts:130-147`），无 `root` 兜底注册。

## 3. 二十个审计领域（主规格 §47）

### 领域 1 — 所有 Cordis direct imports

- **状态**：Manager 侧合格；Feature 侧部分（静态面合格、隔离面缺 CI 门禁）
- **当前机制**：Manager 作为 DSH-native 插件允许 Cordis public API（§8A）；Host-safe core 与 Cordis 完全解耦；Feature 以 manifest 声明（`dsh.bundle.patch` + `dsh.workspace` + `dsh.client`）进入 Loader，源码不 import Cordis。
- **证据**：`packages/host/page-app-manager/src/index.ts:15-17` `import type { Context } from '@deepseek-ai/cordis'`、`Loader`（`cordis-plugin-loader`）、`applyEntryPatches`（`cordis-plugin-include`，index.ts:17 与 validation.ts:13 已复核）；`packages/boot/page-app-profile/src/**` 零 Cordis import（仅 node:fs/path/crypto、zod、js-yaml、`@deepseek-ai/dsh-atomic-write`）；`packages/extensions/cordis-client-runner/src/client/runtime.ts:356-380` `ctx.plugin(surface)` 动态包挂 runner child fiber。
- **影响**：Manager 侧无违规；Feature client bundle 被 Loader 挂载后是完整 Cordis plugin（可用 `ctx.effect/provide/inject`），运行时无强制隔离，Strict Mode（§9/§45）无工程门禁。
- **边界**：`@deepseek-ai/cordis` 是 vendor fork v4.0.1（`vendor/cordis/package.json`），为唯一 Cordis 依赖源；Feature 为外部 npm 包（已构建产物），manager 只能做 artifact/manifest 校验，源码级门禁对已构建包不适用。

### 领域 2 — ctx.effect / provide / plugin / inject 位置与归属层

- **状态**：合格
- **当前机制**：所有注册与副作用经 `ctx.effect` 挂在所属 fiber，disposer 链完整；Manager service 经 `ctx.reflect.provide` 注册，fiber unload 自动 unregister。
- **证据**：`packages/host/page-app-manager/src/index.ts:389` `export const inject = [PROFILE_RUNTIME_SERVICE, 'loader']`；index.ts:400-404 `apply(ctx)` → `new PageAppManager(ctx, { profileRuntime })` → `ctx.reflect.provide('pageAppManager')`；`packages/boot/app-boot/src/profile-runtime.ts:484-860` `class ProfileRuntime extends Service` + `states = new WeakMap` + `profileRuntimeControl`；`apps/cli/src/profile-boot.ts:225-263` `bootComposedProfile`；`packages/client/ui-page-app-manager/src/client/apply.ts:165-193` 两处 `ctx.effect`（locale、slots.register root + inject settings.tab + controller.start）；`packages/client/runtime/src/client/slots.ts:368-389` `_register` 从 caller fiber 的 Loader entry `entry.options.name` 派生 `ownerPackage`（strip `/client`；options.ownerPackage 永不读取，已复核）。
- **影响**：无；归属与清理语义正确。
- **边界**：`ownerPackage` 派生依赖 vendor `loader` 通过 `internal/plugin` 设置 `fiber.entry` 的既有机制，子 fiber/HMR reload 下的稳定性由 slots 域测试覆盖。

### 领域 3 — Loader / HMR direct calls

- **状态**：核心扩展点合格；legacy 路径残留（P8）
- **当前机制**：`ProfileRuntime` 是 launcher-owned 的唯一 live 重组成入口；client 侧 graph 增删走通用收敛路径，无 Manager 特判。
- **证据**：`packages/boot/app-boot/src/profile-runtime.ts:686-701` `applyGeneration` → `entry.update({ config: { ...includeConfig, patches } })` + `loader.await()`；profile-runtime.ts:557-612 `registerWatchPatches` → `loader.create` + `hmr.registerConfig`；`packages/client/hmr/src/client/index.ts:114-141,207-213` `reconcileGraph` → `loader.remove/create` + `modLoader.replaceGraph`；`packages/client/modules/src/client/system.ts:230-330` `replaceGraph` / `validateGraphOrder`（整图候选先验证后发布，环/自引用拒绝）；`packages/boot/app-boot/src/index.ts:253-286` `watchUserPatches` 存在但 `profile-boot` 已不再调用（死代码/兼容面）。
- **影响**：live 组合与热插拔机制可用；`watchUserPatches` 属 §55 P8 待清理项。
- **边界**：`entry.update` 的 transactional rollback 语义由 `packages/boot/app-boot/tests/include-rollback.spec.ts` 契约测试钉住（plan Task 0）。

### 领域 4 — 手工 Feature enable/disable cascade 与第二套 lifecycle graph

- **状态**：核心合格；CLI 侧缺失
- **当前机制**：无 `for feature in allFeatures: disable(feature)` 循环，无第二套 lifecycle graph；依赖传播委托 Cordis Loader/Include。
- **证据**：`packages/host/page-app-manager/src/transaction.ts:162-266` `setEnabled` / `setHidden` / `reorder` / `uninstall` 全部走 `withTransaction`（stage registry → 重生成 runtime layer → `applyManagerLayer` → publish）；transaction.ts:341-372 `stageFromRegistry` 只将 enabled 且 statically-valid 的 root 写入 layer；`packages/boot/app-boot/src/profile-runtime.ts:628-749` `applyManagerLayer` → `audit` 逐 root 校验 `FiberState.ACTIVE`；`apps/cli/src/plugin.ts` 与 master 零 diff（已复核）：无 `dsh.workspace` 分类、无共享 profile mutation lock。
- **影响**：Manager 内部生命周期正确；`dsh plugin add <workspace-pkg>` 会把含 `dsh.bundle` 的包并入 `dsh.profile.bundles`，与 Manager admission（validation.ts 拒绝 bundle-listed 包）冲突，用户被两套入口卡死。
- **边界**：CLI 分类与共享锁是 §17 显式要求，属 P1 缺口（lock.ts 已预留 `plugin-cli` ownerKind）。

### 领域 5 — Root/AppFrame 硬编码与挂载方式

- **状态**：风险
- **当前机制**：`ui-page-app-manager` 是 `root` seat 的唯一 occupant；`ui-layout` 的 `AppFrame` 只注册进 `page-app.shell.builtin`；`DSH / Agent` 是 rail 常量行。
- **证据**：`packages/client/ui-page-app-manager/src/client/apply.ts:165-183` `ctx.slots.register({ name: 'root', children: { 'page-app.shell.builtin': { single, root }, 'page-app.shell.surface': { keyed, root } } }, PageAppShell)`；`packages/client/ui-layout/src/client/index.ts:130-147` `ctx.slots.inject('page-app.shell.builtin', () => ctx.slots.register({ name: 'page-app.shell.builtin', children: { sidebar, conversation, details, shell.overlay } }, AppFrame))`（已复核）；`packages/bundle/web-app/cordis.patch.yml:198-199` `ui-page-app-manager` 行在 `ui-layout` 之前；`packages/client/ui-page-app-manager/src/client/PageAppRail.tsx:37,58` `DSH_ROW = { pageId: 'dsh', label: 'DSH / Agent', order: -1 }` 常量（锁定产品规则）。
- **影响**：Manager 行缺失时 `root` 无注册 → `renderSlot('root')` fail-loud（`packages/client/runtime/src/client/slots.ts:269-272`）与 `RootOutlet` throw `SlotAssemblyError`（`packages/client/ui-renderer/src/client/scoped-slots.tsx:867`）→ 整个客户端不可渲染；Manager 崩溃 → `data-slot-error="root"` 空白。违反 §17/§22/§53/§57 "Manager 不存在时 Native DSH ACTIVE"。
- **边界**：`slots.inject` 声明回归可重挂（re-enable 理论可行），但期间 UI 已空白，不能依赖刷新恢复。

### 领域 6 — DOM / CSS hacks

- **状态**：合格
- **当前机制**：可见性仅用 HTML `hidden` + CSS；无 fixed 注入、无 MutationObserver。
- **证据**：新包 grep `querySelector / appendChild / MutationObserver / createPortal / document.body / position:fixed` 无命中；`packages/client/ui-page-app-manager/src/client/PageAppShell.module.css:11-13` `.surface[hidden]{display:none}`；`PageAppRail.tsx:42` `onRailKeyDown` 的 `querySelectorAll('[data-page-app-rail-item]')` + `document.activeElement`（roving tabindex，局部作用域）。
- **影响**：无违规；状态保持的实现基础成立。
- **边界**：`ui-layout/src/client/theme-presenter.ts` 的 `document.body` 主题写入是 master 既有模式，非本域新增。

### 领域 7 — Feature 对 Sidebar UI implementation 的依赖

- **状态**：合格（低耦合）
- **当前机制**：rail 行只来自 controller 投影（registry rows：enabled && !hidden && eligible，order 排序）；Feature 无法注入 rail 项/标签。
- **证据**：`packages/client/ui-page-app-manager/src/client/PageAppShell.tsx:65-78` `railInjected`；`PageAppRail.tsx:21-30` props `{ pageId, label, order }`；`packages/client/ui-page-app-manager/src/client/contracts.ts:42-45` `PAGE_APP_SURFACE_SLOT = 'page-app.shell.surface'`、`PAGE_APP_DSH_PAGE = 'dsh'`。
- **影响**：无；单向依赖（Manager → Feature）。
- **边界**：契约未版本化（只有 manifest `schemaVersion=1`，无 Workbench Contract 包），见 §6。

### 领域 8 — Managed Registry 当前 schema

- **状态**：合格
- **当前机制**：`registry.json` 是唯一 ownership 权威；strict zod 解析、唯一性约束、原子写、凭据脱敏；损坏时保留原文并 fail-closed。
- **证据**：`packages/boot/page-app-profile/src/types.ts:33-50` `PageAppRegistryV1` / `PageAppRegistryEntry`（`packageName`、`source{kind,display}`、`resolvedVersion`、`page{id,name,description,defaultOrder,rootEntryId}`、`order/enabled/hidden/installedAt/updatedAt`，已复核）；`registry.ts:15-80` `parsePageAppRegistry`（拒绝未知版本/键、重复 package/page/root id、order 排序、逐层 freeze）；`registry.ts:90-100` `readPageAppRegistry`（缺失=null 空态、损坏=抛错绝不静默重写）；`registry.ts:112-116` `writePageAppRegistry`（唯一写路径，atomic 0600，写前全量重校验）；`manifest.ts:112-142` `assertPageAppSourceNoCredentials` / `parsePageAppSourceDisplay`。
- **影响**：无；Registry=SoT、Runtime 层派生、UI 投影的层级成立。
- **边界**：目录名 `.workspace-manager` 与内部 page-app 标识不一致（刻意兼容产品 brief，design spec §9 明示）。

### 领域 9 — Managed Runtime Layer 当前实现

- **状态**：合格
- **当前机制**：`runtime-layer.yml` 由 launcher 从 registry 确定性派生，只含 enabled 且 statically-valid 的 Managed Root；损坏可重建；永不成为 authority。
- **证据**：`packages/boot/page-app-profile/src/paths.ts:12-41`（已复核）；`packages/boot/app-boot/src/profile-runtime.ts:228-331` `deriveSafeRuntimeLayer` / `prepareManagerRuntimeLayer`（corrupt registry → 删 layer、保留 registry、报 `recoveryError`、roots fail-closed）；profile-runtime.ts:363-401 `deriveRoot`（missing-dependency/version-drift/invalid-manifest 的 root 被 omit，不自动重装/认领）；`packages/host/page-app-manager/src/transaction.ts:341-372` `stageFromRegistry`。
- **影响**：无；"Registry 丢失禁止扫描认领"（§35）成立。
- **边界**：组合顺序由 `apps/cli/src/profile-boot.ts` 单一代际函数统一 boot/watcher/manager 三条路径。

### 领域 10 — install / disable / uninstall 当前 lifecycle

- **状态**：部分 / 风险（三处失败点）
- **当前机制**：install 走 `pnpm add → resolve → validate → stage → applyRuntime（audit）→ activation gate → ack → publish → 删 journal`；disable 移除 layer 中的根（真卸载）；uninstall 先 disable/unload 再 `pnpm remove` 再删行。
- **证据**：`packages/host/page-app-manager/src/transaction.ts:110-151` `install`；transaction.ts:162-181 `setEnabled(false)`；transaction.ts:190-203 `setHidden`；transaction.ts:238-266 `uninstall`；`packages/host/page-app-manager/src/activation.ts:60-80` `awaitSettlement`（无超时，已复核）；`packages/host/page-app-manager/src/index.ts:156-159,167-170,198-201` `install/setEnabled/uninstall` 传入 `new AbortController().signal`（永不 abort；Remote 签名无 signal 参数，已复核 index.ts:158/169/200）。
- **影响**：① `applyRuntime` 成功而 publish 失败 → rollback 只恢复文件，live Include 树停在未提交层（树/盘不一致）；② 客户端断连后 ack 无限等待，`operation.lock` 被活进程长期持有（仅进程重启/15 分钟竞争超时兜底）；③ 客户端取消不达 Host。
- **边界**：hide 只改 registry 呈现位，不触碰 runtime layer；order 同。

### 领域 11 — package.json / dsh.bundle

- **状态**：合格（基座契约存在）
- **当前机制**：`dsh.bundle.patch` 是 package.json 键（指向 `cordis.patch.yml`），`dsh.client.{inject,platform,immediately,external}` 是客户端插件契约；三个新包遵循 in-repo 约定（`workspace:^` 依赖、`0.1.1-rc.2`、`publishConfig.access: public`）。
- **证据**：`packages/host/page-app-manager/package.json`、`packages/boot/page-app-profile/package.json`、`packages/client/ui-page-app-manager/package.json`（已复核 name/version）；`packages/bundle/base/package.json:36-40` `dsh.bundle.patch`；`packages/bundle/web-app/package.json:41-45`；`packages/client/modules/src/index.ts` 扫描 Loader 条目收集 `dsh.client`。
- **影响**：无；这是未来 out-of-tree Manager 包必须满足的正式 manifest 形态。
- **边界**：`workspace:^` 协议只限仓库内；独立仓库须正常 SemVer 范围。

### 领域 12 — Out-of-Tree 边界

- **状态**：缺失（§4 HARD REQUIREMENT 未满足）
- **当前机制**：实现为 in-tree monorepo 包（`packages/host/page-app-manager`、`packages/boot/page-app-profile`、`packages/client/ui-page-app-manager`）+ web-app bundle 常驻行；无独立仓库、无独立版本线、无独立发布。
- **证据**：`packages/bundle/web-app/cordis.patch.yml` roster 行（已复核 198-199）；git worktree list 显示 master 与 feature worktree 两处 checkout（本会话复核）。
- **影响**：§4/§5/§6 三个 HARD REQUIREMENT 在本轮交付前全部未满足；Manager 成为"官方 bundle 永久组成"的形态（对应 §16 点名的风险）。
- **边界**：新代码无 DSH private `internal/*` imports、无 monorepo-only 相对导入、无绝对路径（审计确认；ui-workspace 测试 fixture 中 4 处 `C:\` 非 src）。

### 领域 13 — npm pack 是否已经可用

- **状态**：部分（基座可用；对 out-of-tree Manager 不适用；内容级扫描缺失）
- **当前机制**：monorepo 发布管线 `pnpm pack` → tarball 校验 → `npm publish <tarball>`；校验 `workspace:` 残留、src/map、内部同版本 pin。
- **证据**：`scripts/release/pack.ts:27-35,38-60` `packMember` + `validatePayload`；`scripts/release/families.ts` `DshFamily.patterns` / `validatePayload`；`scripts/release/verify-packed-install.ts:70-119`；`scripts/publish-npm-baseline.ts:304-357,426-493`；`.github/workflows/release.yml:29-98`；`scripts/publication-payload.ts:33-55` 只检查 tarball 成员名（src/、`*.map`），**无内容级绝对路径扫描**（§56 首行测试无法被现有门禁证明）。
- **影响**：现有 dsh 家族包可 pack/publish（配置/CI 层面证实）；独立仓库需要自己的 SemVer/LICNESE/files/exports 基线（现有包 `exports["./src/*"]` vs `files` 不含 src 造成发布后悬空；LICENSE 文件仅根/vendor/native）。
- **边界**：本会话未实跑 pack/publish（只读审计）。

### 领域 14 — DSH Plugin Manager install 是否已经可用

- **状态**：部分（基座链可用；Manager 产品级安装链未建立）
- **当前机制**：`dsh plugin --profile <name> <pnpm args>` 是原始 pnpm 转发器，安装后按已装状态 reconcile `dsh.profile.bundles`；uninstall = `pnpm remove` + reconcile。
- **证据**：`apps/cli/src/plugin.ts:120-157` `runPlugin`；plugin.ts:59-91 `reconcilePlugins`；plugin.ts:104-112 `anchorPathSpec`；`apps/cli/tests/built-bin.e2e.ts:625-709`（path spec 已测；tarball/registry spec 未测）；`args.ts` 无 enable/disable 动词；`packages/boot/app-boot/src/profile.ts:152-168` `initProfile`（fresh web Profile 自带 base+web-app 模板层）。
- **影响**：基座链（pack → fresh Profile → plugin add → start）对 path spec 已证实；Manager 自身不是可安装插件（bundle 常驻行），§48 P1 链式 smoke 无对象。
- **边界**：基座无事务/回滚/恢复态（§42/§43 属产品层实现）；Profile 生成的 `pnpm-workspace.yaml`（hoisted、autoInstallPeers:false、默认无 allowBuilds）是隐式契约。

### 领域 15 — DSH private imports

- **状态**：合格（无违规）
- **当前机制**：新包只 import 本地相对（`.ts/.tsx`）与 `@deepseek-ai/dsh-*` 包说明符；`@deepseek-ai/cordis` 仅被 Host manager type/运行时使用。
- **证据**：三包 import 面审计无 `internal/*`、无绝对路径；`vendor/cordis/package.json` fork v4.0.1；`pnpm-workspace.yaml:27-29` overrides 用 `link:` 钉住 vendor fork。
- **影响**：无；out-of-tree 插件必须 peer 依赖 `@deepseek-ai/cordis`（fork API 可能偏离上游，由未来 Adapter 吸收）。
- **边界**：`@deepseek-ai/cordis` fork 的 Fiber/effect/inject/Loader await/HMR API 面与上游 cordis v4 语义逐点一致（域 3 审计核对过 vendor/cordis/src/fiber.ts 与 reflect.ts）。

### 领域 16 — unmanaged timer / listener / watcher

- **状态**：部分（1 个 unmanaged timer，P3）
- **当前机制**：除 `buildGraphWait` 的 `setInterval` 外，其余 timer/listener 均挂 disposer 链或 AbortSignal。
- **证据**：`packages/client/ui-page-app-manager/src/client/apply.ts:111` `setInterval`（100ms 轮询 `modules.manifest.rev`，30s 上限，resolve 时 clearInterval；controller 被 dispose 时不清除，已复核）；`activation.ts:60-80` `signal.addEventListener('abort')` 在 acknowledge/discard 时 removeEventListener；`executor.ts:59-85` `createPnpmExecutor`（execa `cancelSignal`）；`packages/boot/page-app-profile/src/lock.ts:28-121` `withPageAppProfileLock`（setTimeout 退避 + 15min deadline）。
- **影响**：controller dispose 后 interval 存活至 30s 超时自愈；违反 §20 "Hot-Plug 副作用规则" 的严格形式。
- **边界**：属低优先级（P3）；`awaitSettlement` 的 abort listener 已有清理。

### 领域 17 — Surface Error Boundary

- **状态**：部分 / 风险（per-surface 隔离合格；root SPOF、无 manager-owned failure surface）
- **当前机制**：每个 slot entry 独立 `SlotErrorBoundary`；keyed 单元格崩溃后 abdicate 为常驻 `data-slot-error` 空 div；`root` entry 崩溃/缺失无兜底。
- **证据**：`packages/client/ui-renderer/src/client/scoped-slots.tsx:317-380` `SlotErrorBoundary`（`getDerivedStateFromError` 重抛 `SlotAssemblyError` 或返回 `<div data-slot-error={slotKey}/>`，已复核 317/330）；scoped-slots.tsx:759-770 keyed dispatch `abdicate` → `deadCell()` 常驻；scoped-slots.tsx:854-888 `RootOutlet`（root 无注册 → throw `SlotAssemblyError`；全部 abdicated → `data-slot-error="root"` 空白，已复核 866-867）；`packages/client/runtime/src/client/slots.ts:269-272` `renderSlot('root')` fail-loud（已复核）；Manager 未订阅 `onEntryError`。
- **影响**：单 Feature Surface 崩溃被隔离（rail + DSH 可用）；Manager Shell（root entry）崩溃 = 整 UI 空白，无 Native DSH 回退；崩溃页永久死亡（无重试/remount 路径）。
- **边界**：`reportEntryError` abdicate 后注册仍在 ledger（controller 保持 eligible），框架与 DSH 可用——监督 seam 存在但未被 Manager 消费。

### 领域 18 — Profile isolation

- **状态**：部分（文件级隔离合格；双 profile e2e 缺失、CLI 锁缺失）
- **当前机制**：所有持久文件位于 `$DSH_HOME/profiles/<profile>/.workspace-manager/`；profile 身份来自 launcher 不可变快照。
- **证据**：`packages/boot/page-app-profile/src/paths.ts:33-41`（已复核）；`packages/boot/app-boot/src/profile-runtime.ts:47-52,826-829` `identity`（绝不从 cwd/browser 推断）；`lock.ts:72-121` 单 profile 单操作串行；`apps/web/tests` grep `workspace-apps` 0 命中（已复核）——无真实组合 e2e、无两 profile 用例；`apps/cli/src/plugin.ts` 不获取共享锁。
- **影响**：文件级隔离成立；CLI 与 manager 可并发改同一 profile 的 package.json/lockfile（journal snapshot 可能错过并发变更，恢复时 fail-closed，安全但不优雅）。
- **边界**：Manager 是 web-app bundle 常驻行，`manager state per profile` 退化为"仅 web profile 存在"。

### 领域 19 — runtime status model

- **状态**：部分
- **当前机制**：四维状态已实际分离——registry 持 package+presentation 持久位（`enabled/hidden`），journal 持 operation 相位，loader 事实派生 runtime 状态；`activePageId/visited` 是浏览器态不落盘。
- **证据**：`packages/host/page-app-manager/src/index.ts:64-85` `deriveHealth` 八态（`disabled/missing-dependency/version-drift/invalid-manifest/activation-failed/externally-overridden/ready`，已复核）；index.ts:84 `runtimeState = String(fiberState)` 数字（无 PENDING/LOADING/UNLOADING 语义标签，P3）；`packages/boot/page-app-profile/src/journal.ts:14-16,26` `PageAppJournalPhase = prepared|staged|committing`（已复核）；`packages/client/ui-page-app-manager/src/client/controller.ts:240-279` `rebuild` / `isSelectable`（presentation 决策：enabled && !hidden && eligible；失效回落 DSH）。
- **影响**：操作状态是隐式约定（journal 保留 = `recovery-required`，rollback 错误文本含 `managerState = recovery-required`，transaction.ts:450-454），无 `installing/install_failed/remove_failed` 显式字段；runtime 状态无细粒度标签。
- **边界**：§36 要求"至少拆成四维"，实现满足等价语义但非字面字段，可在 Design Spec 裁决。

### 领域 20 — rollback / recovery behavior

- **状态**：部分 / 风险（骨架合格；live Include 树复原缺失）
- **当前机制**：install/uninstall 先写 prepared journal（含锁 token 与 before-file hashes + 0600 私有 backups）再变更；失败回滚恢复文件 + profile-local `pnpm install` 收敛；收敛失败保留 journal → `recovery-required`；启动恢复以 registry 为 commit 标记做三态决策。
- **证据**：`packages/host/page-app-manager/src/transaction.ts:270-294` `withTransaction`（snapshot registry/layer/package.json/pnpm-lock.yaml + sha256 + .backup，journal 先于一切变更）；transaction.ts:420-456 `rollback`（恢复 backup + `pnpm install` 收敛）；`packages/host/page-app-manager/src/recovery.ts:68-134` `recoverPageAppTransaction`（registry 变且在 committing → 完成提交；未变 → 恢复 before-state + 收敛；相位矛盾 → fail-closed）；`packages/boot/page-app-profile/src/lock.ts:311-447` `recoverOrphanedPageAppLock`（claim chain + token 匹配 + quarantine 改名，单赢家）；**`ProfileRuntime.restoreManagerLayer` 定义于 `packages/boot/app-boot/src/profile-runtime.ts:640,857` 但 page-app-manager 全包零调用（已复核）**。
- **影响**：applyRuntime 成功而 publish/后续失败时，live Cordis 树与 acknowledged snapshot 停在未提交层，registry/文件已回滚——树/盘不一致直到重启或下次生成；违反 §44 last-known-good 与 design spec §10.1 step10 "restore the prior runtime composition"。
- **边界**：recovery 决策正确（registry 为 commit 标记、orphan lock 恢复单赢家、dead CLI lock 无 journal fail-closed 需人工修复）。

## 4. 已满足项（跨域核对通过）

1. 无第二套 lifecycle graph：Feature 生命周期全部委托 Cordis Loader/Include（`entry.update` + `loader.await` + fiber dispose），无手工级联。✓ §59.3
2. Registry 为 ownership 权威，runtime layer 为 derived：`runtime-layer.yml` 可从 registry 重建；registry 损坏 fail-closed 保留原文。✓ §28/§35
3. `ownerPackage` 不可伪造：`StoredEntry.ownerPackage` 由 caller fiber 的 Loader entry 派生，注册选项无法覆盖；`cordis-client-runner` 动态包贡献天然不 eligible。✓ §7/§30
4. client graph 通用收敛：graph 帧广播 + `replaceGraph` 原子验证 + 增删串行化，无 Manager 特判。✓ §12
5. 特权围栏 hoist：`PRIVILEGED_METHODS` 在 Typert interceptor 选择前做 loopback 检查，7 个 `pageAppManager/*` mutation 全部钉死，有 route 级测试（`api-request-trust.host.spec.ts`、`node-half.host.spec.ts`）。✓ §13/§40
6. 事务与恢复骨架：journal + backups + 共享锁 + orphan-lock claim-chain 恢复 + 收敛失败 → `recovery-required`。✓ §10/§16/§42/§43
7. Profile 文件级隔离：全部持久文件 profile-scoped。✓ §31
8. hide / disable / uninstall 语义区分完整：hide 不卸载、disable 真卸载且 registry 保留、uninstall 最后删 registry 行。✓ §37/§43
9. DSH/Agent fallback 在 Manager 存活时成立：`DSH_ROW` 永久第一行、DSH 页恒挂载（hidden 切换）、controller 自动回落。✓ §24/§25
10. 状态保持：visited 页 keep-mounted（HTML `hidden`，非卸载）；DSH 子树常挂载。✓ §26
11. Feature 静态面不 import Cordis：manifest 为声明式 patch；需 CI 固化（见缺口）。✓（部分）
12. no-scan-and-adopt：全包无"扫描全部插件"逻辑；Plugin Inventory 从未被读取。✓ §28/§29

## 5. 缺陷分类与 P0/P1 结论

### A. implementation drift（规范已要求、实现未完成或未接线）

| # | 级别 | 缺陷 | 证据 |
|---|---|---|---|
| A1 | P0 | install/事务 cancellation 未接线 + ack 无超时：Remote 签名无 `signal`，Host 传永不自 abort 的 `new AbortController().signal`，client `void signal`；`awaitSettlement` 无限等待 → 断线可永久挂锁 | index.ts:156-201、activation.ts:60-80、controller.ts:167-185 |
| A2 | P0/P1 | rollback 不恢复 live Include 树：`restoreManagerLayer` 存在但零调用；applyRuntime 成功后 publish 失败 → 树/盘不一致 | transaction.ts:420-456、profile-runtime.ts:640,857 |
| A3 | P1 | CLI 分类与共享锁未实现：`dsh.workspace` 包被 `reconcilePlugins` 并入 `dsh.profile.bundles`；`dsh plugin` 不获取共享锁 | apps/cli/src/plugin.ts（0 diff）、lock.ts（`plugin-cli` kind 已预留） |
| A4 | P2 | Strict Mode CI 门禁缺失：§45 source/dependency/admission 三道检查无 CI 实现 | 无门禁脚本 |
| A5 | P2 | Manager 侧 Cordis 调用未集中 Adapter：`applyEntryPatches`/loader 访问分散于 index/validation/transaction | index.ts:17,343、validation.ts:13,174 |
| A6 | P3 | `runtimeState` 以 `String(fiberState)` 数字暴露，无 PENDING/LOADING/UNLOADING 语义标签 | index.ts:84 |
| A7 | P3 | client `buildGraphWait` 的 `setInterval` 未入 disposer 链 | apply.ts:111 |

### B. architecture flaw（结构性风险）

| # | 级别 | 缺陷 | 证据 |
|---|---|---|---|
| B1 | P0 | Native DSH 渲染耦合 manager 的 seat 声明：root 单 occupant、ui-layout 无 root 兜底 → Manager 缺失/崩溃 = 整 Web shell 空白 | apply.ts:165-183、ui-layout/src/client/index.ts:130-147、slots.ts:269-272、scoped-slots.tsx:854-888 |
| B2 | P0/P1 | "Manager disabled → Feature PENDING" 语义未实现：runtime layer 是 launcher-owned，禁用 `page-app-manager` 插件行不令 Feature 失活（registry 驱动而非 Cordis provider dependency） | profile-runtime.ts:228-331、profile-boot.ts:178-186 |
| B3 | P1 | Manager 热替换时 in-flight 事务生命周期未定义：`PageAppLifecycle` 无 dispose 钩子，孤儿事务继续写 registry | transaction.ts:88-99 |
| B4 | P0/P1 | 实现形态 in-tree、Manager 为 bundle 常驻行：§4-6 HARD REQUIREMENT 未满足，Manager 不可独立 enable/disable/uninstall | web-app/cordis.patch.yml:198-199 |
| B5 | P1 | 崩溃页永久死亡 + 无 manager-owned failure surface：abdicate 一次性，无重试/恢复 UI | scoped-slots.tsx:759-770、apply.ts（未订阅 onEntryError） |

### C. spec assumption possibly wrong（规范假设与已批准设计/实现不符）

| # | 冲突 | 说明 |
|---|---|---|
| C1 | §11/§19/§59.1 Workbench Contract / Feature Runtime Wrapper / Adapter 兼容层 | approved design（2026-08-22 用户批准）锁定 contract v1 = bundle patch → 单 Loader root entry，无 wrapper、无 contract service；规范文本与已批准基线冲突，应以 approved design 为准或由用户重新裁决 |
| C2 | §38 Cordis 依赖传播作为 Manager 失效机制 | approved design §8.2 选择 launcher-owned runtime layer；二者机制不同，需用户在 Design Spec 修订中确认保留哪一种（审计倾向保留 launcher-owned，因已批准且实现完成） |
| C3 | §12/§33 `workbench.contractVersion` 字段命名 | 实现用 `dsh.workspace.schemaVersion=1`；规范 §33 自述"字段最终由 P0 + Formal Design Spec 锁定"——P0 应裁决字段名与 `supportedContractVersions` 存放处 |
| C4 | §45 Strict Mode 对已构建 npm 包的可实施性 | Feature 是外部 npm 包（已构建产物），源码级 import 检查只对源码仓库 CI 成立；坚持 Strict Mode 需 authoring preset（design spec §21 已自认缺失） |
| C5 | 术语 "Workspace Manager / Managed Feature" 与 DSH 既有 Workspace 域同名 | `packages/workspace`（`ctx.workspaceRegistry`）、`ui-workspace`、`WorkspaceManager` 客户端类是既有"目录/会话分组"域；page-app 命名已锁定，需在文档固化术语映射 |

## 6. 需其他域验证的接口

| 接口/边界 | 所在代码 | 需验证域 |
|---|---|---|
| Typert Gateway 断线是否 reject in-flight 调用 | connection/rpc-host.ts、gateway | 决定 A1 严重度（永久挂起 vs 自动回滚） |
| `slots.inject` 缺失声明时的行为（黑屏场景实机确认） | client/runtime/src/client/slots.ts:156-217 | Web boot/composition |
| web-app bundle roster 与 `window.__DSH_BOOT__` graph 装配 | apps/web、packages/bundle/web-app | 打包/安装链（P1） |
| `ProfileRuntime.applyManagerLayer/restoreManagerLayer` 与 Include `entry.update` 的事务性（A2 修复前提） | profile-runtime.ts:628-749、include-rollback.spec.ts | Boot/Profile 组合域 |
| `ctx.slots` 公共 API 形态被 Feature 直用 = Strict Mode 边界 | client/runtime/src/client/slots.ts | Feature 契约域（C1/C4） |
| `dsh-better-sidebar` 等已装第三方插件与新 rail 共存 | `~/.dsh/profiles/web/node_modules` | UI 共存 |

## 7. 建议迁移序列（仅建议，不执行）

1. **A1 取消接线 + ack 超时（P0）**：Remote 方法接受 `signal`（design spec §13 签名），client 断开 → Host abort；`awaitSettlement` 加 Host 超时并接线 rollback；补断线/取消/超时四路径测试。
2. **A2 rollback live 树复原（P0/P1）**：rollback 与 recovery 路径调用 `ProfileRuntime.restoreManagerLayer` 并 await audit；补 publish 失败、pnpm remove 失败、audit 失败的树/盘一致性断言。
3. **B4 拆包 + P1 Packaging Baseline（P0/P1）**：三个包转 out-of-tree 独立仓库（SemVer 1.0.0、LICENSE、files 仅 lib、exports 无 `./src/*`）；证明 pack → fresh Profile → `dsh plugin` install → start → disable → re-enable → uninstall 链；给 `scripts/publication-payload.ts` 补 tarball 内容级绝对路径扫描。
4. **A3 CLI 共存（P1）**：`apps/cli/src/plugin.ts` 识别 `dsh.workspace` → 输出 Plugins → Workspace Apps 指引、不并入 bundles；`runPlugin` 接入 `withPageAppProfileLock`（`plugin-cli` kind）。
5. **B1 Shell 兜底（P0）**：`ui-layout`（或独立 fallback）在 `page-app.shell.builtin` 缺席时注册 `root` 兜底；补"无 manager → Native DSH 可渲染"集成测试。
6. **B5 失败 surface（P1）**：Manager 订阅 `slots.onEntryError`，为 abdicated surface 渲染 manager-owned failure surface（含重试/卸载）。
7. **C1-C4 裁决（先于编码）**：把 launcher-owned 语义、无 wrapper 的 contract v1 形态、Manager disable 语义、字段命名显式写入 Design Spec 修订。
8. **P2+ 主航道**：Workbench Contract v1（P2）→ Cordis Adapter（P3）→ Workbench Runtime Provider（P4）→ Feature Hot-Plug 验证（P5）→ Shell Hot-Plug 验证（P6）→ 真实 Feature 迁移（P7）→ legacy 清理（P8，含 `watchUserPatches` 收窄/删除）。

## 8. 检查与证据

- 本会话复核命令：`git status --short --branch`（`feature/workspace-apps`、干净）、`git rev-parse --short HEAD`（`e91e2c5bd1`）、`git rev-list --count master..HEAD`（32）、`git worktree list`（master checkout `C:/AAA-workboard/DSH/deepseek-harness-source` 无实现）、`git diff master..HEAD -- apps/cli/src/plugin.ts`（空）、grep 复核 A1/A2/A6/A7/B1 与 registry/journal/paths/slots/privileged-methods 证据。
- 未修改任何代码、配置、既有文档；未提交；未执行发布。
- 本会话新增文件仅本审计与 Gap Matrix 两份（见文件头）；Markdown 链接/格式检查与 `git diff --check` 结果见 [2026-08-25-dsh-workspace-manager-gap-matrix.md](2026-08-25-dsh-workspace-manager-gap-matrix.md) 末尾。
