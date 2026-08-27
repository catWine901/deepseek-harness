# @deepseek-ai/dsh-page-app-manager

[English](README.md) | 中文

Host 端 Workspace Apps 管理器：只读的归属投影、安装源解析与静态 Workspace Contract 校验，以及带日志的生命周期事务（安装、启用/停用、隐藏、排序、卸载）。`.workspace-manager/registry.json` 是唯一归属权威；launcher 持有的 `ProfileRuntime` 是唯一经过确认的实时重组写入方，因此管理 API 的就绪状态永远不会阻塞内置 DSH shell。

`snapshot.operation` 由持久 journal 相位加 registry 恢复事实投影进行中的变更：prepared/staged → `installing`，committing → `active`，可见的恢复 → `recovery-required`（闭合的 `PageAppOperationState` 联合类型；不新增持久字段）。每行的 `runtimeState` 是其 Cordis fiber 状态的语义标签（`pending`/`loading`/`active`/`failed`/`unloading`，终态 `DISPOSED` 折叠为 `failed`），绝不是数值 fiber 值。

`PageAppManager` 继承 Typert Remote 服务 `pageAppManager`。每次变更都在共享 profile 变更锁内执行，并在任何受管文件变更之前先写入 prepared journal 与私有 before-state 备份；失败的事务会通过 `ProfileRuntime.restoreManagerLayer` 先复原先前的 live Include 树（携带真实 expected-root 哈希）再收敛文件，复原失败则保留 journal 为 `recovery-required`。operator 的 `recover()` Remote 在同一共享锁内解决它：registry 在 `committing` 阶段已变更则完成提交，否则先从 journal before-state 复原 live layer 再让 pnpm 收敛。journal 存在期间拒绝新事务——operator 必须先 recover。生成的 Host 与 Client Remote 产物由 `./typert` 与 `./remote` 导出。

## Cordis adapter 与公开 rc.2 兼容

Manager 产品代码通过 `src/adapter.ts` 接触常规 Cordis 表面。adapter 在运行时导入 Include，而 Cordis Context 与 Loader entry 形状仅用于类型；实时 Loader 服务从 Host context 按结构取得。因此独立制品要求 Cordis 与 `cordis-plugin-include` peer，但不要求把 `cordis-plugin-loader` 声明为包 peer。adapter 暴露 Manager 读取的状态，并委托它所包裹的 vendored 表面完成 expected-root 哈希、patch 组合与解析、Loader 行查找、fiber 语义状态投影及 Feature Runtime Wrapper 子行挂载。

唯一有意分开的框架边界是 `src/legacy-rc2-compat.ts`。它只在精确匹配公开 `@deepseek-ai/dsh-app-boot@0.1.1-rc.2` 指纹、Host 缺少原生 `ProfileRuntime` 服务且 root Include 通过严格校验时激活。它通过同一 FIFO 串行化旧 watcher 与 Manager generation，保留 bundle/profile/home/overlay 优先级，并在 dispose 时移除 listener。未来原生 Host 会让该兼容桥成为经过验证的 no-op。

兼容性承诺：adapter 委托保持行为一致并由 vendored 表面对照测试锁定；兼容桥则以 FIFO 顺序、优先级、恢复、dispose 与 native no-op 测试锁定。导入门禁只允许这两处经审计的框架边界。不存在需要保留的可选运行时契约。

## Workbench Runtime 与 Feature Runtime Wrapper

Manager 以 manager fiber 的生命周期提供 `workbenchRuntime` 服务：`ctx.provide` 在 fiber 卸载时删除服务并重新评估每个依赖 fiber，因此 Manager 丢失会让每个 wrapper fiber 停驻在 PENDING，provider 回归则重新加载它们。runtime 只向 Feature 暴露 contract-v1 的领域表面——生命周期释放、workspace surface 注册、事件、storage get/set 与 host-call seam——绝不暴露原始 context。因此卸载 Manager 会通过真实的 Loader 生命周期挂起每个 Feature（不存在第二套生命周期系统），重新启用或重新安装则恢复它。

每个启用且静态有效的受管 root 都挂载在 Feature Runtime Wrapper（`page-app-manager.wrapper`，以 `@deepseek-ai/dsh-page-app-manager/wrapper` 加载）之下：wrapper 行 id 是确定性的 `page-app.wrapper.<pageId>`，它注入 `workbenchRuntime`，把 Feature 的组合行挂载为 Loader entry（各自保留自己的 entry 与 fiber），并以所属包注册 Feature 的 surface seat。runtime layer 推导、事务 staging 与 Manager 的健康态查找共用 app-boot 的 wrapper 渲染函数，因此 staged 文档、已加载树与健康事实永远不会漂移。

Strict Mode 后果：Feature 仍然以 Cordis loader entry 运行——wrapper 是组合它的 seam，而 Feature 自身源码保持 Cordis-free（其依赖边界在安装时强制）。契约的客户端 render 接线随 fixture 迁移落地；在那之前 wrapper 只记录 surface seat 与来源。

wrapper 模块无法解析的 root——manager 包未安装在 profile 中，即 manager 卸载后 registry 仍在的启动场景——会以 `missing-manager` 被省略：启动以零受管 root 成功，且 registry 保持归属。

## 取消与激活握手

变更类 Remote 方法 `installPackage`、`setEnabled` 与 `uninstall` 携带末尾参数 `signal: AbortSignal`（安装的 wire 名称不能复用 `install`——gateway 的 namespace service 在其原型上保留了该成员）。该信号流入事务，中止 profile 本地 pnpm 与定向客户端激活等待；事务信号还会与 manager fiber 的生命周期控制器合并，因此 manager 重载会中止进行中的事务而不是让其成为孤儿。`setHidden`、`reorder`、`ackClientActivation`、`recover` 与 `list` 保持不变。

安装的激活请求携带 Host 客户端图修订（`clientModules.graph().rev`）——绝不是 runtime-layer 文档——且确认必须回显完全相同的修订，因此过期或无关的图变更无法完成握手。Host 结算等待由经校验的插件配置 `settlementTimeoutMs`（默认 `60000` 毫秒）限定，因此消失的客户端无法在存活进程中无限期持有 profile 锁。

## 模型体验

### Workspace Apps 管理

#### 模型看到什么

没有任何直接内容——管理器不注册提示词或工具 schema；它服务于 operator 的设置添加流程与 `pageAppManager` Remote 表面（`installPackage`、`setEnabled`、`uninstall`）。

#### Token 影响

无；管理器从不向模型请求贡献 token。

#### KV Cache 影响

无；管理器从不组装模型输入。

## 已知限制与暂缓事项

- **安装依赖 Host client-modules 注册表** —— 精确修订的激活握手读取 `clientModules.graph().rev`，注册表不可用时安装会立即失败，而不是基于不可验证的确认完成握手。
- **不放宽 pnpm `allowBuilds`** —— pnpm 构建脚本拒绝会以 `PageAppBuildPermissionError` 呈现给 operator 处理；管理器从不修改 profile workspace 的 `allowBuilds`。
