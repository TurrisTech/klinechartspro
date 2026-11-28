import { registerIndicator, utils, type Indicator, type IndicatorTemplate, type KLineData } from 'klinecharts'
import type { IndicatorGroup } from '../../src'
import { MTF01_GENERATION, type Stage, type Mtf01Event, type Mtf01Trade } from './api'
import { peekStore } from '../plugins/store'
import type { Mtf01Store } from './store'
import { shouldUpdateOn, timestampCalc } from '../plugins/calc'
import { drawShape, drawText, paintShape, trianglePath, type Fill } from '../plugins/draw'
import { gridOf, type Schedule } from '../time/timeframes'

// One klinecharts indicator template: mtf01's cascade as a SUB-PANE. Like the AREV and
// KREV templates, `calc` computes nothing — it reads what the controller fetched from
// `/strategy/values`.
//
// **What the pane is.** A ladder with three rungs, one per stage, and a step line showing
// how far up it the cascade currently is:
//
//   3 ── trigger ─ a 5m/3m red arrow fired a short; the mark carries its outcome
//   2 ── confirm ─ a 1h/30m/15m red arrow, above the arming floor
//   1 ── armed   ─ an 8h/4h/1h red arrow; everything above min(open, close) is in play
//   0 ── idle
//
// The line is the state, and the marks are the moments it changed. A rung is held until
// its context ends — timed out, superseded, or spent because price closed below its floor
// — which is why the line falls back on its own with no mark under it.
//
// **Everything is drawn at the instant it became actionable, never at the candle it came
// from**, because a wall of charts is exactly where that distinction stops being free: an
// 8h arrow at its own label would be eight hours of hindsight on a 5m pane. The server
// resolves the bar (services/strategy.py); the client only has to not undo it.
//
// The marks are `draw`n rather than declared as figures because their style is per-point
// (a stage colour, an outcome fill) and a figure's style is per-figure. `draw` therefore
// returns FALSE so the declared line still renders: klinecharts renders an indicator's
// figures only `if (!isCover)`, where `isCover` is what `draw` returned — klinechartspro
// #6 is that bug, which cost the AREV panes all of their lines.

const TEMPLATE_NAME = `MTF01:${MTF01_GENERATION}`

interface ExtendData {
  seriesKey: string
  rev: number
  /** One pip in price, for the P&L label: the pane's `SymbolInfo.pipSize`, which comes from the
   * instrument's configuration (`pipSizeOf`). Null for an instrument its configuration does not
   * price in pips (crypto, equities) or one with no configuration at all. */
  pip?: number | null
  /** The instrument's display precision (`SymbolInfo.pricePrecision`, its configuration's
   * `displayPrecision`), for a P&L label stated in price. Null without a configuration. */
  pricePrecision?: number | null
  /** The pane's interval and its instrument's schedule (plain data, as extendData must be): how
   * an instant is placed on the pane's bars. Without them a bar is taken to be dated by its open,
   * which holds below 1D and nowhere a day is dated by its session. */
  chartInterval?: string
  schedule?: Schedule | null
}

const STAGE_LEVEL: Record<Stage, number> = { htf: 1, mtf: 2, ltf: 3 }

// One family, brightening as the cascade tightens: every arrow in mtf01 is a red down
// arrow, and the stage is which timeframe it was on.
const STAGE_COLOR: Record<Stage, string> = { htf: '#8E24AA', mtf: '#E53935', ltf: '#FB8C00' }

const WIN_COLOR = '#26A69A'
const LOSS_COLOR = '#EF5350'

export function isMtf01Indicator(name: string): boolean {
  return name === TEMPLATE_NAME
}

interface Value {
  /** The cascade's depth at this bar: 0 idle, 1 armed, 2 confirmed, 3 in a trade. */
  stage?: number
  /** This bar's rows, for `draw`. Deliberately not figures: they are not numbers, and
   * only figure keys widen the pane's y-axis range. */
  events?: Mtf01Event[]
  trades?: Mtf01Trade[]
}

/** The last of the ascending `times` at or before `instant`, or -1. A binary search. */
function indexAtOrBefore(times: readonly number[], instant: number): number {
  let lo = 0
  let hi = times.length - 1
  let found = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (times[mid] <= instant) {
      found = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return found
}

const calc = timestampCalc((dataList: KLineData[], indicator: Indicator<Value, number, ExtendData>): Value[] => {
  const extend = indicator.extendData
  const store = peekStore<Mtf01Store>(extend?.seriesKey)
  const out: Value[] = dataList.map(() => ({ stage: 0 }))
  if (!store || dataList.length === 0) return out

  // Two clocks. A row's `date` is a bar of this pane on the wire clock, as `dataList` is. A
  // context's end (`endedAt`, `expiresAt`, a trade's `resolvedAt`) is an instant, which the
  // server never shifts. From 1D up the wire dates a bar by its session -- an FX day at 00:00
  // New York of its date, seven hours after it opened -- so an end between 17:00 and midnight,
  // compared with the wire labels, fell on the bar before the one open at that instant and the
  // rung dropped a bar early. An instant is placed on the pane's bars by when they opened,
  // through the instrument's schedule.
  const wire = dataList.map((d) => d.timestamp)
  const interval = extend?.chartInterval
  const clock = extend?.schedule && interval ? gridOf(extend.schedule) : null
  const opens = clock && interval ? wire.map((w) => clock.fromWire(interval, w)) : wire

  // A context holds its rung from the bar it became actionable on until the bar it ended
  // on. `endedAt` is null only for a context still live at the end of the generated data,
  // which holds to the right edge — the honest reading, since nothing has ended it yet.
  const hold = (fromBar: number, until: number | null, level: number): void => {
    const start = indexAtOrBefore(wire, fromBar)
    if (start < 0) return
    const end = until == null ? dataList.length - 1 : indexAtOrBefore(opens, until)
    for (let i = start; i <= Math.max(start, end); i++) {
      const value = out[i]
      if (value.stage == null || value.stage < level) value.stage = level
    }
  }

  for (const [bar, events] of store.events) {
    const index = indexAtOrBefore(wire, bar)
    if (index >= 0) {
      const value = out[index]
      value.events = value.events ? [...value.events, ...events] : events
    }
    for (const e of events) {
      if (!e.accepted || e.stage === 'ltf') continue
      hold(e.date, e.endedAt ?? e.expiresAt, STAGE_LEVEL[e.stage])
    }
  }
  for (const [bar, trades] of store.trades) {
    const index = indexAtOrBefore(wire, bar)
    if (index >= 0) {
      const value = out[index]
      value.trades = value.trades ? [...value.trades, ...trades] : trades
    }
    for (const t of trades) hold(t.date, t.resolvedAt, STAGE_LEVEL.ltf)
  }
  return out
})

const shouldUpdate = shouldUpdateOn<ExtendData>({ keys: ['seriesKey', 'rev'] })

/** A down arrow: every mtf01 signal is one, at the rung of the stage that produced it. Squatter
 * than the registry's `triangle-down` -- its base 0.4 of its size above the rung rather than
 * 0.8 -- and painted by the same `Fill` rule, so a hollow one means a stopped trade here too. */
function triangleDown(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  size: number,
  color: string,
  fill: Fill,
  alpha: number
): void {
  ctx.save()
  ctx.globalAlpha = alpha
  trianglePath(ctx, x, y, size, false, 0.4)
  paintShape(ctx, color, fill, alpha)
  ctx.restore()
}

/** A trade's P&L as its label states it: in the instrument's pips where its configuration gives it
 * one, else as the price move at its display precision -- and, for an instrument with no
 * configuration, at klinecharts' default precision, which is what that pane's price axis shows.
 * Nothing here is a constant: a JPY cross reads in 0.01 pips because its configuration says so,
 * and a crypto pair in price because its configuration gives it no pip. */
export function pnlLabel(move: number, pip: number | null | undefined, pricePrecision: number | null | undefined): string {
  const sign = move >= 0 ? '+' : ''
  if (pip) return `${sign}${(move / pip).toFixed(1)}`
  return `${sign}${utils.formatPrecision(move, pricePrecision ?? undefined)}`
}

function fillOf(trade: Mtf01Trade): Fill {
  if (trade.outcome === 'target') return 'solid'
  if (trade.outcome === 'stop') return 'hollow'
  return 'pending'
}

let registered = false

// Registers the template once and returns the picker group for ChartProOptions.indicatorGroups.
// Call only when the server advertises 'strategy'.
export function registerMtf01Indicators(): IndicatorGroup[] {
  if (!registered) {
    const template: IndicatorTemplate<Value, number, ExtendData> = {
      name: TEMPLATE_NAME,
      shortName: 'MTF01',
      precision: 0,
      calcParams: [],
      shouldOhlc: false,
      shouldFormatBigNumber: false,
      visible: true,
      zLevel: 0,
      extendData: { seriesKey: '', rev: 0 },
      series: 'normal',
      figures: [{ key: 'stage', title: 'cascade: ', type: 'line' }],
      // Three rungs and the floor; the axis never needs to be anything else, and pinning
      // it keeps a screen with no events looking like an idle cascade rather than noise
      // zoomed to fill the pane.
      minValue: 0,
      maxValue: 3,
      styles: {
        lines: [{ color: '#787B8699', size: 1, style: 'solid', smooth: false }]
      },
      shouldUpdate,
      calc,
      regenerateFigures: null,
      createTooltipDataSource: null,
      draw: ({ ctx, chart, indicator, xAxis, yAxis }) => {
        const data = chart.getDataList()
        const range = chart.getVisibleRange()
        const size = Math.max(3, Math.min(7, chart.getBarSpace().bar * 0.35))
        const pip = indicator.extendData?.pip
        const pricePrecision = indicator.extendData?.pricePrecision
        // The P&L labels are drawn left to right, so one x is enough to keep them apart.
        // On a 1D pane a cluster of trades is a few pixels wide and the labels land on top
        // of each other -- unreadable, and worse, it reads as one number. The marks
        // themselves always draw; it is only the text that is dropped.
        let lastLabelX = Number.NEGATIVE_INFINITY
        const LABEL_GAP = 30
        for (let i = Math.max(0, range.realFrom); i <= Math.min(data.length - 1, range.realTo); i++) {
          const value = indicator.result[i]
          if (value == null) continue
          const x = xAxis.convertToPixel(i)
          for (const e of value.events ?? []) {
            const y = yAxis.convertToPixel(STAGE_LEVEL[e.stage])
            if (e.accepted) triangleDown(ctx, x, y, size, STAGE_COLOR[e.stage], 'solid', 1)
            // A rejected arrow is drawn small and hollow rather than dropped: on a
            // multi-timeframe rule "why was there no trade here" is the question actually
            // asked, and the answer is usually a ring on a rung.
            else drawShape(ctx, 'circle', x, y, size * 0.45, STAGE_COLOR[e.stage], { fill: 'hollow', alpha: 0.5, lineWidth: 1 })
          }
          for (const t of value.trades ?? []) {
            const y = yAxis.convertToPixel(STAGE_LEVEL.ltf)
            const won = (t.pnlPrice ?? 0) > 0
            const color = t.outcome === 'open' ? STAGE_COLOR.ltf : won ? WIN_COLOR : LOSS_COLOR
            triangleDown(ctx, x, y, size * 1.3, color, fillOf(t), 1)
            if (t.pnlPrice != null && x - lastLabelX >= LABEL_GAP) {
              drawText(ctx, x + size * 1.3 + 3, y, pnlLabel(t.pnlPrice, pip, pricePrecision), color)
              lastLabelX = x
            }
          }
        }
        // The declared line must still render -- see the note at the top.
        return false
      }
    }
    registerIndicator(template)
    registered = true
  }
  return [
    {
      label: 'Strategy research',
      main: false,
      items: [
        {
          name: TEMPLATE_NAME,
          label: 'MTF01',
          description:
            'Multi-timeframe arev21 cascade: 8h/4h/1h arms, 1h/30m/15m confirms, 5m/3m triggers a short — each arrow drawn on the bar it became actionable on'
        }
      ]
    }
  ]
}
