/**
 * Workspace Apps settings tab (Settings → Plugins → Workspace, spec §21/§22):
 * add a workspace plugin from a single source field, manage rows (show/hide,
 * reorder, enable/disable, uninstall with confirmation), view the committed
 * profile identity, and run startup/rollback recovery. Every mutation
 * delegates to the Host through the controller — the browser never touches
 * packages or the filesystem. Disabled, hidden, unhealthy, and
 * recovery-required rows stay listed (the rail may hide them; Settings must
 * not).
 * @module @deepseek-ai/dsh-client-ui-page-app-manager/client/PageAppSettingsTab
 */

import { useMemo, useState, type FormEvent, type ReactNode } from 'react'
import type {
  InjectFace, PropsLocale, PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { PageAppClientSnapshot } from './controller.ts'
import type { PageAppOperationState } from '@deepseek-ai/dsh-page-app-manager/types'
import type { PageAppObservable } from './stores.ts'
import type { PageAppSettingsKey } from './locales.ts'
import { parsePageAppInstallSourceClient } from './source.ts'
import css from './PageAppSettingsTab.module.css'

/** The controller face the manager apply() hands to the tab registration. */
export interface PageAppSettingsTabInjected {
  /** Bare controller observable bound to `usePageApp` by the renderer. */
  hooks: { pageApp: PageAppObservable<PageAppClientSnapshot> }
  /** Install one workspace package. */
  install: (source: string, signal: AbortSignal) => Promise<void>
  /** Enable or disable one managed page. */
  setEnabled: (pageId: string, enabled: boolean, signal: AbortSignal) => Promise<void>
  /** Hide or show one managed page. */
  setHidden: (pageId: string, hidden: boolean) => Promise<void>
  /** Uninstall one managed page. */
  uninstall: (pageId: string, signal: AbortSignal) => Promise<void>
  /** Run startup/operator recovery over the profile journal. */
  recover: () => Promise<void>
  /** Cancel the in-flight install (aborts the controller's per-call signal). */
  cancelInstall: () => void
}

/** Full composed props: runtime share + locale seat + inject face. */
export type PageAppSettingsTabProps =
  & PropsRuntime<'settings.plugins.tab'>
  & PropsLocale<'settings.pageApp'>
  & InjectFace<PageAppSettingsTabInjected>

/**
 * Whether a mutation failure is a cancellation. The abort reason is a
 * DOMException (AbortError) which jsdom does NOT subclass Error, so the name
 * check must not rely on `instanceof Error`.
 */
function isAbort(failure: unknown): boolean {
  return typeof failure === 'object' && failure !== null && 'name' in failure
    && (failure as { name?: unknown }).name === 'AbortError'
}

/**
 * Operation-state display keys: one per closed PageAppOperationState member
 * (the Host projects prepared/staged → installing, committing → active, and a
 * visible recovery → recovery-required). The durable journal phase is never
 * the user-facing state; a recovery-visible operation carries no phase at all.
 */
const OPERATION_STATE_KEYS: Record<PageAppOperationState, PageAppSettingsKey> = {
  installing: 'operationInstalling',
  active: 'operationActive',
  removing: 'operationRemoving',
  'install-failed': 'operationInstallFailed',
  'remove-failed': 'operationRemoveFailed',
  'recovery-required': 'recoveryRequired',
}

/** Health display keys (one per manager health value that Settings shows). */
const HEALTH_KEYS: Record<string, PageAppSettingsKey> = {
  'ready': 'ready',
  'disabled': 'disabledState',
  'missing-dependency': 'missingDependency',
  'version-drift': 'versionDrift',
  'invalid-manifest': 'invalidManifest',
  'activation-failed': 'activationFailed',
  'externally-overridden': 'externallyOverridden',
  'recovery-required': 'recoveryRequired',
}

/** Render the Workspace Apps settings tab. */
export function PageAppSettingsTab(
  { usePageApp, t, install, setEnabled, setHidden, uninstall, recover, cancelInstall }: PageAppSettingsTabProps,
): ReactNode {
  const snapshot = usePageApp((state: PageAppClientSnapshot) => state)
  const [source, setSource] = useState('')
  const [busy, setBusy] = useState(false)
  // Install-specific in-flight flag: the cancel action is visible only while
  // an install is running (other busy row actions never show it).
  const [installing, setInstalling] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)

  const rows = snapshot.registry?.entries ?? []
  const ordered = useMemo(() => [...rows].sort((a, b) => a.order - b.order), [rows])

  const onAdd = (event: FormEvent): void => {
    event.preventDefault()
    setError(null)
    setBusy(true)
    setInstalling(true)
    try {
      // Classify locally for the typed Remote; the Host re-validates on its side.
      void parsePageAppInstallSourceClient(source)
    } catch (failure) {
      setBusy(false)
      setInstalling(false)
      setError(String(failure instanceof Error ? failure.message : failure))
      return
    }
    void install(source.trim(), new AbortController().signal).then(
      () => { setBusy(false); setInstalling(false); setSource('') },
      (failure: unknown) => {
        setBusy(false)
        setInstalling(false)
        // A cancelled install is user intent, not an error.
        if (!isAbort(failure)) {
          setError(String(failure instanceof Error ? failure.message : failure))
        }
      },
    )
  }

  const onRecover = (): void => {
    setBusy(true)
    void recover().then(
      () => { setBusy(false); setError(null) },
      (failure: unknown) => {
        setBusy(false)
        setError(String(failure instanceof Error ? failure.message : failure))
      },
    )
  }

  const action = (run: () => Promise<void>): void => {
    setBusy(true)
    setError(null)
    void run().then(
      () => { setBusy(false) },
      (failure: unknown) => {
        setBusy(false)
        setError(String(failure instanceof Error ? failure.message : failure))
      },
    )
  }

  return (
    <div className={css.tab} aria-busy={busy}>
      <h3 className={css.heading}>{t('rows')}</h3>
      <p className={css.profile}>
        {t('profile')}: {snapshot.registry?.profile.name || t('noProfile')}
      </p>

      {snapshot.registry?.recovery !== null && snapshot.registry?.recovery !== undefined
        ? (
          <div className={css.recovery} role="alert">
            <span>{t('recoveryMessage')}{snapshot.registry.recovery.message}</span>
            <button type="button" onClick={onRecover} disabled={busy}>{t('recoveryAction')}</button>
          </div>
        ) : null}
      {snapshot.registry?.operation !== null && snapshot.registry?.operation !== undefined ? (
        <p className={css.operation}>
          {t('operationProgress')}{t(OPERATION_STATE_KEYS[snapshot.registry.operation.state])}
        </p>
      ) : null}
      {error !== null ? <p className={css.error} role="alert">{error}</p> : null}

      <form className={css.addRow} onSubmit={onAdd}>
        <input
          type="text"
          className={css.addInput}
          value={source}
          placeholder={t('addPlaceholder')}
          aria-label={t('addPlaceholder')}
          disabled={busy}
          onChange={(event) => { setSource(event.currentTarget.value) }}
        />
        <button type="submit" disabled={busy || source.trim().length === 0}>
          {busy ? t('addProgress') : t('addAction')}
        </button>
        {installing ? (
          <button type="button" onClick={cancelInstall}>
            {t('cancelInstall')}
          </button>
        ) : null}
      </form>

      {ordered.length === 0 ? <p className={css.empty}>{t('empty')}</p> : null}
      <ul className={css.rows}>
        {ordered.map(row => (
          <li key={row.page.id} className={css.row} data-page-app-row={row.page.id}>
            <div className={css.rowMain}>
              <strong>{row.page.name}</strong>
              <code className={css.packageName}>{row.packageName}</code>
              <span className={css.health} data-health={row.health}>{t(HEALTH_KEYS[row.health] ?? 'ready')}</span>
            </div>
            <div className={css.controls}>
              <span>{t('visibleLabel')}</span>
              <button type="button" disabled={busy} onClick={() => { action(() => setHidden(row.page.id, !row.hidden)) }}>
                {row.hidden ? t('show') : t('hide')}
              </button>
              <button type="button" disabled={busy} onClick={() => { action(() => setEnabled(row.page.id, !row.enabled, new AbortController().signal)) }}>
                {row.enabled ? t('disable') : t('enable')}
              </button>
              <button type="button" disabled={busy} onClick={() => { setConfirming(row.page.id) }}>
                {t('uninstall')}
              </button>
            </div>
            {confirming === row.page.id ? (
              <div className={css.confirm} role="alertdialog" aria-label={t('uninstallConfirm')}>
                <span>{t('uninstallConfirm')}</span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setConfirming(null)
                    action(() => uninstall(row.page.id, new AbortController().signal))
                  }}
                >
                  {t('uninstall')}
                </button>
                <button type="button" onClick={() => { setConfirming(null) }}>{t('cancel')}</button>
              </div>
            ) : null}
          </li>
        ))}
      </ul>
    </div>
  )
}
