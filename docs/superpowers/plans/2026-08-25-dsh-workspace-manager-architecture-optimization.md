# DSH Workspace Manager Architecture Optimization Implementation Plan（2026-08-25）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development（逐任务实现 + 任务级审查）或 superpowers:executing-plans（批次执行 + checkpoint 审查）；多对话编排使用 superpowers:dispatching-parallel-agents 与 superpowers:using-git-worktrees。步骤使用复选框（- [ ]）跟踪；每个任务是独立的 red→green→refactor→commit 循环。

**Goal:** 在保留已实现 Workspace Apps 产品能力的前提下，把 DSH Workspace Manager 重构为 Out-of-Tree、可独立 npm 发布、可通过 DSH Plugin Manager 安装、可热插拔、并对 Managed Feature 提供版本化 Workbench Contract 的上游 Workbench Provider，同时修复审计确认的 P0 缺陷（root SPOF、rollback 不复原 live 树、取消未接线、ack 无超时）。

**Architecture:** 保留 launcher-owned runtime layer 与 registry 权威；新增 Cordis Adapter（D3，唯一理解 Cordis 的层）、Workbench Runtime provider `workbenchRuntime` + Feature Runtime Wrapper 父行（D4，provider 丢失→Feature PENDING）、ui-layout 双路径 root 兜底（D5，Manager 缺失→Native DSH 可渲染）、事务取消/超时/精确 ack/rollback live 树复原（D8）、CLI 共享锁与 `dsh.workspace` 分类（D11）、出树打包基线与 tarball 内容级扫描 + pnpm 版本门禁（D10）。

**Tech Stack:** TypeScript 6（erasableSyntaxOnly）、Node fs/process、Cordis 4.0.1（vendor fork `@deepseek-ai/cordis`）、Cordis Loader/Include/HMR、Typert Remote（支持 final `signal: AbortSignal`）、React 18、DSH slots/ui-layout、Vitest、Testing Library、pnpm 11.7.0（声明与门禁）、npm pack→publish tarball 链。

**Spec（设计基线，按此优先级裁决冲突）：**
- 主规格：C:/AAA-workboard/项目拓展计划/DSH_Workspace_Manager_Architecture_Optimization_for_Codex.md（2107 行，外部文件，仅作需求来源）
- Formal Design（修订后）：[2026-08-25-dsh-workspace-manager-architecture-optimization-design.md](../specs/2026-08-25-dsh-workspace-manager-architecture-optimization-design.md)（M0–M12、D1–D12 的最终裁决）
- Self-Review：[2026-08-25-dsh-workspace-manager-architecture-optimization-self-review.md](../specs/2026-08-25-dsh-workspace-manager-architecture-optimization-self-review.md)（F-1–F-12 修订来源）
- Audit：[2026-08-25-dsh-workspace-manager-existing-architecture-audit.md](../specs/2026-08-25-dsh-workspace-manager-existing-architecture-audit.md)（证据基线）
- Gap Matrix：[2026-08-25-dsh-workspace-manager-gap-matrix.md](../specs/2026-08-25-dsh-workspace-manager-gap-matrix.md)
- 已批准基线（仅作实现来源，冲突处 2026-08-25 文档优先）：[2026-08-22-dsh-workspace-manager-design.md](../specs/2026-08-22-dsh-workspace-manager-design.md)、[2026-08-22-dsh-workspace-manager-self-review.md](../specs/2026-08-22-dsh-workspace-manager-self-review.md)、[2026-08-22-dsh-workspace-apps.md](2026-08-22-dsh-workspace-apps.md)
- 仓库规则：[../../../AGENTS.md](../../../AGENTS.md)、[../../AGENTS.md](../../AGENTS.md)、[../../../packages/AGENTS.md](../../../packages/AGENTS.md)、[../../../packages/client/AGENTS.md](../../../packages/client/AGENTS.md)

---

## 0. 文档角色与执行模型

本文件是交付物 5（Implementation Plan），其输入是已审计、已自审修订的 Formal Design（2026-08-25）。执行顺序：P0 Audit → Gap Matrix → Formal Design → Self-Review → 本 Implementation Plan → TDD 迁移 → 验证（主规格 §60）。本文件只规定实现工作；本文件自身不修改代码、不执行包操作、不提交、不发布。

执行模型：4 个 DSH 对话（3 实现 + 1 集成/审查）在 4 个独立 git worktree 上并行；每个对话一个 lane，每个 lane 一个分支；跨 lane 依赖通过合并上游 lane 分支解决；每个批次结束由 Codex 审查 checkpoint；最终由用户做手工验收。任何对话不得越界写文件（§2.3 所有权表），不得提前合并，不得在 checkpoint 未过时推进下一批次。

## 1. 基线事实与全局约束

### 1.1 基线事实（以 2026-08-25 实测为准）

- 分支：`feature/workspace-apps`；实现/源码基线 HEAD：`e91e2c5bd1`（相对 master `b150a551b8` 32 commits）；M0 前由 D 把五份 2026-08-25 文档提交为 `DESIGN_BASELINE`（§3.2），此后工作树干净、无未跟踪文件；lane worktree 从 `DESIGN_BASELINE` 创建。
- 实现包（version 均 0.1.1-rc.2）：`@deepseek-ai/dsh-page-app-profile`（`packages/boot/page-app-profile/`）、`@deepseek-ai/dsh-page-app-manager`（`packages/host/page-app-manager/`）、`@deepseek-ai/dsh-client-ui-page-app-manager`（`packages/client/ui-page-app-manager/`）。
- 集成 seam（本轮会修改）：`packages/boot/app-boot/src/profile-runtime.ts`（`ProfileRuntime` 的 `applyManagerLayer`/`restoreManagerLayer`/`applyGeneration`/`audit`/`deriveSafeRuntimeLayer`/`prepareManagerRuntimeLayer`/`deriveRoot`）、`packages/boot/app-boot/src/index.ts`（`watchUserPatches` 死代码）、`apps/cli/src/profile-boot.ts`（`composeLivePatches`/`bootComposedProfile`）、`apps/cli/src/plugin.ts`（`runPlugin`/`reconcilePlugins`/`anchorPathSpec`）、`apps/cli/src/bin.ts`（`runPlugin` 同步调用点）、`packages/client/ui-layout/src/client/index.ts`（`ctx.slots.inject(page-app.shell.builtin, ...)`）、`packages/client/connection/src/privileged-methods.ts`（7 个 `pageAppManager/*` 端点，只读不改）。
- 持久文件（每 profile）：`$DSH_HOME/profiles/<profile>/.workspace-manager/{registry.json, runtime-layer.yml, transaction.json, operation.lock}`。
- 组合顺序：bundles → manager runtime layer → profile `cordis.patch.yml` → home `cordis.patch.yml` → `--patch` overlays/telemetry。
- 环境事实：本机 `pnpm --version` = 11.7.0（root `packageManager: pnpm@11.7.0`）；审计会话曾测得 11.19.0（版本漂移真实存在，M10 门禁）。
- CI：`pnpm/action-setup@v4` 读取 `packageManager`；`scripts/run-gates.ts` 是 gate 聚合（`ci-static` 等）。
- 测试基座：`packages/boot/app-boot/tests/include-rollback.spec.ts` 已存在并绿（Task 0 已完成）；`apps/cli/tests/plugin.spec.ts` 不存在（Task 13 未实现，M4 新建）；`packages/examples/page-app-fixture` 不存在（M5 新建）；`apps/web/tests/` 无 `workspace-apps*` e2e（M3/M9/M12 新建）。
- doc-typecheck 既有红项（§7）：`docs/superpowers/plans/2026-08-22-dsh-workspace-apps.md` 与 `packages/boot/page-app-profile/README.md` 各有失败 ts fence；本计划不新增红项，M12 修复后者（因会更新该 README），前者保持为冻结计划文档不修。

### 1.2 全局约束（每任务的隐式要求）

1. 实现/源码基线提交 `e91e2c5bd1`（diff 对照基准）；lane worktree 起点为 `DESIGN_BASELINE`（五份 2026-08-25 文档的提交，§3.2），任何任务开始前先 `git rev-parse --short HEAD` 核对 lane HEAD=DESIGN_BASELINE。
2. 产品语用：用户可见标签 **Workspace Apps**、Settings 位于 **Plugins → Workspace Apps**；内部标识一律 page-app / page-app.*，不得引入第二个 Workspace 域（approved R1/R2）。
3. Manager manifest 为 `dsh.bundle.patch` + `dsh.client`，**永不声明 `dsh.workspace`**（F-3）；Feature manifest 为 `dsh.workspace`（`schemaVersion: 1`，R-3 锁定，`workbench.*` 改名留 v2）。
4. `supportedContractVersions = [1]` 是 Manager 常量；未知版本在准入与激活两处硬拒绝，绝不静默跳过（D2）。
5. 不修改 DSH Core 产品逻辑；只允许最小通用扩展点（主规格 §7）；`ProfileRuntime` 仍是唯一 acknowledged live 重组写路径（P-2）。
6. 无第二套 lifecycle graph、无第二套包管理器；Manager 禁用 Feature 只经 provider 依赖传播（P-3/D4）；删除 legacy 只在替代路径测试绿且 grep/graph 证明无引用后执行（D12）。
7. Registry 是唯一 ownership 权威；损坏 fail-closed 保留原文；无 scan-and-adopt（P-1/D7）。
8. 全部持久文件 profile-scoped；identity 来自 launcher 不可变快照，绝不从 cwd/browser 推断（P-9）。
9. Host/Client 边界：浏览器永不执行 pnpm/写 profile 文件；7 个 `pageAppManager/*` 端点 loopback-only 前置围栏不改（P-6/D9）。
10. pnpm 安全：arg-array execa、无 shell 拼接、永不放宽 `allowBuilds`、不删用户源/global store、`file:`/`link:` uninstall 只移除引用（P-12）。
11. 注册即副作用：全部注册/订阅经 `ctx.effect()`；disposer 链完整；组件不拿 `ctx`、不直接 `useSyncExternalStore`；hook 由 renderer 绑定（client AGENTS）。
12. `scripts/`、根 `package.json`、`.github/workflows/`、`scripts/run-gates.ts` 是共享文件，只有 integration owner（lane D）在 M12 修改；其余文件按 §2.3 所有权表单一 owner。
13. 生成的 Typert 产物在 `lib/`（gitignored）由 build 生成；不得手改，author 在 `src/` 改签名后 `pnpm run build:lib:host` 重新生成。
14. TDD 铁律：无失败测试先写实现即违规；每个任务先写测试并见证其按预期原因失败（RED），再写最小实现（GREEN），再重构；测试写后立即通过 = 违规。
15. 每任务独立 commit（commit 边界见各任务）；不跨 checkpoint 批量提交；提交信息按给定格式。
16. Context7 核对：每批次第一任务前执行 batch preflight（§4），结论写入 `.superpowers/sdd/2026-08-25-dsh-workspace-manager-optimization/<batch>-preflight.md`（该目录 `.gitignore` 为 `*`，永不提交）；preflight 文件缺失时 lane 停止并报告。
17. 既有 doc-typecheck 红项不得作为跳过校验的理由；本计划新增文档不得引入新红项（ts fence 只允许纯自包含代码，见 §0 检查）。
18. 文档伴随代码：每个改行为的任务在同一 commit 内更新所属包 README/README.zh（word budget、i18n pairing 规则）与 JSDoc；M12 更新子系统页与 Agent Note。
19. 覆盖门禁：`test:coverage`（per-file 100%）是 CI 覆盖门禁；涉及 client 包时 `pnpm run test:gui`；涉及组装输出时 `DSH_SNAPSHOT=replay pnpm run test:web`（keyless）。
20. 不回滚已批准设计裁决：R-4（引入 wrapper，父行形态）、R-5（provider 依赖传播）已按推荐锁定；D1–D12 为设计裁决，实现不得另选方向。

---

## 2. 依赖有向图、lane 划分与文件所有权

### 2.1 Milestone 依赖图（M0–M12，来自 Formal Design §21，M1/M8 按 Host/Client 拆分子任务）

```text
M0 ──► M1.1 ──► M2 ──► M5 ──► M6 ──► M7 ──► M8-host ──► M11-host
        │                                  │
M3 ─────┘                                  │
M1.2（依赖 M1.1 合并）                      │
M8-client（独立）                           │
M9（依赖 M5 + M7 合并）─────────────────────┘
M4（独立）                                  │
M10（依赖 M1–M9 全部合并）───────────────────┘
M12（依赖全部）─────────────────────────────┘
```

边即文件或语义依赖；同一 lane 内串行，跨 lane 依赖通过合并上游分支满足（§3.3）。

### 2.2 Lane 与对话

| Lane | 分支 | 对话角色 | 里程碑 |
|---|---|---|---|
| A | `lane/a-host-runtime` | 实现对话 A：Host 运行时/契约/Adapter/Wrapper/状态 | M0、M1.1、M2、M5、M6、M7、M8-host、M11-host（含 M5 fixture 骨架、M12 窗口内 page-app-profile README 红项修复） |
| B | `lane/b-client-ui` | 实现对话 B：Client Shell/Controller/Failure Surface/e2e | M3、M1.2、M8-client、M9 |
| C | `lane/c-cli-packaging` | 实现对话 C：CLI 共存/出树打包基线 | M4、M10 |
| D | `lane/d-integration` | 集成/审查对话：合并、checkpoint 审查、共享文件、文档/Note/门禁 | M12 + 全部批次 checkpoint |

并发上限：A、B、C 三个实现对话 + D 一个集成/审查对话同时存在；D 不写实现代码（M12 除外）。

### 2.3 文件所有权表（禁止并行写同一文件；共享文件只有指定 integration owner 修改）

| 文件/目录 | Owner（M1–M11 窗口） | M12 窗口 | 说明 |
|---|---|---|---|
| `packages/host/page-app-manager/**` | A | A | 含 src + tests + README 对 |
| `packages/boot/page-app-profile/**` | A（M1–M9 只读；M12 窗口内修复其 README ts fence） | A | 核心契约包 |
| `packages/boot/app-boot/src/profile-runtime.ts`、`src/index.ts`、`tests/**` | A | A | M2/M7/M8/M11 修改 |
| `packages/examples/page-app-fixture/**` | A（M5 创建骨架）→ B（M9 迁移，在 A 合并后） | — | 跨 lane 顺序文件：B 只能在 A 的 M5 合并后改 |
| `packages/client/ui-page-app-manager/**` | B | B | 含 src/client + tests + README 对 |
| `packages/client/ui-layout/src/client/**`、`tests/**` | B | B | M3 双路径 |
| `apps/web/tests/workspace-apps*.e2e.ts`、`workspace-apps-profiles.e2e.ts`、`scaffold.ts`、`assembled-boot.ts`、`snapshots/workspace-apps/**`、`settings-chrome.e2e.ts` | B | B | 组装 e2e 与快照（settings-chrome 仅在有意图的 snapshot 变更时改） |
| `apps/cli/src/plugin.ts`、`apps/cli/src/bin.ts`、`apps/cli/tests/**`、`apps/cli/package.json` | C | C | M4/M10 |
| `scripts/publication-payload.ts`(+spec)、`scripts/release/**`、`scripts/verify-pnpm-version.ts`(+spec)、`scripts/extract-workspace-manager.ts`(+spec) | C | C | M10 打包基线 |
| `scripts/verify-page-app-source-boundary.ts`(+spec) | A（M5 创建） | — | M12 由 D 接入 run-gates 与 package.json scripts |
| `packages/bundle/web-app/cordis.patch.yml` | A（M1–M9；仅 M1.1 加 manager config 行） | D（M12 移除 manager 行） | 所有权随里程碑转移 |
| `packages/bundle/web-app/package.json` | A（只读） | D | 仅 M12 移除依赖 |
| `tsconfig.host.json`、`tsconfig.client.json` | A | A | 仅 M5 fixture 聚合引用 |
| 根 `package.json`（scripts）、`.github/workflows/**`、`scripts/run-gates.ts` | **D（唯一 owner）** | D | 共享文件，他人只读 |
| `docs/subsystems/workspace-apps.md`(+zh)、`docs/architecture.md`、`.agents/notes/implemented/architecture/2026-08-25-workspace-apps-architecture-optimization.md`(+zh) | D | D | M12 文档 |
| `docs/superpowers/specs/2026-08-25-workspace-apps-workbench-contract-v1.md` | A（M5 创建）→ C（M10 复制进出树骨架）→ D（M12 移除 in-tree 副本） | D | 契约文档，所有权随里程碑转移 |
| `pnpm-lock.yaml` | 无（可再生物） | 无 | 冲突解决 = 合并后由 D 重跑 `pnpm install` 提交再生成结果 |
| `.superpowers/sdd/2026-08-25-dsh-workspace-manager-optimization/**` | 各 lane 自写 | 各 lane | 批次产物，gitignored |

## 3. 批次、并发模型、worktree 与合并纪律

### 3.1 批次与 checkpoint（4 批；每批结束 Codex 审查 checkpoint，全部通过才允许下一批）

| 批次 | 里程碑 | 并发 | Checkpoint 门禁（全部通过才允许下一批） |
|---|---|---|---|
| Batch 1（Foundation） | M0、M1.1、M2（A）；M3（B）；M1.2（B，依赖 A 的 M1.1 合并） | A ‖ B（C 可并行启动 M4） | ① 四路 P0 缺陷各有红→绿证据（取消/超时/rollback 树复原/root 兜底）；② fresh tests 输出；③ 工作树状态干净（除预期文件）；④ 无越界文件（对照 §2.3）；⑤ Context7 preflight 记录存在；⑥ `include-rollback.spec.ts` / `config-reload.spec.ts` 保持绿 |
| Batch 2（Runtime） | M4（C）；M5、M6、M7（A） | A ‖ C | ① 契约准入/Strict-Mode 门禁/Adapter grep 门禁/wrapper 热插拔测试全绿；② CLI 分类与锁测试绿；③ 同上四项 |
| Batch 3（UI） | M8-host（A）、M8-client（B）、M9（B，依赖 A 的 M5+M7 合并） | A ‖ B | ① 状态投影/timer disposer 测试绿；② 真实 Feature 全链 e2e 绿（keyless）；③ 同上四项 |
| Batch 4（Composition） | M10（C）、M11-host（A）、M12（D） | A ‖ C ‖ D | ① 打包基线链式 smoke 绿；② legacy 删除后 grep/graph 无引用；③ 全量比例门禁（§5.12）绿；④ doc-typecheck 无新增红项 |

### 3.2 Worktree 与分支创建（using-git-worktrees：先探测既有隔离，再原生工具，最后 git fallback）

当前会话工作区本身就是 worktree（`feature/workspace-apps`）。M0 前由集成对话 D 在 `feature/workspace-apps` 上把五份 2026-08-25 文档提交为 `DESIGN_BASELINE`（父提交 `e91e2c5bd1`，实现/源码基线不变）。Batch 1 启动时由 D 在仓库根从 `DESIGN_BASELINE` 创建四个 lane worktree（绝对路径，用户指定）：

```bash
# DESIGN_BASELINE = 提交五份 2026-08-25 文档的 commit SHA；实现/源码基线 e91e2c5bd1 保持不变
git worktree add C:/Users/17948/Documents/Codex/2026-08-25/xian/work/dsh-ws-lane-a -b lane/a-host-runtime <DESIGN_BASELINE>
git worktree add C:/Users/17948/Documents/Codex/2026-08-25/xian/work/dsh-ws-lane-b -b lane/b-client-ui <DESIGN_BASELINE>
git worktree add C:/Users/17948/Documents/Codex/2026-08-25/xian/work/dsh-ws-lane-c -b lane/c-cli-packaging <DESIGN_BASELINE>
git worktree add C:/Users/17948/Documents/Codex/2026-08-25/xian/work/dsh-ws-lane-d -b lane/d-integration <DESIGN_BASELINE>
```

五份 2026-08-25 文档在 `DESIGN_BASELINE` 中已 tracked；未跟踪文件不会随 worktree 创建带入任何 checkout，因此每个 lane 初始工作树必须干净、无未跟踪文件。每个 lane worktree 首次进入后执行 `pnpm install`（lockfile 一致时 `--frozen-lockfile`；不一致时由 D 决定再生成路径）并跑 M0 基线 `pnpm exec vitest run packages/boot/app-boot/tests/include-rollback.spec.ts packages/boot/app-boot/tests/config-reload.spec.ts packages/boot/app-boot/tests/profile-runtime.spec.ts packages/boot/app-boot/tests/user-patches.spec.ts` 确认干净基线。若 `git worktree add` 被 sandbox 拒绝，降级为在当前 worktree 内按文件所有权串行执行并报告。

### 3.3 合并顺序与冲突处理

- 上游序：A → B → C → D → `feature/workspace-apps`。即 B 需要 A 的提交（M1.1 之后、M5+M7 之后）、C 需要 A+B（M10 前）、D 需要全部（M12 前）。
- 合并动作由 **D 执行**（integration owner）：在依赖 lane worktree 内 `git merge --no-ff <上游分支>`；合并后立即 `pnpm install` + `pnpm run build:lib:host && pnpm run build:lib:client`，跑被并入 lane 的 focused tests 确认无回归，才允许依赖 lane 继续。
- 冲突期望：§2.3 所有权表保证同文件单 owner，正常无冲突。若出现冲突（仅可能是 `pnpm-lock.yaml` 或意外越界写）：lockfile 冲突由 D 重跑 `pnpm install` 后提交再生成结果；越界写冲突以所有权表为准，D 丢弃越界方改动并让该 lane 重做。
- 最终合并：D 的 `lane/d-integration` 合并 A/B/C 后，把 `lane/d-integration` 以 `--no-ff` 合入 `feature/workspace-apps`（或按用户偏好合入新发布分支）。合并前 D 执行 §5.12 全量门禁与 `git diff --check`。
- 冻结：任何 lane 不得 merge 到 `feature/workspace-apps`；只有 D 可以做。

### 3.4 回滚点

- 每个任务 = 一个 commit = 最小回滚单元（`git revert <commit>` 或 `git reset --hard <上一提交>`，在所属 lane 分支内）。
- 批次回滚：checkpoint 未过时，D 在依赖 lane 上 `git revert` 该批 commits（逆序）或 reset 到批次起点；回滚后跑 focused tests 确认基线恢复。
- 跨 lane 回滚：已并入下游的提交不回滚已发布状态；改在该 lane 提交后续修复 commit（保持历史线性，禁止 force push，除非经用户授权且 `--force-with-lease`）。
- 出树/发布回滚（外部状态）：`npm unpublish` 属外部状态变更，需用户单独授权（§5.10）。

---

## 4. Context7 批次 preflight（可验证，不是泛泛提醒）

每批次第一任务之前，由 Codex（或该 lane 的首个任务内）通过 Context7 查询官方文档并把结论写入 `.superpowers/sdd/2026-08-25-dsh-workspace-manager-optimization/<batch>-preflight.md`，文件必须包含：查询的 library id、官方源 URL 列表、每条结论与设计 §4 的对照、以及 vendored/安装现实 vs 上游语义差异结论。lane 首任务先检查该文件存在且引用至少一个官方 URL；缺失则停止并报告（可验证门禁，禁止口头跳过）。

| 批次 | Preflight 主题（library id） | 必须核实的结论 | 作用里程碑 |
|---|---|---|---|
| Batch 1 | `/cordiverse/cordis`（Fiber 状态/effect disposer/inject epoch reload/provide cleanup 与 notify） | FiberState PENDING→LOADING→ACTIVE→UNLOADING/DISPOSED/FAILED；`ctx.effect` 收集 disposer 并返回；`inject` 缺失→PENDING；`provide` disposer 删除服务并通知依赖 fiber 重评估（与 `vendor/cordis/src/fiber.ts`、`reflect.ts` 对照，设计 §4.1） | M1/M2 |
| Batch 1 | `/reactjs/react.dev/__branch__v18`（StrictMode） | StrictMode 开发态额外 render 并执行 effect/ref 的 setup→cleanup→setup；UI 订阅、root handoff、observer/ref 必须通过 cleanup 对称性测试 | M3 |
| Batch 2 | `/pnpm/pnpm.io`（file:/link:/workspace:/frozen install/allowBuilds） | `file:` 硬链并装目标依赖；`pnpm link` 符号链接不装目标依赖；`workspace:` 拒绝 registry fallback；无 `--frozen-lockfile` 时每次 install 重校验 `file:` 目标；allowBuilds 门控 build scripts | M4 |
| Batch 2 | `/cordiverse/cordis`（Adapter 面对的表面：Loader/Include/applyEntryPatches/loader.await） | Loader entry/await 语义；Include `entry.update` 事务性（Include rollback 契约已由 include-rollback.spec.ts 钉住）；vendor 4.0.1 与上游一致 | M6/M7 |
| Batch 3 | `/cordiverse/cordis`（FiberState 枚举与 `_reload`/`_unload` epoch 语义） | DISPOSED 存在且 `_setEpoch(INACTIVE)`→`_unload`；恢复时 `_reload`；依赖回补语义 | M8-host（F-8 标签映射） |
| Batch 3 | `/reactjs/react.dev/__branch__v18`（StrictMode + 状态保持） | hidden-not-unmounted 与 keep-mounted 在 StrictMode 双调用下不丢 state；keyed wrapper 稳定性 | M9 |
| Batch 4 | `/npm/cli`（files/private/dry-run/provenance/packlist） | files 是发布白名单；pack/publish 共享 packlist 优先级；本仓库链是 pnpm pack→npm publish tarball，最终 tarball 内容必须实测（npm 不重跑 packlist） | M10 |
| Batch 4 | `/pnpm/pnpm.io`（版本行为） | 声明 11.7.0 vs 实测 11.19.0 漂移；门禁必须两侧都 fail | M10 |
| Batch 4 | `/cordiverse/cordis`（loader.await 启动错误语义） | 不可解析模块名 → `loader.await()` rethrow → 启动失败（F-2 的 boot-after-uninstall 前提） | M11-host |

---

## 5. 任务定义（M0–M12）

任务格式统一为：目标 / 前置依赖 / 精确文件（新增、修改、删除）/ 精确测试文件与测试名称 / RED 命令与预期失败 / 最小 GREEN 实现步骤 / focused regression / 全局门禁 / Context7 preflight 主题 / 验收证据 / commit 边界与回滚点。每任务严格 red→green→refactor；禁止先写实现再补测试；删除 legacy 只在替代路径测试绿且 grep/graph 证明无引用后执行。

### 5.1 M0 — 冻结前置条件（Lane A，Batch 1）

**目标：** 证明实现基线成立：lane worktree HEAD 为 `DESIGN_BASELINE`（实现/源码基线 `e91e2c5bd1` 不变，五份 2026-08-25 文档已 tracked）、现有 Include rollback 契约测试与 config-reload 测试绿、doc-typecheck 红项清单固定，为后续每批次的回归对照建立零基线。

**前置：** 无（`DESIGN_BASELINE` 提交与四个 lane worktree 创建由 D 在 M0 前完成，§3.2）。

**文件：**
- 新增：`.superpowers/sdd/2026-08-25-dsh-workspace-manager-optimization/batch-1-preflight.md`（含 Context7 Batch 1 结论，§4）
- 修改：无
- 删除：无

**测试文件与测试名称：** 无新测试；验证既有测试文件 `packages/boot/app-boot/tests/include-rollback.spec.ts`、`packages/boot/app-boot/tests/config-reload.spec.ts`、`packages/boot/app-boot/tests/profile-runtime.spec.ts`、`packages/boot/app-boot/tests/user-patches.spec.ts`。

**步骤：**
- [ ] Step 1（RED 前置核对）：在 lane A worktree 执行 `git rev-parse --short HEAD` 与 `git status --short --branch`；预期 HEAD=`DESIGN_BASELINE`（§3.2 提交五份 2026-08-25 文档的 commit）、分支 `lane/a-host-runtime`、工作树干净且无未跟踪文件（五份文档已 tracked；未跟踪文件不会随 worktree 创建带入任何 checkout）。若 HEAD 不符：停止并向 D 报告，不得推进。
- [ ] Step 2（GREEN 基线）：执行 `pnpm exec vitest run packages/boot/app-boot/tests/include-rollback.spec.ts packages/boot/app-boot/tests/config-reload.spec.ts packages/boot/app-boot/tests/profile-runtime.spec.ts packages/boot/app-boot/tests/user-patches.spec.ts`；预期全部绿。若红：记录失败并停止，这是既有回归而非本计划引入。
- [ ] Step 3（红项基线）：执行 `pnpm run doc-typecheck`，记录失败清单必须精确等于 §7 的两项（2026-08-22 plan 与 page-app-profile README）；若出现第三项，停止并报告。
- [ ] Step 4（Context7 preflight）：完成 Batch 1 preflight（Cordis + React 18）并写入 batch-1-preflight.md（§4 格式）。
- [ ] Step 5（commit）：本任务无代码改动，不提交；batch-1-preflight.md 为 gitignored 产物。

**回归/门禁：** 见 Step 2/3。

**验收证据：** 基线测试输出（绿）、doc-typecheck 红项清单与 §7 一致、batch-1-preflight.md 存在。

**commit 边界与回滚点：** 无 commit；若后续任何批次出现基线回归，先回退到本任务记录的 baseline 输出对照。

### 5.2 M1.1 — Host 取消接线、settlement 超时、精确 graph ack（Lane A，Batch 1；D8 的 G-2/G-4/F-5/F-10）

**目标：** Remote 方法签名携带 `signal` 并透传（G-2）；`awaitSettlement` 加可配置 Host 超时 `settlementTimeoutMs`（G-4，validated Config）；activation request 携带 Host client-graph rev 而非 runtime-layer 文档、ack 要求精确收敛（F-5）；事务 AbortSignal 链接 manager fiber 生命周期（F-10，`PageAppLifecycle` 增加 dispose 钩子）。

**前置：** M0；Batch 1 preflight（Cordis Fiber/effect/provide 语义）存在。

**文件（全部 Lane A 所有）：**
- 修改 `packages/host/page-app-manager/src/types.ts`：新增 `PageAppManagerConfig`（`settlementTimeoutMs?: number`）；`PageAppTransactionDeps` 增 `settlementTimeoutMs` 与 `clientGraphRev: () => string`；`ClientActivationRequest` 不变（`graphRevision` 语义改为 client graph rev）
- 修改 `packages/host/page-app-manager/src/activation.ts`：`awaitSettlement(signal, timeoutMs)`，超时即 reject；JSDoc 更新
- 修改 `packages/host/page-app-manager/src/transaction.ts`：`install` 的 request.graphRevision 改为 `this.deps.clientGraphRev()`（apply 成功后读取）；`PageAppLifecycle` 持有 in-flight AbortController 并暴露 `dispose()`；`install/setEnabled/uninstall` 接收 `AbortSignal` 传入 executor 与 awaitSettlement；`PageAppTransactionDeps` 接线
- 修改 `packages/host/page-app-manager/src/index.ts`：`install(source, clientInstanceId, signal: AbortSignal)`、`setEnabled(pageId, enabled, signal)`、`uninstall(pageId, signal)` 三个 `@Remote` 方法签名（`setHidden/reorder/ackClientActivation/recover/list` 不变）；新增 `export const Config`（zod `z.object({ settlementTimeoutMs: z.number().int().positive().default(60000) })`，参照 `packages/host/frontend-static/src/index.ts:33` 的 Config 模式）；`apply(ctx, config)` 把 config 与 `clientGraphRev` 传入 `PageAppLifecycle`；manager fiber 的 `ctx.effect` 注册 `lifecycle.dispose` 以 abort in-flight 事务；Host client-modules 注册表经 `ctx.get("modules")`（`ClientModuleRegistry`，`packages/client/modules/src/index.ts:61` 以 `modules` 提供，`graph().rev` 在 352/414 行）解析 `clientGraphRev`
- 修改 `packages/bundle/web-app/cordis.patch.yml`：`page-app-manager` 行（当前 106-107 行）追加 `config: { settlementTimeoutMs: 60000 }`（Manager 正式配置值来自 cordis.yml，非硬编码默认）
- 新增测试 `packages/host/page-app-manager/tests/activation.spec.ts`
- 修改 `packages/host/page-app-manager/README.md` + `README.zh.md`：settlementTimeoutMs 配置、取消语义

**测试文件与测试名称（新增/新增用例）：**
- `packages/host/page-app-manager/tests/activation.spec.ts`（新文件）：`resolves on the first valid acknowledgement before the timeout`、`rejects the settlement wait when the timeout elapses`、`rejects on abort before the timeout`、`discard rejects pending waiters and clears listeners`
- `packages/host/page-app-manager/tests/transaction.spec.ts`（新增用例）：`carries the host client-graph revision (not the layer document) in the activation request`、`refuses a stale acknowledgement whose graph revision does not match the request`、`aborts pnpm and the settlement wait when the passed signal aborts`、`aborts the in-flight transaction when the lifecycle disposes (manager fiber gone)`
- `packages/host/page-app-manager/tests/remote.spec.ts`（新增用例）：`propagates an aborted signal through the install Remote call`、`reads the settlement timeout from the plugin config`

**RED 命令与预期失败：** `pnpm exec vitest run packages/host/page-app-manager/tests/activation.spec.ts packages/host/page-app-manager/tests/transaction.spec.ts packages/host/page-app-manager/tests/remote.spec.ts`；预期：activation.spec 全部失败（模块/签名不存在）；transaction/remote 新用例失败于 `graphRevision: staged.layer` 依旧（精确 rev 断言失败）与签名缺 `signal`（编译缺失视为 RED）。

**最小 GREEN 实现步骤：**
- [ ] 1. activation.ts：`awaitSettlement(signal, timeoutMs)` 用定时器竞速；超时 reject 与 abort reject 使用同一错误面（`page-app activation: settlement wait timed out`）。
- [ ] 2. transaction.ts：`PageAppTransactionDeps` 增字段；`install` 的 request.graphRevision = `clientGraphRev()`（`applyRuntime` 成功后读取）；`PageAppLifecycle` 增 `private inFlight = new AbortController()` 与 `dispose()`（abort + 失效 gate）；`withTransaction` 把入参 signal 与 inFlight 信号合并（任一 abort 即 abort）。
- [ ] 3. index.ts：三个 Remote 方法加 final `signal: AbortSignal` 参数并透传；新增 zod Config 与 `apply(ctx, config)`；`ctx.effect(() => lifecycle.dispose(), ...)` 挂 fiber；`clientGraphRev` 经 `ctx.get("modules")` 解析（缺失时抛错，install 必须精确收敛）。
- [ ] 4. cordis.patch.yml：manager 行加 config。
- [ ] 5. `pnpm run build:lib:host` 重新生成 Typert client 类型（不得手改 lib/）。
- [ ] 6. README 对更新（config 键、取消语义）。

**focused regression：** `pnpm exec vitest run packages/host/page-app-manager/tests packages/client/connection/tests/api-request-trust.host.spec.ts packages/client/connection/tests/node-half.host.spec.ts`；`pnpm exec tsc -b packages/host/page-app-manager/tsconfig.json`。

**全局门禁：** `pnpm run lint`、`pnpm run typecheck`（含 typert 重新生成后的契约一致）。

**Context7 preflight 主题：** Batch 1 Cordis（provide 通知/await 语义，M1.1 的 fiber 生命周期 abort 依据）。

**验收证据：** 上述 focused 测试全绿；activation.spec 超时/abort 用例红转绿记录；`git grep -n "graphRevision: staged.layer" packages/host/page-app-manager/src` 无命中；remote.spec 的 abort 传播用例绿。

**commit 边界与回滚点：** 单个 commit，信息 `fix(page-apps): wire cancellation, settlement timeout, and exact graph ack`；回滚点 = 该 commit（revert 后 activation/transaction/remote 回到 M0 状态）。

### 5.3 M1.2 — Client 控制器真实信号 + Settings 取消（Lane B，Batch 1；D8/D9）

**目标：** controller 的 `install/setEnabled/uninstall` 把真实 `AbortSignal` 传给 Remote（替换 `void signal`，`controller.ts:167-215`）；Settings 增加显式取消按钮（D9）；controller 生命周期 dispose 时取消 in-flight 调用（既有 `controller disposal cancels in-flight acknowledgement` 语义扩展）。

**前置：** M1.1 已由 D 合并入 `lane/b-client-ui` 且 build 通过（§3.3）；Batch 1 preflight 存在。

**文件（全部 Lane B 所有）：**
- 修改 `packages/client/ui-page-app-manager/src/client/controller.ts`：`install/setEnabled/uninstall` 创建每调用 AbortController，外部 signal 与 controller dispose 均接线（disposed 置位时 abort）
- 修改 `packages/client/ui-page-app-manager/src/client/contracts.ts`：`PageAppManagerRemoteMethods` 的 `install/setEnabled/uninstall` 增 final `signal: AbortSignal`（24-39 行面）
- 修改 `packages/client/ui-page-app-manager/src/client/apply.ts`：`settingsInjected` 的 mutations 保持透传；`stubRemote` 签名同步（61-65 行）
- 修改 `packages/client/ui-page-app-manager/src/client/PageAppSettingsTab.tsx`：install 流程显示取消按钮，点击 abort 当前 AbortController
- 修改 `packages/client/ui-page-app-manager/src/client/locales.ts` + `tests/locales.client.spec.ts`：新增取消文案键
- 修改 `packages/client/ui-page-app-manager/README.md` + `README.zh.md`

**测试文件与测试名称：**
- `packages/client/ui-page-app-manager/tests/controller.client.spec.ts`（新增用例）：`passes a real AbortController signal to install and aborts on controller disposal`、`aborts setEnabled and uninstall through the controller signal`、`a pre-aborted signal rejects the mutation without reaching the remote`
- `packages/client/ui-page-app-manager/tests/settings.client.spec.tsx`（新增用例）：`cancel button aborts the in-flight install and clears the busy state`、`cancel button is absent when no install is running`

**RED 命令与预期失败：** `pnpm exec vitest run packages/client/ui-page-app-manager/tests/controller.client.spec.ts packages/client/ui-page-app-manager/tests/settings.client.spec.tsx`；预期：新用例失败（`void signal` 不 abort；Settings 无取消按钮）。

**最小 GREEN 实现步骤：**
- [ ] 1. controller：`install/setEnabled/uninstall` 内部 `const ctrl = new AbortController()`；`this.disposers.push(() => ctrl.abort())`；外部 signal 的 abort 监听转发到 ctrl；Remote 调用传 `ctrl.signal`；`dispose()` 置位并 abort（disposers 既有机制扩展）。
- [ ] 2. contracts.ts 与 stubRemote 同步信号签名。
- [ ] 3. PageAppSettingsTab：install 进行中渲染取消按钮（busy 态），onClick 调注入的 `cancelInstall()`（`settingsInjected` 增该回调）。
- [ ] 4. locales 新增取消键（zh 为源，en 对齐，遵守 pairing）。

**focused regression：** `pnpm exec vitest run packages/client/ui-page-app-manager/tests`；`pnpm run test:gui`。

**全局门禁：** `pnpm exec tsc -b packages/client/ui-page-app-manager/tsconfig.json`；`pnpm run verify-client-packages`。

**Context7 preflight 主题：** Batch 1 React 18 StrictMode（取消按钮订阅/清理的对称性）。

**验收证据：** controller/settings 新用例红转绿；`git grep -n "void signal" packages/client/ui-page-app-manager/src` 无命中；`test:gui` 绿。

**commit 边界与回滚点：** 单 commit `fix(page-apps): pass real cancellation to the client controller`；回滚点 = 该 commit。

### 5.4 M2 — Rollback live 树复原、journal 既有记录守卫、recover 入锁、期望哈希（Lane A，Batch 1；D8 的 G-3/F-4/F-6）

**目标：** 每处 rollback 先经 `ProfileRuntime.restoreManagerLayer` 复原 live Include 树并 await audit（G-3，last-known-good）；expectedRoots 发送真实 `canonicalManagedRootHash(record.rootRow)` 哈希，永不空串（F-4）；`withTransaction` 在既有 journal 存在时 fail loud `recovery-required`（F-6a）；operator `recover()` 在共享锁内执行（F-6b）；uninstall rollback 复原仍含该 root 的层。

**前置：** M1.1；Batch 1 preflight（Cordis provide/await 语义）。

**文件（全部 Lane A 所有）：**
- 修改 `packages/host/page-app-manager/src/transaction.ts`：`applyRuntime` 的 expectedRoots 携带 `canonicalManagedRootHash`（rootRow 来自 `validateInstalledPageAppPackage` 返回的 `record.rootRow`；`stageFromRegistry` 已算过，把哈希随 `PageAppStagedState` 带出）；`rollback(token, cause)` 在恢复文件前先调用 `this.deps.runtime.restoreManagerLayer({ registryRevision, runtimeLayer: 由 journal 记录的 before layer, expectedRoots: 由 journal before registry 重算 })` 并 await；`withTransaction` 开头 `readPageAppJournal` 非空即抛 `recovery-required` 错误；`uninstall` 失败路径的 rollback 用 disabled 前状态
- 修改 `packages/host/page-app-manager/src/recovery.ts`：`recoverPageAppTransaction` 内部 `withPageAppProfileLock(profileDir, { kind: "manager", token })` 包裹；restore-before-state 分支先 `restoreManagerLayer`（用 journal 的 before layer 与 before registry 重算哈希）再收敛 pnpm
- 修改 `packages/host/page-app-manager/src/index.ts`：`recover()` Remote 保持调用 `recoverPageAppTransaction`（锁已内化），删除 call-site 无锁 executor 创建
- 新增测试 `packages/host/page-app-manager/tests/loader-composition.spec.ts`

**测试文件与测试名称：**
- `packages/host/page-app-manager/tests/transaction.spec.ts`（新增用例）：`publish failure rolls back the live Include tree via restoreManagerLayer and awaits its audit`、`pnpm remove failure on uninstall restores the layer that still contains the root`、`refuses to start a new transaction while a journal exists (recovery-required)`、`sends real expected root hashes in the apply request (never empty)`
- `packages/host/page-app-manager/tests/recovery.spec.ts`（新增用例）：`restores the live layer before converging on restore-before-state`、`runs recovery under the shared profile lock`、`keeps the journal and reports recovery-required when the layer audit fails`
- `packages/host/page-app-manager/tests/loader-composition.spec.ts`（新文件）：`applyManagerLayer failure rolls back to the prior committed tree`、`restoreManagerLayer restores the prior composition and audits active roots`、`an activation audit failure rejects the apply and keeps the prior layer`

**RED 命令与预期失败：** `pnpm exec vitest run packages/host/page-app-manager/tests/transaction.spec.ts packages/host/page-app-manager/tests/recovery.spec.ts packages/host/page-app-manager/tests/loader-composition.spec.ts`；预期：新用例失败（rollback 不调 restoreManagerLayer、journal 无守卫、哈希为空、recover 无锁）。

**最小 GREEN 实现步骤：**
- [ ] 1. `PageAppStagedState` 携带 `expectedRoots`（含哈希）；`applyRuntime` 用之。
- [ ] 2. `rollback`：先读 journal 得 before layer/registry，重算 expectedRoots，`await runtime.restoreManagerLayer(...)`；audit 失败 → 保留 journal 报 recovery-required。
- [ ] 3. `withTransaction`：journal 存在即抛 `page-app transaction: a journal exists; run recover() first (recovery-required)`。
- [ ] 4. recovery.ts：锁包裹 + restore-before-state 分支先 restoreManagerLayer。
- [ ] 5. README 对更新（recovery 语义）。

**focused regression：** `pnpm exec vitest run packages/host/page-app-manager/tests packages/boot/app-boot/tests/profile-runtime.spec.ts`；`pnpm exec tsc -b packages/host/page-app-manager/tsconfig.json packages/boot/app-boot/tsconfig.json`。

**全局门禁：** `pnpm run lint`、`pnpm run typecheck`。

**Context7 preflight 主题：** Batch 1 Cordis（`ctx.provide` disposer 通知、loader.await 语义支撑 restore 审计）。

**验收证据：** 四路径（publish 失败/remove 失败/断线/audit 失败）树盘一致性断言绿；`git grep -n "hash: " packages/host/page-app-manager/src` 无空哈希（空串构造删除）；锁可再获取测试绿。

**commit 边界与回滚点：** 单 commit `fix(page-apps): restore the live layer on rollback and guard the journal`；回滚点 = 该 commit。

### 5.5 M3 — Native DSH root 兜底 + Manager failure surface（Lane B，Batch 1；D5 的 G-1/G-13/F-1）

**目标：** ui-layout 双路径注册：builtin seat 声明存在时照旧注入 `page-app.shell.builtin`；absent 时以 priority 1（严格劣于 manager 的 0）把 `AppFrame` 注册进 `root`，订阅在 root-entries mutation（先于 child-declaration 通知）同步让路，杜绝同 priority 双 occupant 与 duplicate-children throw（F-1）；Manager 订阅 `slots.onEntryError` 为崩溃的 managed surface 渲染 manager-owned failure surface（重试/卸载）（G-13）；M3 测试钉住两种加载顺序与一次 Manager HMR 周期（设计 §25 risk 2/8）。

**前置：** M0；Batch 1 preflight（React 18 StrictMode）存在；既有 `packages/client/ui-layout/tests/apply.client.spec.ts` 与 `app-frame.client.spec.tsx` 为本任务先写后改的回归面。

**文件（全部 Lane B 所有）：**
- 修改 `packages/client/ui-layout/src/client/index.ts`：`apply` 内单订阅双路径（i）builtin 存在 → inject `page-app.shell.builtin`；（ii）absent → `ctx.slots.register({ name: "root", priority: 1, children: { sidebar, conversation, details, shell.overlay } }, AppFrame)`；两条路径永不并发注册同一 child slot；让路协议实现于 root-entries 变更回调（同步）
- 修改 `packages/client/ui-page-app-manager/src/client/apply.ts`：新增 `ctx.slots.onEntryError` 订阅（`packages/client/runtime/src/client/slots.ts:336` 已存在），disposer 入 effect；root seat 本身不需 failure surface（兜底拥有它）
- 新增 `packages/client/ui-page-app-manager/src/client/PageAppFailureSurface.tsx` + `PageAppFailureSurface.module.css`：每崩溃 managed surface 的失败面，含 retry 与 uninstall 动作
- 修改 `packages/client/ui-page-app-manager/src/client/PageAppShell.tsx`：渲染 failure surface 替换 data-slot-error 空单元
- 新增 `apps/web/tests/workspace-apps-shell.e2e.ts`

**测试文件与测试名称：**
- `packages/client/ui-layout/tests/apply.client.spec.ts`（新增用例）：`registers AppFrame into root at priority 1 when the builtin seat is absent (no-manager boot)`、`yields to the builtin path when the manager declares the seat (manager-first load order)`、`yields to the builtin path when the manager arrives after ui-layout (layout-first load order)`、`never holds two root occupants (distinct priorities, no same-priority throw)`、`survives a manager HMR reload cycle without duplicate child declarations`、`survives a StrictMode double-invoke (setup, cleanup, setup) without duplicate registrations`
- `packages/client/ui-page-app-manager/tests/apply.client.spec.ts`（新增用例）：`subscribes to slot entry errors and disposes the subscription with the fiber`
- `packages/client/ui-page-app-manager/tests/shell.client.spec.tsx`（新增用例）：`renders a manager-owned failure surface with retry and uninstall actions when a managed surface abdicates`、`the rail and DSH stay usable while one surface shows the failure face`
- `apps/web/tests/workspace-apps-shell.e2e.ts`（新文件，keyless）：`boots Native DSH without the manager row (fallback renders, root not blank)`、`a root crash recovers to Native DSH without a refresh (P6 two start/stop cycles)`

**RED 命令与预期失败：** `pnpm exec vitest run packages/client/ui-layout/tests/apply.client.spec.ts packages/client/ui-page-app-manager/tests/apply.client.spec.ts packages/client/ui-page-app-manager/tests/shell.client.spec.tsx`；预期：no-manager 与双 occupant 断言失败（当前 ui-layout 无兜底路径）。e2e 在 GREEN 后另跑。

**最小 GREEN 实现步骤：**
- [ ] 1. ui-layout apply：单订阅监听 builtin seat 声明状态；声明变更时同步切换路径；fallback disposer 先 collapse 自身 children 声明（root-entries mutation 内完成，遵循 `packages/client/ui-slots/src/index.ts:892-911` 的提交序）再允许 builtin AppFrame 重注册；priority: 1 恒劣于 manager 默认 0（`ui-slots/src/index.ts:706-726` 单 seat 同 priority throw 永不触发）。
- [ ] 2. ui-page-app-manager apply：`ctx.slots.onEntryError` 订阅 → 控制器记录失败 pageId → shell 渲染 failure surface；订阅 disposer 入既有 effect 的 disposers。
- [ ] 3. PageAppFailureSurface：retry = 重新 select/remount（controller 已有 select）；uninstall = 现有 uninstall 流程。
- [ ] 4. e2e：`pnpm run build` 后 `DSH_SNAPSHOT=replay pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/workspace-apps-shell.e2e.ts`。

**focused regression：** `pnpm exec vitest run packages/client/ui-layout/tests packages/client/ui-page-app-manager/tests`；`pnpm run test:gui`；e2e 见上。

**全局门禁：** `pnpm exec tsc -b packages/client/ui-layout/tsconfig.json packages/client/ui-page-app-manager/tsconfig.json`；`pnpm run verify-client-packages`。

**Context7 preflight 主题：** Batch 1 React 18 StrictMode（双路径注册与 failure surface 订阅必须 cleanup 对称）。

**验收证据：** 两种加载顺序 + HMR 周期 + StrictMode 双调用用例绿；`apps/web/tests/workspace-apps-shell.e2e.ts` keyless 绿；`git grep -n "MutationObserver" packages/client/ui-layout/src packages/client/ui-page-app-manager/src` 无新增命中（既有 `PageAppRail.tsx:42` roving tabindex 的 querySelectorAll 不属本任务改动）。

**commit 边界与回滚点：** 单 commit `feat(page-apps): add native DSH root fallback and failure surface`；回滚点 = 该 commit（回滚后 root 回到单 occupant 状态，属设计 §25 risk 8 已接受的临时窗口）。

### 5.6 M4 — CLI 共享锁与 `dsh.workspace` 分类（Lane C，Batch 2，可随 Batch 1 并行启动；D11 的 G-5/F-9）

**目标：** `dsh plugin` 的 read→pnpm→reconcile 序列纳入 `withPageAppProfileLock`（ownerKind `plugin-cli`，`packages/boot/page-app-profile/src/lock.ts:22` 已预留）；`reconcilePlugins` 过滤声明 `dsh.workspace` 的依赖，不并入 `dsh.profile.bundles` 并输出 Plugins → Workspace Apps 指引（G-5）；`runPlugin` 因锁为 promise 而异步化并重构 bin 调用链（F-9）；CLI 永不调用 Manager adoption API。

**前置：** Batch 2 preflight（pnpm file:/link:/workspace: 语义）存在；`apps/cli/src/plugin.ts` 当前与 master 零 diff（审计域 4），本任务首次修改。

**文件（全部 Lane C 所有）：**
- 修改 `apps/cli/src/plugin.ts`：`runPlugin(profile, args): Promise<number>`；内部 `withPageAppProfileLock(profileDir, { kind: "plugin-cli", token: randomUUID() }, ...)` 包裹 init/read/pnpm/reconcile；`reconcilePlugins` 读依赖 manifest 的 `dsh.workspace` 键做分类（不触碰该包的其他面）；`anchorPathSpec` 不变
- 修改 `apps/cli/src/bin.ts`：`await runPlugin(...)` 后 `process.exit(code)`（41-42 行调用点异步化）
- 修改 `apps/cli/package.json`：dependencies 增 `@deepseek-ai/dsh-page-app-profile`（锁 + manifest 解析）
- 新增 `apps/cli/tests/plugin.spec.ts`
- 修改 `apps/cli/tests/built-bin.e2e.ts`

**测试文件与测试名称：**
- `apps/cli/tests/plugin.spec.ts`（新文件）：`serializes dsh plugin and manager mutations on the same profile via the shared lock`、`never promotes a dsh.workspace dependency into dsh.profile.bundles and prints the Workspace Apps diagnostic`、`leaves ordinary plugins with unchanged reconciliation behavior`、`does not add an external page-app dependency to the manager registry (no adoption)`、`anchors relative path specs before pnpm (existing behavior pinned)`
- `apps/cli/tests/built-bin.e2e.ts`（新增用例）：`dsh plugin add of a dsh.workspace package does not join bundles (built bin)`

**RED 命令与预期失败：** `pnpm exec vitest run apps/cli/tests/plugin.spec.ts`；预期：文件不存在或断言失败（runPlugin 同步、无锁、无分类）。

**最小 GREEN 实现步骤：**
- [ ] 1. `runPlugin` 异步化：整个序列包进 `withPageAppProfileLock`；返回 number；bin.ts await 后 exit。
- [ ] 2. `reconcilePlugins`：对每个依赖解析其 package.json，若 `dsh?.workspace` 存在 → 不 append 到 bundles；若该依赖是新增且声明 `dsh.workspace` → stderr 输出 `dsh: <pkg> declares dsh.workspace - manage it in Plugins → Workspace Apps, not as a profile layer`。
- [ ] 3. apps/cli package.json 依赖 + `pnpm install`（lockfile 由 D 在合并时收敛）。

**focused regression：** `pnpm exec vitest run apps/cli/tests/plugin.spec.ts apps/cli/tests/args.spec.ts`；build 后 `pnpm exec vitest run apps/cli/tests/built-bin.e2e.ts -t "dsh.workspace"`。

**全局门禁：** `pnpm exec tsc -b apps/cli/tsconfig.json`（或 CLI 所属 aggregate，以实现时项目配置为准，不得跳过）；`pnpm run lint`。

**Context7 preflight 主题：** Batch 2 pnpm（file:/link:/workspace: 语义，确保分类不改变 pnpm 行为；无 `--frozen-lockfile` 时 `file:` 重校验语义）。

**验收证据：** 争用测试证明 pnpm 调用不重叠；分类 e2e 证明 `dsh.workspace` 包不入 bundles 且输出指引；普通插件 reconciliation 不变；`git diff master..HEAD -- apps/cli/src/plugin.ts` 不再为空。

**commit 边界与回滚点：** 单 commit `feat(cli): serialize plugin mutations and classify workspace packages`；回滚点 = 该 commit（回滚后 CLI 回到 raw pnpm forwarder）。

### 5.7 M5 — Workbench Contract v1 与 Strict Mode 准入（Lane A，Batch 2；D2 的 G-8/G-16/F-11/C3，A4）

```ts
export function assertSupportedContractVersion(version: number, supported: readonly number[]): void {
  if (!supported.includes(version)) throw new Error(`unsupported contract version ${version}`)
}
```


**目标：** 定义并固化 `supportedContractVersions = [1]` 常量（C3 锁定物理键 `dsh.workspace.schemaVersion`，R-3）；新增依赖边界准入检查（Feature 的 package.json 不得直接依赖 `cordis` 或 `@deepseek-ai/cordis`，G-8）；区分 pnpm 前 preflight 与 pnpm 后依赖边界（F-11：依赖边界在 staging 后、任何 registry/ownership 变更前拒绝，无需 rollback）；编写规范契约文档；新建 Strict-Mode 源码边界门禁脚本与 spec；新建真实 Feature fixture 骨架作为门禁主体与 M9 迁移对象（A4）。

**前置：** M2；Batch 2 preflight（Cordis Adapter 面对的表面）存在。

**文件（全部 Lane A 所有，除契约文档所有权另注）：**
- 新增 `packages/host/page-app-manager/src/contract.ts`：`export const SUPPORTED_CONTRACT_VERSIONS = [1] as const`；`assertSupportedContractVersion(version: number): void`（未知版本抛错，错误信息含版本号）
- 修改 `packages/host/page-app-manager/src/validation.ts`：`validateInstalledPageAppPackage` 增依赖边界检查（读已安装 package.json 的 dependencies，含 `cordis` 或 `@deepseek-ai/cordis` 即拒绝）；契约版本检查经 `assertSupportedContractVersion` 走常量（现有 zod 已拒非 1，改为显式走常量以单一事实源）
- 修改 `packages/host/page-app-manager/src/index.ts`：`validateInstall` 的本地目录 preflight 保持（pnpm 前），依赖边界走 validation（pnpm 后）
- 新增 `docs/superpowers/specs/2026-08-25-workspace-apps-workbench-contract-v1.md`（A 创建；M10 由 C 复制进出树骨架；M12 由 D 移除 in-tree 副本）：固定 manifest 字段、`registerWorkspaceSurface()` 单一入口、生命周期义务（§20）、兼容承诺（§13）、honest limits（D2）
- 新增 `scripts/verify-page-app-source-boundary.ts` + `scripts/verify-page-app-source-boundary.spec.ts`：扫描声明为 Feature 的源码目录（`packages/examples/page-app-fixture/src`）与依赖清单，检出 import/require/dynamic import 的 `cordis`/`@deepseek-ai/cordis` 与 package.json 直接依赖；供 M12 由 D 接入 `run-gates` 与根 `package.json` scripts
- 新增 `packages/examples/page-app-fixture/`（骨架，名称 `@deepseek-ai/dsh-page-app-fixture`，参照 examples 命名 `@deepseek-ai/dsh-acp-demo`）：package.json（`dsh.bundle.patch` + `dsh.client.platform: web` + `dsh.workspace.schemaVersion: 1`，无任何 cordis 依赖）、cordis.patch.yml（空根上组合出唯一 rootEntryId）、src/index.ts（host apply）、src/client/index.tsx（keyed surface 贡献）、tsconfig.json、tsdown.config.ts、invariant.ts、tests/fixture.spec.ts、README.md + README.zh.md
- 修改 `tsconfig.host.json` + `tsconfig.client.json`：fixture 聚合引用（A 唯一 owner）
- 修改 `packages/examples/page-app-fixture/package.json`：devDependencies 与 workspace 依赖（不含 cordis）

**测试文件与测试名称：**
- `packages/host/page-app-manager/tests/validation.spec.ts`（新增用例）：`rejects a package declaring a direct cordis dependency`、`rejects a package declaring a direct @deepseek-ai/cordis dependency`、`accepts a package whose dependencies are cordis-free`、`refuses an unsupported contract version through the supportedContractVersions constant`、`runs the dependency boundary after pnpm staging but before any ownership mutation`
- `packages/host/page-app-manager/tests/contract.spec.ts`（新文件）：`assertSupportedContractVersion accepts version 1 and rejects 2`、`SUPPORTED_CONTRACT_VERSIONS is frozen and contains exactly 1`
- `scripts/verify-page-app-source-boundary.spec.ts`（新文件）：`flags a fixture source importing cordis`、`flags a fixture package declaring a cordis dependency`、`passes the clean fixture`、`ignores non-feature packages outside the declared scope`
- `packages/examples/page-app-fixture/tests/fixture.spec.ts`（新文件）：`fixture manifest is a valid contract-v1 workspace package (parsePageAppManifest passes)`、`fixture source never imports cordis (source boundary)`、`fixture declares no cordis dependency`

**RED 命令与预期失败：** `pnpm exec vitest run packages/host/page-app-manager/tests/contract.spec.ts packages/host/page-app-manager/tests/validation.spec.ts scripts/verify-page-app-source-boundary.spec.ts packages/examples/page-app-fixture/tests/fixture.spec.ts`；预期：contract.spec 失败（常量不存在）、validation 新用例失败（依赖边界未实现）、scripts spec 失败（脚本不存在）、fixture.spec 失败（包不存在）。

**最小 GREEN 实现步骤：**
- [ ] 1. contract.ts 常量与断言函数。
- [ ] 2. validation.ts：在 `validateInstalledPageAppPackage` 的 manifest 校验段后加依赖边界（读 `resolveInstalledPackageDir` 下 package.json 的 dependencies）；契约版本检查改走常量。
- [ ] 3. 契约文档（§4 格式：manifest 字段、入口 API、生命周期义务、兼容承诺、honest limits；文档链接 Design 与本计划）。
- [ ] 4. fixture 骨架（package.json/tsconfig/tsdown/patch/src/tests/README 对）；`pnpm install` 由 D 在合并时收敛 lockfile。
- [ ] 5. verify-page-app-source-boundary 脚本 + spec（扫描范围显式参数化，默认 fixture 目录；源码正则：import/require/动态 import 的 cordis 说明符）。
- [ ] 6. tsconfig 聚合引用 + `pnpm exec tsc -b tsconfig.host.json tsconfig.client.json`。

**focused regression：** `pnpm exec vitest run packages/host/page-app-manager/tests/validation.spec.ts packages/boot/page-app-profile/tests/manifest.spec.ts`；`pnpm exec vitest run scripts/verify-page-app-source-boundary.spec.ts`。

**全局门禁：** `pnpm run lint`、`pnpm run typecheck`、`pnpm run verify-cordis-config`（fixture 的 patch 语法）。

**Context7 preflight 主题：** Batch 2 Cordis（Adapter 面对的表面；依赖边界在已构建包上的诚实局限，D2 non-goals）。

**验收证据：** 依赖边界四用例 + 契约常量用例绿；fixture 通过 `verify-page-app-source-boundary`；`git grep -n "cordis" packages/examples/page-app-fixture/package.json` 无命中（peer/dev 除外——fixture 不得声明 cordis 依赖）。

**commit 边界与回滚点：** 单 commit `feat(page-apps): define workbench contract v1 and strict-mode admission`；回滚点 = 该 commit（契约常量/依赖边界/fixture 骨架一并回滚）。

### 5.8 M6 — Cordis Compatibility Adapter 抽取（Lane A，Batch 2；D3 的 G-10，A5）

**目标：** 新建 `adapter.ts` 作为 Manager 内唯一 import `@deepseek-ai/cordis`、`cordis-plugin-loader`、`cordis-plugin-include` 的文件；`managedRootHash`/`applyEntryPatches`/loader 读访问收敛其中；既有行为完全不变（行为保持重构，§50）；grep 门禁测试证明其余产品文件无 Cordis import（G-10）。

**前置：** M5。

**文件（全部 Lane A 所有）：**
- 新增 `packages/host/page-app-manager/src/adapter.ts`：`managedRootHash(row): string`（委托 `canonicalManagedRootHash`）、`composePatchRows(patches): EntryOptions[]`（委托 `applyEntryPatches`）、`findLoaderRow(loader, rootEntryId)`（`loader.entries()` 查找）、`fiberStateOf(loaderRow)`（读 `fiber.state`）；JSDoc 说明每个函数映射的 Workbench 关注点与 Cordis 机制（设计 §14）
- 修改 `packages/host/page-app-manager/src/index.ts`：`factsOf` 中 `loadOverlayPatches`/`applyEntryPatches`/`canonicalManagedRootHash` 改经 adapter；`import type { Context }` 保留（类型面）；`applyEntryPatches` 运行时 import 移到 adapter
- 修改 `packages/host/page-app-manager/src/validation.ts`：patch 组合经 adapter
- 修改 `packages/host/page-app-manager/src/transaction.ts`：`stageFromRegistry` 的组合与哈希经 adapter
- 修改 `packages/host/page-app-manager/package.json`：把 `@deepseek-ai/cordis`、`cordis-plugin-loader`、`cordis-plugin-include` 从 peerDependenciesMeta 的 optional 移为必选 peer（adapter 是唯一消费点，语义不变）——若实现时确认可选标记另有用途则保持，并记录在 README
- 新增测试 `packages/host/page-app-manager/tests/adapter.spec.ts`

**测试文件与测试名称：**
- `packages/host/page-app-manager/tests/adapter.spec.ts`（新文件）：`managedRootHash matches canonicalManagedRootHash for the same row`、`composePatchRows composes patches exactly as the include plugin does`、`findLoaderRow finds the loader row by root entry id`、`fiberStateOf reads the fiber state of a loader row`
- `packages/host/page-app-manager/tests/adapter.spec.ts`（同文件，grep 门禁）：`no manager product file imports Cordis outside adapter.ts`（扫描 `src/*.ts` 的 import 说明符，exclude adapter.ts）

**RED 命令与预期失败：** `pnpm exec vitest run packages/host/page-app-manager/tests/adapter.spec.ts`；预期：文件不存在（RED）。

**最小 GREEN 实现步骤：**
- [ ] 1. 建 adapter.ts 并实现四个纯委托函数（先于任何调用点迁移）。
- [ ] 2. 逐调用点迁移（index.ts → validation.ts → transaction.ts），每迁移一个跑 focused tests 保持绿（行为保持）。
- [ ] 3. grep 门禁测试（fs 扫描 src 目录 import 面）。
- [ ] 4. README 对更新（Adapter 定位与兼容承诺）。

**focused regression：** `pnpm exec vitest run packages/host/page-app-manager/tests`（全部既有测试保持绿 = 行为不变证据）。

**全局门禁：** `pnpm run lint`、`pnpm run typecheck`。

**Context7 preflight 主题：** Batch 2 Cordis（Loader/Include/applyEntryPatches/loader.await 语义，适配器对照表）。

**验收证据：** 既有 transaction/validation/manager/recovery/remote/source 测试全部保持绿（无行为变化）；grep 门禁绿：`git grep -n "cordis" packages/host/page-app-manager/src --include=*.ts` 仅命中 adapter.ts 与类型 import（`import type { Context }` 允许并记录）。

**commit 边界与回滚点：** 单 commit `refactor(page-apps): concentrate Cordis calls in the adapter`；回滚点 = 该 commit。

### 5.9 M7 — Workbench Runtime provider + Feature Runtime Wrapper 父行（Lane A，Batch 2；D4 的 G-7/G-17/F-2/F-7）

**目标：** Manager Host 以 `ctx.provide` 提供 `workbenchRuntime` 能力（生命周期 = manager fiber，disposer 删除服务并通知依赖，PENDING/恢复语义由 Cordis 原生保证，§4.1）；runtime-layer 渲染器对每个 enabled 且 statically-valid 的 Feature 生成 wrapper 父行（`inject: ["workbenchRuntime"]`，Feature 组合行作为其 insert children，各自保留 Loader entry 与 ownerPackage 血缘，F-7）；`deriveRoot` 增 wrapper 模块可解析性检查：manager 包不可解析 → omit 该 root 并报 `missing-manager` 健康态（F-2，boot-after-uninstall 测试钉住）；Strict Mode 后果（Feature 仍以 Cordis entry 运行）在文档与 D2 边界上明示。

**前置：** M5、M6；Batch 2 preflight（provide/inject 依赖传播）存在。

**文件（全部 Lane A 所有）：**
- 新增 `packages/host/page-app-manager/src/wrapper.ts`：命名导出函数插件 `export const name = "page-app-manager.wrapper"`、`export const inject = ["workbenchRuntime"]`、`export function apply(ctx, config)`（config: { packageName, pageId, rootEntryId, contractVersion }）；mount 其 children（由 runtime-layer 已组合的 insert 提供），把 `WorkbenchContext` 注入面交给 Feature 模块（v1：经 contract 的 `registerWorkspaceSurface`，M9 的 fixture 消费）
- 新增 `packages/host/page-app-manager/src/workbench-runtime.ts`：`createWorkbenchRuntime(ctx)` 提供领域 API：`lifecycle.onDispose`、`surfaces.registerWorkspaceSurface(registration)`（经 adapter 的 slot 桥）、`events.on`、`storage.get/set`、`host.call`；`inject` 面最小化（设计 D4 数据面）
- 修改 `packages/host/page-app-manager/src/index.ts`：`apply` 内 `ctx.reflect.provide("workbenchRuntime", runtime, true)`（disposer 语义；fiber unload 自动回收）；wrapper 行需要的 `workbenchRuntime` 服务声明与 provide 生命周期一致
- 修改 `packages/boot/app-boot/src/profile-runtime.ts`：`deriveRoot` 改为生成 wrapper 父行（wrapper name 指向 manager 包 wrapper 入口，`insert` 为 Feature 组合行；wrapper id 取固定前缀 + 页面 id，如 `page-app.wrapper.<pageId>`）；新增 wrapper 可解析性检查（resolveInstalledPackageDir 查 manager 包；不可解析 → `{ reason: "missing-manager" }`）；`ManagedRootOmissionReason` 增 `missing-manager`；`deriveSafeRuntimeLayer` 的 omit 路径覆盖新 reason
- 修改 `packages/host/page-app-manager/src/transaction.ts`：`stageFromRegistry` 经 wrapper 渲染路径生成行（复用 app-boot 导出或本地等价，保持一致——以 app-boot 的导出函数为唯一实现，transaction 调用之）
- 修改 `packages/host/page-app-manager/src/index.ts` `factsOf`/`deriveHealth`：loaderRow 查找与哈希按 wrapper 行 id；新增 `missing-manager` 健康态映射（health 枚举扩展，wire 类型同步）
- 修改 `packages/host/page-app-manager/src/types.ts`：`PageAppHealth` 增 `missing-manager`
- 新增测试 `packages/boot/app-boot/tests/profile-runtime.spec.ts` 用例与 `packages/host/page-app-manager/tests/loader-composition.spec.ts` 用例

**测试文件与测试名称：**
- `packages/boot/app-boot/tests/profile-runtime.spec.ts`（新增用例）：`derives wrapper root rows that inject workbenchRuntime and mount feature rows as children`、`omits a root whose wrapper module cannot resolve from the profile (missing-manager health)`、`boots with zero managed roots after a manager uninstall with a surviving registry (boot-after-uninstall)`、`layer serializes the wrapper form deterministically`
- `packages/host/page-app-manager/tests/loader-composition.spec.ts`（新增用例，沿用 M2 建立的 real Loader 组合测试）：`workbenchRuntime provider loss leaves wrapper fibers PENDING and return reloads them`、`wrapper fiber with satisfied inject mounts its feature children`、`a feature surface registered through the contract carries ownerPackage equal to the feature package`
- `packages/host/page-app-manager/tests/manager.spec.ts`（新增用例）：`derives missing-manager when the wrapper module is unresolvable`、`health projects ready only when the wrapper row is active and hash-matching`

**RED 命令与预期失败：** `pnpm exec vitest run packages/boot/app-boot/tests/profile-runtime.spec.ts packages/host/page-app-manager/tests/loader-composition.spec.ts packages/host/page-app-manager/tests/manager.spec.ts`；预期：wrapper 派生/可解析性/健康态用例失败（无 wrapper 生成、无 missing-manager）。

**最小 GREEN 实现步骤：**
- [ ] 1. workbench-runtime.ts 提供 `workbenchRuntime`（最小领域 API）；index.ts provide 接线。
- [ ] 2. profile-runtime.ts：`deriveRoot` 生成 wrapper 父行 + 可解析性检查 + `missing-manager` reason；导出 wrapper 行渲染函数供 transaction 复用。
- [ ] 3. wrapper.ts 函数插件（inject `workbenchRuntime`，mount children，经 contract 注入面）。
- [ ] 4. host index.ts/types.ts：wrapper 行 id 查找 + `missing-manager` 健康态。
- [ ] 5. transaction.ts stageFromRegistry 走统一 wrapper 渲染。
- [ ] 6. 测试红转绿；README 对更新（provider/wrapper/Strict Mode 后果）。

**focused regression：** `pnpm exec vitest run packages/boot/app-boot/tests/profile-runtime.spec.ts packages/boot/app-boot/tests/include-rollback.spec.ts packages/host/page-app-manager/tests`。

**全局门禁：** `pnpm run lint`、`pnpm run typecheck`、`pnpm run verify-cordis-config`。

**Context7 preflight 主题：** Batch 2 Cordis（provide disposer 通知依赖 fiber、inject 缺失→PENDING、恢复→reload）。

**验收证据：** provider 丢失/恢复热插拔测试绿（真实 Loader）；boot-after-uninstall 测试绿；wrapper 下 Feature 的 ownerPackage 血缘测试绿；M9 可基于本里程碑继续。

**commit 边界与回滚点：** 单 commit `feat(page-apps): provide workbench runtime and wrap feature roots`；回滚点 = 该 commit（回滚后回到 direct-root 形态，M9 依赖此形态，先回滚 M9 或跳过）。

### 5.10 M8-host — 操作状态投影与 runtime 标签（Lane A，Batch 3；D6 的 G-11，A6）



**目标：** `snapshot.operation` 由 journal 相位 + registry 事实投影为 `PageAppOperationState`（`installing`/`active`/`removing`/`install-failed`/`remove-failed`/`recovery-required` 闭集；无新持久字段，D6 non-goal）；`runtimeState` 由 `String(fiberState)` 数字改为语义标签 `pending/loading/active/failed/unloading`，`DISPOSED→failed`（F-8）；非法组合（如 installing + 已提交 registry）是投影 bug，由测试钉死。

**前置：** M7。

**文件（全部 Lane A 所有）：**
- 修改 `packages/host/page-app-manager/src/types.ts`：新增 `PageAppOperationState` 与 `PageAppRuntimeStateLabel` 联合类型；`PageAppOperationView` 增 `state: PageAppOperationState`；`PageAppView.runtimeState` 类型改为标签
- 修改 `packages/host/page-app-manager/src/index.ts`：`readJournalOperation(profileDir)` 返回带 `state` 的视图（映射表：无 journal→null；prepared/staged→installing；committing→active；recovery 视图存在→recovery-required；removing/install-failed/remove-failed 经 journal+recovery 投影的闭集成员，测试钉住）；`deriveHealth` 的 `runtimeState` 走标签映射（PENDING→pending、LOADING→loading、ACTIVE→active、FAILED→failed、UNLOADING→unloading、DISPOSED→failed）
- 修改 `packages/client/ui-page-app-manager/src/client/apply.ts`（B 的 M8-client 处理 timer；本任务只读型面，见 5.11）

**测试文件与测试名称：**
- `packages/host/page-app-manager/tests/manager.spec.ts`（新增用例）：`projects installing for a prepared journal and active for committing`、`projects recovery-required when recovery is visible`、`maps runtime fiber states to semantic labels (pending/loading/active/failed/unloading)`、`maps a disposed managed root to failed until the next generation`

**RED 命令与预期失败：** `pnpm exec vitest run packages/host/page-app-manager/tests/manager.spec.ts`；预期：新用例失败（数字 runtimeState、无 state 字段）。

**最小 GREEN 实现步骤：**
- [ ] 1. types.ts 增类型与字段。
- [ ] 2. index.ts 投影映射（纯函数，便于测试）；`viewOf`/`snapshot` 走新映射。
- [ ] 3. manager.spec 红转绿。

**focused regression：** `pnpm exec vitest run packages/host/page-app-manager/tests`；`pnpm exec tsc -b packages/host/page-app-manager/tsconfig.json`。

**全局门禁：** `pnpm run lint`、`pnpm run typecheck`（wire 类型变化同步 client 面，见 5.11）。

**Context7 preflight 主题：** Batch 3 Cordis（FiberState 枚举与 DISPOSED 语义）。

**验收证据：** 投影用例绿；`git grep -n "runtimeState: String" packages/host/page-app-manager/src` 无命中。

**commit 边界与回滚点：** 单 commit `feat(page-apps): project operation states and runtime labels`；回滚点 = 该 commit。

### 5.11 M8-client — graph-wait timer 入 disposer（Lane B，Batch 3；D6 的 G-12，A7）

**目标：** `buildGraphWait` 的 `setInterval`（`apply.ts:111`）随 controller 停止即清除，不再存活至 30s 上限（G-12）；Settings 面同步显示新的 operation state 标签（M8-host 的 wire 类型变化消费面）。

**前置：** M8-host 合并入 B；M3。

**文件（全部 Lane B 所有）：**
- 修改 `packages/client/ui-page-app-manager/src/client/apply.ts`：`buildGraphWait` 返回 `{ wait, cancel }` 或接收取消回调；`createController` 把 cancel 接入 `PageAppControllerDeps`；`controller.stop()`（既有 start 返回的 disposer）调用 cancel
- 修改 `packages/client/ui-page-app-manager/src/client/controller.ts`：`awaitGraphRevision` 调用点保持；stop 时调用 cancel（若 seam 需要）
- 修改 `packages/client/ui-page-app-manager/src/client/PageAppSettingsTab.tsx`：operation 展示使用 `snapshot.operation.state` 标签文案（locales 增键）

**测试文件与测试名称：**
- `packages/client/ui-page-app-manager/tests/apply.client.spec.ts`（新增用例）：`clears the graph-wait interval on controller disposal`（fake timers 断言无残留 interval）
- `packages/client/ui-page-app-manager/tests/settings.client.spec.tsx`（新增用例）：`renders the projected operation state label from the snapshot`

**RED 命令与预期失败：** `pnpm exec vitest run packages/client/ui-page-app-manager/tests/apply.client.spec.ts packages/client/ui-page-app-manager/tests/settings.client.spec.tsx`；预期：interval 残留断言失败、标签用例失败（无 state 面）。

**最小 GREEN 实现步骤：**
- [ ] 1. buildGraphWait 取消化；controller stop 链清除。
- [ ] 2. Settings 标签渲染 + locales。

**focused regression：** `pnpm exec vitest run packages/client/ui-page-app-manager/tests`；`pnpm run test:gui`。

**全局门禁：** `pnpm exec tsc -b packages/client/ui-page-app-manager/tsconfig.json`。

**Context7 preflight 主题：** Batch 3 React 18（订阅/定时器 cleanup 对称）。

**验收证据：** fake-timer 无残留 interval；标签用例绿。

**commit 边界与回滚点：** 单 commit `fix(page-apps): dispose the graph-wait interval with the controller`；回滚点 = 该 commit。

### 5.12 M9 — 真实 Feature 迁移（Lane B，Batch 3；P7 的 §54 全链，D2/D4 落地）

**目标：** 把 M5 创建的 fixture 从直接 `ctx.slots` 形态迁移为 Workbench Contract 形态：经 `registerWorkspaceSurface()` 注册（不再调用 `ctx.slots`）；证明 §54 全链：不 import Cordis、用 Contract、安装、出现在 Sidebar、disable、re-enable、uninstall、Manager 挂起/恢复（e2e，keyless）；Feature dispose 后副作用全部释放。

**前置：** M5 + M7 已合并入 B；M8-host 已合并（wire 类型一致）；Batch 3 preflight（React 18）存在。

**文件（全部 Lane B 所有，fixture 所有权已随合并转移）：**
- 修改 `packages/examples/page-app-fixture/src/client/index.tsx`：经 `registerWorkspaceSurface` 注册（WorkbenchContext 注入面由 wrapper 提供），删除对 `ctx.slots` 的直接调用；`src/index.ts` 保持非 Cordis（host 面由 wrapper 组合）
- 修改 `packages/examples/page-app-fixture/package.json`：version 升 1.0.0（fixture 独立语义版本，正常 SemVer）
- 修改 `packages/examples/page-app-fixture/tests/fixture.spec.ts`：新增契约形态断言
- 新增 `apps/web/tests/workspace-apps.e2e.ts`（keyless 全链）：boot → install fixture → Host/Client 激活 → 选择 fixture → 变更 fixture 内 React 状态 → 切 DSH → 返回证明状态保留 → hide 证明保留 → disable 证明 Host+Client+React 卸载 → re-enable → uninstall 证明依赖/registry 移除 → Manager 行 disable（overlay）→ fixture PENDING → re-enable → fixture 恢复
- 新增 `apps/web/tests/workspace-apps-e2e-support.ts`（B 私有测试工具，不进生产包）

**测试文件与测试名称：**
- `packages/examples/page-app-fixture/tests/fixture.spec.ts`（新增用例）：`fixture registers its surface through the Workbench Contract (no ctx.slots call)`、`fixture source contains no cordis import and declares no cordis dependency`
- `apps/web/tests/workspace-apps.e2e.ts`（新文件）：`installs the fixture and awaits host and client activation`、`selects the fixture and preserves its React state across DSH round-trips`、`hide keeps the runtime mounted and falls back to DSH`、`disable unloads host, client, and the React subtree`、`re-enable remounts the fixture`、`uninstall removes the profile dependency and the registry row while user data survives`、`manager row disable suspends the fixture (PENDING) and re-enable restores it`、`fixture disposal releases its side effects`

**RED 命令与预期失败：** `pnpm exec vitest run packages/examples/page-app-fixture/tests/fixture.spec.ts`；预期：契约形态断言失败（fixture 仍直连 ctx.slots）。e2e：`pnpm run build` 后 `DSH_SNAPSHOT=replay pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/workspace-apps.e2e.ts`；预期：失败（无 e2e 文件或断言失败）。

**最小 GREEN 实现步骤：**
- [ ] 1. fixture client 迁移到 `registerWorkspaceSurface`；fixture.spec 红转绿。
- [ ] 2. e2e：先写测试（keyless，fixtures 用 llm-replay 无键回放）；实现 scaffold 扩展（B 所有 `apps/web/tests/scaffold.ts` 与 `assembled-boot.ts` 的新增辅助，不破坏既有 e2e）。
- [ ] 3. 全链红转绿；`pnpm run test:web:built` 的 replay 模式验证。
- [ ] 4. fixture README 对更新（v1 消费者契约：已构建 lazy-CJS client artifact，无 authoring preset）。

**focused regression：** `pnpm exec vitest run packages/examples/page-app-fixture/tests packages/client/ui-page-app-manager/tests`；`DSH_SNAPSHOT=replay pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/workspace-apps.e2e.ts apps/web/tests/workspace-apps-shell.e2e.ts`。

**全局门禁：** `pnpm run test:gui`、`pnpm run lint`、`pnpm run typecheck`、`pnpm run verify-client-packages`（fixture 的 dsh.client 声明面）。

**Context7 preflight 主题：** Batch 3 React 18（keep-mounted 与 hidden-not-unmounted 在 StrictMode 双调用下状态保持）。

**验收证据：** §54 全链 e2e 全绿（keyless replay）；fixture 无 cordis 依赖与 import；dispose 释放断言绿；`git grep -n "ctx.slots" packages/examples/page-app-fixture/src` 无命中。

**commit 边界与回滚点：** 单 commit `feat(page-apps): migrate the fixture to the workbench contract`；回滚点 = 该 commit。

### 5.13 M10 — Out-of-Tree 打包基线：tarball 内容扫描、pnpm 版本门禁、extraction seam、安装链 smoke（Lane C，Batch 4；D1/D10 的 G-6/G-9/G-15，A2）

**目标：** 在本仓库内完成可验证的出树迁移产物定义与打包基线（不假设外部仓库已存在）：(1) tarball 内容级绝对路径扫描（G-9，§56 首行可由门禁证明）；(2) pnpm 版本一致性门禁（G-15，两侧 fail）；(3) `extract-workspace-manager` 脚本把三个 in-tree 包 + 契约文档确定性生成出树仓库骨架（迁移产物定义：正常 SemVer 1.0.0、private:false、files 仅 lib 与元数据、exports 无 `./src/*`、LICENSE/CHANGELOG/README 对、peer 依赖 `@deepseek-ai/cordis`、无 `workspace:` 引用、Manager manifest 为 `dsh.bundle.patch` + `dsh.client` 且永不 `dsh.workspace`，F-3）；(4) 安装链 smoke：pack 骨架 → fresh temp Profile → `dsh plugin --profile <tmp> add <tarball>` → start → disable（overlay `disabled: true`）→ re-enable → uninstall（§48 链，本地可测）；(5) 真实创建/发布独立仓库与 registry publish 列为需用户单独授权的发布步骤，本任务只做本地验证。

**前置：** M1–M9 全部由 D 合并入 C；Batch 4 preflight（npm files/packlist + pnpm 版本 + Cordis loader.await）存在。

**文件（全部 Lane C 所有）：**
- 修改 `scripts/publication-payload.ts`：新增 `scanTarballContent(tarballPath, memberFilter)`（解 tar 成员内容，正则检 Windows 盘符（`[A-Za-z]:` 后跟反斜杠或正斜杠）与 POSIX 根（`/Users/` 与 `/home/` 起始段）绝对路径）；新增 `validateTarballPayloadContent(files, readMember, context)`；既有 `validateTarballPayload` 成员名检查保持
- 修改 `scripts/publication-payload.spec.ts`（新增用例）：`flags a member containing a Windows drive path`、`flags a member containing a POSIX root`、`passes a payload with no absolute paths`、`member-name checks still reject src and maps`
- 修改 `scripts/release/pack.ts`（+ `scripts/release/families.ts` 若校验路径在此）：`validatePayload` 调用内容扫描（读取 tarball 成员内容经 `scripts/release/tarball.ts`）；pack 后即扫
- 新增 `scripts/verify-pnpm-version.ts` + `scripts/verify-pnpm-version.spec.ts`：读根 package.json `packageManager`（`pnpm@11.7.0`）执行 `pnpm --version`，不匹配即 fail（两侧 fail：任何一侧与 pin 不同）
- 新增 `scripts/extract-workspace-manager.ts` + `scripts/extract-workspace-manager.spec.ts`：从 `packages/boot/page-app-profile`、`packages/host/page-app-manager`、`packages/client/ui-page-app-manager` 与契约文档生成 `dist/out-of-tree/dsh-workspace-manager/`（确定性；manifest 改写规则如上；spec 断言骨架 manifest 无 `workspace:`、exports 无 `./src/*`、files 仅 lib、LICENSE 存在、可 pack）
- 新增 `scripts/page-app-install-chain.smoke.ts` + spec（或扩展 `scripts/release/verify-packed-install.ts` 链）：pack 骨架 → 建临时 fresh profile → 经 `dsh` built bin 执行 add/start/disable/re-enable/uninstall；断言每步（disable 用 overlay `disabled: true` 表达，审计领域 14 无 disable 动词）
- 修改 `apps/cli/tests/built-bin.e2e.ts`：新增 `workspace manager tarball installs into a fresh profile and survives disable and uninstall (built bin)` 用例（若链式 smoke 放在 CLI 测试层则此处承接）
- 修改 `packages/host/page-app-manager/package.json`（出树 manifest 模板的 peer 依赖基准，供 extract 引用）——若实现时发现 extraction 需要 in-tree manifest 辅助字段则仅在此包内加

**测试文件与测试名称：**
- `scripts/publication-payload.spec.ts`：如上四条
- `scripts/verify-pnpm-version.spec.ts`：`fails when pnpm --version differs from the declared packageManager`、`passes when they match`（fake 版本注入）
- `scripts/extract-workspace-manager.spec.ts`：`skeleton manifest is private false with normal semver and no workspace: references`、`skeleton exports contain no ./src/* subpath`、`skeleton files cover lib only`、`skeleton includes LICENSE, CHANGELOG, and the README pair`、`skeleton declares a peer dependency on @deepseek-ai/cordis`、`skeleton never declares dsh.workspace`、`extraction is deterministic (byte-identical on rerun)`
- `scripts/page-app-install-chain.smoke.ts`（spec 内断言）：`pack produces a tarball with no absolute paths (content scan green)`、`fresh profile installs the manager tarball and starts`、`disable via overlay keeps native DSH and uninstall removes the dependency`

**RED 命令与预期失败：** `pnpm exec vitest run scripts/publication-payload.spec.ts scripts/verify-pnpm-version.spec.ts scripts/extract-workspace-manager.spec.ts`；预期：新 spec 失败（函数/脚本不存在）。链式 smoke：GREEN 后执行。

**最小 GREEN 实现步骤：**
- [ ] 1. publication-payload 内容扫描 + 测试；pack.ts 接线。
- [ ] 2. verify-pnpm-version 脚本 + 测试（当前本机 11.7.0 与 pin 一致 → pass；spec 用 mock 版本验证 fail 侧）。
- [ ] 3. extract-workspace-manager 脚本 + 测试（骨架生成到 `dist/out-of-tree/`，gitignored）。
- [ ] 4. 链式 smoke：pack 骨架（`pnpm run build` 后）→ fresh temp profile → built bin add/start/disable/re-enable/uninstall；断言每步。
- [ ] 5. README/CHANGELOG 骨架模板内容定义（在脚本内以常量模板给出，随 spec 断言）。

**focused regression：** `pnpm exec vitest run scripts/publication-payload.spec.ts scripts/verify-pnpm-version.spec.ts scripts/extract-workspace-manager.spec.ts apps/cli/tests/built-bin.e2e.ts -t "workspace manager"`。

**全局门禁：** `pnpm run build`（链式 smoke 需要 built bin 与 built 包）、`pnpm run lint`。

**Context7 preflight 主题：** Batch 4 npm（files/private/packlist：最终 tarball 必须实测，npm 不重跑 packlist）、pnpm 版本、Cordis loader.await。

**验收证据：** 内容扫描 spec 绿且对含盘符/根的 fixture tarball 拒收；版本门禁两侧 fail 用例绿；骨架 spec 全部绿；链式 smoke 全绿；`dist/out-of-tree/dsh-workspace-manager` 的 `npm pack`（或 pnpm pack）产物通过内容扫描。

**commit 边界与回滚点：** 单 commit `feat(release): scan tarball content, pin pnpm, and prove the out-of-tree install chain`；回滚点 = 该 commit。**外部状态说明：** 实际 `git init` 独立仓库、推送到远程、`npm publish` 属用户授权的外部发布步骤，不在本任务执行；本任务产物（extraction 骨架、扫描、链式 smoke）全部本地可复现。

### 5.14 M11-host — Legacy 删除（Lane A，Batch 4；D12 的 §55 P8）

**目标：** 按 D12 判定标准删除 legacy：(1) `watchUserPatches`（`packages/boot/app-boot/src/index.ts:253-286` 死代码）——先把三个 spec 文件（`include-rollback.spec.ts`、`profile-runtime.spec.ts`、`user-patches.spec.ts`）的引用迁移到 `ProfileRuntime` watcher 路径，再删除并 grep 证明零引用；(2) direct-root runtime 形态——M7 后渲染器只产出 wrapper 行，删除 raw-root 回退路径与未契约面（§55：不允许两套 runtime 并存）。每个删除独立 commit、独立测试锚点，删除与替代不在同一 commit（D12）。

**前置：** M7、M9 已合并；Batch 4 preflight（loader.await 启动错误语义）存在；grep/graph 证据：`git grep -n "watchUserPatches"` 仅命中 spec 文件与 index.ts。

**文件（全部 Lane A 所有）：**
- 修改 `packages/boot/app-boot/tests/include-rollback.spec.ts`、`packages/boot/app-boot/tests/profile-runtime.spec.ts`、`packages/boot/app-boot/tests/user-patches.spec.ts`：把 `watchUserPatches` 引用迁移到 `ProfileRuntime` 的 watcher/重组合路径（行为断言不变，subject 换为 ProfileRuntime）
- 修改 `packages/boot/app-boot/src/index.ts`：删除 `watchUserPatches` 及仅其使用的导出（`loadOptionalPatches` 等按引用面保留或一并删除，以 grep 为准）
- 修改 `packages/boot/app-boot/src/profile-runtime.ts`：删除 direct-root 回退分支（若 M7 后存在 raw-root 生成残留）；wrapper-only 断言由测试钉住
- 修改 `packages/host/page-app-manager/src/transaction.ts`：删除 `stageFromRegistry` 的 raw-root 分支（若有）

**测试文件与测试名称：**
- `packages/boot/app-boot/tests/profile-runtime.spec.ts`（新增用例）：`ProfileRuntime composition covers the user-patch watcher path formerly served by watchUserPatches`、`no direct-root form remains (derivation emits wrapper rows only)`
- `packages/boot/app-boot/tests/config-reload.spec.ts`、`user-patches.spec.ts`、`include-rollback.spec.ts`：迁移后保持绿（回归面）

**RED 命令与预期失败：** 迁移前先跑 `pnpm exec vitest run packages/boot/app-boot/tests/user-patches.spec.ts packages/boot/app-boot/tests/config-reload.spec.ts` 记录绿基线；删除后 `git grep -n "watchUserPatches"` 预期零命中（这是删除前提，先绿后删）。

**最小 GREEN 实现步骤：**
- [ ] 1. 迁移三个 spec 到 ProfileRuntime 路径（先写/改测试，绿）。
- [ ] 2. 删除 `watchUserPatches` 与死导出；grep 零引用；focused 全绿。
- [ ] 3. 删除 direct-root 回退（若存在）；wrapper-only 断言绿。
- [ ] 4. README 对更新（app-boot 删减面）。

**focused regression：** `pnpm exec vitest run packages/boot/app-boot/tests`；`git grep -n "watchUserPatches"` 零命中；`pnpm exec tsc -b packages/boot/app-boot/tsconfig.json`。

**全局门禁：** `pnpm run lint`、`pnpm run typecheck`。

**Context7 preflight 主题：** Batch 4 Cordis（loader.await 对不可解析模块的启动错误语义，删除前确认无其它调用面）。

**验收证据：** 迁移后三个 spec 绿；`watchUserPatches` 删除后全仓 grep 零命中；wrapper-only 断言绿；§57 DoD 行 `不存在第二套与 Cordis 重叠的生命周期系统` 保持。

**commit 边界与回滚点：** 两个独立 commit：(a) `test(app-boot): migrate user-patch specs to the profile runtime watcher`，(b) `refactor(app-boot): remove watchUserPatches and the direct-root form`；回滚点 = 各自 commit（先回滚 (b)，再回滚 (a)）。

### 5.15 M12 — 组装验收、文档、Agent Note、门禁接线（Lane D，Batch 4；§22/§26/§57）

**目标：** 完成组装级验收与收尾：(1) 两 profile 真实组合 e2e 与 keyless 快照（G-14）；(2) 子系统/架构文档与 i18n 对更新、Agent Note（§26）；(3) 新门禁接入共享文件（根 package.json scripts、`scripts/run-gates.ts` ci-static、`.github/workflows/ci.yml`）；(4) manager bundle 行移除（D12 判定标准：D1 安装链 proven + D5 兜底绿后执行）；(5) 修复 page-app-profile README 既有 doc-typecheck 红项；(6) 全量比例门禁与 `git diff --check`。

**前置：** M10、M11-host 合并入 D；Batch 4 preflight 存在。

**文件（全部 Lane D 所有，除注明）：**
- 新增 `.agents/notes/implemented/architecture/2026-08-25-workspace-apps-architecture-optimization.md` + `.zh.md`：记录 D1–D12 裁决、审计→决策映射、命名验证契约（§26）
- 修改 `docs/subsystems/workspace-apps.md` + `.zh.md`：contract v1、adapter、workbenchRuntime provider、wrapper、root 兜底、CLI 分类、出树形态（最低拥有层级，遵守 docs/AGENTS.md 一事实一归属）
- 修改 `docs/architecture.md`（≤1800 words budget）：Workspace Manager 出树/Provider 定位行（若既有架构图含 bundle 常驻表述则更新）
- 修改 `packages/boot/page-app-profile/README.md`：修复既有 doc-typecheck 红项（失败的 ts fence 改为可编译形态或 `type-equiv` 并在 doc-typecheck-paths 注册——以实现时门禁说明为准；不得留红）
- 修改 根 `package.json`：新增 scripts `verify-page-app-source-boundary`、`verify-pnpm-version`（唯一 owner D）
- 修改 `scripts/run-gates.ts`：`ci-static` 增 `verify-page-app-source-boundary`（fixture 存在时）、`verify-pnpm-version`（唯一 owner D）
- 修改 `.github/workflows/ci.yml`：`ci-static` job 接线（唯一 owner D）
- 修改 `packages/bundle/web-app/cordis.patch.yml` + `package.json`：移除 `page-app-manager` 与 `ui-page-app-manager` 行与依赖（D12 判定标准满足后；移除后 Native DSH 仍由 M3 兜底渲染）
- 新增 `apps/web/tests/workspace-apps-profiles.e2e.ts`（Lane B 创建，D 协调——按 §2.3 该文件 owner 为 B；M12 由 B 在 D 合并基础上执行，或 D 合并 B 已交付文件；以 §2.3 为准）
- 新增 `apps/web/tests/snapshots/workspace-apps/**`（keyless 快照；owner B 按 §2.3）
- 修改 `apps/web/tests/settings-chrome.e2e.ts`（仅当新 tab 有意图地改变 shipped snapshot；owner B）

**测试文件与测试名称：**
- `apps/web/tests/workspace-apps-profiles.e2e.ts`（新文件，keyless）：`installs in Profile A and proves Profile B sees no row or code`、`manages the same package independently in both profiles without crossing revisions or orders`
- `apps/web/tests/workspace-apps.e2e.ts`（回归面）+ `workspace-apps-shell.e2e.ts`（回归面）：Manager 行移除后仍绿（兜底生效）

**RED 命令与预期失败：** `DSH_SNAPSHOT=replay pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/workspace-apps-profiles.e2e.ts`；预期：文件不存在（RED，新建后绿）。

**最小 GREEN 实现步骤：**
- [ ] 1. Agent Note + 子系统文档 + architecture.md 更新（一事实一归属；链接验证）。
- [ ] 2. page-app-profile README 红项修复（本地 `pnpm run doc-typecheck` 收敛到仅剩 2026-08-22 plan 一项）。
- [ ] 3. 共享文件接线（scripts、run-gates、CI）；`pnpm exec tsx scripts/verify-page-app-source-boundary.ts` 与 `pnpm exec tsx scripts/verify-pnpm-version.ts` 直接可跑。
- [ ] 4. manager 行移除（先确认 M10 链式 smoke + M3 兜底 e2e 绿）；移除后跑 web e2e 回归。
- [ ] 5. 两 profile e2e（B 交付文件，D 合并验证）。
- [ ] 6. 快照（keyless replay；有意图变更才 record）。
- [ ] 7. 全量比例门禁（下）。

**focused regression / 全量比例门禁（fresh output）：**
- `pnpm exec vitest run packages/boot/page-app-profile/tests packages/boot/app-boot/tests packages/host/page-app-manager/tests packages/client/connection/tests/node-half.host.spec.ts packages/client/modules/tests packages/client/hmr/tests packages/client/ui-page-app-manager/tests packages/client/ui-layout/tests apps/cli/tests/plugin.spec.ts`
- `pnpm run test:gui`、`pnpm run typecheck`、`pnpm run lint`、`pnpm run build`、`pnpm run hygiene`、`pnpm run test:coverage`（三包 per-file 100%）
- PowerShell：`$env:DSH_SNAPSHOT="replay"; pnpm run test:web; Remove-Item Env:DSH_SNAPSHOT`
- `pnpm run doc-sync`、`pnpm run doc-typecheck`（新增红项 = 0）
- `git diff --check`；`git status --short` 检查生成物

**全局门禁：** 上列全量。

**Context7 preflight 主题：** Batch 4 npm/pnpm/Cordis（已有结论复用；无新增查询）。

**验收证据：** §57 DoD 22 项全部映射到绿锚点（§6.4 对照表）；两 profile e2e 绿；快照绿；doc-typecheck 无新增红项；`git diff --check` 干净。

**commit 边界与回滚点：** 拆 4 个 commit：(a) `docs(page-apps): document the architecture optimization and note D1-D12`，(b) `chore(gates): wire page-app strict-mode and pnpm version gates`，(c) `chore(bundle): remove the shipped manager rows behind the fallback`，(d) `test(page-apps): prove two-profile isolation and assembled acceptance`；回滚点 = 各自 commit，逆序回滚。

---

## 6. 覆盖矩阵

### 6.1 Formal Design 决策 D1–D12 → 任务

| 决策 | 任务 | 关键测试锚点 |
|---|---|---|
| D1 出树交付形态 | M5（契约文档 in-tree）、M10（extraction seam/链式 smoke） | extract spec、install-chain smoke |
| D2 Workbench Contract v1 + Strict Mode | M5、M9 | contract/validation spec、fixture source-boundary |
| D3 Cordis Adapter | M6 | adapter.spec 与既有套件保持绿 |
| D4 Workbench Runtime + Wrapper | M7、M9 | provider-loss/return、boot-after-uninstall、ownerPackage 血缘 |
| D5 Root Shell 兜底 + failure surface | M3 | no-manager boot、root-crash、双加载序、HMR 周期 |
| D6 状态模型 | M8-host、M8-client | 投影映射、DISPOSED→failed、timer disposer |
| D7 Registry/ownership/profile | 无代码改动（P-1 复锁） | 既有 registry/authorization 套件 |
| D8 锁/journal/rollback/recovery | M1.1、M1.2、M2 | 四路径一致性、ack 超时、journal 守卫、recover 入锁 |
| D9 Host/Client 授权 | M1.2（取消按钮） | route-level 403 既有套件 + cancel 用例 |
| D10 出树打包/发布/安装链 | M10 | 内容扫描、版本门禁、链式 smoke |
| D11 CLI 共存 | M4 | 锁争用、分类 e2e |
| D12 Legacy 删除标准 | M11-host、M12(c) | 迁移后 spec 绿 + grep 零引用 + 兜底 e2e |

### 6.2 Self-Review 发现 F-1–F-12 → 任务

| 发现 | 修正落点 | 任务 |
|---|---|---|
| F-1 root 双 occupant/渲染层矛盾 | priority 1 兜底 + 让路协议（D5 修订） | M3 |
| F-2 wrapper 不可解析 → boot 失败 | `missing-manager` omit（D4 修订） | M7 |
| F-3 Manager manifest 与 D11 分类矛盾 | Manager 永不声明 `dsh.workspace` | M1（manifest 约束）+ M10 extract + M4 |
| F-4 空期望哈希污染 audit | 真实 `canonicalManagedRootHash`（D8 修订） | M2 |
| F-5 ack 永不证明收敛 | client-graph rev 精确握手（D8 修订） | M1.1 |
| F-6 journal 覆盖/recover 无锁 | 守卫 + recover 入锁（D8 修订） | M2 |
| F-7 wrapper 父子关系歧义 | 父行形态钉死（D4 修订） | M7 |
| F-8 DISPOSED 无标签 | DISPOSED→failed（D6 修订） | M8-host |
| F-9 同步 CLI 与 promise 锁冲突 | runPlugin 异步化（D11 修订） | M4 |
| F-10 事务未绑 fiber | lifecycle.dispose abort（D8 修订） | M1.1 |
| F-11 依赖边界前置措辞不实 | pnpm 后/ownership 前拒绝（D2 修订） | M5 |
| F-12 P-13 证据路径错 | scoped-slots.tsx 修正 | 文档层面已修，无需任务 |

### 6.3 Gap Matrix 关键行 → 任务

| Gap Matrix 行 | 任务 |
|---|---|
| §7 root 兜底（P0） | M3 |
| §17 Manager 热插拔（B2） | M7（provider 传播）+ M3（shell） |
| §20 副作用（A7） | M8-client |
| §21 故障传播（B1/B5） | M3 |
| §27 管理域隔离（A3） | M4 |
| §42/§43 事务（A1/A2） | M1.1、M2 |
| §44 last-known-good（A2） | M2 |
| §4/§5/§6 出树/包/安装（P0） | M10 |
| §9 Strict Mode（C4） | M5 |
| §11/§14/§15/§19 契约/Adapter/Provider/Wrapper | M5、M6、M7 |
| §48 P1 打包基线 | M10 |
| §53 P6 Shell 热插拔 | M3 |
| §54 P7 真实 Feature | M9 |
| §55 P8 legacy | M11-host、M12(c) |

### 6.4 主规格 §57 DoD → 验收锚点

| DoD 条目 | 锚点 |
|---|---|
| Out-of-Tree 独立仓库 | M10 extract 骨架 + 用户授权发布步骤 |
| npm pack/publish 可用 | M10 内容扫描 + 链式 smoke |
| DSH Plugin Manager 安装到 fresh Profile | M10 链式 smoke |
| Manager enable/disable/re-enable/uninstall | M10 链式 smoke + M3 P6 e2e |
| Manager 不存在时 Native DSH 正常 | M3 no-manager boot |
| Feature 禁止直接依赖 Cordis | M5 依赖边界 + M9 源码边界 |
| Workbench Contract v1 版本化 | M5 常量 + admission |
| Cordis 调用集中在 Adapter | M6 grep 门禁 |
| Feature 生命周期映射 Cordis Fiber | M7 wrapper + loader-composition |
| Provider 消失→子树失活 | M7 provider-loss 测试 |
| Provider 恢复→自动恢复 | M7 反向测试 |
| 单 Feature 拔出隔离 | M9 disable 单根 + 既有测试 |
| dispose 副作用全清理 | M9 释放断言 |
| Registry 仍为 ownership 权威 | 既有 registry 测试 + M12 两 profile |
| 外部插件不能绕过 Registry | 既有 authorization 矩阵 |
| Profile 隔离完整 | M12 workspace-apps-profiles.e2e |
| Hide/Disable/Uninstall 语义独立 | 既有 transaction/controller 测试 |
| install/uninstall 事务 rollback/recovery | M1.1/M2 测试 |
| disable/uninstall 不删用户数据 | 既有 P-12 测试 + M9 uninstall 断言 |
| Original DSH 导航状态保留 | 既有 shell DOM 同一性测试 + M12 |
| 无无意产品回归 | M12 全量比例门禁 |
| 无第二套生命周期系统 | P-3 既有测试 + M7 组合测试 |

### 6.5 主规格 §56 测试矩阵 → 归属（含既有绿行）

| §56 行 | 归属 |
|---|---|
| npm pack 成功且无绝对路径 | M10（新） |
| fresh Profile 安装 Manager | M10（新） |
| disable Manager → Native DSH 正常、Features PENDING | M3 + M7（新） |
| re-enable Manager → 自动恢复 | M7（新） |
| disable Script → 仅 Script 子树受影响 | M9（新，机制既有） |
| re-enable Script → 恢复 | M9（新） |
| Feature import Cordis → CI FAIL | M5（新门禁） |
| Feature 依赖 cordis → CI FAIL | M5（新门禁） |
| unsupported Contract version 拒绝 | M5（新） |
| dispose 释放全部副作用 | M9（新） |
| Manager Surface crash → Native DSH 恢复 | M3（新） |
| external plugin 不进 Managed Sidebar | 既有 authorization.client.spec.ts |
| Profile A 安装 → B 不可见 | M12（新 e2e） |
| hide ≠ unload | 既有 transaction.spec setHidden |
| disable ≠ 删包 | 既有 transaction.spec setEnabled |
| uninstall 保留用户数据 | 既有 + M9 |
| Script→Board→Script 状态保留 | 既有 shell.client.spec.tsx DOM 同一性 |
| DSH→Script→DSH 状态保留 | 既有 shell.client.spec.tsx |
| install rollback 失败 → recovery-required 可见 | M2（新） |
| uninstall 失败 → ownership 保留 | M2（新） |

## 7. 既有 doc-typecheck 红项记录（独立记录，非跳过理由）

执行 `pnpm run doc-typecheck` 时（M0 Step 3 实测基线），全仓失败项为：

| 文件 | 红项 | 处置 |
|---|---|---|
| `docs/superpowers/plans/2026-08-22-dsh-workspace-apps.md` | 既有失败 ts fence | 冻结计划文档，不修改；M0 记录为基线，M12 确认无新增 |
| `packages/boot/page-app-profile/README.md` | 既有失败 ts fence | M12 修复（README 本就要更新；失败 fence 改可编译或 `type-equiv` 注册） |

规则：本计划所有新增/修改文档不得新增红项（本文档的 ts fence 仅限 §5 中标注的纯自包含片段，均已按 host aggregate 可编译设计）；既有红项不作为跳过 doc-typecheck 的理由。

## 8. 执行表（批次 → DSH 对话 → 文件所有权 → 前置 → 合并顺序 → 验证命令）

| 批次 | DSH 对话 | 里程碑 | 文件所有权（§2.3 简表） | 前置 | 合并顺序 | 验证命令（每任务聚焦；此处为批次级） |
|---|---|---|---|---|---|---|
| Batch 1 | A（lane/a-host-runtime） | M0、M1.1、M2 | host/page-app-manager、app-boot、bundle/cordis.patch.yml（config 行）、batch-1-preflight | 无（M0）；M0（M1.1）；M1.1（M2） | A 首批 | `pnpm exec vitest run packages/host/page-app-manager/tests packages/boot/app-boot/tests`；`pnpm run typecheck` |
| Batch 1 | B（lane/b-client-ui） | M3、M1.2 | client/ui-page-app-manager、client/ui-layout、apps/web/tests/workspace-apps-shell.e2e.ts | 无（M3）；M1.1 合并（M1.2） | A→B（M1.1 后） | `pnpm exec vitest run packages/client/ui-page-app-manager/tests packages/client/ui-layout/tests`；`pnpm run test:gui` |
| Batch 2 | C（lane/c-cli-packaging） | M4 | apps/cli/src/plugin.ts、bin.ts、tests、package.json | Batch 2 preflight | C 独立（可并行 Batch 1） | `pnpm exec vitest run apps/cli/tests/plugin.spec.ts apps/cli/tests/args.spec.ts`；built-bin 过滤 |
| Batch 2 | A | M5、M6、M7 | 同 A + fixture、contract.ts、verify-page-app-source-boundary.ts、tsconfig 聚合 | M2（M5）；M5（M6）；M5+M6（M7） | A 第二批 | `pnpm exec vitest run packages/host/page-app-manager/tests packages/boot/app-boot/tests scripts/verify-page-app-source-boundary.spec.ts packages/examples/page-app-fixture/tests` |
| Batch 3 | A | M8-host | 同 A（types/index） | M7 | A 第三批 | `pnpm exec vitest run packages/host/page-app-manager/tests/manager.spec.ts` |
| Batch 3 | B | M8-client、M9 | 同 B + fixture（M5 合并后）+ workspace-apps.e2e.ts | M8-host 合并（M8-client）；M5+M7 合并（M9） | A→B（M5+M7 后） | `pnpm exec vitest run packages/client/ui-page-app-manager/tests packages/examples/page-app-fixture/tests`；`DSH_SNAPSHOT=replay pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/workspace-apps*.e2e.ts` |
| Batch 4 | C | M10 | scripts/publication-payload/release、verify-pnpm-version、extract-workspace-manager、install-chain smoke、built-bin.e2e.ts | M1–M9 全合并 | A+B→C | `pnpm exec vitest run scripts/publication-payload.spec.ts scripts/verify-pnpm-version.spec.ts scripts/extract-workspace-manager.spec.ts`；链式 smoke |
| Batch 4 | A | M11-host | app-boot index/profile-runtime、三个 spec | M7+M9 合并 | — | `pnpm exec vitest run packages/boot/app-boot/tests`；`git grep -n "watchUserPatches"` 零命中 |
| Batch 4 | D（lane/d-integration） | M12 | 根 package.json、run-gates、workflows、docs/subsystems、architecture.md、Agent Note、bundle web-app（移除）、README 红项 | 全部合并 | A+B+C→D→feature/workspace-apps | §5.15 全量比例门禁 |

## 9. 回滚与故障恢复（编排层）

- 回滚单元与批次回滚见 §3.4；每任务 commit 为最小回滚点（§5 各任务）。
- lane 卡死/工具失败：按 fail-log-guide 技能查历史错因；先修复再重试，禁止绕过门禁。
- Context7 preflight 缺失：lane 停止并报告，不静默继续。
- 意外越界写：D 丢弃越界方改动并让该 lane 重做（§3.3）。
- 外部发布（独立仓库创建、npm publish、uninstall/republish）：一律需用户单独授权；授权后按 M10 定义的迁移产物与链式 smoke 先验证后发布。

## 10. 完成标准（§57 DoD 对照入口）

实现完成的判定 = §6.4 全部 DoD 锚点绿 + §6.5 全部 §56 行绿 + M12 全量比例门禁绿 + Codex 四个 checkpoint 全部通过 + 用户手工验收（Web GUI 手测 Manager 安装/禁用/恢复与 Native DSH 兜底）。本计划执行后 Codex 输出 checkpoint 报告与最终验收证据包。
