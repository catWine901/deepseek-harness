/**
 * Host half of the page-app fixture. Contract v1 keeps the Feature module free
 * of Cordis: the Workbench Runtime wrapper (M7) composes this row and exposes
 * only the WorkbenchContext to it, so the node half stays an empty mount until
 * the wrapper injects the surface context (M9).
 * @module @deepseek-ai/dsh-page-app-fixture
 */

/** Stable Loader entry name for the fixture's host row. */
export const name = 'dsh-page-app-fixture'

/** No services required: the wrapper supplies the WorkbenchContext at mount. */
export const inject: readonly string[] = []

/** Mount the host half; the wrapper drives the surface lifecycle (M9). */
export function apply(): void {}
