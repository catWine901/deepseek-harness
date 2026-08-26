# 工作区应用

English | [中文](workspace-apps.md)

工作区应用子系统让 DSH Profile 通过可选管理器安装、管理并运行整页工作区插件。管理器是通过 `dsh plugin` 按 Profile 安装的树外 npm 包；它贡献最左栏启动器、Surface Host 与 Settings → Plugins → Workspace 流程，而不是作为 `dsh-web-app` 的常驻行交付。本子系统**只**管理经由该 Settings 流程安装的功能包——外部 DSH 插件永不出现、永不被收养、也永不被枚举。

来源：[`packages/host/page-app-manager/src/index.ts`](../../packages/host/page-app-manager/src/index.ts)、[`packages/client/ui-page-app-manager/src/client/apply.ts`](../../packages/client/ui-page-app-manager/src/client/apply.ts)

## 所有权模型

- **托管注册表**（`$DSH_HOME/profiles/<profile>/.workspace-manager/registry.json`）是唯一的所有权权威。只有当注册表记录存在时，一个包才算被托管。
- **托管运行时层**（`runtime-layer.yml`）是由注册表派生的生成数据；若它消失则重新生成，绝不把它当作第二权威。
- **内置 DSH 表面**是外壳持有的回退表面，从不作为注册表行存在——不可隐藏、不可停用、不可卸载。
- 隐藏（仅展示）、停用（运行时卸载）与卸载（依赖与注册表记录移除）是三个不同的操作。
- 安装与卸载都是事务性的，带有持久日志与备份；提交前的任何失败都会回滚，回滚失败则暴露 `recovery-required`，绝不假装系统干净。

同一 Harness home 下的两个 Profile 具有独立的管理器依赖、注册表、运行时层、修订与顺序。在一个 Profile 安装管理器或功能，绝不会让其行或代码在另一个 Profile 可见。

## Workbench Contract v1

托管功能声明 `dsh.workspace.schemaVersion: 1`、一个包、一个页面与一个 Managed Root。准入会拒绝不支持的版本、无效的根/客户端组合、所有权冲突及直接 Cordis 依赖。仓库源码检查还会在声明的功能源码作用域内拒绝对 `cordis` 或 `@deepseek-ai/cordis` 的静态导入、再导出、动态导入、`require` 与直接依赖声明。该源码检查无法证明源码不可用的预构建第三方制品。

管理器产品代码把 Cordis、Include 与 Loader 操作集中在 Cordis Compatibility Adapter。每个通过准入的根都会渲染在确定性的 Feature Runtime Wrapper 下；该包装层注入管理器提供的 `workbenchRuntime` 服务，并在保留包来源的情况下挂载功能原始行。功能通过版本化 Workbench API 注册生命周期回调及工作区表面；它们绝不会获得原始 Cordis 上下文。

管理器 fiber 持有该提供方。管理器卸载时，Cordis 移除 `workbenchRuntime` 并停驻每个依赖的包装层 fiber；管理器恢复时，Cordis 重新加载这些包装层。该机制使用 Loader 的普通依赖生命周期，不维护第二套功能生命周期图。

## 客户端表面

管理器活动时，其客户端包持有内置 `root` 席位并声明两个子席位：内置 DSH 席位（`page-app.shell.builtin`，由常规 DSH 布局占用）与键控托管表面席位（`page-app.shell.surface`）。外壳让已访问表面保持挂载（仅切换 HTML `hidden`，使编辑器/草稿/滚动状态在切换后得以保留），卸载被停用/卸载的表面，并始终让 DSH 可到达。失败的托管表面会被隔离在重试/卸载界面后，同时最左栏与 DSH 保持可用。

没有管理器或其根条目因渲染失败而放弃时，`ui-layout` 会在无需刷新浏览器的情况下渲染 Native DSH。它持有一份优先级为 1 的 `AppFrame` 注册，并在 `root` 与 `page-app.shell.builtin` 之间原子式 `retarget` 同一个实时条目：移动操作先检查两个席位是否为兼容的 `single`/`root` 席位，在发布变更通知前提交两侧账本，并保留条目标识、子声明、已加载后代、`store` 状态、元数据与 disposer 权威。因此，后到的管理器可以接管并在之后离开，而不会折叠或重新加载 Native DSH 子树。管理器 Settings 变更调用 Host 持有的服务——浏览器绝不运行 pnpm 或触碰文件系统。

## 安装与 CLI 共存

提取出的管理器包会被打包，接受源码文件、source map、`workspace:` 说明符与绝对本地路径扫描，然后通过全新 Profile 的安装/停用/重新启用/卸载链。仓库要求活动 pnpm 版本与 `packageManager` pin 相等。

通用 `dsh plugin` 变更与管理器事务使用同一把 Profile 锁。声明 `dsh.workspace` 的包会被分类为托管功能，绝不会追加到 `dsh.profile.bundles`；请通过工作区应用 Settings 流程安装它，使注册表保持为所有权权威。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxpageappmanager--pageappmanager"></a>

### `ctx.pageAppManager` — `PageAppManager`

Build the Host page-app manager service. Extends `TypertRemoteService` so the generated `pageAppManager` namespace exposes the mutation API; the read projection and staged validation are plain methods on the same service.

```ts cordis-catalog
/** Abort the in-flight transaction; wired to the manager fiber's effect. */
public dispose(): void

/**
 * The full read-only projection of the managed set. The registry is the
 * ownership authority; health is derived from current dependency, version,
 * and runtime facts. Plugin Inventory and unrelated Loader rows never create
 * entries.
 * @returns the immutable snapshot.
 */
@Remote('list') public list(): PageAppManagerSnapshot

/**
 * Install one managed package (exposed as the `installPackage` Remote of the
 * Settings add-flow; the gateway namespace service reserves the `install`
 * member on its prototype, so the wire method cannot reuse that spelling
 * while the internal lifecycle method keeps the `install` name).
 * @param source - the validated install source.
 * @param clientInstanceId - the opaque initiating client instance.
 * @param signal - cancellation; aborts pnpm and the activation wait.
 * @returns the committed registry revision.
 */
@Remote('installPackage') public install(source: PageAppInstallSource, clientInstanceId: PageAppClientInstanceId, signal: AbortSignal): Promise<number>

/**
 * Enable or disable one managed page.
 * @param pageId - the managed page id.
 * @param enabled - the new enabled state.
 * @param signal - cancellation; honored by the shared lock.
 * @returns the committed registry revision.
 */
@Remote('setEnabled') public setEnabled(pageId: string, enabled: boolean, signal: AbortSignal): Promise<number>

/**
 * Hide or show one managed page (presentation only).
 * @param pageId - the managed page id.
 * @param hidden - the new hidden state.
 * @returns the committed registry revision.
 */
@Remote('setHidden') public setHidden(pageId: string, hidden: boolean): Promise<number>

/**
 * Reorder managed pages.
 * @param pageIds - page ids in the desired order.
 * @returns the committed registry revision.
 */
@Remote('reorder') public reorder(pageIds: readonly string[]): Promise<number>

/**
 * Uninstall one managed page from the current profile.
 * @param pageId - the managed page id.
 * @param signal - cancellation; aborts pnpm and the activation wait.
 * @returns the committed registry revision.
 */
@Remote('uninstall') public uninstall(pageId: string, signal: AbortSignal): Promise<number>

/**
 * Acknowledge a pending targeted client activation. Only the first valid
 * acknowledgement from the initiating client instance settles the install.
 * @param transactionId - the transaction the acknowledgement names.
 * @param clientInstanceId - the acknowledging client instance.
 * @param packageName - the acknowledged package.
 * @param pageId - the acknowledged page id.
 * @param graphRevision - the graph revision the client converged to.
 * @returns whether this attempt settled the transaction.
 */
@Remote('ackClientActivation') public ackClientActivation( transactionId: PageAppTransactionId, clientInstanceId: PageAppClientInstanceId, packageName: string, pageId: string, graphRevision: string, ): { accepted: boolean; reason?: string }

/**
 * Run the startup/operator recovery over the profile journal.
 * @returns the recovery outcome.
 */
@Remote('recover') public recover(): Promise<{ action: string; message?: string }>

/**
 * The full read-only projection of the managed set (the `list` Remote
 * delegates here; the raw method stays available to host-side consumers).
 * @returns the immutable snapshot.
 */
public snapshot(): PageAppManagerSnapshot

/**
 * Parse and classify one Settings add-flow source spec. Local directory
 * sources are additionally preflighted against the on-disk package; registry,
 * git, link, and tarball sources await the pnpm staging step (Task 8) before
 * the full static validation runs. Never mutates ownership.
 * @param source - the raw specifier (or an already-typed source).
 * @returns the validated install source plus a preflight note.
 * @throws {Error} when the spec is rejected (kind grammar, credentials, relative path).
 */
public validateInstall(source: string | PageAppInstallSource): { source: PageAppInstallSource; preflight: string | null }
```

Source: [`packages/host/page-app-manager/src/index.ts`](../../packages/host/page-app-manager/src/index.ts)

<a id="ctxworkbenchruntime--workbenchruntime"></a>

### `ctx.workbenchRuntime` — `WorkbenchRuntime`

The Feature-facing domain API the manager provides.

Source: [`packages/host/page-app-manager/src/workbench-runtime.ts`](../../packages/host/page-app-manager/src/workbench-runtime.ts)

<a id="page-app-manager-events"></a>

### `page-app-manager/*` events

<a id="page-app-manageractivation-requested--emit"></a>

#### `page-app-manager/activation-requested` — emit

An install staged its runtime layer and now waits for the targeted client instance to acknowledge the activation.

```ts cordis-catalog
/**
 * An install staged its runtime layer and now waits for the targeted
 * client instance to acknowledge the activation.
 * @param request - transaction, client instance, package, page, and graph revision.
 * @mode emit
 */
'page-app-manager/activation-requested'(request: PageAppActivationRequestedEvent): void
```

Source: [`packages/host/page-app-manager/src/types.ts`](../../packages/host/page-app-manager/src/types.ts)

<a id="page-app-managerchanged--emit"></a>

#### `page-app-manager/changed` — emit

The manager committed a registry change (install/enable/disable/hide/ reorder/uninstall published a new revision). Consumers re-read the snapshot.

```ts cordis-catalog
/**
 * The manager committed a registry change (install/enable/disable/hide/
 * reorder/uninstall published a new revision). Consumers re-read the
 * snapshot.
 * @param revision - the newly committed registry revision.
 * @mode emit
 */
'page-app-manager/changed'(revision: number): void
```

Source: [`packages/host/page-app-manager/src/types.ts`](../../packages/host/page-app-manager/src/types.ts)
<!-- END GENERATED cordis-surface -->
