# @deepseek-ai/dsh-client-ui-page-app-manager

[English](README.md) | 中文

Workspace Apps 客户端：keep-mounted 外壳（内置 DSH 座位加键控的受管 surface 座位）、基于生成 `pageAppManager` remote 的 React-free controller，以及 Settings → Plugins → Workspace 选项卡。内置 DSH 座位从不依赖 remote 就绪——没有生成的 remote 命名空间时外壳仍然注册，controller 降级为只读空投影，因此组合顺序永远不会阻塞 Original DSH Surface。

## Shell 座位

Manager 的 `apply` 拥有内置 `root` 座位并声明两个子座位：单一内置 DSH 座位（`page-app.shell.builtin`）与键控的受管 surface 座位（`page-app.shell.surface`，每个 page id 一个单元）。外壳无条件挂载内置座位，并在受管 surface 激活期间隐藏（绝不卸载）它。受管包只在运行时激活后才向 surface 座位贡献；controller 的闭合授权投影（spec §7）让无关、来源错误、重复与修订不匹配的贡献保持不可见。

## Controller 生命周期

每次 apply 一个 `PageAppController`，同时服务外壳与 Settings 选项卡，因此两个 surface 上的状态与变更保持一致。Controller 随注册启动（事件订阅、slot ledger 观察、初始快照），并随 apply fiber 停止：`controller.stop()` 取消全部订阅并立即取消每个进行中的 graph-wait interval。停止是幂等的——重复清理是 no-op。

## 图收敛等待

进行中的定向激活等待客户端图收敛到已公告修订（`awaitGraphRevision`，接到 HMR graph reconcile）。30 秒上限是收敛超时，不是清理路径：等待暴露幂等的 `cancel`，由 controller 停止路径调用，因此已停止的 controller 永不泄漏定时器，React 18 StrictMode 的 setup→cleanup→setup 双调用也不会留下残留 interval。

## Settings 选项卡

Workspace 选项卡（order 20，位于只读 `all` 选项卡之后）列出每个受管行——停用、隐藏、不健康与需要恢复的行保持列出——并提供安装、显示/隐藏、启用/停用、排序、带确认的卸载与 operator 恢复。操作横幅渲染 `snapshot.operation.state` 的本地化标签，覆盖闭合的六成员 `PageAppOperationState` 联合（installing/active/removing/install-failed/remove-failed/recovery-required）；持久 journal `phase` 绝不是用户可见状态，因此没有 phase 的恢复可见操作永远不会渲染出 `undefined`。

## 模型体验

### Workspace Apps 管理

#### 模型看到什么

没有任何直接内容——client manager 不注册提示词或工具 schema；它服务于 operator 的设置添加流程，并渲染生成的 `pageAppManager` Remote 投影（`installPackage`、`setEnabled`、`uninstall`）。

#### Token 影响

无；client manager 从不向模型请求贡献 token。

#### KV Cache 影响

无；本包既不组装也不发送 provider 请求。

## 已知限制与暂缓事项

- **没有 modules 服务时收敛等待无法验证** —— `ctx.get('modules')` 缺失时等待立即 resolve，随后确认会报告 controller 无法验证的收敛；Host client-modules registry 通常会保证该服务存在。
- **没有生成的 remote 命名空间时 surface 只读** —— 降级 stub 列出空投影，每次变更都按 no-op 解析；外壳与 Settings 选项卡保持挂载。
- **`setHidden` 与 `reorder` 不携带 abort signal** —— 它们只是展示型变更，中途不可取消。
