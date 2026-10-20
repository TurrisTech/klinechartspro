import { el } from '../alerts/dom'
import { change, FIGURE_COLUMNS, type FigureColumn, type Figures } from './figures'

// GLUE (DOM). Rows of figures (figures.ts) as one table, the way every comparison in the lab
// shows them: the Summary's this-run / fitting / holdout / baseline, the run history, a sweep's
// values and a basket's instruments. A row compared with another shows each change under its
// value, coloured by whether it is better.

export interface FigureRow {
  /** The first cell: what the row is. */
  label: string | HTMLElement
  figures: Figures | null
  /** Shown across the figures when there are none. */
  error?: string | null
  className?: string
  /** Each change from these figures is written under the value. */
  compareTo?: Figures | null
  /** Cells after the figures (buttons). */
  extra?: Array<string | HTMLElement>
  onClick?: () => void
  title?: string
}

/** Columns whose sign is the news: green above zero, red below. */
const SIGNED = new Set(['totalR', 'avgR', 'tR', 'pips', 'fwd'])

export function figuresTable(rows: readonly FigureRow[], opts: { first: string; extraHeaders?: string[]; columns?: FigureColumn[]; className?: string } = { first: '' }): HTMLElement {
  const columns = opts.columns ?? FIGURE_COLUMNS
  const wrap = el('div', 'wd-lab-table-wrap')
  const table = el('table', `wd-lab-table wd-lab-figures ${opts.className ?? ''}`)
  const head = el('thead', '')
  const tr = el('tr', '')
  for (const [text, title] of [[opts.first, ''], ...columns.map((c) => [c.label, c.title] as const), ...(opts.extraHeaders ?? []).map((h) => [h, ''] as const)]) {
    const th = el('th', '')
    th.textContent = text
    if (title) th.title = title
    tr.appendChild(th)
  }
  head.appendChild(tr)
  const body = el('tbody', '')
  for (const row of rows) {
    const line = el('tr', `${row.className ?? ''}${row.onClick ? ' is-clickable' : ''}`)
    if (row.title) line.title = row.title
    const first = el('td', 'wd-lab-figures-label')
    if (typeof row.label === 'string') first.textContent = row.label
    else first.appendChild(row.label)
    line.appendChild(first)
    if (!row.figures) {
      const td = el('td', row.error ? 'is-down' : 'is-muted') as HTMLTableCellElement
      td.colSpan = columns.length
      td.style.textAlign = 'left'
      td.textContent = row.error ?? '…'
      line.appendChild(td)
    } else {
      for (const c of columns) {
        const v = c.value(row.figures)
        const td = el('td', SIGNED.has(c.key) && v !== null && Number.isFinite(v) && v !== 0 ? (v > 0 ? 'is-up' : 'is-down') : '')
        td.textContent = c.format(v)
        const d = row.compareTo ? change(c, row.figures, row.compareTo) : null
        if (d && d.text !== '=') {
          const delta = el('div', `wd-lab-delta${d.sign > 0 ? ' is-better' : d.sign < 0 ? ' is-worse' : ''}`)
          delta.textContent = d.text
          td.appendChild(delta)
        }
        line.appendChild(td)
      }
    }
    for (const cell of row.extra ?? []) {
      const td = el('td', 'wd-lab-figures-extra')
      if (typeof cell === 'string') td.textContent = cell
      else td.appendChild(cell)
      line.appendChild(td)
    }
    if (row.onClick) {
      line.tabIndex = 0
      line.addEventListener('click', (e) => {
        // A button in the row does its own thing.
        if ((e.target as HTMLElement).closest('button')) return
        row.onClick?.()
      })
      line.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.target === line) row.onClick?.()
      })
    }
    body.appendChild(line)
  }
  table.append(head, body)
  wrap.appendChild(table)
  return wrap
}
