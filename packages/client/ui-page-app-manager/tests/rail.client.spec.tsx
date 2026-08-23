// @vitest-environment jsdom
/**
 * PageAppRail: DSH / Agent is always rendered first; eligible managed rows
 * appear in stable registry order; a hidden/disabled/unhealthy row never
 * appears (the shell filters eligibility before handing rows in); accessible
 * current-page state (aria-current), roving-tabindex keyboard navigation,
 * and labels. Pure component: rows, active id, and select arrive as props.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { PageAppRail, type PageAppRailInjected, type PageAppRailRow } from '../src/client/PageAppRail.tsx'

function row(pageId: string, label: string, order: number): PageAppRailRow {
  return { pageId, label, order }
}

function mountRail(over: Partial<PageAppRailInjected> = {}) {
  const select = vi.fn()
  const props: PageAppRailInjected = {
    rows: [row('page-a', 'Script', 100), row('page-b', 'Storyboard', 200)],
    activePageId: null,
    select,
    ...over,
  }
  const utils = render(<PageAppRail {...props} />)
  return { select, ...utils }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('PageAppRail', () => {
  it('renders DSH / Agent first, then eligible rows in stable order', () => {
    const { container } = mountRail()
    const labels = [...container.querySelectorAll('[data-page-app-rail-item]')]
      .map(el => el.textContent ?? '')
    expect(labels).toEqual(['DSH / Agent', 'Script', 'Storyboard'])
  })

  it('marks the active page with aria-current and focuses it initially', () => {
    const { getByRole } = mountRail({ activePageId: 'page-b' })
    const storyboard = getByRole('button', { name: 'Storyboard' })
    expect(storyboard.getAttribute('aria-current')).toBe('page')
    expect(storyboard.getAttribute('tabindex')).toBe('0')
    const dsh = getByRole('button', { name: 'DSH / Agent' })
    expect(dsh.getAttribute('aria-current')).toBeNull()
  })

  it('defaults the active marker to DSH when no managed page is active', () => {
    const { getByRole } = mountRail({ activePageId: null })
    expect(getByRole('button', { name: 'DSH / Agent' }).getAttribute('aria-current')).toBe('page')
  })

  it('selects the built-in DSH page with null on click', () => {
    const { select, getByRole } = mountRail({ activePageId: 'page-a' })
    fireEvent.click(getByRole('button', { name: 'DSH / Agent' }))
    expect(select).toHaveBeenCalledWith(null)
  })

  it('selects a managed page with its page id on click', () => {
    const { select, getByRole } = mountRail({ activePageId: null })
    fireEvent.click(getByRole('button', { name: 'Script' }))
    expect(select).toHaveBeenCalledWith('page-a')
  })

  it('supports ArrowDown/ArrowUp/Home/End roving-tabindex navigation', () => {
    const { getByRole, container } = mountRail({ activePageId: 'page-a' })
    const script = getByRole('button', { name: 'Script' })
    act(() => { script.focus() })
    const rail = container.querySelector('[data-page-app-rail]') as HTMLElement
    fireEvent.keyDown(rail, { key: 'ArrowDown' })
    expect(document.activeElement?.textContent).toBe('Storyboard')
    fireEvent.keyDown(rail, { key: 'ArrowUp' })
    expect(document.activeElement?.textContent).toBe('Script')
    fireEvent.keyDown(rail, { key: 'Home' })
    expect(document.activeElement?.textContent).toBe('DSH / Agent')
    fireEvent.keyDown(rail, { key: 'End' })
    expect(document.activeElement?.textContent).toBe('Storyboard')
  })

  it('keeps a single tab stop (roving tabindex) per the active row', () => {
    const { container } = mountRail({ activePageId: 'page-b' })
    const tabbable = [...container.querySelectorAll('[data-page-app-rail-item]')]
      .filter(el => el.getAttribute('tabindex') === '0')
    expect(tabbable).toHaveLength(1)
    expect(tabbable[0]?.textContent).toBe('Storyboard')
  })

  it('renders no managed rows when the projection is empty', () => {
    const { container } = mountRail({ rows: [] })
    const labels = [...container.querySelectorAll('[data-page-app-rail-item]')]
      .map(el => el.textContent ?? '')
    expect(labels).toEqual(['DSH / Agent'])
  })
})
