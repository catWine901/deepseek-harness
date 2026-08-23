/**
 * Host loader entry for the browser-only page-app manager plugin. The node
 * half is intentionally a no-op: the browser half (`./client`) registers the
 * Workspace App shell, rail, and Settings tab through the slot ledger. The
 * generated `pageAppManager` Host service lives in
 * `@deepseek-ai/dsh-page-app-manager`; this package owns only the client
 * surface.
 * @module @deepseek-ai/dsh-client-ui-page-app-manager
 */

/** Provides no host-side behavior (the loader entry for the browser bundle). */
export function apply(): void {}
