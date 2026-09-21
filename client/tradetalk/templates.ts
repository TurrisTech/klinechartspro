import { registerIndicator, type Chart, type IndicatorTemplate, type KLineData } from 'klinecharts'
import { registerIndicatorSettings, type IndicatorGroup } from '../../src'
import type { Unit } from './calendar'
import {
  chartSessions,
  chipText,
  drawLevelLabels,
  drawLevelLines,
  LABEL_FONT,
  lineTo,
  MUTED,
  paneBackground,
  UNIT_COLOR,
  type Axis,
  type ExtendData
} from './levelmap'
import { computeTradeTalk, type BarValue, type Settings, type Skips, type Trade } from './rules'

// TT:entries -- where TradeTalk would enter, drawn on the price pane.
//
// The rule is rules.ts; this is the chart half: the parameters, the one pass over the bars
// the pane holds, and the drawing -- the objective level map as labelled lines, each entry
// as an arrow with its stop and target boxed out to wherever the trade ended.
//
// Like every app-registered template, `calc` computes from what the plugin host fetched (the
// daily bars) plus the bars the pane already holds. Nothing is asked of the server that the
// chart does not already ask for.

export const TEMPLATE_NAME = 'TT:entries'

/** [min R:R, bias, hours, order life, smallest unit, level lines]. */
export const DEFAULT_PARAMS = [2, 1, 1, 5, 0, 1]

const MIN_UNITS: readonly Unit[] = ['D', 'W', 'M']

function numberAt(calcParams: unknown[] | undefined, at: number, fallback: number): number {
  const raw = calcParams?.[at]
  const value = typeof raw === 'number' || typeof raw === 'string' ? Number(raw) : Number.NaN
  return Number.isFinite(value) ? value : fallback
}

export interface ChartSettings extends Settings {
  lines: boolean
}

export function settingsOf(calcParams: unknown[] | undefined): ChartSettings {
  const bias = Math.min(2, Math.max(0, Math.round(numberAt(calcParams, 1, DEFAULT_PARAMS[1]))))
  const window = Math.min(2, Math.max(0, Math.round(numberAt(calcParams, 2, DEFAULT_PARAMS[2]))))
  const minUnit = MIN_UNITS[Math.min(2, Math.max(0, Math.round(numberAt(calcParams, 4, DEFAULT_PARAMS[4]))))]
  return {
    rr: Math.max(0, numberAt(calcParams, 0, DEFAULT_PARAMS[0])),
    bias: bias as Settings['bias'],
    window: window as Settings['window'],
    expiry: Math.min(200, Math.max(1, Math.round(numberAt(calcParams, 3, DEFAULT_PARAMS[3])))),
    minUnit,
    lines: Math.round(numberAt(calcParams, 5, DEFAULT_PARAMS[5])) !== 0
  }
}

/** What the pane says about itself in the corner: the trades over the loaded bars, and why
 * there are none when there are none. */
export interface Summary {
  entries: number
  target: number
  stop: number
  open: number
  sessions: number
  units: Unit[]
  skips: Skips
}

export interface TradeTalkValue extends BarValue {
  summary?: Summary
}

function calc(dataList: KLineData[], indicator: { extendData?: ExtendData; calcParams?: unknown[] }): TradeTalkValue[] {
  const extend = indicator.extendData
  if (!extend?.clock) return dataList.map(() => ({}))
  const settings = settingsOf(indicator.calcParams)
  const sessions = chartSessions(dataList, { ...extend, clock: extend.clock })
  const { values, trades, units, skips } = computeTradeTalk({
    bars: dataList,
    sessions,
    clock: extend.clock,
    barMs: extend.barMs,
    tick: extend.tick,
    settings
  })
  const out = values as TradeTalkValue[]
  const last = out[out.length - 1]
  if (last) {
    last.summary = {
      entries: trades.length,
      target: trades.filter((trade) => trade.outcome === 'target').length,
      stop: trades.filter((trade) => trade.outcome === 'stop').length,
      open: trades.filter((trade) => trade.outcome === 'open').length,
      sessions: sessions.length,
      units,
      skips
    }
  }
  return out
}

// -- drawing ------------------------------------------------------------------------------

/** The zones read against candles, not against the ground, so they are just strong enough to
 * be seen over a wick and no stronger. */
const ZONE_ALPHA = 0.16

/** A filled triangle whose tip is at (x, y), pointing up for a long and down for a short. */
function arrow(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, up: boolean, color: string): void {
  const base = up ? y + size : y - size
  ctx.beginPath()
  ctx.moveTo(x, y)
  ctx.lineTo(x - size * 0.7, base)
  ctx.lineTo(x + size * 0.7, base)
  ctx.closePath()
  ctx.fillStyle = color
  ctx.fill()
}

/** What an entry is labelled with on the chart: the side, the level it was taken at, where
 * it is going and what that is worth -- "L Aug low > week open 2.4R", "½" when another level
 * sits between entry and stop and he would halve the size. */
export function tradeLabel(trade: Trade): string {
  const side = trade.side === 'long' ? 'L' : 'S'
  const half = trade.halfSize ? ' ½' : ''
  return `${side} ${trade.level.label} › ${trade.target.label} ${trade.rr.toFixed(1)}R${half}`
}

/** What each rejected sweep is called in the corner. An empty pane with "8 against the bias"
 * on it is a filter doing its job; an empty pane with nothing on it looks broken. */
const SKIP_LABEL: Record<keyof Skips, string> = {
  bias: 'against the bias',
  rr: 'short of the reward',
  hours: 'outside the hours',
  invalidated: 'invalidated',
  expired: 'never triggered'
}

export function summaryText(summary: Summary | undefined, settings: ChartSettings): string {
  if (!summary) return 'TradeTalk · no bars'
  if (summary.sessions === 0) return 'TradeTalk · daily levels loading'
  if (summary.units.length === 0) return 'TradeTalk · no level coarser than this chart'
  const parts = [`${summary.entries} ${summary.entries === 1 ? 'entry' : 'entries'}`]
  if (summary.entries > 0) parts.push(`${summary.target} target · ${summary.stop} stopped · ${summary.open} open`)
  parts.push(`min ${settings.rr.toFixed(1)}R`)
  const skipped = (Object.keys(summary.skips) as Array<keyof Skips>)
    .map((reason) => [reason, summary.skips[reason]] as const)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([reason, count]) => `${count} ${SKIP_LABEL[reason]}`)
  if (skipped.length > 0) parts.push(`skipped ${skipped.join(', ')}`)
  return `TradeTalk · ${parts.join(' · ')}`
}

let registered = false

export function registerTradeTalkIndicator(): IndicatorGroup[] {
  if (!registered) {
    const template: IndicatorTemplate<TradeTalkValue, number, ExtendData> = {
      name: TEMPLATE_NAME,
      shortName: 'TradeTalk',
      precision: 5,
      calcParams: [...DEFAULT_PARAMS],
      shouldOhlc: false,
      shouldFormatBigNumber: false,
      visible: true,
      zLevel: 0,
      extendData: { seriesKey: '', rev: 0, clock: null, barMs: 0, tick: 0 },
      series: 'price',
      // Entry and stop only, and no `type` on either: they are the signal candle's own high
      // and low, so the tooltip can read them without the y-axis moving. The target is
      // deliberately NOT a figure -- a yearly level several percent away would stretch the
      // axis and squash the candles the moment a trade appeared.
      figures: [
        { key: 'entry', title: 'entry: ' },
        { key: 'stop', title: 'stop: ' }
      ],
      minValue: null,
      maxValue: null,
      shouldUpdate: (prev, cur) => {
        const a = prev.extendData
        const b = cur.extendData
        const changed =
          a?.seriesKey !== b?.seriesKey || a?.rev !== b?.rev || JSON.stringify(prev.calcParams) !== JSON.stringify(cur.calcParams)
        return { calc: changed, draw: true }
      },
      calc: calc as IndicatorTemplate<TradeTalkValue, number, ExtendData>['calc'],
      regenerateFigures: null,
      // ChartPane installs its own tooltip data source on every indicator it creates, which
      // would discard one declared here (only this library's own templates are asked first).
      createTooltipDataSource: null,
      draw: ({ ctx, chart, indicator, bounding, xAxis, yAxis }) => {
        const data = chart.getDataList()
        const result = indicator.result
        const settings = settingsOf(indicator.calcParams)
        const range = chart.getVisibleRange()
        const from = Math.max(0, range.realFrom - 1)
        const to = Math.min(data.length - 1, range.realTo + 1)
        ctx.save()
        ctx.font = LABEL_FONT
        ctx.textBaseline = 'middle'
        if (to >= from) {
          const background = paneBackground(chart)
          if (settings.lines) {
            drawLevelLines(ctx, result, from, to, xAxis, yAxis, bounding, chart)
            drawLevelLabels(ctx, result, to, yAxis, bounding, background)
          }
          drawTrades(ctx, result, data, from, to, xAxis, yAxis, chart, background)
        }
        const summary = result[result.length - 1]?.summary
        ctx.textAlign = 'right'
        ctx.textBaseline = 'bottom'
        ctx.globalAlpha = 0.85
        ctx.fillStyle = MUTED
        ctx.fillText(summaryText(summary, settings), bounding.width - 6, bounding.height - 4)
        ctx.restore()
        // False: the declared figures carry no `type`, so nothing else is drawn either way.
        return false
      }
    }
    registerIndicator(template as never)
    registerIndicatorSettings(TEMPLATE_NAME, [
      { paramNameKey: 'Minimum reward:risk', precision: 1, min: 0, max: 20, default: DEFAULT_PARAMS[0] },
      { paramNameKey: 'Bias: 0 none, 1 daily 21 EMA, 2 + yearly open', precision: 0, min: 0, max: 2, default: DEFAULT_PARAMS[1] },
      { paramNameKey: 'Hours: 0 any, 1 03:00-11:00 NY, 2 07:00-11:00 NY', precision: 0, min: 0, max: 2, default: DEFAULT_PARAMS[2] },
      { paramNameKey: 'Entry order lives for (bars)', precision: 0, min: 1, max: 200, default: DEFAULT_PARAMS[3] },
      { paramNameKey: 'Smallest level: 0 daily, 1 weekly, 2 monthly', precision: 0, min: 0, max: 2, default: DEFAULT_PARAMS[4] },
      { paramNameKey: 'Draw the level map (0/1)', precision: 0, min: 0, max: 1, default: DEFAULT_PARAMS[5] }
    ])
    registered = true
  }
  return [
    {
      label: 'TradeTalk · price pane',
      main: true,
      items: [
        {
          name: TEMPLATE_NAME,
          label: 'TradeTalk entries',
          description:
            'Where the TradeTalk (Heath) method would enter: a candle sweeps an objective level — a yearly/quarterly/monthly/weekly/daily open, or the previous period’s high, low or midpoint — and closes back through it; the entry is a stop order at that candle’s extreme, the stop at its other extreme, the target the next opposing level, and anything under the minimum reward:risk is not a trade. Params: min R:R, bias filter, trading hours, order life, smallest level, level map on/off.'
        }
      ]
    }
  ]
}

function drawTrades(
  ctx: CanvasRenderingContext2D,
  result: readonly TradeTalkValue[],
  data: readonly KLineData[],
  from: number,
  to: number,
  xAxis: Axis,
  yAxis: Axis,
  chart: Chart,
  background: string | null
): void {
  const pitch = chart.getBarSpace().bar
  const { upColor, downColor } = chart.getStyles().candle.bar
  const drawn = new Set<Trade>()
  for (let i = from; i <= to; i++) {
    const trade = result[i]?.trade
    if (!trade || drawn.has(trade)) continue
    drawn.add(trade)
    const long = trade.side === 'long'
    const color = long ? upColor : downColor
    const lastIndex = trade.exitIndex ?? data.length - 1
    const left = xAxis.convertToPixel(trade.entryIndex) - pitch / 2
    const right = Math.max(left + 2, xAxis.convertToPixel(lastIndex) + pitch / 2)
    const yEntry = yAxis.convertToPixel(trade.entry)
    const yStop = yAxis.convertToPixel(trade.stop)
    const yTarget = yAxis.convertToPixel(trade.target.price)

    ctx.setLineDash([])
    ctx.globalAlpha = ZONE_ALPHA
    ctx.fillStyle = upColor
    ctx.fillRect(left, Math.min(yEntry, yTarget), right - left, Math.abs(yTarget - yEntry))
    ctx.fillStyle = downColor
    ctx.fillRect(left, Math.min(yEntry, yStop), right - left, Math.abs(yStop - yEntry))

    ctx.globalAlpha = 0.9
    ctx.lineWidth = 1
    ctx.strokeStyle = color
    lineTo(ctx, left, right, yEntry)
    ctx.setLineDash([3, 3])
    ctx.strokeStyle = upColor
    lineTo(ctx, left, right, yTarget)
    ctx.strokeStyle = downColor
    lineTo(ctx, left, right, yStop)
    ctx.setLineDash([])

    // The candle that swept the level, marked at the price it swept.
    const signal = data[trade.signalIndex]
    if (signal) {
      ctx.globalAlpha = 1
      ctx.fillStyle = UNIT_COLOR[trade.level.unit]
      const x = xAxis.convertToPixel(trade.signalIndex)
      const y = yAxis.convertToPixel(trade.level.price)
      ctx.beginPath()
      ctx.arc(x, y, 2.5, 0, Math.PI * 2)
      ctx.fill()
    }

    const entryBar = data[trade.entryIndex]
    const xEntry = xAxis.convertToPixel(trade.entryIndex)
    if (entryBar) {
      const size = Math.max(5, Math.min(9, pitch * 0.8))
      const tip = long ? yAxis.convertToPixel(entryBar.low) + 4 : yAxis.convertToPixel(entryBar.high) - 4
      ctx.globalAlpha = 1
      arrow(ctx, xEntry, tip, size, long, color)
    }

    ctx.textAlign = 'left'
    // Clamped into the pane: a trade whose entry is off to the left keeps its label.
    chipText(ctx, tradeLabel(trade), Math.max(4, left + 3), long ? yEntry - 8 : yEntry + 8, color, background)

    // How it ended, where it ended.
    if (trade.exitIndex !== null) {
      const hit = trade.outcome === 'target'
      ctx.fillStyle = hit ? upColor : downColor
      ctx.globalAlpha = 1
      const y = yAxis.convertToPixel(hit ? trade.target.price : trade.stop)
      ctx.fillRect(xAxis.convertToPixel(trade.exitIndex) - 2.5, y - 2.5, 5, 5)
    }
  }
}
