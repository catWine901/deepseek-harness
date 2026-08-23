/**
 * Bare observable primitive for the page-app client controller: a stable
 * getSnapshot/subscribe pair with no React dependency. React binding arrives
 * through the slot renderer's `inject.hooks` compartment (Task 11), which
 * hands the observable to uSES — the methods are arrow-class fields so they
 * stay `this`-safe even when passed as bare references.
 * @module @deepseek-ai/dsh-client-ui-page-app-manager/client/stores
 */

/** One observable value: stable snapshot reference between changes. */
export interface PageAppObservable<T> {
  /** Current value; the same reference until a committed change. */
  getSnapshot(): T
  /**
   * Observe committed changes (post-notification snapshots are current).
   * @param fn - change callback.
   * @returns unsubscribe.
   */
  subscribe(fn: () => void): () => void
}

/**
 * Mutable observable cell: set() commits a new value and notifies listeners
 * only when the reference changed, so getSnapshot() stays a valid uSES-style
 * source.
 */
export class MutableObservable<T> implements PageAppObservable<T> {
  private readonly listeners = new Set<() => void>()

  /**
   * @param value - the initial value.
   */
  constructor(private value: T) {}

  /** The current value (stable until set()). */
  public getSnapshot = (): T => this.value

  /**
   * Commit a new value. Notifies listeners exactly when the reference changes.
   * @param next - the new value.
   */
  public set = (next: T): void => {
    if (next === this.value) return
    this.value = next
    for (const fn of [...this.listeners]) fn()
  }

  /**
   * Observe committed changes.
   * @param fn - change callback.
   * @returns unsubscribe.
   */
  public subscribe = (fn: () => void): () => void => {
    this.listeners.add(fn)
    return () => { this.listeners.delete(fn) }
  }
}
