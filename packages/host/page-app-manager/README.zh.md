# @deepseek-ai/dsh-page-app-manager

[English](README.md) | 中文

Host 端 Workspace Apps 管理器：只读的归属投影、安装源解析与静态 Workspace Contract 校验，以及带日志的生命周期事务（安装、启用/停用、隐藏、排序、卸载）。`.workspace-manager/registry.json` 是唯一归属权威；launcher 持有的 `ProfileRuntime` 是唯一经过确认的实时重组写入方，因此管理 API 的就绪状态永远不会阻塞内置 DSH shell。

`snapshot.operation` 由持久 journal 相位加 registry 恢复事实投影进行中的变更：prepared/staged → `installing`，committing → `active`，可见的恢复 → `recovery-required`（闭合的 `PageAppOperationState` 联合类型；不新增持久字段）。每行的 `runtimeState` 是其 Cordis fiber 状态的语义标签（`pending`/`loading`/`active`/`failed`/`unloading`，终态 `DISPOSED` 折叠为 `failed`），绝不是数值 fiber 值。

`PageAppManager` 继承 Typert Remote 服务 `pageAppManager`。每次变更都在共享 profile 变更锁内执行，并在任何受管文件变更之前先写入 prepared journal 与私有 before-state 备份；失败的事务会通过 `ProfileRuntime.restoreManagerLayer` 先复原先前的 live Include 树（携带真实 expected-root 哈希）再收敛文件，复原失败则保留 journal 为 `recovery-required`。operator 的 `recover()` Remote 在同一共享锁内解决它：registry 在 `committing` 阶段已变更则完成提交，否则先从 journal before-state 复原 live layer 再让 pnpm 收敛。journal 存在期间拒绝新事务——operator 必须先 recover。生成的 Host 与 Client Remote 产物由 `./typert` 与 `./remote` 导出。

## Cordis Adapter

Manager 产品代码仅通过 `src/adapter.ts` 接触 Cordis——它是 `@deepseek-ai/cordis`、`@deepseek-ai/cordis-plugin-loader` 与 `@deepseek-ai/cordis-plugin-include` 在 Manager 产品代码中的唯一运行时导入位置；仅允许 type-only 的 `Context` 导入（插件签名）作为例外。adapter 暴露 Manager 读取的 Cordis 状态，并委托给它所包裹的 vendored 表面：`managedRootHash`（expected-root 哈希，委托 `canonicalManagedRootHash`）、`composePatchRows`（空根上的 bundle patch 组合，委托 Include 的 `applyEntryPatches`）、`parseEntryList`（include 的 `!!js` entry-list YAML 方言）、`findLoaderRow`（通过 `loader.entries()` 查找 Loader 行）、`fiberStateOf`（行的数值 `FiberState`）、`fiberStateLabelOf`（语义标签映射：pending/loading/active/failed/unloading，`DISPOSED` → failed）、`isActiveFiberState`（`ready` 健康态对 ACTIVE 的要求）、`wrapperChildrenOf` 与 `mountWrapperChildren`（Feature Runtime Wrapper 通过 `Loader.create`/`remove` 挂载子行）。

兼容性承诺：所有委托都是行为保持的——adapter 测试把每个委托钉在它所包裹的 vendored Cordis 表面之上，导入门禁（同样在 `tests/adapter.spec.ts` 中钉住）让其余每个产品文件在运行时保持 Cordis-free，因此 Cordis API 变更只会在 `adapter.ts` 内被吸收。

三个 Cordis peer 是必选而非可选：adapter 在模块加载时即运行时导入 `cordis-plugin-include`，peer 缺失会让 Manager 模块本身加载失败。不存在需要保留的可选运行时契约——`verify-optional-dependency-imports` 强制要求声明为可选的包绝不在模块作用域被加载。

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
