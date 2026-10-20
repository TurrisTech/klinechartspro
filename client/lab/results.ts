import { button, el } from '../alerts/dom'
import { resolutionDurationMs } from '../periods'
import { rootIndex } from './entries'
import { download, entriesCsv, fileStem, tradesCsv } from './export'
import { figuresTable, type FigureRow } from './figtable'
import { describeMean, type Figures, figuresOf } from './figures'
import { meanStats } from './stats'
import type { Problem } from './model'
import type { EntryOutcome, OutcomeSummary } from './outcomes'
import type { LabRun } from './runner'
import type { ExitReason, LabTrade } from './trades'

// GLUE (DOM). What a run found, in four views:
//
//   Summary   counts, what happened after the entries (the outcome measures, all / long /
//             short), and the simulated account
//   Entries   one row per entry, with its outcomes -- a click takes the chart there
//   Trades    one row per simulated trade -- a click takes the chart there
//   Equity    the closed-trade balance over time, with a crosshair; a click takes the chart to
//             the trade closed there
//
// The Entries and Trades tables sort on a header click (ascending, descending, back to time), and
// the stepper beside the tabs -- or `[` / `]`, or the arrow keys on a row -- walks the chart through
// the rows in the order shown, so the worst ten trades are ten key presses once sorted by R.
//
// Problems that stop a run are shown in a banner over the LAST run's results, which stay -- dimmed,
// as they no longer describe the draft -- so a half-typed condition does not take away what the
// run before it found. Each problem is a link to its slot.
//
// The Summary's first table is the run's figures (figures.ts) -- beside the fitting part and the
// holdout when the window has one, and beside the BASELINE run when one is pinned, each change
// coloured by whether it is better. Under them: how sure the mean R and the forward pips are
// (stats.ts), the trades month by month, and what the costs came to. Panels the page adds (the
// run history, a sweep, a basket) are tabs after these four, and work without a run.

export interface Pick {
  /** The entry the row is about (a trade's entry too). */
  entryId: string
  /** The instant to bring on screen. */
  at: number
}

export interface ResultsHandlers {
  /** A row (or the stepper, or the equity curve) chose an entry: take the chart there. */
  onPick(pick: Pick): void
  /** A problem in the banner was clicked: show its slot. */
  onProblem?(problem: Problem): void
}

export interface ResultsView {
  readonly element: HTMLElement
  showRun(run: LabRun): void
  /** Problems (or a failure, with none) that stop the draft running. The last run stays shown,
   * marked out of date, under a banner listing them. */
  showProblems(problems: Problem[], message: string): void
  /** The draft was edited and no run is coming (Auto-run is off): the last run stays shown,
   * marked out of date, under `text`. */
  showStale(text: string): void
  /** A message in place of everything: no run is shown (another strategy, before its first run). */
  showMessage(text: string, kind?: 'info' | 'error'): void
  /** The run's progress, over whatever is shown. */
  progress(text: string | null): void
  /** Mark a row as the chart's selection. */
  select(entryId: string | null): void
  /** Select the next (+1) or previous (-1) row of the table shown -- the entries in time order on
   * the Summary and Equity tabs -- and take the chart there. False when there is nothing to step. */
  step(delta: 1 | -1): boolean
  /** A tab after the run's own four, shown with or without a run. */
  addPanel(panel: ResultsPanel): void
  /** Re-read the panels' tab labels (a count changed). */
  refreshTabs(): void
  /** The run the Summary compares with, and what to call it; null for none. */
  setBaseline(baseline: { figures: Figures; label: string } | null): void
}

export interface ResultsPanel {
  id: string
  label(): string
  element: HTMLElement
}

/** The run's own tabs; panels' ids are theirs. */
type Tab = string
type Sortable = 'entries' | 'trades'
const RUN_TABS = new Set(['summary', 'entries', 'trades', 'equity'])

const TAB_KEY = 'wd.lab.tab'

const REASON_WORDS: Record<ExitReason, string> = {
  stop: 'stop',
  target: 'target',
  breakeven: 'breakeven',
  trail: 'trailing stop',
  rule: 'exit rule',
  time: 'time limit',
  opposite: 'opposite entry',
  end: 'still open at the end'
}

/** One row of a results table. `keys` sort it, one per column (null sorts last either way). */
interface Row {
  /** The entry it is about: what selecting it picks. */
  id: string
  at: number
  cells: Array<string | HTMLElement>
  keys: Array<number | string | null>
  tone?: string[]
  /** An entry the filter took out: shown, but not stepped to from the Summary. */
  muted?: boolean
  /** In the holdout. */
  holdout?: boolean
}

function storedTab(): Tab {
  try {
    return window.localStorage.getItem(TAB_KEY) ?? 'summary'
  } catch {
    return 'summary'
  }
}

export function createResultsView(handlers: ResultsHandlers): ResultsView {
  const element = el('section', 'wd-lab-results')
  const bar = el('div', 'wd-lab-tabs')
  const tabs = el('div', 'wd-lab-tab-list')
  tabs.setAttribute('role', 'tablist')
  const stepper = el('div', 'wd-lab-stepper')
  const csv = button('kc-button wd-lab-mini wd-lab-csv', 'CSV', () => exportCsv())
  csv.title = 'Save this table as a CSV file (raw values, UTC times)'
  const tools = el('div', 'wd-lab-tools')
  tools.append(csv, stepper)
  bar.append(tabs, tools)
  const status = el('div', 'wd-lab-status')
  status.hidden = true
  const banner = el('div', 'wd-lab-banner')
  banner.hidden = true
  const body = el('div', 'wd-lab-results-body')
  element.append(bar, status, banner, body)

  let tab: Tab = storedTab()
  let run: LabRun | null = null
  let selected: string | null = null
  let side: 'all' | 'long' | 'short' = 'all'
  /** Per table: the column it is sorted on and which way; null for time order. */
  const sorts: Record<Sortable, { col: number; desc: boolean } | null> = { entries: null, trades: null }
  const panels: ResultsPanel[] = []
  let baseline: { figures: Figures; label: string } | null = null
  /** The results no longer describe the draft (a banner says why). */
  let stale = false

  const TABS: Array<{ id: Tab; label: string }> = [
    { id: 'summary', label: 'Summary' },
    { id: 'entries', label: 'Entries' },
    { id: 'trades', label: 'Trades' },
    { id: 'equity', label: 'Equity' }
  ]

  const isPanel = (id: Tab): boolean => panels.some((p) => p.id === id)
  /** The tab to show: the chosen one when it exists, else the Summary. */
  const shown = (): Tab => (RUN_TABS.has(tab) || isPanel(tab) ? tab : 'summary')

  function renderTabs(): void {
    tabs.innerHTML = ''
    const current = shown()
    for (const t of [...TABS, ...panels.map((p) => ({ id: p.id, label: p.label() }))]) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = `wd-lab-tab${t.id === current ? ' is-on' : ''}${isPanel(t.id) ? ' is-panel' : ''}`
      b.setAttribute('role', 'tab')
      b.setAttribute('aria-selected', String(t.id === current))
      let count = ''
      if (run && t.id === 'entries') count = ` ${run.entries.length}`
      if (run?.sim && t.id === 'trades') count = ` ${run.sim.trades.length}`
      b.textContent = `${t.label}${count}`
      b.disabled = run === null && !isPanel(t.id)
      b.addEventListener('click', () => {
        tab = t.id
        try {
          window.localStorage.setItem(TAB_KEY, tab)
        } catch {
          // A per-device convenience only.
        }
        render()
      })
      tabs.appendChild(b)
    }
  }

  function render(): void {
    renderTabs()
    renderStepper()
    const current = shown()
    const panel = panels.find((p) => p.id === current)
    csv.hidden = !run || !(current === 'entries' || current === 'trades')
    // Out of date describes the run, not a panel.
    body.classList.toggle('is-stale', stale && !panel)
    if (panel) {
      if (panel.element.parentElement !== body || body.childElementCount !== 1) body.replaceChildren(panel.element)
      return
    }
    if (!run) {
      // A panel was shown before any run; the run's own tabs have nothing to show yet.
      if (body.firstElementChild && panels.some((p) => p.element === body.firstElementChild)) body.replaceChildren(message('Press Run to evaluate the strategy over its window.'))
      return
    }
    body.innerHTML = ''
    if (current === 'summary') body.appendChild(summaryView(run))
    if (current === 'entries') body.appendChild(entriesView(run))
    if (current === 'trades') body.appendChild(tradesView(run))
    if (current === 'equity') body.appendChild(equityView(run))
  }

  function exportCsv(): void {
    if (!run) return
    const stem = `${fileStem(run.strategy.name)}-${run.symbol.replace(':', '-')}`
    if (shown() === 'trades') download(`${stem}-trades.csv`, tradesCsv(run), 'text/csv')
    else download(`${stem}-entries.csv`, entriesCsv(run), 'text/csv')
  }

  // -- formatting --------------------------------------------------------------------------------

  const fmt = (v: number | null | undefined, digits = 1): string => (v === null || v === undefined || !Number.isFinite(v) ? '–' : v.toFixed(digits))
  const pct = (v: number | null | undefined): string => (v === null || v === undefined ? '–' : `${(v * 100).toFixed(0)}%`)
  const signed = (v: number | null | undefined, digits = 1): string => (v === null || v === undefined || !Number.isFinite(v) ? '–' : `${v > 0 ? '+' : ''}${v.toFixed(digits)}`)
  /** A whole amount with its thousands grouped: 1,696,969. */
  const whole = (v: number | null | undefined, sign = false): string =>
    v === null || v === undefined || !Number.isFinite(v) ? '–' : `${sign && v > 0 ? '+' : ''}${Math.round(v).toLocaleString('en-US')}`
  const time = (ms: number, zone: string): string =>
    new Intl.DateTimeFormat('en-GB', { timeZone: zone, year: '2-digit', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms)
  const zoneOf = (r: LabRun): string => r.grid.schedule.timezone

  const tone = (v: number | null | undefined): string => (v === null || v === undefined || !Number.isFinite(v) || v === 0 ? '' : v > 0 ? 'is-up' : 'is-down')

  /** A table of plain rows: the Summary's. */
  function table(headers: string[], rows: Array<{ cells: string[]; tone?: string[] }>, className = ''): HTMLElement {
    const wrap = el('div', 'wd-lab-table-wrap')
    const t = el('table', `wd-lab-table ${className}`)
    const head = el('thead', '')
    const tr = el('tr', '')
    for (const h of headers) {
      const th = el('th', '')
      th.textContent = h
      tr.appendChild(th)
    }
    head.appendChild(tr)
    const tbody = el('tbody', '')
    for (const r of rows) {
      const row = el('tr', '')
      r.cells.forEach((cell, i) => {
        const td = el('td', r.tone?.[i] ?? '')
        td.textContent = cell
        row.appendChild(td)
      })
      tbody.appendChild(row)
    }
    t.append(head, tbody)
    wrap.appendChild(t)
    return wrap
  }

  /** `rows` in the order `which` is sorted in: by the clicked column, else as given (time). */
  function sorted(which: Sortable, rows: Row[]): Row[] {
    const sort = sorts[which]
    if (!sort) return rows
    const sign = sort.desc ? -1 : 1
    return rows
      .map((row, i) => ({ row, i }))
      .sort((a, b) => {
        const x = a.row.keys[sort.col]
        const y = b.row.keys[sort.col]
        if (x === y || (x === null && y === null)) return a.i - b.i
        if (x === null) return 1
        if (y === null) return -1
        return (x < y ? -1 : 1) * sign
      })
      .map((x) => x.row)
  }

  /** A results table whose rows pick an entry, sorted on a header click. */
  function pickTable(which: Sortable, headers: string[], rows: Row[], className = ''): HTMLElement {
    const wrap = el('div', 'wd-lab-table-wrap')
    const t = el('table', `wd-lab-table is-picking ${className}`)
    const head = el('thead', '')
    const tr = el('tr', '')
    const sort = sorts[which]
    headers.forEach((h, col) => {
      const th = el('th', 'is-sortable')
      const on = sort?.col === col
      th.textContent = `${h}${on ? (sort?.desc ? ' ▾' : ' ▴') : ''}`
      th.title = on && sort?.desc ? 'Back to time order' : `Sort by ${h}`
      th.setAttribute('aria-sort', on ? (sort?.desc ? 'descending' : 'ascending') : 'none')
      th.addEventListener('click', () => {
        // Ascending, then descending, then back to time order.
        sorts[which] = !on ? { col, desc: false } : sort?.desc ? null : { col, desc: true }
        render()
      })
      tr.appendChild(th)
    })
    head.appendChild(tr)
    const tbody = el('tbody', '')
    for (const r of sorted(which, rows)) {
      const row = el('tr', `is-clickable${selected === r.id ? ' is-selected' : ''}${r.holdout ? ' is-holdout' : ''}`)
      if (r.holdout) row.title = 'In the holdout'
      row.dataset.id = r.id
      row.tabIndex = 0
      r.cells.forEach((cell, i) => {
        const td = el('td', r.tone?.[i] ?? '')
        if (typeof cell === 'string') td.textContent = cell
        else td.appendChild(cell)
        row.appendChild(td)
      })
      row.addEventListener('click', () => pick(r.id, r.at))
      row.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') pick(r.id, r.at)
        else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault()
          if (step(e.key === 'ArrowDown' ? 1 : -1)) (body.querySelector('tr.is-selected') as HTMLElement | null)?.focus()
        }
      })
      tbody.appendChild(row)
    }
    t.append(head, tbody)
    wrap.appendChild(t)
    return wrap
  }

  // -- selecting ------------------------------------------------------------------------------------

  function pick(id: string, at: number): void {
    selected = id
    markSelected()
    handlers.onPick({ entryId: id, at })
  }

  /** The selection's row(s) marked in place -- a re-render would lose the table's scroll. */
  function markSelected(): void {
    for (const row of body.querySelectorAll<HTMLElement>('tr[data-id]')) row.classList.toggle('is-selected', row.dataset.id === selected)
    body.querySelector('tr.is-selected')?.scrollIntoView({ block: 'nearest' })
    renderStepper()
  }

  /** What the stepper walks: the shown table's rows in their order, else the entries in time. */
  function stepList(): { noun: string; rows: Row[] } {
    const tab = shown()
    if (!run || isPanel(tab)) return { noun: 'entry', rows: [] }
    if (tab === 'trades') return { noun: 'trade', rows: sorted('trades', tradeRows(run)) }
    if (tab === 'entries') return { noun: 'entry', rows: sorted('entries', entryRows(run)) }
    return { noun: 'entry', rows: entryRows(run).filter((r) => !r.muted) }
  }

  function step(delta: 1 | -1): boolean {
    const { rows } = stepList()
    if (rows.length === 0) return false
    const at = rows.findIndex((r) => r.id === selected)
    const next = at < 0 ? (delta > 0 ? 0 : rows.length - 1) : at + delta
    if (next < 0 || next >= rows.length) return false
    pick(rows[next].id, rows[next].at)
    return true
  }

  function renderStepper(): void {
    stepper.innerHTML = ''
    const { noun, rows } = stepList()
    if (!run || rows.length === 0) return
    const at = rows.findIndex((r) => r.id === selected)
    const prev = button('kc-button wd-lab-step', '‹', () => step(-1))
    prev.title = `Previous ${noun} ([)`
    prev.setAttribute('aria-label', `Previous ${noun}`)
    prev.disabled = at === 0
    const next = button('kc-button wd-lab-step', '›', () => step(1))
    next.title = `Next ${noun} (])`
    next.setAttribute('aria-label', `Next ${noun}`)
    next.disabled = at === rows.length - 1
    const label = el('span', 'wd-lab-step-label')
    label.textContent = at < 0 ? `${rows.length} ${noun === 'entry' ? 'entries' : 'trades'}` : `${noun} ${at + 1} / ${rows.length}`
    stepper.append(prev, label, next)
  }

  // -- views --------------------------------------------------------------------------------------

  function summaryView(r: LabRun): HTMLElement {
    const box = el('div', 'wd-lab-summary')
    const longs = r.entries.filter((e) => e.direction === 'long').length
    const facts = el('div', 'wd-lab-facts')
    const fact = (value: string, label: string, title = '', valueTone = ''): void => {
      const f = el('div', 'wd-lab-fact')
      const v = el('div', `wd-lab-fact-value ${valueTone}`)
      v.textContent = value
      const l = el('div', 'wd-lab-fact-label')
      l.textContent = label
      f.append(v, l)
      if (title) f.title = title
      facts.appendChild(f)
    }
    const inWindow = r.signals.filter((s) => s.knownAt >= r.from && s.knownAt <= r.to).length
    fact(whole(inWindow), 'signals', 'Signals of the pool in the window (more are read before it, for the graphs in force at its start)')
    if (r.strategy.graph.enabled) fact(String(r.graphs.length), 'graphs')
    fact(String(r.entries.length), 'entries', `${longs} long, ${r.entries.length - longs} short`)
    if (r.filtered.length > 0) fact(String(r.filtered.length), 'filtered out')
    if (r.sim) {
      fact(String(r.sim.stats.trades), 'trades')
      fact(pct(r.sim.stats.winRate), 'won')
      fact(signed(r.sim.stats.totalR, 1), 'R in all', '', tone(r.sim.stats.totalR))
      fact(signed(r.sim.stats.netPips, 0), 'pips', '', tone(r.sim.stats.netPips))
    }
    box.appendChild(facts)

    // The run beside its parts and the baseline.
    const figureRows: FigureRow[] = []
    const all = figuresOf(r)
    if (r.split !== null || baseline) {
      figureRows.push({ label: 'this run', figures: all, compareTo: baseline?.figures ?? null, className: 'is-current' })
      if (r.split !== null) {
        const at = time(r.split, zoneOf(r))
        figureRows.push({ label: `fitting, to ${at}`, figures: figuresOf(r, 'fit'), className: 'is-part' })
        figureRows.push({ label: `holdout, from ${at}`, figures: figuresOf(r, 'holdout'), className: 'is-part is-holdout' })
      }
      if (baseline) figureRows.push({ label: `baseline: ${baseline.label}`, figures: baseline.figures, className: 'is-baseline' })
      box.appendChild(figuresTable(figureRows, { first: '' }))
      if (baseline) {
        const note = el('p', 'wd-lab-note')
        note.textContent = 'Under each figure of this run: its change from the baseline, green where better. Pin a different baseline on the Runs tab.'
        box.appendChild(note)
      }
    }

    // Signals per source and timeframe.
    const counts = r.counts.filter((c) => c.signals >= 0)
    if (counts.length > 0) {
      const line = el('p', 'wd-lab-note')
      line.textContent = `Read: ${counts.map((c) => `${c.source} ${c.interval} ${c.signals}`).join(' · ')}`
      box.appendChild(line)
    }

    // What happened after the entries.
    const head = el('div', 'wd-lab-subhead')
    head.textContent = `After the entries -- on ${r.pathInterval ?? 'no'} bars, mid prices`
    const sides = el('span', 'wd-lab-chips')
    for (const s of ['all', 'long', 'short'] as const) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = `wd-lab-chip${s === side ? ' is-on' : ''}`
      b.textContent = s === 'all' ? `all ${r.summary.all.n}` : `${s} ${r.summary[s].n}`
      b.addEventListener('click', () => {
        side = s
        render()
      })
      sides.appendChild(b)
    }
    head.appendChild(sides)
    box.appendChild(head)
    const summary: OutcomeSummary = r.summary[side]
    // How sure each mean is: forward pips per entry on this side, horizon by horizon.
    const sideEntries = r.entries.filter((e) => side === 'all' || e.direction === side)
    const forwardStats = summary.horizons.map((_, h) => meanStats(sideEntries.flatMap((e) => {
      const pips = r.outcomes.get(e.id)?.forward[h]?.pips
      return pips === undefined || !Number.isFinite(pips) ? [] : [pips]
    })))
    box.appendChild(
      table(
        ['after', 'n', 'mean pips', 't', '95% CI', 'median pips', 'its way', 'mean ATR'],
        summary.horizons.map((h, i) => {
          const st = forwardStats[i]
          return {
            cells: [
              `${h.bars} bar${h.bars === 1 ? '' : 's'}`,
              String(h.n),
              signed(h.meanPips),
              st.t === null ? '–' : signed(st.t, 1),
              st.ci ? `${signed(st.ci[0])} to ${signed(st.ci[1])}` : '–',
              signed(h.medianPips),
              pct(h.positive),
              signed(h.meanAtr, 2)
            ],
            tone: ['', '', tone(h.meanPips), Math.abs(st.t ?? 0) >= 2 ? tone(st.t) : '', '', tone(h.medianPips), '', tone(h.meanAtr)]
          }
        })
      )
    )
    box.appendChild(
      table(
        ['first to', 'its way', 'for', 'against', 'neither'],
        summary.touches.map((t) => ({ cells: [`±${t.k} ATR`, pct(t.rate), String(t.wins), String(t.losses), String(t.open)] }))
      )
    )
    const excursion = el('p', 'wd-lab-note')
    excursion.textContent = `Furthest for / against inside the longest horizon: ${fmt(summary.meanMfeAtr, 2)} / ${fmt(summary.meanMaeAtr, 2)} ATR on average (${fmt(summary.meanMfePips)} / ${fmt(summary.meanMaePips)} pips).`
    box.appendChild(excursion)

    if (r.sim) {
      const s = r.sim.stats
      const simHead = el('div', 'wd-lab-subhead')
      simHead.textContent = 'Simulated trades -- the paper-trading fill engine, bid/ask'
      box.appendChild(simHead)
      box.appendChild(
        table(
          ['trades', 'won', 'net pips', 'R', 'avg R', 'profit factor', 'max drawdown', `net (${quoteOf(r)})`, 'avg bars'],
          [
            {
              cells: [String(s.trades), pct(s.winRate), signed(s.netPips, 0), signed(s.totalR, 1), signed(s.avgR, 2), fmt(s.profitFactor, 2), pct(s.maxDrawdown), whole(s.netPnl, true), fmt(s.avgBarsHeld, 0)],
              tone: ['', '', tone(s.netPips), tone(s.totalR), tone(s.avgR), '', '', tone(s.netPnl), '']
            }
          ]
        )
      )
      const sure = el('p', 'wd-lab-note wd-lab-significance')
      sure.textContent = `Mean R per trade: ${describeMean(meanStats(s.rs), 2)}. The t and the interval treat trades as independent; trades close together are not, so read them as the least doubt there is. |t| under 2 is noise.`
      box.appendChild(sure)
      const paid = s.costs.commission + s.costs.financing + s.costs.slippage
      if (paid !== 0 || s.capped > 0) {
        const p = el('p', 'wd-lab-note')
        const parts = [
          s.costs.commission ? `commission ${whole(s.costs.commission)}` : '',
          s.costs.financing ? `financing ${whole(s.costs.financing, true)}` : '',
          s.costs.slippage ? `slippage ${whole(s.costs.slippage)}` : ''
        ].filter(Boolean)
        p.textContent = `${parts.length > 0 ? `Costs beyond the spread (${quoteOf(r)}, in the P&L and R above): ${parts.join(' · ')}.` : ''}${s.capped > 0 ? ` ${s.capped} trade${s.capped === 1 ? '' : 's'} cut to the ${r.strategy.sizing.maxLeverage}:1 leverage cap.` : ''}`.trim()
        box.appendChild(p)
      }
      const months = monthly(r)
      if (months.length > 1) {
        const mHead = el('div', 'wd-lab-subhead')
        mHead.textContent = 'Month by month -- by when each trade closed'
        box.appendChild(mHead)
        box.appendChild(
          table(
            ['month', 'trades', 'won', 'R', 'avg R', 'pips', `net (${quoteOf(r)})`],
            months.map((m) => ({
              cells: [m.month, String(m.trades), pct(m.trades > 0 ? m.wins / m.trades : null), signed(m.r, 1), signed(m.trades > 0 ? m.r / m.trades : null, 2), signed(m.pips, 0), whole(m.pnl, true)],
              tone: ['', '', '', tone(m.r), tone(m.r), tone(m.pips), tone(m.pnl)]
            }))
          )
        )
      }
      const reasons = Object.entries(s.byReason)
        .map(([reason, n]) => `${REASON_WORDS[reason as ExitReason] ?? reason} ${n}`)
        .join(' · ')
      if (reasons) {
        const p = el('p', 'wd-lab-note')
        p.textContent = `Closed by: ${reasons}`
        box.appendChild(p)
      }
      if (r.sim.skipped.length > 0) {
        const why = new Map<string, number>()
        for (const k of r.sim.skipped) why.set(k.reason, (why.get(k.reason) ?? 0) + 1)
        const p = el('p', 'wd-lab-note')
        p.textContent = `Not taken: ${[...why].map(([reason, n]) => `${n} -- ${reason}`).join('; ')}`
        box.appendChild(p)
      }
    }
    for (const warning of r.warnings) {
      const p = el('p', 'wd-lab-warning')
      p.textContent = warning
      box.appendChild(p)
    }
    const timing = el('p', 'wd-lab-note wd-lab-timing')
    timing.textContent = `${r.symbol} · ${time(r.from, zoneOf(r))} – ${time(r.to, zoneOf(r))} (${zoneOf(r)}) · ${r.timings.map((t) => `${t.stage} ${(t.ms / 1000).toFixed(2)} s`).join(', ')}`
    box.appendChild(timing)
    return box
  }

  /** Entries and the filter's rejects, in time. */
  function entryRows(r: LabRun): Row[] {
    const zone = zoneOf(r)
    const horizons = [...r.strategy.outcomes.horizons].sort((a, b) => a - b)
    const touches = r.strategy.outcomes.touches
    const all = [...r.entries.map((e) => ({ e, filtered: false })), ...r.filtered.map((e) => ({ e, filtered: true }))].sort((a, b) => a.e.at - b.e.at)
    const touchKey = (t: string | undefined): number | null => (t === 'win' ? 1 : t === 'loss' ? -1 : t === 'open' ? 0 : null)
    return all.map(({ e, filtered }, i) => {
      const o: EntryOutcome | undefined = r.outcomes.get(e.id)
      const root = e.graph ? (e.graph.nodes[rootIndex(e.graph, e.node)] ?? null) : null
      const depth = e.graph ? e.graph.nodes[e.node].depth : null
      return {
        id: e.id,
        at: e.at,
        muted: filtered,
        holdout: r.split !== null && e.at >= r.split,
        cells: [
          String(i + 1),
          time(e.at, zone),
          e.signal.interval,
          filtered ? `${e.direction} (filtered)` : e.direction,
          e.signal.price.toFixed(5),
          root ? `${e.graph?.root} ${time(root.signal.knownAt, zone)}` : '',
          depth === null ? '' : String(depth),
          ...horizons.map((_, h) => signed(o?.forward[h]?.pips)),
          ...touches.map((_, t) => {
            const result = o?.touches[t]?.result
            return result === 'win' ? 'for' : result === 'loss' ? 'against' : result === 'open' ? '–' : ''
          }),
          o ? `${fmt(o.mfeAtr, 2)} / ${fmt(o.maeAtr, 2)}` : ''
        ],
        keys: [
          i,
          e.at,
          resolutionDurationMs(e.signal.interval),
          `${filtered ? 'z' : ''}${e.direction}`,
          e.signal.price,
          root?.signal.knownAt ?? null,
          depth,
          ...horizons.map((_, h) => o?.forward[h]?.pips ?? null),
          ...touches.map((_, t) => touchKey(o?.touches[t]?.result)),
          o?.mfeAtr !== undefined && o?.maeAtr !== undefined ? o.mfeAtr - o.maeAtr : null
        ],
        tone: ['', '', '', filtered ? 'is-muted' : '', '', '', '', ...horizons.map((_, h) => tone(o?.forward[h]?.pips)), ...touches.map((_, t) => (o?.touches[t]?.result === 'win' ? 'is-up' : o?.touches[t]?.result === 'loss' ? 'is-down' : '')), '']
      }
    })
  }

  function entriesView(r: LabRun): HTMLElement {
    if (r.entries.length === 0 && r.filtered.length === 0) return message('No entries in this window.')
    const horizons = [...r.strategy.outcomes.horizons].sort((a, b) => a - b)
    const touches = r.strategy.outcomes.touches
    return pickTable('entries', ['#', 'at', 'tf', 'trade', 'price', 'root', 'depth', ...horizons.map((h) => `+${h}`), ...touches.map((k) => `±${k}`), 'MFE/MAE ATR'], entryRows(r), 'is-entries')
  }

  function tradeRows(r: LabRun): Row[] {
    if (!r.sim) return []
    const zone = zoneOf(r)
    return r.sim.trades.map((t: LabTrade, i) => ({
      id: t.entry.id,
      at: t.openedAt,
      holdout: r.split !== null && t.openedAt >= r.split,
      cells: [
        String(i + 1),
        time(t.openedAt, zone),
        t.direction,
        t.capped ? `${whole(t.units)} (cap)` : whole(t.units),
        t.openPrice.toFixed(5),
        t.stop === null ? '–' : t.stop.toFixed(5),
        t.target === null ? '–' : t.target.toFixed(5),
        t.closedAt === null ? '' : time(t.closedAt, zone),
        t.reason ? REASON_WORDS[t.reason] : '',
        t.closePrice === null ? '' : t.closePrice.toFixed(5),
        signed(t.pips),
        signed(t.r, 2),
        whole(t.pnl, true),
        whole(t.commission + t.financing + t.slippage),
        String(t.barsHeld)
      ],
      keys: [i, t.openedAt, t.direction, t.units, t.openPrice, t.stop, t.target, t.closedAt, t.reason, t.closePrice, t.pips, t.r, t.pnl, t.commission + t.financing + t.slippage, t.barsHeld],
      tone: ['', '', '', '', '', '', '', '', '', '', tone(t.pips), tone(t.r), tone(t.pnl), '', '']
    }))
  }

  function tradesView(r: LabRun): HTMLElement {
    if (!r.sim) return message(r.entries.length === 0 ? 'No entries, so no trades.' : 'No trades were simulated.')
    if (r.sim.trades.length === 0) return message('No trades: every entry was refused (see the Summary).')
    return pickTable('trades', ['#', 'opened', 'trade', 'units', 'in', 'stop', 'target', 'closed', 'by', 'out', 'pips', 'R', `P&L (${quoteOf(r)})`, 'costs', 'bars'], tradeRows(r))
  }

  function equityView(r: LabRun): HTMLElement {
    if (!r.sim || r.sim.trades.length === 0) return message('No trades, so no equity curve.')
    return equityChart(r, zoneOf(r), time, (trade) => pick(trade.entry.id, trade.openedAt))
  }

  function message(text: string, kind: 'info' | 'error' = 'info'): HTMLElement {
    const p = el('p', kind === 'error' ? 'wd-lab-error' : 'wd-lab-note')
    p.textContent = text
    return p
  }

  function hideBanner(): void {
    banner.hidden = true
    banner.innerHTML = ''
    stale = false
    body.classList.remove('is-stale')
  }

  const onPanel = (): boolean => isPanel(shown())

  renderTabs()
  body.appendChild(message('Press Run to evaluate the strategy over its window.'))

  return {
    element,
    showRun(next) {
      run = next
      hideBanner()
      if (selected && !next.entries.some((e) => e.id === selected) && !next.filtered.some((e) => e.id === selected)) selected = null
      render()
      markSelected()
    },
    showProblems(problems, text) {
      banner.innerHTML = ''
      const head = el('p', 'wd-lab-error')
      head.textContent = run ? `${text} -- the results below are the last run's` : text
      banner.appendChild(head)
      if (problems.length > 0) {
        const list = el('ul', 'wd-lab-problems')
        for (const p of problems) {
          const li = el('li', '')
          const where = el('strong', '')
          where.textContent = `${p.where}: `
          if (handlers.onProblem) {
            const link = button('wd-lab-problem-link', '', () => handlers.onProblem?.(p))
            link.title = 'Show it in the editor'
            link.append(where, document.createTextNode(p.message))
            li.appendChild(link)
          } else li.append(where, document.createTextNode(p.message))
          list.appendChild(li)
        }
        banner.appendChild(list)
      }
      banner.hidden = false
      stale = run !== null
      body.classList.toggle('is-stale', stale && !onPanel())
      if (!run) {
        renderTabs()
        renderStepper()
        if (!onPanel()) body.innerHTML = ''
      }
    },
    showStale(text) {
      if (!run) return
      banner.innerHTML = ''
      banner.appendChild(message(text))
      banner.hidden = false
      stale = true
      body.classList.toggle('is-stale', !onPanel())
    },
    showMessage(text, kind = 'info') {
      run = null
      hideBanner()
      renderTabs()
      renderStepper()
      csv.hidden = true
      if (onPanel()) return
      body.innerHTML = ''
      body.appendChild(message(text, kind))
    },
    progress(text) {
      status.hidden = text === null
      status.textContent = text ?? ''
    },
    select(entryId) {
      selected = entryId
      markSelected()
    },
    step,
    addPanel(panel) {
      panels.push(panel)
      render()
    },
    refreshTabs() {
      renderTabs()
    },
    setBaseline(next) {
      baseline = next
      if (run && shown() === 'summary') render()
    }
  }
}

/** The closed trades by the month they closed in, on the instrument's clock. */
function monthly(r: LabRun): Array<{ month: string; trades: number; wins: number; r: number; pips: number; pnl: number }> {
  const zone = r.grid.schedule.timezone
  const key = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit' })
  const name = new Intl.DateTimeFormat('en-GB', { timeZone: zone, year: 'numeric', month: 'short' })
  const out = new Map<string, { month: string; trades: number; wins: number; r: number; pips: number; pnl: number }>()
  for (const t of r.sim?.trades ?? []) {
    if (t.closedAt === null || t.pnl === null) continue
    const k = key.format(t.closedAt)
    const m = out.get(k) ?? { month: name.format(t.closedAt), trades: 0, wins: 0, r: 0, pips: 0, pnl: 0 }
    m.trades++
    if (t.pnl > 0) m.wins++
    m.r += t.r ?? 0
    m.pips += t.pips ?? 0
    m.pnl += t.pnl
    out.set(k, m)
  }
  return [...out.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, m]) => m)
}

/** The instrument's quote currency (what P&L is counted in): EURUSD's USD. */
function quoteOf(r: LabRun): string {
  return r.symbol.split(':')[1]?.slice(3) || 'quote'
}

// -- the equity curve -------------------------------------------------------------------------------

const SVG = 'http://www.w3.org/2000/svg'

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG, tag)
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v))
  return node
}

/** The closed-trade balance as a step line over time, the opening balance as a reference, and a
 * crosshair that reads the balance under the pointer -- and the trade that set it, which a click
 * takes the chart to. One series, so no legend: the title names it. Inline SVG drawn with the
 * page's tokens, so it follows the theme. */
function equityChart(r: LabRun, zone: string, time: (ms: number, zone: string) => string, onTrade: (trade: LabTrade) => void): HTMLElement {
  const sim = r.sim as NonNullable<LabRun['sim']>
  const box = el('figure', 'wd-lab-equity')
  const caption = el('figcaption', 'wd-lab-subhead')
  const start = r.strategy.sizing.balance
  const points = [{ t: sim.trades[0].openedAt, balance: start }, ...sim.equity]
  const last = points[points.length - 1]
  caption.textContent = `Balance after each closed trade: ${start.toLocaleString()} → ${Math.round(last.balance).toLocaleString()} (max drawdown ${(sim.stats.maxDrawdown * 100).toFixed(1)}%)`
  box.appendChild(caption)

  const W = 720
  const H = 220
  const pad = { l: 64, r: 12, t: 10, b: 24 }
  const t0 = points[0].t
  const t1 = Math.max(last.t, t0 + 1)
  const values = points.map((p) => p.balance)
  let lo = Math.min(...values, start)
  let hi = Math.max(...values, start)
  if (hi - lo < 1e-9) {
    hi += 1
    lo -= 1
  }
  const x = (t: number): number => pad.l + ((t - t0) / (t1 - t0)) * (W - pad.l - pad.r)
  const y = (v: number): number => pad.t + (1 - (v - lo) / (hi - lo)) * (H - pad.t - pad.b)
  const chart = svg('svg', { viewBox: `0 0 ${W} ${H}`, class: 'wd-lab-equity-svg', role: 'img', 'aria-label': caption.textContent ?? '' })

  // Recessive grid: three levels and their values.
  for (const v of [lo, (lo + hi) / 2, hi]) {
    chart.appendChild(svg('line', { x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v), class: 'wd-lab-grid' }))
    const label = svg('text', { x: pad.l - 6, y: y(v) + 4, class: 'wd-lab-axis', 'text-anchor': 'end' })
    label.textContent = Math.round(v).toLocaleString()
    chart.appendChild(label)
  }
  for (const [t, anchor] of [
    [t0, 'start'],
    [t1, 'end']
  ] as const) {
    const label = svg('text', { x: x(t), y: H - 6, class: 'wd-lab-axis', 'text-anchor': anchor })
    label.textContent = time(t, zone)
    chart.appendChild(label)
  }
  // The opening balance.
  chart.appendChild(svg('line', { x1: pad.l, x2: W - pad.r, y1: y(start), y2: y(start), class: 'wd-lab-reference' }))
  // Where the holdout begins.
  if (r.split !== null && r.split > t0 && r.split < t1) {
    chart.appendChild(svg('line', { x1: x(r.split), x2: x(r.split), y1: pad.t, y2: H - pad.b, class: 'wd-lab-split-line' }))
    const label = svg('text', { x: x(r.split) + 4, y: pad.t + 10, class: 'wd-lab-axis' })
    label.textContent = 'holdout →'
    chart.appendChild(label)
  }
  // A step line: the balance holds between closes.
  let d = `M${x(points[0].t)},${y(points[0].balance)}`
  for (let i = 1; i < points.length; i++) d += `H${x(points[i].t)}V${y(points[i].balance)}`
  chart.appendChild(svg('path', { d, class: 'wd-lab-equity-line' }))

  // Crosshair + readout.
  const cross = svg('line', { y1: pad.t, y2: H - pad.b, class: 'wd-lab-cross', visibility: 'hidden' })
  const dot = svg('circle', { r: 4, class: 'wd-lab-equity-dot', visibility: 'hidden' })
  chart.append(cross, dot)
  const readout = el('div', 'wd-lab-readout')
  readout.hidden = true
  const hit = svg('rect', { x: pad.l, y: pad.t, width: W - pad.l - pad.r, height: H - pad.t - pad.b, class: 'wd-lab-hit' })
  // The closed trades in the order the balance moved: point i (i >= 1) is after closed[i - 1].
  const closed = sim.trades.filter((t) => t.closedAt !== null).sort((a, b) => (a.closedAt as number) - (b.closedAt as number))
  /** The point in force at the pointer: the balance after the last close at or before it. */
  const pointAt = (event: PointerEvent | MouseEvent): { t: number; i: number } => {
    const rect = chart.getBoundingClientRect()
    const px = ((event.clientX - rect.left) / rect.width) * W
    const t = t0 + ((px - pad.l) / (W - pad.l - pad.r)) * (t1 - t0)
    let i = 0
    while (i + 1 < points.length && points[i + 1].t <= t) i++
    return { t, i }
  }
  hit.addEventListener('click', (event) => {
    const trade = closed[Math.max(0, pointAt(event).i - 1)]
    if (trade) onTrade(trade)
  })
  hit.addEventListener('pointermove', (event) => {
    const { t, i } = pointAt(event)
    const p = points[i]
    const trade = i > 0 ? closed[i - 1] : undefined
    cross.setAttribute('x1', String(x(t)))
    cross.setAttribute('x2', String(x(t)))
    dot.setAttribute('cx', String(x(t)))
    dot.setAttribute('cy', String(y(p.balance)))
    cross.setAttribute('visibility', 'visible')
    dot.setAttribute('visibility', 'visible')
    readout.hidden = false
    const after = trade ? ` after the ${trade.direction} opened ${time(trade.openedAt, zone)} (${trade.r === null ? '' : `${trade.r > 0 ? '+' : ''}${trade.r.toFixed(2)} R`}) -- click to see it` : ''
    readout.textContent = `${time(t, zone)} · ${Math.round(p.balance).toLocaleString()} (${p.balance >= start ? '+' : ''}${Math.round(p.balance - start).toLocaleString()})${after}`
  })
  hit.addEventListener('pointerleave', () => {
    cross.setAttribute('visibility', 'hidden')
    dot.setAttribute('visibility', 'hidden')
    readout.hidden = true
  })
  chart.appendChild(hit)
  box.append(chart, readout)
  return box
}
