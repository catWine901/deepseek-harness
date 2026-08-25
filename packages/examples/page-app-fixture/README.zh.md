# @deepseek-ai/dsh-page-app-fixture

[English](README.md) | 中文

真实且不依赖 Cordis 的 Workspace Apps Feature fixture：一个 contract-v1 workspace 包（`dsh.workspace.schemaVersion: 1`）、一个在空根上组合出唯一受管根的 bundle patch，以及一个通过契约入口注册带键 workspace 表面的客户端半部。该 fixture 是 Strict-Mode 源码／依赖边界的扫描对象（`scripts/verify-page-app-source-boundary.ts`），也是完整 Feature 链路（M9）的迁移目标。

## 清单（Manifest）

包声明 `dsh.bundle.patch`（`./cordis.patch.yml`）、`dsh.client.platform: web`，以及含 `schemaVersion: 1`、`id: dsh-page-app-fixture`、`rootEntryId: dsh-page-app-fixture-root` 的 `dsh.workspace` v1 块。patch 在空根上组合出恰好一个携带该 id 的顶层根行，因此管理器校验会为该包统计出一个受管根与一个客户端行。包在任何依赖段都未声明 Cordis 依赖，源码也从不 import Cordis——fixture 始终处于 Adapter（设计 D3）的 Feature 侧。

## 表面入口

客户端半部（`src/client/index.tsx`）通过 `registerWorkspaceSurface({ pageId, packageName, render })`——Workbench Contract v1 的唯一表面入口——注册带键 workspace 表面，并返回移除它的 disposer。共享契约包随 Workbench Runtime（M7）一起到来；在此之前 fixture 在本地持有该入口的副本，以保持不依赖 Cordis 且自包含。M9 将用 wrapper 注入的 `WorkbenchContext` 替换它。

## 构建

tsdown 配置产出宿主半部（`lib/index.js`、`lib/invariant.js`）与浏览器表面 bundle（`lib/client.js`）；`exports["./client"]` 提供该表面。Node 半部是空挂载点——由 wrapper 组合，并仅向 Feature 暴露契约表面。

## 模型体验

fixture 从不进入模型请求：它不注册提示词、工具或 KV-cache 贡献，因此没有 token 或 KV-cache 影响。

## 已知限制与暂缓事项

- **目前只是骨架，还不是可运行的 Feature**——完整的安装→表面→隐藏／禁用／重新启用／卸载链路属于 M9 迁移；在此之前 fixture 只证明 contract-v1 清单、不依赖 Cordis 的源码／依赖边界，以及带键注册入口。
- **注册目前是模块局部的**——在 wrapper 注入 `WorkbenchContext`（M7）之前，`registerWorkspaceSurface` 将带键注册保存在 fixture 自己的模块内；M9 会把该入口移到契约的注入面之后。
