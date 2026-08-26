/**
 * Host half of the page-app fixture. Contract v1 keeps the Feature module free
 * of Cordis: the Workbench Runtime wrapper composes this row and provides the
 * workbenchRuntime service, so the node half stays an empty mount — the
 * surface contribution lives in the client half, which consumes the
 * Workbench Contract surface entry from the injected, caller-bound bridge.
 * @module @deepseek-ai/dsh-page-app-fixture
 */

/** Stable Loader entry name for the fixture's host row. */
export const name = 'dsh-page-app-fixture'

/** No services required: the host wrapper supplies its Workbench Runtime. */
export const inject: readonly string[] = []

/** Mount the host half; the wrapper drives the surface lifecycle. */
export function apply(): void {}
