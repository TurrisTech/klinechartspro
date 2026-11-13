import type { KLineData } from 'klinecharts'
import { formatClock } from '../replay/format'
import { type CandleGrid, nominalMs } from '../replay/timeframes'
import { formatInstant, formatMoney, formatShare } from './format'
import { h, kbtn } from './kit'
import type { MarkAt } from './ledger'
import {
  accountStart,
  baseInstant,
  chooseStep,
  markInterval,
  marksFrom,
  marksNeeded,
  PERF_RANGES,
  type PerfMetric,
  type PerfModel,
  type PerfRange,
  perfModel,
  perfWindow,
  periodEnds,
  RANGE_LABEL
} from './performance'
import { setTradePrefs, subscribeTradePrefs, tradePrefs } from './prefs'
import type { TradingSession } from './session'

// The account window's Performance tab (user, 2026-11-13: "next to history, show a histogram,
// with button allowing the user to see balance or equity for last 1M, 3M, 6M, 1Y and all time").
//
// One bar per period, the balance or equity at its end, growing from a baseline at what it was
// when the window began -- green above, red below -- so the bars read as gain or loss over the
// window, and the axis states the values. The last bar is the account now. Hover (or focus) a bar
// for its period and figures; the choice of measure and range is kept per browser (prefs.ts).
//
// Past equity needs a price for every trade that was open at a period's end: the closed stored
// bars of its instrument (`fetchBars`, which under a replay stops at the clock), read once per
// window and kept while the window and the trades stay the same -- a poll changes neither.

export interface PerfContext {
  /** The active chart's candle grid, which the periods are cut on; null for equal steps. */
  grid(): CandleGrid | null
  /** The account's clock now: a replay's cursor, else the wall clock. */
  now(): number
  /** Closed bars of an instrument over `[from, to)` on the wire clock (intraday: bar opens). */
  fetchBars(symbol: string, resolution: string, from: number, to: number): Promise<KLineData[]>
}

/** A request is at most this many nominal bars, under the server's per-request cap. */
const PAGE_BARS = 4000

const PLOT_HEIGHT = 132
const AXIS_WIDTH = 72
const BAR_MAX = 24
const BAR_GAP = 2
const RADIUS = 4
const UP = '#26a69a'
const DOWN = '#ef5350'
const SVG_NS = 'http://www.w3.org/2000/svg'

interface Frame {
  model: PerfModel | null
  /** Still reading the bars past equity needs. */
  loading: boolean
  error: string | null
}

export class PerformanceView {
  readonly element: HTMLElement
  private readonly metricButtons = new Map<PerfMetric, HTMLButtonElement>()
  private readonly rangeButtons = new Map<PerfRange, HTMLButtonElement>()
  private readonly headline: HTMLElement
  private readonly change: HTMLElement
  private readonly since: HTMLElement
  private readonly plot: HTMLElement
  private readonly readout: HTMLElement
  private readonly note: HTMLElement
  private marks: { key: string; markAt: MarkAt | null; error: string | null; pending: Promise<void> | null } | null = null
  private hover: number | null = null
  private model: PerfModel | null = null
  private width = 0
  private disposed = false
  private readonly shape: ResizeObserver
  private readonly unsubscribePrefs: () => void

  constructor(
    private readonly session: TradingSession,
    private readonly ctx: PerfContext
  ) {
    this.element = h('div', 'wd-perf')
    const controls = h('div', 'wd-perf-controls')
    const metric = h('div', 'wd-perf-seg')
    metric.setAttribute('role', 'group')
    metric.setAttribute('aria-label', 'Measure')
    for (const [id, label, title] of [
      ['balance', 'Balance', 'The balance: what the closed trades have realised'],
      ['equity', 'Equity', 'The equity: the balance plus what the open trades were worth']
    ] as Array<[PerfMetric, string, string]>) {
      const b = kbtn(label, () => setTradePrefs({ perfMetric: id }), ['chip'], title)
      this.metricButtons.set(id, b)
      metric.appendChild(b)
    }
    const range = h('div', 'wd-perf-seg')
    range.setAttribute('role', 'group')
    range.setAttribute('aria-label', 'Range')
    for (const id of PERF_RANGES) {
      const b = kbtn(RANGE_LABEL[id], () => setTradePrefs({ perfRange: id }), ['chip'], id === 'all' ? 'Since the account began' : `The last ${RANGE_LABEL[id]}`)
      this.rangeButtons.set(id, b)
      range.appendChild(b)
    }
    controls.append(metric, range)

    const summary = h('div', 'wd-perf-summary')
    this.headline = h('span', 'wd-perf-value')
    this.change = h('span', 'wd-perf-change')
    this.since = h('span', 'wd-perf-since')
    summary.append(this.headline, this.change, this.since)

    this.plot = h('div', 'wd-perf-plot')
    this.readout = h('div', 'wd-perf-readout')
    this.readout.setAttribute('aria-live', 'polite')
    this.note = h('div', 'wd-perf-note')
    this.element.append(controls, summary, this.plot, this.readout, this.note)

    this.unsubscribePrefs = subscribeTradePrefs(() => this.render())
    this.shape = new ResizeObserver(() => {
      const width = this.plot.clientWidth
      if (width > 0 && width !== this.width) this.render()
    })
    this.shape.observe(this.plot)
  }

  /** Redraw from the session. Cheap when nothing but the live figures moved. */
  render(): void {
    if (this.disposed) return
    const prefs = tradePrefs()
    for (const [id, b] of this.metricButtons) {
      b.classList.toggle('is-active', id === prefs.perfMetric)
      b.setAttribute('aria-pressed', String(id === prefs.perfMetric))
    }
    for (const [id, b] of this.rangeButtons) {
      b.classList.toggle('is-active', id === prefs.perfRange)
      b.setAttribute('aria-pressed', String(id === prefs.perfRange))
    }
    const frame = this.frame(prefs.perfMetric, prefs.perfRange)
    this.model = frame.model
    this.drawSummary(frame)
    this.drawPlot(frame)
    this.drawReadout()
  }

  private frame(metric: PerfMetric, range: PerfRange): Frame {
    const s = this.session.snapshot
    if (!this.session.ready) return { model: null, loading: false, error: null }
    const now = this.ctx.now()
    const start = accountStart(s, this.session.startedAt)
    const win = perfWindow(range, now, start)
    const grid = this.ctx.grid()
    const step = chooseStep(win.to - win.from)
    let ends = periodEnds(win.from, win.to, step, grid)
    // A window reaching back past the account's start begins at the account. One that does not
    // begins at the first period end inside it, so the window moves a period at a time rather
    // than with every tick of the clock -- and a poll leaves the bars, and the marks, alone.
    if (!win.clamped && ends.length > 1) {
      win.from = ends[0]
      ends = ends.slice(1)
    }
    if (metric === 'balance') return { model: perfModel(s, 'balance', win, step, ends, null), loading: false, error: null }

    const times = [baseInstant(win), ...ends.slice(0, -1)]
    const resolution = markInterval(step)
    const barMs = nominalMs(resolution)
    const needed = marksNeeded(s, times, barMs)
    const key = `${resolution}|${times.join(',')}|${JSON.stringify([...needed])}`
    if (this.marks?.key !== key) this.loadMarks(key, needed, resolution, barMs)
    const marks = this.marks
    if (!marks || marks.pending) return { model: this.model?.metric === 'equity' ? this.model : null, loading: true, error: null }
    if (marks.error) return { model: perfModel(s, 'equity', win, step, ends, () => null), loading: false, error: marks.error }
    return { model: perfModel(s, 'equity', win, step, ends, marks.markAt), loading: false, error: null }
  }

  private loadMarks(key: string, needed: Map<string, { from: number; to: number }>, resolution: string, barMs: number): void {
    const entry: NonNullable<PerformanceView['marks']> = { key, markAt: null, error: null, pending: null }
    this.marks = entry
    if (needed.size === 0) {
      entry.markAt = () => null
      return
    }
    entry.pending = (async () => {
      const bars = new Map<string, KLineData[]>()
      try {
        for (const [symbol, span] of needed) {
          const out: KLineData[] = []
          const page = PAGE_BARS * barMs
          for (let from = span.from; from < span.to; from += page) {
            out.push(...(await this.ctx.fetchBars(symbol, resolution, from, Math.min(span.to, from + page))))
          }
          bars.set(symbol, out)
        }
        entry.markAt = marksFrom(bars, barMs)
      } catch (err) {
        console.warn('[performance] reading the bars to mark equity failed', err)
        entry.error = 'Could not read the prices to mark the open trades; they are counted at entry'
      } finally {
        entry.pending = null
        if (this.marks === entry) this.render()
      }
    })()
  }

  private currency(): string {
    return this.session.snapshot.account.currency
  }

  private when(ms: number): string {
    const grid = this.ctx.grid()
    return grid ? formatClock(ms, grid.schedule.timezone) : formatInstant(ms)
  }

  private drawSummary(frame: Frame): void {
    const m = frame.model
    const c = this.currency()
    const metric = tradePrefs().perfMetric
    if (!m) {
      this.headline.textContent = this.session.ready ? (frame.loading ? 'Reading prices…' : '') : 'Connecting…'
      this.change.textContent = ''
      this.since.textContent = ''
      return
    }
    const live = m.bars[m.bars.length - 1]?.value ?? m.base
    this.headline.textContent = `${metric === 'equity' ? 'Equity' : 'Balance'} ${formatMoney(live, c, false)}`
    this.change.textContent = `${formatMoney(m.change, c)} · ${formatShare(m.changePercent)}`
    this.change.className = `wd-perf-change ${m.change > 0 ? 'is-up' : m.change < 0 ? 'is-down' : ''}`
    const range = tradePrefs().perfRange
    this.since.textContent = m.window.clamped
      ? `since the account began, ${this.when(m.window.from)}`
      : `over ${RANGE_LABEL[range]}, since ${this.when(m.window.from)}`
  }

  private drawPlot(frame: Frame): void {
    const m = frame.model
    // Measured BEFORE the old drawing goes: emptied, the window may lose its vertical scrollbar
    // and the plot gain its width, and a drawing that wide brings the scrollbar straight back --
    // with a horizontal one under it.
    this.width = this.plot.clientWidth
    this.plot.innerHTML = ''
    this.plot.classList.toggle('is-loading', frame.loading)
    const notes: string[] = []
    if (frame.error) notes.push(frame.error)
    if (m && m.metric === 'equity') {
      const unmarked = m.bars.filter((b) => b.unmarked > 0).length
      notes.push('Past equity marks each open trade at the close of its last stored bar (the mid), so it reads up to half a spread above what the engine would have booked.')
      if (unmarked > 0) notes.push(`${unmarked} period${unmarked === 1 ? '' : 's'} had an open trade with no stored price; it is counted at its entry.`)
    }
    this.note.textContent = notes.join(' ')
    this.note.hidden = notes.length === 0
    if (!m || m.bars.length === 0) {
      const empty = h('div', 'wd-trade-empty', frame.loading ? 'Reading the prices to mark the open trades…' : this.session.ready ? 'Nothing to show yet' : '')
      this.plot.appendChild(empty)
      return
    }

    const width = Math.max(this.width || 600, 160)
    const plotW = width - AXIS_WIDTH
    const values = [m.base, ...m.bars.map((b) => b.value)]
    let lo = Math.min(...values)
    let hi = Math.max(...values)
    if (hi - lo < Math.max(Math.abs(m.base) * 1e-6, 1e-9)) {
      // Flat: a band around the value, so the baseline sits mid-plot rather than on an edge.
      const pad = Math.max(Math.abs(m.base) * 0.001, 1)
      lo -= pad
      hi += pad
    } else {
      const pad = (hi - lo) * 0.08
      lo -= pad
      hi += pad
    }
    const top = 6
    const bottom = PLOT_HEIGHT - 6
    const y = (v: number): number => bottom - ((v - lo) / (hi - lo)) * (bottom - top)
    const yBase = y(m.base)

    const svg = document.createElementNS(SVG_NS, 'svg')
    svg.setAttribute('class', 'wd-perf-svg')
    svg.setAttribute('width', String(width))
    svg.setAttribute('height', String(PLOT_HEIGHT))
    svg.setAttribute('role', 'img')
    svg.setAttribute('aria-label', `${m.metric === 'equity' ? 'Equity' : 'Balance'} at the end of each of ${m.bars.length} periods`)

    // Hairline grid: the top and bottom of the scale, and the baseline the bars grow from.
    const tick = (v: number, cls: string): void => {
      const line = document.createElementNS(SVG_NS, 'line')
      line.setAttribute('x1', '0')
      line.setAttribute('x2', String(plotW))
      line.setAttribute('y1', String(Math.round(y(v)) + 0.5))
      line.setAttribute('y2', String(Math.round(y(v)) + 0.5))
      line.setAttribute('class', cls)
      svg.appendChild(line)
      const text = document.createElementNS(SVG_NS, 'text')
      text.setAttribute('x', String(plotW + 6))
      text.setAttribute('y', String(y(v)))
      text.setAttribute('dominant-baseline', 'middle')
      text.setAttribute('class', `wd-perf-tick ${cls === 'wd-perf-base' ? 'is-base' : ''}`)
      text.textContent = formatMoney(v, '', false)
      svg.appendChild(text)
    }
    const max = Math.max(...m.bars.map((b) => b.value), m.base)
    const min = Math.min(...m.bars.map((b) => b.value), m.base)
    if (max > m.base && Math.abs(y(max) - yBase) > 12) tick(max, 'wd-perf-grid')
    if (min < m.base && Math.abs(y(min) - yBase) > 12) tick(min, 'wd-perf-grid')
    tick(m.base, 'wd-perf-base')

    const n = m.bars.length
    const slot = plotW / n
    const barW = Math.max(1, Math.min(BAR_MAX, slot - BAR_GAP))
    m.bars.forEach((bar, i) => {
      const cx = slot * i + slot / 2
      const x = cx - barW / 2
      const yv = y(bar.value)
      const up = bar.value >= m.base
      const height = Math.abs(yv - yBase)
      const mark = document.createElementNS(SVG_NS, 'path')
      mark.setAttribute('d', barPath(x, yBase, barW, height, up))
      mark.setAttribute('fill', bar.value === m.base ? 'currentColor' : up ? UP : DOWN)
      mark.setAttribute('class', `wd-perf-bar${bar.live ? ' is-live' : ''}${this.hover === i ? ' is-hover' : ''}${bar.value === m.base ? ' is-flat' : ''}`)
      svg.appendChild(mark)
      // The hit target is the whole slot, top to bottom: a 2px bar is not something to aim at.
      const hit = document.createElementNS(SVG_NS, 'rect')
      hit.setAttribute('x', String(slot * i))
      hit.setAttribute('y', '0')
      hit.setAttribute('width', String(slot))
      hit.setAttribute('height', String(PLOT_HEIGHT))
      hit.setAttribute('class', 'wd-perf-hit')
      hit.setAttribute('tabindex', i === n - 1 ? '0' : '-1')
      const title = document.createElementNS(SVG_NS, 'title')
      title.textContent = this.describe(bar.value, bar.start, bar.end, bar.live)
      hit.appendChild(title)
      hit.addEventListener('mouseenter', () => this.setHover(i))
      hit.addEventListener('focus', () => this.setHover(i))
      hit.addEventListener('keydown', (event) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
        event.preventDefault()
        event.stopPropagation()
        const next = Math.min(n - 1, Math.max(0, i + (event.key === 'ArrowLeft' ? -1 : 1)))
        ;(svg.querySelectorAll('.wd-perf-hit')[next] as SVGElement | undefined)?.focus()
      })
      svg.appendChild(hit)
    })
    svg.addEventListener('mouseleave', () => this.setHover(null))
    svg.addEventListener('focusout', () => this.setHover(null))
    this.plot.appendChild(svg)

    const axis = h('div', 'wd-perf-axis')
    axis.style.width = `${plotW}px`
    axis.append(h('span', '', this.when(m.window.from)), h('span', '', m.bars[n - 1].live ? 'now' : this.when(m.bars[n - 1].end)))
    this.plot.appendChild(axis)
  }

  private describe(value: number, start: number, end: number, live: boolean): string {
    const m = this.model
    const c = this.currency()
    const vs = m ? ` · ${formatMoney(value - m.base, c)} (${formatShare(m.base > 0 ? ((value - m.base) / m.base) * 100 : null)}) on the start` : ''
    return `${this.when(start)} → ${live ? 'now' : this.when(end)}: ${formatMoney(value, c, false)}${vs}`
  }

  private setHover(index: number | null): void {
    if (this.hover === index) return
    this.hover = index
    const bars = this.plot.querySelectorAll('.wd-perf-bar')
    bars.forEach((bar, i) => {
      bar.classList.toggle('is-hover', i === index)
    })
    this.plot.classList.toggle('has-hover', index !== null)
    this.drawReadout()
  }

  private drawReadout(): void {
    const m = this.model
    const bar = m && this.hover !== null ? m.bars[this.hover] : null
    this.readout.textContent = bar
      ? this.describe(bar.value, bar.start, bar.end, bar.live)
      : m
        ? `${m.bars.length} period${m.bars.length === 1 ? '' : 's'} of ${periodWord(m.step)}, each bar the ${m.metric} at its end, from the line at the start. Hover a bar for its figures.`
        : ''
  }

  dispose(): void {
    this.disposed = true
    this.shape.disconnect()
    this.unsubscribePrefs()
  }
}

/** A bar from the baseline `y0`, `height` up (or down), with its DATA end rounded and its
 * baseline end square. */
export function barPath(x: number, y0: number, w: number, height: number, up: boolean): string {
  const hgt = Math.max(height, 1)
  const r = Math.min(RADIUS, w / 2, hgt)
  const dir = up ? -1 : 1
  const yEnd = y0 + dir * hgt
  if (r < 1) return `M${x},${y0}H${x + w}V${yEnd}H${x}Z`
  // Baseline corners square; the two at the data end are quarter circles.
  const sweep = up ? 1 : 0
  return [
    `M${x},${y0}`,
    `V${yEnd - dir * r}`,
    `A${r},${r} 0 0 ${sweep} ${x + r},${yEnd}`,
    `H${x + w - r}`,
    `A${r},${r} 0 0 ${sweep} ${x + w},${yEnd - dir * r}`,
    `V${y0}`,
    'Z'
  ].join('')
}

function periodWord(step: string): string {
  const words: Record<string, string> = {
    '1m': 'a minute',
    '5m': 'five minutes',
    '15m': 'fifteen minutes',
    '1h': 'an hour',
    '4h': 'four hours',
    '1D': 'a day',
    '1W': 'a week',
    '1M': 'a month'
  }
  return words[step] ?? step
}
