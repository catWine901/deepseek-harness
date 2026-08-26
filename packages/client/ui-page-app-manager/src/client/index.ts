/**
 * Client page-app manager package entry: the React-free controller, its bare
 * observable store, the client-safe contracts, and the keep-mounted shell
 * apply (root seat handoff + builtin/surface child seats). The shell
 * constructs the controller with the real remote, slot ledger, and graph
 * convergence seams; nothing here imports React directly (the shell
 * components do, through the slot renderer's inject.hooks compartment).
 * @module @deepseek-ai/dsh-client-ui-page-app-manager/client
 */

export * from './controller.ts'
export * from './stores.ts'
export * from './contracts.ts'
export * from './workbench.ts'
export * from './apply.ts'
export * from './PageAppShell.tsx'
export * from './PageAppRail.tsx'
export * from './PageAppSettingsTab.tsx'
export * from './locales.ts'
