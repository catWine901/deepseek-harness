/**
 * The permanent far-left Workspace App rail (spec §2/§20): DSH / Agent plus
 * every eligible managed page, in stable registry order. A row appears only
 * when the shell's closed projection reports it eligible (registry ownership +
 * enabled + runtime registration; the shell also filters hidden). Accessible
 * current-page state via aria-current, roving-tabindex keyboard navigation,
 * and stable labels/ordering. Pure component: rows, active id, and the select
 * callback arrive from the shell.
 * @module @deepseek-ai/dsh-client-ui-page-app-manager/client/PageAppRail
 */

import type { KeyboardEvent } from 'react'
import { PAGE_APP_DSH_PAGE } from './contracts.ts'
import css from './PageAppRail.module.css'

/** One rail row projected by the shell from the controller snapshot. */
export interface PageAppRailRow {
  /** Managed page id. */
  readonly pageId: string
  /** Display label (the manifest page name). */
  readonly label: string
  /** Registry order (ascending). */
  readonly order: number
}

/** Injected props the shell hands to the rail. */
export interface PageAppRailInjected {
  /** Ordered eligible rows (DSH/Agent is always rendered first, not a row). */
  readonly rows: readonly PageAppRailRow[]
  /** Active page id, or null when the built-in DSH page is active. */
  readonly activePageId: string | null
  /** Select one page (null = built-in DSH). */
  readonly select: (pageId: string | null) => void
}

/** Built-in DSH/Agent row constant (not a managed registry row). */
const DSH_ROW = { pageId: PAGE_APP_DSH_PAGE, label: 'DSH / Agent', order: -1 }

/** Keyboard navigation across the rail buttons (roving tabindex). */
function onRailKeyDown(event: KeyboardEvent<HTMLDivElement>): void {
  const target = event.currentTarget
  const buttons = [...target.querySelectorAll<HTMLButtonElement>('[data-page-app-rail-item]')]
  const current = buttons.findIndex(button => button === document.activeElement)
  let next: number | undefined
  if (event.key === 'ArrowDown') next = current + 1
  else if (event.key === 'ArrowUp') next = current - 1
  else if (event.key === 'Home') next = 0
  else if (event.key === 'End') next = buttons.length - 1
  if (next === undefined) return
  const targetButton = buttons[next]
  if (targetButton === undefined) return
  event.preventDefault()
  targetButton.focus()
}

/** The permanent far-left launcher (see module doc). */
export function PageAppRail({ rows, activePageId, select }: PageAppRailInjected) {
  const items = [DSH_ROW, ...rows]
  const active = activePageId ?? PAGE_APP_DSH_PAGE

  return (
    <nav
      className={css.rail}
      aria-label="Workspace Apps"
      onKeyDown={onRailKeyDown}
      data-page-app-rail
    >
      {items.map((row) => {
        const isActive = row.pageId === active
        return (
          <button
            key={row.pageId}
            type="button"
            className={css.item}
            data-page-app-rail-item
            data-page-app-rail-active={isActive ? 'true' : undefined}
            aria-current={isActive ? 'page' : undefined}
            tabIndex={isActive ? 0 : -1}
            onClick={() => { select(row.pageId === PAGE_APP_DSH_PAGE ? null : row.pageId) }}
          >
            <span className={css.itemLabel}>{row.label}</span>
          </button>
        )
      })}
    </nav>
  )
}
