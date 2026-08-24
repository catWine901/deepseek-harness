# @deepseek-ai/dsh-page-app-manager

[English](README.md) | 中文

Host 端 Workspace Apps 管理器：只读的归属投影、安装源解析与静态 Workspace Contract 校验，以及带日志的生命周期事务（安装、启用/停用、隐藏、排序、卸载）。`.workspace-manager/registry.json` 是唯一归属权威；launcher 持有的 `ProfileRuntime` 是唯一经过确认的实时重组写入方，因此管理 API 的就绪状态永远不会阻塞内置 DSH shell。

`PageAppManager` 继承 Typert Remote 服务 `pageAppManager`。每次变更都在共享 profile 变更锁内执行，并在任何受管文件变更之前先写入 prepared journal 与私有 before-state 备份；失败的事务会通过 `ProfileRuntime.restoreManagerLayer` 先复原先前的 live Include 树（携带真实 expected-root 哈希）再收敛文件，复原失败则保留 journal 为 `recovery-required`。operator 的 `recover()` Remote 在同一共享锁内解决它：registry 在 `committing` 阶段已变更则完成提交，否则先从 journal before-state 复原 live layer 再让 pnpm 收敛。journal 存在期间拒绝新事务——operator 必须先 recover。生成的 Host 与 Client Remote 产物由 `./typert` 与 `./remote` 导出。

## 取消与激活握手

变更类 Remote 方法 `install`、`setEnabled` 与 `uninstall` 携带末尾参数 `signal: AbortSignal`。该信号流入事务，中止 profile 本地 pnpm 与定向客户端激活等待；事务信号还会与 manager fiber 的生命周期控制器合并，因此 manager 重载会中止进行中的事务而不是让其成为孤儿。`setHidden`、`reorder`、`ackClientActivation`、`recover` 与 `list` 保持不变。

安装的激活请求携带 Host 客户端图修订（`clientModules.graph().rev`）——绝不是 runtime-layer 文档——且确认必须回显完全相同的修订，因此过期或无关的图变更无法完成握手。Host 结算等待由经校验的插件配置 `settlementTimeoutMs`（默认 `60000` 毫秒）限定，因此消失的客户端无法在存活进程中无限期持有 profile 锁。

## 模型体验

### Workspace Apps 管理

#### 模型看到什么

没有任何直接内容——管理器不注册提示词或工具 schema；它服务于 operator 的设置添加流程与 `pageAppManager` Remote 表面（`install`、`setEnabled`、`uninstall`）。

#### Token 影响

无；管理器从不向模型请求贡献 token。

#### KV Cache 影响

无；管理器从不组装模型输入。

## 已知限制与暂缓事项

- **安装依赖 Host client-modules 注册表** —— 精确修订的激活握手读取 `clientModules.graph().rev`，注册表不可用时安装会立即失败，而不是基于不可验证的确认完成握手。
- **不放宽 pnpm `allowBuilds`** —— pnpm 构建脚本拒绝会以 `PageAppBuildPermissionError` 呈现给 operator 处理；管理器从不修改 profile workspace 的 `allowBuilds`。
