/**
 * Client page-app manager package entry: the React-free controller, its bare
 * observable store, and the client-safe contracts. The shell (Task 11)
 * constructs the controller with the real remote, slot ledger, and graph
 * convergence seams; nothing here imports React.
 * @module @deepseek-ai/dsh-client-ui-page-app-manager/client
 */

export * from './controller.ts'
export * from './stores.ts'
export * from './contracts.ts'
