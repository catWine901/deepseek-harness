# DSH Workspace Manager Gap Matrix（优化规范 → 现状映射）

- Status: 完成（供总协调会话与 Design Spec 修订使用）
- 审计基线: `e91e2c5bd1`（`feature/workspace-apps` worktree）
- Date: 2026-08-25
- 依据: [2026-08-25-dsh-workspace-manager-existing-architecture-audit.md](2026-08-25-dsh-workspace-manager-existing-architecture-audit.md)（下称"审计"，领域 1-20 与缺陷 A1-A7/B1-B5/C1-C5 均指该文）+ 四路 P0 审计报告
- 主规格: `DSH_Workspace_Manager_Architecture_Optimization_for_Codex.md`（§4-§57）

## 1. 阅读说明

严重度：P0 = 阻塞 DoD 或破坏安全/一致性；P1 = 主要缺口；P2 = 中等；P3 = 低。

分类口径："已实现但需强化" = 该条目的核心机制存在且正确，但有明确的最小补齐面；"完全缺失" = 该条目的机制不存在或不可运行。部分满足的条目按其主体落表并在"现状"列注明。

两条硬规则贯穿全部条目：不修改 DSH Core 产品逻辑（只允许最小通用扩展点，§7）；Manager 不得实现第二套 npm/package manager 与第二套 lifecycle graph（§6/§51）。

## 2. 已实现但需强化（Implement → Harden）

| 主规格条目 | 现状（审计） | 必须保留的正确实现 | 需补齐的最小改动面 | 严重度 | 依赖 | 验收证据 |
|---|---|---|---|---|---|---|
| §7 Core 修改边界 | `ProfileRuntime` 是 launcher-owned 通用重组 seam（审计域 3）；root seat 无兜底 occupant（B1） | `applyManagerLayer`/audit 的 candidate→validate→commit；launcher 独占重组写路径 | `ui-layout`（或独立 fallback 包）在 `page-app.shell.builtin` 缺席时注册 `root` 兜底 | P0 | 无 | "无 manager 行 → Native DSH 可渲染"集成测试；P6 热插拔验证 |
| §8 两类插件区分 | Manager 是 DSH-native 插件（§8A 满足）；Feature 仅 manifest 声明、源码不 import Cordis（审计域 1） | Manager 侧 Cordis public API 使用；`dsh.bundle.patch` + `dsh.client` manifest 契约 | 无（静态面已满足）；运行时隔离面见 §9/§45 | P2 | §9/§45 | 现有 validation.spec.ts 18 项静态校验保持绿 |
| §12 Contract 版本化 | `dsh.workspace.schemaVersion=1` 存在且准入拒绝未知版本（审计域 8/11）；无 `supportedContractVersions` 显式声明 | strict zod 解析、未知版本 fail-closed | 裁决字段名（C3：`dsh.workspace.schemaVersion` vs `workbench.contractVersion`）与 `supportedContractVersions` 存放处，同步 validation/文档/CI | P1 | C3 裁决 | manifest.spec.ts 未知版本拒绝用例 |
| §16 Manager 可插拔 | Manager 是 web-app bundle 常驻行（B4）；`setEnabled` 仅作用于 Feature 行 | 现有 `PageAppLifecycle` 事务骨架 | Manager 自身拆为可安装包（随 §4-6）并定义 install/enable/disable/re-enable/uninstall 语义 | P0 | §4/§5/§6 | P1 链式 smoke（§48） |
| §17 Manager Hot-Plug 语义 | launcher-owned runtime layer：禁用 `page-app-manager` 插件行不会令 Feature 失活（B2，审计域 5）；依赖传播靠 registry 驱动而非 Cordis provider dependency | `stageFromRegistry` 只写 enabled 且 statically-valid 的 root；`deriveSafeRuntimeLayer` fail-closed | 在 Design Spec 修订中显式声明 launcher-owned 语义（两种 disable 语义：插件行 disable → runtime 保持 / Manager 内 setEnabled → runtime 卸载）；或按 C2 裁决改回 Cordis 依赖传播 | P0/P1 | C2 裁决 | 固化两种 disable 语义的测试（Manager 行禁用后 Feature 保持 ACTIVE 的断言） |
| §18 Feature 独立可插拔 | `setEnabled`/disable → 层移除该根 → Include update → Host+Client 卸载；hide/order 只改 registry（审计域 10） | 单根卸载路径、visited evict 语义 | CLI 互操作（A3）后补"disable Script 仅影响 Script 子树"集成验证 | P1 | A3 | P5 验证：单 Feature 拔插不影响无关 Feature |
| §20 Hot-Plug 副作用 | 除 `buildGraphWait` 的 `setInterval` 外全部 disposer/AbortSignal 化（A7，审计域 16） | `awaitSettlement` abort listener 清理；executor `cancelSignal` | `setInterval` 入 controller disposer 链 | P3 | 无 | controller dispose 后无残留 interval 的测试 |
| §21 故障传播边界 | 每个 slot entry 独立 `SlotErrorBoundary`（审计域 17）；单 Feature 崩溃被隔离 | `reportEntryError` abdicate 语义、rail+DSH 保持可用 | root 兜底（B1）+ manager-owned failure surface（B5：订阅 `onEntryError`，渲染失败面含重试/卸载） | P0/P1 | B1 | root 崩溃 → Native DSH 恢复；单 Surface 崩溃 → failure surface 可见 |
| §23 DSH Slot 生命周期复用 | `ctx.slots.register/inject` + caller-fiber 级联销毁 + `ownerPackage` 不可变 provenance（审计域 2/3） | `slots.inject` 声明回归重挂语义 | 无（机制已复用）；root 兜底不改变 slot 机制 | P2 | B1 | slots-service.client.spec.ts ownerPackage 用例 |
| §24 DSH/Agent Fallback | `DSH_ROW` 常量行 + DSH 页恒挂载 + controller 自动回落（审计域 5/10） | permanent-within-Manager 语义 | 无（Manager 存活时已满足）；Manager 消失场景由 B1 兜底 | P1 | B1 | rail/controller 既有测试保持绿 |
| §25/§26 状态保持 | DSH 子树与 visited 页均 hidden-not-unmounted（HTML `hidden` + CSS，审计域 6/10） | `SurfaceFrame` 稳定 keyed 位置 | 无 | P1 | 无 | shell.client.spec.tsx DOM 同一性断言（`toBe(first)`） |
| §27 Management-Domain Isolation | Manager 侧隔离完整（validation 拒绝外部 bundle/非 direct dep，审计域 8）；CLI 侧缺口（A3） | `validateInstalledPageAppPackage` 的 no-auto-adoption 检查 | `apps/cli/src/plugin.ts` 分类：`dsh.workspace` 包不入 bundles、输出 Plugins → Workspace Apps 指引、不认领 | P1 | 无 | CLI 分类 e2e：外部安装不污染管理域 |
| §28 Registry 为 ownership 权威 | `registry.json` strict zod + 原子写 + 损坏 fail-closed（审计域 8） | `writePageAppRegistry` 唯一写路径；corrupt 保留原文 | 无 | P1 | 无 | registry.spec.ts 保持绿 |
| §29 No Auto-Adoption | validation 拒绝非 profile 直接依赖与已存在外部 bundle（审计域 8） | 同上 | 无 | P1 | 无 | validation.spec.ts no-adoption 用例 |
| §30 Managed Surface Authorization | `authorizedProjection`：key + ownerPackage + enabled + activation 精确匹配（审计域 7/19） | 封闭投影、重复贡献诊断不投影 | 无 | P1 | 无 | authorization.client.spec.ts 矩阵用例 |
| §31 Profile Scope | 全部持久文件 profile-scoped（审计域 18）；identity 来自 launcher 不可变快照 | `resolvePageAppProfilePaths`；不推断 cwd/browser | 补双 profile 真实组合 e2e（§18.6） | P1 | 无 | Profile A 装 → B 的 registry/层/rail/settings 均无 |
| §32 One Package = One Workspace | validation 强制恰好 1 root + 1 client 行 + 三轴唯一（审计域 8） | `validateInstalledPageAppPackage` 计数检查 | 无 | P1 | 无 | validation.spec.ts 单包多页拒绝用例 |
| §34 Manager 自身 Manifest | `dsh.bundle.patch` + `dsh.client` + `dsh.workspace` 并存（审计域 11） | 三个键的既有契约 | 无 | P2 | 无 | verify-cordis-config 保持绿 |
| §35 Managed Runtime Layer | `runtime-layer.yml` 由 launcher 从 registry 确定性派生、可重建（审计域 9） | `deriveSafeRuntimeLayer` omit 不安全根、registry 权威 | 无 | P1 | 无 | layer.spec.ts 字节级确定性断言 |
| §36 State Model | 四维分离成立（registry 持 enabled/hidden、journal 持相位、loader 事实派生 runtime、浏览器态持 activePageId/visited，审计域 19）；`install_failed/remove_failed` 无显式字段、`runtimeState` 无标签（A6） | journal 相位严格单向 prepared→staged→committing；`recovery-required` 隐式约定 | 裁决"journal 相位即操作状态"是否够用；如不够，补持久 operation 状态字段；`runtimeState` 补 PENDING/LOADING/UNLOADING 标签映射 | P2/P3 | C 类裁决 | transaction/recovery spec 保持绿；新状态标签测试 |
| §37 Hide/Disable/Uninstall 区分 | `setHidden` 只改 registry；`setEnabled(false)` 真卸载；`uninstall` 最后删行（审计域 10） | 三个操作的既有顺序与语义 | 无 | P1 | 无 | transaction.spec.ts 三操作用例 |
| §39 用户数据生命周期 | 全生命周期无用户数据删除路径（审计域 10/20） | uninstall 只动 profile 依赖 + registry | 无 | P1 | 无 | uninstall e2e：用户数据保留 |
| §40 Host/Client 边界 | `PRIVILEGED_METHODS` loopback 403 在 Typert interceptor 选择前执行（审计域 15/18） | 7 个 `pageAppManager/*` 双拼写钉死 | 无 | P1 | 无 | api-request-trust.host.spec.ts 非 loopback 403 路由测试 |
| §41 pnpm/package 安全 | allowBuilds 拒绝不自动放宽；`file:`/`link:` uninstall 只移除引用；无 shell 拼接（审计域 10/20） | `createPnpmExecutor` arg 数组 + cancelSignal；`PageAppBuildPermissionError` | 无 | P1 | 无 | transaction.spec.ts allowBuilds 拒绝用例 |
| §42/§43 事务 | journal + backups + 共享锁 + rollback 收敛（审计域 20）；**rollback 不恢复 live Include 树（A2）、ack 无超时/取消未接线（A1）** | 事务骨架、registry 为 commit 标记、`recovery-required` 约定 | rollback/recovery 调用 `ProfileRuntime.restoreManagerLayer` 并 await audit；`awaitSettlement` 加 Host 超时；Remote 签名补 `signal` 并透传取消 | P0 | 无 | publish 失败/remove 失败/断线/audit 失败四路径树盘一致性断言；超时后锁可再获取 |
| §44 Last-Known-Good | `applyManagerLayer` candidate→validate→commit 成立；rollback 面缺失（A2） | audit 逐根 ACTIVE 校验 | 同 §42/§43 的 restoreManagerLayer 接线 | P0 | 无 | 同上 |
| §46 Out-of-Tree 依赖边界 | 新代码无 private imports/相对跨包导入/绝对路径（审计域 12/15）；`@deepseek-ai/cordis` fork 唯一 Cordis 入口 | 现状 import 面 | tarball 内容级绝对路径扫描（`scripts/publication-payload.ts`）；独立仓库 files/exports 基线（无 `./src/*` 悬空、含 LICENSE 文件） | P2 | §4/§5 | publication 基线 + `npm pack` 产物检查 |
| §52 P5 Feature Hot-Plug | 单 Feature enable/disable 走真实 Loader 卸载（审计域 10）；Manager 级挂起语义未实现（B2） | `setEnabled` 单根卸载路径 | B2 裁决后补 P5 场景验证（disable Script → 仅 Script 子树受影响） | P1 | C2 | P5 验证用例 |

## 3. 完全缺失（Missing）

| 主规格条目 | 现状 | 需补齐的最小改动面 | 严重度 | 依赖 | 验收证据 |
|---|---|---|---|---|---|
| §4 Out-of-Tree 独立仓库 | 三个包 in-tree monorepo（审计域 12，B4）；无独立仓库 | 建立 `dsh-workspace-manager` 独立仓库（package.json SemVer 1.0.0、README/CHANGELOG/LICENSE、files 仅 lib、exports 无 `./src/*`、peer 依赖 `@deepseek-ai/cordis` + 公开 `@deepseek-ai/dsh-*`） | P0 | 无 | `npm pack` 成功且产物无绝对路径（§56 首行） |
| §5 独立 npm Plugin Package | Manager 随 monorepo 版本线 `0.1.1-rc.2`，不可独立 publish（审计域 11/12） | 独立版本线 + `dsh.bundle.patch` + `dsh.client` manifest 保留 | P0 | §4 | `npm publish` 到 registry 后 tarball 可装 |
| §6 DSH Plugin Manager 安装（Manager 自身） | `dsh plugin` 基座链对 path spec 可用（审计域 14）；Manager 是 bundle 常驻行，无插件安装路径 | Manager 以包形式经 `dsh plugin --profile <name> add <manager-package>` 安装；不得实现第二套包管理器 | P0 | §4/§5、A3 | fresh Profile 安装 Manager 成功；disable/re-enable/uninstall 全链 |
| §9 Strict Mode | Feature 直接经 Cordis Loader 运行（client bundle 可用 `ctx.effect/provide/inject`）；无契约层、无 CI 门禁（审计域 1，C4） | 先裁决契约形态（C1/C4）：定义 Workbench Contract + 注册封装（`registerWorkspaceSurface()`），Feature 不再直连 `ctx.slots` | P0/P1 | C1/C4 | Feature import cordis → CI FAIL；Feature package 依赖 cordis → CI FAIL（§45/§56） |
| §11 Workbench Contract | 无 contract service/API；Feature 契约 = slot key 约定 + manifest（审计域 7，C1） | 定义 `WorkbenchContext` 最小面（lifecycle/surfaces/services/events/storage/host/project 按真实 Feature 需求裁剪），禁止机械改名 Cordis API | P1 | C1/C4 | `registerWorkspaceSurface()` 用例；unsupported contractVersion 拒绝 |
| §13 兼容承诺范围 | 无契约层对象；closed projection 只覆盖"manager 装的行"（审计域 7） | 随 §11 落地：兼容承诺只覆盖 Managed Feature → Workbench Contract | P1 | §11 | 外部插件注册类似 Surface 不进入 Managed Sidebar（§56） |
| §14 Cordis Compatibility Adapter | Manager 侧 `applyEntryPatches`/loader 访问分散（A5，审计域 3）；无 Adapter 层 | 抽 `adapter.ts` 收敛 Cordis 调用（canonicalManagedRootHash/applyEntryPatches/loader/FiberState）；行为不变 | P2 | §11 | 重构后既有 transaction/validation/recovery 测试保持绿 |
| §15 Workbench Runtime Provider | 无 `workbenchRuntime` capability；runtime layer 由 launcher-owned `ProfileRuntime` 驱动（B2/C2） | 裁决：保留 launcher-owned（推荐，已批准已实现）或引入 Manager provide 的 workbenchRuntime + Feature 依赖声明；删除 Manager 自维护全局级联算法（不存在，勿引入） | P0/P1 | C2 | Provider 消失 → Feature 子树 PENDING；恢复 → 自动 reload（§17/§38 语义固化） |
| §19 Feature Runtime Wrapper | Feature 是直接 Loader entry，无 wrapper（审计域 5，C1） | 若契约层落地则加 wrapper（Fiber → Feature Runtime Adapter → Feature Module → WorkbenchContext）；approved design 当前形态可维持 | P2 | §11/§14 | Feature dispose 后 timer/listener/watcher/service 全部释放（§56） |
| §33 Feature Manifest Workbench-facing | `dsh.workspace` manifest 存在（schemaVersion/id/name/description/defaultOrder/rootEntryId，审计域 8）；字段名与 §12 冲突（C3） | C3 裁决后定名并同步 validation/文档/CI | P1 | C3 | manifest.spec.ts 字段断言 |
| §38 Manager Disable vs Uninstall | Manager 无产品级 disable/uninstall（B4）；Feature 子树失活语义未实现（B2） | Manager 拆包后定义：disable = 保留包、Fiber 处置、Feature 子树 PENDING/inactive、Native DSH 可用；uninstall = deactivate + 保留 recoverable registry/用户数据 + 移除包 | P0/P1 | §4-6、C2 | disable Manager → Features PENDING；re-enable → 恢复；uninstall 后 Native DSH 正常（§56） |
| §45 Strict Mode CI Gate | 无 source/dependency/admission 三道门禁（A4，审计域 1） | CI 增加：Feature 源码 import cordis FAIL、package.json 依赖 cordis FAIL、admission 校验（workbench manifest/contractVersion/workspaceId/entry/ownership collision） | P1 | §9/§11 | 门禁脚本 + CI 红绿用例 |
| §48 P1 Packaging Baseline | 基座 pack/install 链对官方包可用（审计域 13/14）；无 Manager 对象、无链式 smoke | 补链式 smoke：pack → fresh Profile → plugin add → start → disable → re-enable → uninstall | P1 | §4-6 | 链式 e2e 全绿 |
| §49 P2 Workbench Contract v1 | 无 | 见 §11/§12/§33 | P1 | C1/C3 | contract 包测试 |
| §50 P3 Cordis Adapter | 无 | 见 §14 | P2 | §49 | 行为不变测试 |
| §51 P4 Workbench Runtime Provider | 无 | 见 §15 | P1 | §50 | Provider 依赖传播测试 |
| §53 P6 Shell Hot-Plug | `slots.inject` 声明回归可重挂，但期间 UI 空白、无 Manager 消失路径（B1，审计域 5） | root 兜底 + P6 验证：Manager ACTIVE → Workspace Shell；DISPOSED → Native DSH Shell；再 ACTIVE → 返回；不依赖刷新 | P0 | B1 | P6 热插拔 e2e |
| §54 P7 Real Feature Migration | 无真实 Feature 包（`packages/examples/page-app-fixture` 不存在；仅测试 fake `fake-page-app.client.ts`，审计域 7） | 至少迁移/构建一个真实 Feature（满足 §54 全链证明：不 import Cordis、用 Contract、安装、Sidebar、disable/re-enable/uninstall、Manager 挂起/恢复） | P1 | §11/§15 | §54 全链 e2e |
| §55 P8 Remove Legacy Runtime Paths | `watchUserPatches` 死代码残留（审计域 3）；无第二套 runtime 并存（有利点，勿破坏） | 收窄/删除 `watchUserPatches`；验证后清理 legacy 面 | P2 | 全部 P0/P1 完成 | 删除后 boot/config-reload 测试保持绿 |
| §7（seam 补充）Root Shell 公共扩展点 | 无通用外层壳扩展点；root 是隐式单 occupant 插槽（审计域 5） | 在 `root` 使用 chain/双 occupant 或渲染层保底（最小区分：Manager 壳与 Native DSH 解耦） | P0 | 无 | "无 manager → DSH 可渲染" + "Manager 崩溃 → DSH 恢复" 集成测试 |

## 4. §56 Required Test Matrix 映射

| 场景 | 现状 | 归属 |
|---|---|---|
| `npm pack` 成功、artifact 无绝对路径 | 基座部分（成员名级校验有，内容级扫描缺） | §46 补齐项 |
| fresh Profile 安装 Manager | 基座链对官方包可用；Manager 无插件安装路径 | §6/§48 |
| disable Manager → Native DSH 正常、Features PENDING | 未实现（Manager 是 bundle 行；launcher-owned 语义） | §17/§38/B2 |
| re-enable Manager → Features 自动恢复 | 未验证 | §38/B2 |
| disable Script → 仅 Script 子树受影响 | Manager 内机制存在（setEnabled 单根卸载） | §18/§52 |
| re-enable Script → 恢复 | 机制存在 | §18/§52 |
| Feature import Cordis → CI FAIL | 无门禁 | §45/A4 |
| Feature package 依赖 cordis → CI FAIL | 无门禁 | §45/A4 |
| unsupported Contract version → 拒绝 | `dsh.workspace.schemaVersion` 拒绝未知版本（字段名待裁决） | §12/C3 |
| Feature dispose → 全部副作用释放 | 机制存在；1 个 unmanaged timer（A7） | §20/A7 |
| Manager Surface crash → Native DSH 可恢复 | 未实现（root SPOF） | §21/B1 |
| external plugin 注册类似 Surface → 不进入 Managed Sidebar | 已实现（authorizedProjection + ownerPackage） | §30 |
| Profile A 安装 → Profile B 不可见 | 文件级成立；无 e2e | §31 |
| hide Feature → runtime 不卸载 | 已实现 | §37 |
| disable Feature → runtime 卸载、package 保留 | 已实现 | §37 |
| uninstall Feature → Profile dependency 移除、用户数据保留 | 已实现 | §37/§39 |
| Script → Board → Script 状态保留 | 已实现（visited keep-mounted） | §26 |
| DSH → Script → DSH 状态保留 | 已实现（hidden-not-unmounted） | §25 |
| install rollback 失败 → `recovery_required` 可见 | 已实现（journal 保留）；rollback live 树缺口（A2） | §42/§43/A2 |
| uninstall 失败 → ownership/recovery 信息保留 | 已实现（registry 最后删） | §43 |

## 5. §57 Definition of Done 对照

| DoD 条目 | 现状 | 主要证据/缺口 |
|---|---|---|
| Out-of-Tree 独立仓库 | ✗ | §4/B4 |
| 可 `npm pack` / publish | ✗（基座可，Manager 不可） | §5/§13 域 |
| 经 DSH Plugin Manager 安装到 fresh Profile | ✗ | §6/§48 |
| Manager 自身 enable/disable/re-enable/uninstall | ✗ | §16/§38 |
| Manager 不存在时 Native DSH 正常 | ✗（root SPOF） | §22/B1 |
| Feature 禁止直接依赖 Cordis | △（静态面满足，无 CI/契约） | §9/§45 |
| Workbench Contract v1 有明确版本 | ✗（仅 `dsh.workspace.schemaVersion`） | §11/§12 |
| Cordis API 调用集中在 Adapter | ✗ | §14/A5 |
| Feature 生命周期映射到 Cordis Fiber | ✓（直接 Loader entry） | 审计域 3 |
| Manager Provider 消失 → Feature 子树自动失活 | ✗（launcher-owned 语义差异） | §17/B2 |
| Manager Provider 恢复 → Feature 自动恢复 | ✗ | §17/B2 |
| 单 Feature 拔出不影响无关 Feature | ✓（机制存在，待 P5 验证） | §18 |
| Feature 副作用 dispose 后全部清理 | △（1 个 unmanaged timer） | §20/A7 |
| Managed Registry 是 ownership authority | ✓ | 审计域 8 |
| 外部插件不能绕过 Registry 进入 Sidebar | ✓ | 审计域 7 |
| Profile 隔离完整 | △（文件级 ✓，双 profile e2e 缺） | 审计域 18 |
| Hide/Disable/Uninstall 语义独立 | ✓ | 审计域 10 |
| install/uninstall 事务有 rollback/recovery | △（骨架 ✓，live 树复原缺） | 审计域 20/A2 |
| disable/uninstall 不删除用户项目数据 | ✓ | 审计域 10/20 |
| Original DSH Surface navigation state 保留 | ✓ | 审计域 6/10 |
| 已完成产品功能无无意回归 | △（无真实 Feature、无组装 e2e） | 审计域 18 |
| 不存在第二套与 Cordis 重叠的生命周期系统 | ✓（有利点，重构时勿破坏） | 审计域 4 |

## 6. 迁移依赖序与验收（与审计 §7 一致）

1. **P0 一致性修复（无依赖，可立即开工）**：A1 取消接线 + ack 超时；A2 rollback 调 `restoreManagerLayer`。验收：四路径树/盘一致性断言 + 锁可再获取。
2. **P0 Shell 兜底（依赖 1 可选）**：B1 root 兜底 + B5 failure surface。验收：无 manager → DSH 可渲染；root 崩溃 → DSH 恢复。
3. **P0/P1 交付形态（依赖 2 完成前可并行设计）**：B4 拆包 + §4-6（out-of-tree 仓库、独立 SemVer、DSH Plugin Manager 安装链）+ §46 包装基线（内容级绝对路径扫描）。验收：§48 链式 smoke 全绿。
4. **P1 CLI 共存**：A3 分类 + 共享锁。验收：`dsh plugin add <workspace-pkg>` 指引输出、不并入 bundles；与 manager 并发 pnpm 锁串行化。
5. **P1 契约层主航道（依赖 C1-C4 裁决）**：§11/§12/§33（Workbench Contract v1）→ §14（Adapter）→ §15/§51（Runtime Provider）→ §52/§54（P5/P7 验证）。验收：§56 门禁行与 P7 全链证明。
6. **P2 收尾**：§45 CI 门禁、§55 legacy 清理、双 profile e2e、状态标签（A6/A7）。验收：全量 DoD 对照转绿，`pnpm run test` / `test:gui` / `doc-sync` 等比例门禁通过。

## 7. 检查与证据

本文件与审计文件为本轮仅有的两个新增文件；未修改代码、配置、既有文档，未提交，未执行发布。Markdown 链接/格式检查与 `git diff --check` 结果在最终交付回复中报告（含全仓检查被既有问题阻塞时的最窄可行检查）。
