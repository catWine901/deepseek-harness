# Agent Note: 工作区应用通过版本化 Workbench 运行时工作

Status: implemented

[English](2026-08-25-workspace-apps-architecture-optimization.md) | 中文

## Problem

工作区应用已经具备可靠的 Profile 注册表、事务性包操作、客户端来源检查与保持挂载的表面，但交付和生命周期没有满足这些保证。管理器是 Web 组合包中的常驻行，托管功能可以直接导入 Cordis，管理器消失不会暂停其运行时行，内置 DSH 表面依赖管理器外壳，包发布也缺少端到端的版本与制品证明。取消、回滚、激活结算、CLI 共存、运行时状态标签及双 Profile 隔离同样存在缺口，可能让实时树、磁盘状态或操作员视图不一致。

## Decision

以下决策定义已交付系统；当前状态由[工作区应用](../../../../docs/subsystems/workspace-apps.zh.md)引用页持有。

- **D1 — 交付：** 管理器被提取为树外 npm 包，并通过 `dsh plugin` 按 Profile 安装；Web 组合包不携带常驻管理器行。
- **D2 — Workbench Contract v1：** `dsh.workspace.schemaVersion: 1` 是准入的 manifest 版本。在声明的源码作用域内，托管功能源码与依赖 manifest 不得接触 Cordis；该检查无法证明源码不可用的第三方包。
- **D3 — Cordis 边界：** 常规管理器产品代码通过 `src/adapter.ts` 委托 Cordis、Include、Loader、哈希、fiber 投影与包装层挂载。唯一额外且经过审计的边界是明确命名的旧版 rc.2 兼容桥：它只在精确匹配公开 app-boot 0.1.1-rc.2 指纹且缺少原生 `ProfileRuntime` 时激活，通过同一 FIFO 协调旧 watcher 与 Manager 写入，并在原生路径上保持 no-op。其他位置的 Cordis 运行时导入会被拒绝。
- **D4 — 运行时提供方与包装层：** 管理器提供 `workbenchRuntime`；每个启用的托管根都嵌套在注入该服务的确定性包装层下。提供方消失会停驻依赖的功能 fiber，提供方恢复会重新加载它们，包装层保留各功能行及其包来源。
- **D5 — 外壳回退：** 管理器持有工作区栏与托管 Surface Host，`ui-layout` 则保留一份优先级为 1 的 `AppFrame` 注册，并在 Native DSH 回退与管理器内置席位之间原子式 `retarget` 同一个实时条目。后到的管理器接管及随后离开时，条目、子声明、已加载后代、`store` 状态、元数据与 disposer 都保持不变；失败的托管表面仍被隔离在管理器持有的重试/卸载界面后。
- **D6 — 状态投影：** 操作状态从 journal 相位与恢复事实派生，运行时状态使用 Cordis 语义标签，客户端图等待计时器归控制器 disposer 所有。
- **D7 — 所有权与隔离：** `.workspace-manager/registry.json` 保持为唯一所有权权威；运行时清单只用于观察，每个注册表、事务、已安装包、修订与顺序都保持 Profile 作用域。
- **D8 — 事务完成：** 取消信号抵达 Host 操作与 pnpm，客户端激活具有可配置的结算超时，回滚会先恢复已确认的实时运行时层，再收敛文件。恢复失败会保留 journal 并显示 `recovery-required`。
- **D9 — 授权：** 回环变更路由与不可变客户端贡献来源保持为授权检查；浏览器没有文件系统或 pnpm 能力，只能通过 Host 操作信号取消。
- **D10 — 打包：** 已发布 tarball 会扫描禁止成员与绝对本地路径，不含 `workspace:` 说明符，并在安装 `@deepseek-ai/dsh@0.1.1-rc.2` 的全新 npm consumer 中通过安装/启动/停用/重新启用/卸载链。发布包只内联 Manager 自有的 profile/atomic-write 代码及以源码为权威的 rc.2 bridge helper 子图；官方 DSH、Cordis、Include、Typert、API Remote 与 client runtime 保持为外部 seam。CI 要求活动 pnpm 版本与 `packageManager` 相等。
- **D11 — CLI 共存：** 通用插件变更共用 Profile 锁。声明 `dsh.workspace` 的包被分类为工作区应用，`dsh plugin` 不会把它们提升到 `dsh.profile.bundles`。
- **D12 — 旧路径移除：** 旧路径仅在替代机制的具名证明通过后删除。原生 runtime 只有一个 Profile watcher、一个托管根包装层形态、一个 Cordis adapter，且 `dsh-web-app` 中没有常驻管理器行；精确公开 rc.2 路径使用经审计的 bridge，把其既有 watcher 与 Manager generation 串行化，而不增加独立 writer。

## Audit mapping

这些决策按关闭缺口的权威分组：D1/D10 关闭树内交付、打包内容与 pnpm 漂移缺口；D2–D4 关闭直接 Cordis 访问、分散框架调用与缺失提供方传播；D5/D6 关闭空白根、失败表面、原始状态与计时器所有权缺口；D8/D11 关闭取消、实时回滚、无界结算与 CLI 变更竞争。D7 与 D9 保留已经正确的注册表、传输和来源机制。D12 防止移除早于替代证据。

## Verification

- 源码检查及其聚焦 spec 会拒绝官方功能作用域中的静态、动态、再导出、`require` 及 manifest 声明的 Cordis 访问。
- 适配器、包装层、提供方消失/恢复、回滚、超时、取消、CLI 竞争/分类、无管理器回退和表面失败套件锁定包级决策。聚焦 slot 与 layout 套件还证明：`retarget` 预检失败不会产生局部变更，观察者看到的两侧账本都已处于最终状态，且已加载后代可以跨越后到管理器的接管与离开继续存活。
- 打包安装链 smoke 验证提取与最终 tarball 字节。发布门禁进一步使用全新 npm consumer：安装精确的公开 DSH rc.2 包与本地打包的 Manager，只从该 consumer 解析 CLI，打开真实 Settings UI，证明停用及卸载后的 Native DSH，并证明重新启用后 Workspace Apps 恢复。
- 无密钥 Web 验收在共享一个 Harness home 的两个 Profile 中安装同一个包，并证明注册表行、代码、修订与顺序绝不交叉；完整源码、GUI、Web replay、文档、构建、hygiene 与覆盖率检查守护组装行为。

## Alternatives considered

- **让管理器常驻 `dsh-web-app`：** 这会让安装状态成为组合包常量并绕过产品安装链，因此各 Profile 无法独立持有管理器。
- **让功能声明 Cordis 注入或挂载直接根：** 这会把功能源码耦合到框架 API，且无法在管理器提供方消失时暂停全部功能 fiber，除非增加第二套生命周期图。
- **把 Native DSH 回退逻辑放进 renderer：** renderer 会获得产品特定策略；`ui-layout` 中的优先级注册保留普通 slot 生命周期，并让管理器缺席与根失败共用一条恢复路径。
- **从已安装包或 Loader 行推断所有权：** 扫描会收养不受信任或陈旧的运行时事实。注册表保持为唯一提交标记和所有权权威。
- **与替代机制一起删除旧路径：** 单个变更缺少移除前的绿色锚点，也会让回滚含糊；替代与移除保持为不同提交。

## Consequences

- 没有管理器的 Profile 会启动 Native DSH，而托管功能包装层保持不活动，直到管理器提供 `workbenchRuntime`。
- 框架变化集中在 adapter、精确版本的 legacy bridge 与约定实现中；官方功能源码使用版本化 Workbench API，而不使用 Cordis。具有原生 `ProfileRuntime` 的 Host 会完全绕过 bridge。
- 包安装和操作员动作会取得共享锁，且仅在实时树与磁盘收敛后发布注册表状态；无法恢复的分歧保持可见。
- 树外交付增加制品与版本检查；默认行移除意味着 Profile 必须显式安装管理器，才能暴露工作区应用管理。
