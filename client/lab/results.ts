import { el } from '../alerts/dom'
import { rootIndex } from './entries'
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
//   Equity    the closed-trade balance over time, with a crosshair
//
// Problems that stop a run are shown in place of all of it, each saying where it is.

export interface Pick {
  /** The entry the row is about (a trade's entry too). */
  entryId: string
  /** The instant to bring on screen. */
  at: number
}

export interface ResultsView {
  readonly element: HTMLElement
  showRun(run: LabRun): void
  showProblems(problems: Problem[], message: string): void
  showMessage(text: string, kind?: 'info' | 'error'): void
  /** The run's progress, over whatever is shown. */
  progress(text: string | null): void
  /** Mark a row as the chart's selection. */
  select(entryId: string | null): void
}

type Tab = 'summary' | 'entries' | 'trades' | 'equity'

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

export function createResultsView(onPick: (pick: Pick) => void): ResultsView {
  const element = el('section', 'wd-lab-results')
  const tabs = el('div', 'wd-lab-tabs')
  tabs.setAttribute('role', 'tablist')
  const status = el('div', 'wd-lab-status')
  status.hidden = true
  const body = el('div', 'wd-lab-results-body')
  element.append(tabs, status, body)

  let tab: Tab = 'summary'
  let run: LabRun | null = null
  let selected: string | null = null
  let side: 'all' | 'long' | 'short' = 'all'

  const TABS: Array<{ id: Tab; label: string }> = [
    { id: 'summary', label: 'Summary' },
    { id: 'entries', label: 'Entries' },
    { id: 'trades', label: 'Trades' },
    { id: 'equity', label: 'Equity' }
  ]

  function renderTabs(): void {
    tabs.innerHTML = ''
    for (const t of TABS) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = `wd-lab-tab${t.id === tab ? ' is-on' : ''}`
      b.setAttribute('role', 'tab')
      b.setAttribute('aria-selected', String(t.id === tab))
      let count = ''
      if (run && t.id === 'entries') count = ` ${run.entries.length}`
      if (run?.sim && t.id === 'trades') count = ` ${run.sim.trades.length}`
      b.textContent = `${t.label}${count}`
      b.disabled = run === null
      b.addEventListener('click', () => {
        tab = t.id
        render()
      })
      tabs.appendChild(b)
    }
  }

  function render(): void {
    renderTabs()
    if (!run) return
    body.innerHTML = ''
    if (tab === 'summary') body.appendChild(summaryView(run))
    if (tab === 'entries') body.appendChild(entriesView(run))
    if (tab === 'trades') body.appendChild(tradesView(run))
    if (tab === 'equity') body.appendChild(equityView(run))
  }

  // -- formatting --------------------------------------------------------------------------------

  const fmt = (v: number | null | undefined, digits = 1): string => (v === null || v === undefined || !Number.isFinite(v) ? '–' : v.toFixed(digits))
  const pct = (v: number | null | undefined): string => (v === null || v === undefined ? '–' : `${(v * 100).toFixed(0)}%`)
  const signed = (v: number | null | undefined, digits = 1): string => (v === null || v === undefined || !Number.isFinite(v) ? '–' : `${v > 0 ? '+' : ''}${v.toFixed(digits)}`)
  const time = (ms: number, zone: string): string =>
    new Intl.DateTimeFormat('en-GB', { timeZone: zone, year: '2-digit', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms)
  const zoneOf = (r: LabRun): string => r.grid.schedule.timezone

  function table(headers: string[], rows: Array<{ cells: Array<string | HTMLElement>; onClick?: () => void; selected?: boolean; tone?: string[] }>, className = ''): HTMLElement {
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
    t.appendChild(head)
    const tbody = el('tbody', '')
    for (const r of rows) {
      const row = el('tr', `${r.onClick ? 'is-clickable' : ''}${r.selected ? ' is-selected' : ''}`)
      r.cells.forEach((cell, i) => {
        const td = el('td', r.tone?.[i] ?? '')
        if (typeof cell === 'string') td.textContent = cell
        else td.appendChild(cell)
        row.appendChild(td)
      })
      if (r.onClick) {
        row.tabIndex = 0
        row.addEventListener('click', r.onClick)
        row.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') r.onClick?.()
        })
      }
      tbody.appendChild(row)
    }
    t.appendChild(tbody)
    wrap.appendChild(t)
    return wrap
  }

  const tone = (v: number | null | undefined): string => (v === null || v === undefined || !Number.isFinite(v) || v === 0 ? '' : v > 0 ? 'is-up' : 'is-down')

  // -- views --------------------------------------------------------------------------------------

  function summaryView(r: LabRun): HTMLElement {
    const box = el('div', 'wd-lab-summary')
    const longs = r.entries.filter((e) => e.direction === 'long').length
    const facts = el('div', 'wd-lab-facts')
    const fact = (value: string, label: string, title = ''): void => {
      const f = el('div', 'wd-lab-fact')
      const v = el('div', 'wd-lab-fact-value')
      v.textContent = value
      const l = el('div', 'wd-lab-fact-label')
      l.textContent = label
      f.append(v, l)
      if (title) f.title = title
      facts.appendChild(f)
    }
    const inWindow = r.signals.filter((s) => s.knownAt >= r.from && s.knownAt <= r.to).length
    fact(String(inWindow), 'signals', 'Signals of the pool in the window (more are read before it, for the graphs in force at its start)')
    if (r.strategy.graph.enabled) fact(String(r.graphs.length), 'graphs')
    fact(String(r.entries.length), 'entries', `${longs} long, ${r.entries.length - longs} short`)
    if (r.filtered.length > 0) fact(String(r.filtered.length), 'filtered out')
    if (r.sim) {
      fact(String(r.sim.stats.trades), 'trades')
      fact(pct(r.sim.stats.winRate), 'won')
      fact(signed(r.sim.stats.totalR, 1), 'R in all')
      fact(signed(r.sim.stats.netPips, 0), 'pips')
    }
    box.appendChild(facts)

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
    box.appendChild(
      table(
        ['after', 'n', 'mean pips', 'median pips', 'its way', 'mean ATR'],
        summary.horizons.map((h) => ({
          cells: [`${h.bars} bar${h.bars === 1 ? '' : 's'}`, String(h.n), signed(h.meanPips), signed(h.medianPips), pct(h.positive), signed(h.meanAtr, 2)],
          tone: ['', '', tone(h.meanPips), tone(h.medianPips), '', tone(h.meanAtr)]
        }))
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
          ['trades', 'won', 'net pips', 'R', 'avg R', 'profit factor', 'max drawdown', `net (${r.symbol.split(':')[1]?.slice(3) || 'quote'})`, 'avg bars'],
          [
            {
              cells: [String(s.trades), pct(s.winRate), signed(s.netPips, 0), signed(s.totalR, 1), signed(s.avgR, 2), fmt(s.profitFactor, 2), pct(s.maxDrawdown), signed(s.netPnl, 0), fmt(s.avgBarsHeld, 0)],
              tone: ['', '', tone(s.netPips), tone(s.totalR), tone(s.avgR), '', '', tone(s.netPnl), '']
            }
          ]
        )
      )
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

  function entriesView(r: LabRun): HTMLElement {
    if (r.entries.length === 0 && r.filtered.length === 0) return message('No entries in this window.')
    const zone = zoneOf(r)
    const horizons = [...r.strategy.outcomes.horizons].sort((a, b) => a - b)
    const touches = r.strategy.outcomes.touches
    const all = [...r.entries.map((e) => ({ e, filtered: false })), ...r.filtered.map((e) => ({ e, filtered: true }))].sort((a, b) => a.e.at - b.e.at)
    return table(
      ['#', 'at', 'tf', 'trade', 'price', 'root', 'depth', ...horizons.map((h) => `+${h}`), ...touches.map((k) => `±${k}`), 'MFE/MAE ATR'],
      all.map(({ e, filtered }, i) => {
        const o: EntryOutcome | undefined = r.outcomes.get(e.id)
        const root = e.graph ? (e.graph.nodes[rootIndex(e.graph, e.node)] ?? null) : null
        const depth = e.graph ? String(e.graph.nodes[e.node].depth) : ''
        const cells = [
          String(i + 1),
          time(e.at, zone),
          e.signal.interval,
          filtered ? `${e.direction} (filtered)` : e.direction,
          e.signal.price.toFixed(5),
          root ? `${e.graph?.root} ${time(root.signal.knownAt, zone)}` : '',
          depth,
          ...horizons.map((_, h) => signed(o?.forward[h]?.pips)),
          ...touches.map((_, t) => {
            const result = o?.touches[t]?.result
            return result === 'win' ? 'for' : result === 'loss' ? 'against' : result === 'open' ? '–' : ''
          }),
          o ? `${fmt(o.mfeAtr, 2)} / ${fmt(o.maeAtr, 2)}` : ''
        ]
        return {
          cells,
          tone: ['', '', '', filtered ? 'is-muted' : '', '', '', '', ...horizons.map((_, h) => tone(o?.forward[h]?.pips)), ...touches.map((_, t) => (o?.touches[t]?.result === 'win' ? 'is-up' : o?.touches[t]?.result === 'loss' ? 'is-down' : '')), ''],
          selected: selected === e.id,
          onClick: () => {
            selected = e.id
            onPick({ entryId: e.id, at: e.at })
            render()
          }
        }
      }),
      'is-entries'
    )
  }

  function tradesView(r: LabRun): HTMLElement {
    if (!r.sim) return message(r.entries.length === 0 ? 'No entries, so no trades.' : 'No trades were simulated.')
    if (r.sim.trades.length === 0) return message('No trades: every entry was refused (see the Summary).')
    const zone = zoneOf(r)
    return table(
      ['#', 'opened', 'trade', 'in', 'stop', 'target', 'closed', 'by', 'out', 'pips', 'R', 'P&L', 'bars'],
      r.sim.trades.map((t: LabTrade, i) => ({
        cells: [
          String(i + 1),
          time(t.openedAt, zone),
          `${t.direction} ${t.units}`,
          t.openPrice.toFixed(5),
          t.stop === null ? '–' : t.stop.toFixed(5),
          t.target === null ? '–' : t.target.toFixed(5),
          t.closedAt === null ? '' : time(t.closedAt, zone),
          t.reason ? REASON_WORDS[t.reason] : '',
          t.closePrice === null ? '' : t.closePrice.toFixed(5),
          signed(t.pips),
          signed(t.r, 2),
          signed(t.pnl, 0),
          String(t.barsHeld)
        ],
        tone: ['', '', '', '', '', '', '', '', '', tone(t.pips), tone(t.r), tone(t.pnl), ''],
        selected: selected === t.entry.id,
        onClick: () => {
          selected = t.entry.id
          onPick({ entryId: t.entry.id, at: t.openedAt })
          render()
        }
      }))
    )
  }

  function equityView(r: LabRun): HTMLElement {
    if (!r.sim || r.sim.trades.length === 0) return message('No trades, so no equity curve.')
    return equityChart(r, zoneOf(r), time)
  }

  function message(text: string, kind: 'info' | 'error' = 'info'): HTMLElement {
    const p = el('p', kind === 'error' ? 'wd-lab-error' : 'wd-lab-note')
    p.textContent = text
    return p
  }

  renderTabs()
  body.appendChild(message('Press Run to evaluate the strategy over its window.'))

  return {
    element,
    showRun(next) {
      run = next
      if (selected && !next.entries.some((e) => e.id === selected) && !next.filtered.some((e) => e.id === selected)) selected = null
      render()
    },
    showProblems(problems, text) {
      run = null
      renderTabs()
      body.innerHTML = ''
      body.appendChild(message(text, 'error'))
      const list = el('ul', 'wd-lab-problems')
      for (const p of problems) {
        const li = el('li', '')
        const where = el('strong', '')
        where.textContent = `${p.where}: `
        li.append(where, document.createTextNode(p.message))
        list.appendChild(li)
      }
      body.appendChild(list)
    },
    showMessage(text, kind = 'info') {
      run = null
      renderTabs()
      body.innerHTML = ''
      body.appendChild(message(text, kind))
    },
    progress(text) {
      status.hidden = text === null
      status.textContent = text ?? ''
    },
    select(entryId) {
      selected = entryId
      if (run && (tab === 'entries' || tab === 'trades')) render()
    }
  }
}

// -- the equity curve -------------------------------------------------------------------------------

const SVG = 'http://www.w3.org/2000/svg'

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
  const node = document.createElementNS(SVG, tag)
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v))
  return node
}

/** The closed-trade balance as a step line over time, the opening balance as a reference, and a
 * crosshair that reads the balance under the pointer. One series, so no legend: the title names
 * it. Inline SVG drawn with the page's tokens, so it follows the theme. */
function equityChart(r: LabRun, zone: string, time: (ms: number, zone: string) => string): HTMLElement {
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
  hit.addEventListener('pointermove', (event) => {
    const rect = chart.getBoundingClientRect()
    const px = ((event.clientX - rect.left) / rect.width) * W
    const t = t0 + ((px - pad.l) / (W - pad.l - pad.r)) * (t1 - t0)
    let i = 0
    while (i + 1 < points.length && points[i + 1].t <= t) i++
    const p = points[i]
    cross.setAttribute('x1', String(x(t)))
    cross.setAttribute('x2', String(x(t)))
    dot.setAttribute('cx', String(x(t)))
    dot.setAttribute('cy', String(y(p.balance)))
    cross.setAttribute('visibility', 'visible')
    dot.setAttribute('visibility', 'visible')
    readout.hidden = false
    readout.textContent = `${time(t, zone)} · ${Math.round(p.balance).toLocaleString()} (${p.balance >= start ? '+' : ''}${Math.round(p.balance - start).toLocaleString()})`
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
