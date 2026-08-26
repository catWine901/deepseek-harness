# @deepseek-ai/dsh-page-app-fixture

[English](README.md) | 中文

真实且不依赖 Cordis 的 Workspace Apps Feature fixture：一个 contract-v1 workspace 包（`dsh.workspace.schemaVersion: 1`）、一个在空根上组合出唯一受管根的 bundle patch，以及一个从注入的、与调用方绑定的 `workbench` bridge 消费 Workbench Contract v1 表面入口的客户端半部。该 fixture 是 Strict-Mode 源码／依赖边界的扫描对象（`scripts/verify-page-app-source-boundary.ts`），也是 keyless 端到端链路（`apps/web/tests/workspace-apps.e2e.ts`）中的真实 Feature。

## 清单（Manifest）

包声明 `dsh.bundle.patch`（`./cordis.patch.yml`）、`dsh.client.platform: web`，以及含 `schemaVersion: 1`、`id: dsh-page-app-fixture`、`rootEntryId: dsh-page-app-fixture-root` 的 `dsh.workspace` v1 块。patch 在空根上组合出恰好一个携带该 id 的顶层根行，因此管理器校验会为该包统计出一个受管根与一个客户端行。包在任何依赖段都未声明 Cordis 依赖，源码也从不 import Cordis——fixture 始终处于 Adapter（设计 D3）的 Feature 侧。

## v1 消费者契约

fixture 从管理器提供的、与调用方绑定的 `workbench` service 消费 Workbench Contract v1 的唯一表面入口 `registerWorkspaceSurface({ pageId, packageName, render })`——绝不从 Cordis context 消费。宿主侧由 wrapper 提供 Workbench Runtime；客户端侧由管理器提供 bridge，Loader 仅在注入该 bridge 后调用 `apply`。bridge 持有 slot 访问权限、从 Feature Loader entry 派生不可变 owner 血缘，并随该 Feature fiber 释放贡献。源码中既无 `ctx.slots` 调用，也无 Cordis import；窄契约面是表面逻辑唯一触及的接缝。

表面（`PageAppFixture`）是带状态的真实 React 表面（一个计数器、一个备注输入框，以及一个经 Workbench 生命周期创建的实时 tick）。外壳在稳定的带键座位上 keep-mount 该表面，因此 React 状态在 DSH 往返与隐藏场景下得以保留——无需 React 19 的 Activity/Offscreen API；StrictMode 的 cleanup/setup 只释放 setup 创建的内容。

## 构建

tsdown 配置产出宿主半部（`lib/index.js`、`lib/invariant.js`）与 lazy-CJS 浏览器表面产物（`lib/client.js`，即 `clientBundle` 预设）；`exports["./client"]` 把表面提供给客户端模块表。Node 半部是空挂载点——由 wrapper 组合并提供 workbench 服务。

## 模型体验

### 表面（Fixture Surface）

#### 模型看到什么

fixture 不注册提示词、工具或 KV-cache 贡献。`PageAppFixture` 表面渲染的任何内容——计数器、备注输入框与生命周期 tick——都不会进入任何模型请求；该表面只是浏览器外壳。

#### Token 影响

无。fixture 不会向任何会话添加提示词文本、工具 schema 或模型可见状态。

#### KV Cache 影响

无。fixture 既不组装也不发送任何 provider 请求。

## 已知限制与暂缓事项

- **安装后客户端激活需要一次页面刷新**——已发布的 Web 组合保持共享 HMR 禁用，因此新安装 Feature 的客户端 bundle 会在下一次页面加载时加入 `window.__DSH_BOOT__`；宿主激活是实时的。端到端链路会显式执行这次刷新。
- **客户端 Workbench bridge 由管理器持有**——fixture 依赖管理器注入的 `workbench` service，只保留其窄消费者契约。独立的出树契约包仍推迟到打包里程碑。
- **无 authoring preset**——fixture 没有 agent preset，因此不会向会话贡献任何工具、提示词或委派后端；它只用于证明 Feature 链路。
- **Strict Mode 只约束官方源码**——源码边界门禁无法证明任意预构建第三方产物从未 import Cordis；运行时隔离通过血缘与闭合授权投影实现。
