# dsh-page-app-profile

[English](README.md) | 中文

Host 安全的 page-app 档案核心，由 page-app 管理器与 `dsh` CLI 共用：严格的 manifest/registry 解析、精确的档案路径、确定性的运行时层序列化、日志化事务，以及唯一共享的档案变更锁。

本包以档案为作用域且纯 Host 化：绝不从进程状态推断档案、绝不触碰 pnpm、不暴露任何浏览器界面。档案启动（profile boot）导入它时无需依赖 page-app 管理器的 Typert 服务包。

## 接口面

```ts
import {
  parsePageAppManifest,
  readPageAppRegistry,
  renderPageAppRuntimeLayer,
  resolvePageAppProfilePaths,
  type ValidatedManagedRoot,
  withPageAppProfileLock,
} from '@deepseek-ai/dsh-page-app-profile'

declare const profileDir: string
declare const packageName: string
declare const parsedPackageJson: unknown
declare const roots: readonly ValidatedManagedRoot[]
declare const token: string

const paths = resolvePageAppProfilePaths(profileDir)
// directory: <profileDir>/.workspace-manager
// registry:  .../registry.json
// runtimeLayer: .../runtime-layer.yml
// journal:   .../transaction.json
// operationKey: .../operation.lock

const manifest = parsePageAppManifest(packageName, parsedPackageJson)
const registry = await readPageAppRegistry(profileDir)
const layer = renderPageAppRuntimeLayer(roots)

await withPageAppProfileLock(profileDir, { kind: 'manager', token }, async () => {
  // one mutation per profile: pnpm and owned-file writes stay under the lock
})
```

约定按规格利用它的顺序列出：

- **严格 v1 解析失败即闭合** —— 未知的 registry/journal schema 版本、类型错误、未知键、重复的包名/页面 id/根条目 id，以及携带凭据的 source display 全部拒绝；v1 绝不读取更新的格式。
- **凭据永不落盘** —— 在 URL 中内嵌 userinfo 的源规格会被直接拒绝；持久化的 display 还会剥离 userinfo 作为第二道防线。
- **registry 是唯一的所有权事实** —— 每个返回对象都深度冻结（zod 在每一层应用 `readonly` 并显式冻结），条目按稳定顺序返回（`order` 升序，再按包名），原子写入前会对完整值重新校验。
- **运行时层是派生物，绝非权威** —— 只插入启用的根，按包名排序以保证等价输入得到字节级一致的输出；`!!js` 表达式、相对文件系统名与外来 scheme 一律拒绝，因为 Loader 方言会对其求值。
- **唯一共享的档案变更锁** —— `operation.lock` 以独占 `wx` 创建、0600 权限，位于 0700 的 manager 目录内（POSIX 上即使目录已存在也会收窄），记录 schema 版本、owner 种类、pid、不透明 owner token 与获取时间戳；竞争者串行等待，且只释放自己拥有的 payload。
- **启动恢复绝不猜测** —— 与 journal token 匹配的死 `manager` 锁由恰好一个恢复者改名隔离：恢复 claim 构成按 token 追加的 `wx` 创建代际链（旧的固定路径 claim 视为第 0 代），每个恢复者在行动前先验证整条链——代际从 0 连续、claim 可读、每个祖先可证明已死；存活、活性不确定或不可读的链尾失败闭合，可证明已死的链尾被下一代取代，失败者直接失败退出。无 journal 的死 `manager` 锁可安全移除，因为任何变更都不得先于 journal 发布；其余一切状态——活进程、token 不匹配、payload 不可读、活性不确定，或任何死 `plugin-cli` 锁——都失败闭合交由人工修复。
- **日志化事务在变更前即持久** —— journal 记录锁 owner token、相位（`prepared` → `staged` → `committing`）、变更前文件的 sha256 哈希，以及 0600 私有备份；快照路径为 manager 相对路径，无法逃逸档案目录。

## Model Experience

无。这是纯 Host 持久化原语，没有任何内容进入模型请求。

#### KV Cache effect

无；这里没有任何内容进入请求前缀。

## Known Limitations and Deferred Work

- **自身不保证崩溃持久** —— 原子替换与备份均未 `fsync`；崩溃语义由管理器的事务协议（journal 相位加启动恢复）负责。
- **锁等待时长固定，不可调** —— 竞争者按 pnpm 量级的截止时间退避；死 owner 的恢复是显式启动步骤，绝不隐式等待。
- **隔离与 claim 文件被保留** —— 恢复的死锁以 `<token>.quarantine` 名字留存，按代际追加的恢复 claim 链也保留在本地作为取证证据；尚无自动清理。
- **畸形的恢复链需人工修复** —— 当 claim 链不连续、含畸形 claim 类命名或越界代际、含不可读 claim，或埋有存活/活性不确定的祖先时，恢复失败闭合；操作员须删除或修复相关文件。
- **Windows 模式位不强制** —— 0700 manager 目录与 0600 私有文件依赖 Windows ACL；仅 POSIX 路径做 chmod 收窄。
