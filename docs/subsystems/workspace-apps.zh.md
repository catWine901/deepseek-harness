# 工作区应用

English | [中文](workspace-apps.md)

工作区应用子系统：一个永久最左栏启动器加一个 Surface Host，让当前 DSH Profile 可以安装、管理并运行整页工作区插件。本子系统**只**管理经由其自身 Settings 流程安装的包——外部 DSH 插件永不出现、永不被收养、也永不被枚举。所有权来自 Profile 作用域的托管注册表；其余一切（运行时健康、插件清单、Loader 行）都是派生事实，绝不构成所有权依据。

来源：[`packages/host/page-app-manager/src/index.ts`](../../packages/host/page-app-manager/src/index.ts)、[`packages/client/ui-page-app-manager/src/client/apply.ts`](../../packages/client/ui-page-app-manager/src/client/apply.ts)

## 所有权模型

- **托管注册表**（`$DSH_HOME/profiles/<profile>/.workspace-manager/registry.json`）是唯一的所有权权威。只有当注册表记录存在时，一个包才算被托管。
- **托管运行时层**（`runtime-layer.yml`）是由注册表派生的生成数据；若它消失则重新生成，绝不把它当作第二权威。
- **内置 DSH 表面**是外壳持有的回退表面，从不作为注册表行存在——不可隐藏、不可停用、不可卸载。
- 隐藏（仅展示）、停用（运行时卸载）与卸载（依赖与注册表记录移除）是三个不同的操作。
- 安装与卸载都是事务性的，带有持久日志与备份；提交前的任何失败都会回滚，回滚失败则暴露 `recovery-required`，绝不假装系统干净。

## 客户端表面

客户端包持有内置 `root` 席位并声明两个子席位：内置 DSH 席位（`page-app.shell.builtin`，由常规 DSH 布局占用）与键控托管表面席位（`page-app.shell.surface`）。外壳让已访问表面保持挂载（仅切换 HTML `hidden`，使编辑器/草稿/滚动状态在切换后得以保留），卸载被停用/卸载的表面，并始终让 DSH 可到达。Settings → Plugins → Workspace 标签提供添加、显示/隐藏、排序、详情、启用/停用与卸载，全部经由 Host 所有服务完成——浏览器绝不运行 pnpm 或触碰文件系统。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxpageappmanager--pageappmanager"></a>

### `ctx.pageAppManager` — `PageAppManager`

Build the Host page-app manager service. Extends `TypertRemoteService` so the generated `pageAppManager` namespace exposes the mutation API; the read projection and staged validation are plain methods on the same service.

```ts cordis-catalog
/**
 * The full read-only projection of the managed set. The registry is the
 * ownership authority; health is derived from current dependency, version,
 * and runtime facts. Plugin Inventory and unrelated Loader rows never create
 * entries.
 * @returns the immutable snapshot.
 */
@Remote('list') public list(): PageAppManagerSnapshot

/**
 * Install one managed package (the Remote entry of the Settings add-flow).
 * @param source - the validated install source.
 * @param clientInstanceId - the opaque initiating client instance.
 * @returns the committed registry revision.
 */
@Remote('install') public install(source: PageAppInstallSource, clientInstanceId: PageAppClientInstanceId): Promise<number>

/**
 * Enable or disable one managed page.
 * @param pageId - the managed page id.
 * @param enabled - the new enabled state.
 * @returns the committed registry revision.
 */
@Remote('setEnabled') public setEnabled(pageId: string, enabled: boolean): Promise<number>

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
 * @returns the committed registry revision.
 */
@Remote('uninstall') public uninstall(pageId: string): Promise<number>

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
