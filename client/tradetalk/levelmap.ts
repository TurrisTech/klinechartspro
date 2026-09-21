import type { Chart, KLineData } from 'klinecharts'
import { peekStore, type WindowStore } from '../plugins/store'
import type { DailyPoint } from './api'
import { mergeSessions, sessionDay, sessionsFromBars, unitRank, type Level, type SessionBar, type SessionClock, type Unit } from './calendar'
import { levelMap } from './rules'

// The calendar level map as a CHART reads and draws it -- the half both TradeTalk indicators
// share. TradeTalk entries trades from it; Heath levels can lay it under its supply and demand
// (its `calendar` switch). The rule itself is `levelMap` in rules.ts; this is the plumbing
// either side of it: the daily bars the plugin host fetched, going in, and labelled lines
// coming out.

/** What the plugin host hands a TradeTalk template (plugin.ts `bind`). */
export interface ExtendData {
  seriesKey: string
  rev: number
  /** How a bar of THIS chart is dated to a session, or null for an instrument whose schedule
   * the chart was not given -- in which case no calendar level is drawn at all. */
  clock: SessionClock | null
  /** The chart's own bar span. */
  barMs: number
  /** The instrument's price tick. */
  tick: number
}

/** The daily feed's bars as sessions. Their dates are canonical -- midnight on the
 * instrument's own clock, of the session -- so they are read `sessionDated`, whatever the
 * chart's own bars are dated by. */
export function sessionsFromDaily(store: WindowStore<DailyPoint> | undefined, clock: SessionClock): SessionBar[] {
  if (!store) return []
  const dailyClock: SessionClock = { ...clock, sessionDated: true }
  const points = [...store.values.values()].sort((a, b) => a.date - b.date)
  return points.map((point) => ({
    day: sessionDay(point.date, dailyClock),
    open: point.open,
    high: point.high,
    low: point.low,
    close: point.close
  }))
}

/** Every session the chart can see: the daily feed's, extended with the chart's own bars
 * for the sessions the feed has not served -- the one forming, any that closed since the
 * page loaded, and on a daily-or-coarser chart simply the bars themselves. */
export function chartSessions(dataList: readonly KLineData[], extend: ExtendData & { clock: SessionClock }): SessionBar[] {
  const fed = sessionsFromDaily(peekStore<WindowStore<DailyPoint>>(extend.seriesKey), extend.clock)
  return mergeSessions(fed, sessionsFromBars(dataList, extend.clock))
}

/** The map in force on each of the chart's bars, or null when it cannot be drawn. */
export function chartLevelMap(dataList: readonly KLineData[], extend: ExtendData | undefined, minUnit: Unit): Level[][] | null {
  if (!extend?.clock) return null
  const withClock = { ...extend, clock: extend.clock }
  return levelMap(dataList, chartSessions(dataList, withClock), extend.clock, extend.barMs, extend.tick, minUnit)?.levels ?? null
}

// -- drawing ------------------------------------------------------------------------------

export const UNIT_COLOR: Record<Unit, string> = {
  Y: '#d4a017',
  Q: '#9575cd',
  M: '#4fc3f7',
  W: '#4db6ac',
  D: '#8d9aa5'
}

const UNIT_ALPHA: Record<Unit, number> = { Y: 0.95, Q: 0.8, M: 0.7, W: 0.6, D: 0.45 }

export const MUTED = '#8d9aa5'
export const LABEL_FONT = '10px sans-serif'
/** How close two right-hand labels may sit before the lower-priority one is dropped. */
export const LABEL_GAP = 11

export type Axis = { convertToPixel(value: number): number }

/** Values a template's calc hands back: `levels` is the map in force on the bar, when drawn. */
export interface LevelValue {
  levels?: readonly Level[]
}

/** The pane's own background, for the chip a label sits on -- resolved from the DOM rather
 * than assumed, so it follows the theme. Null when nothing up the tree paints one. */
export function paneBackground(chart: Chart): string | null {
  let node: HTMLElement | null = null
  try {
    node = chart.getDom() as HTMLElement | null
  } catch {
    return null
  }
  for (let depth = 0; node && depth < 8; depth++, node = node.parentElement) {
    const color = getComputedStyle(node).backgroundColor
    if (color && !color.startsWith('rgba(0, 0, 0, 0)') && color !== 'transparent') return color
  }
  return null
}

/** Text on a chip of the pane's own background, so a label over a candle stays readable. */
export function chipText(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, color: string, background: string | null): void {
  if (background !== null) {
    const width = ctx.measureText(text).width
    // The chip follows the caller's alignment; the right-hand labels are right-aligned.
    const left = ctx.textAlign === 'right' ? x - width - 2 : x - 2
    ctx.globalAlpha = 0.8
    ctx.fillStyle = background
    ctx.fillRect(left, y - 6, width + 4, 12)
  }
  ctx.globalAlpha = 1
  ctx.fillStyle = color
  ctx.fillText(text, x, y)
}

export function lineTo(ctx: CanvasRenderingContext2D, x0: number, x1: number, y: number): void {
  const at = Math.round(y) + 0.5
  ctx.beginPath()
  ctx.moveTo(x0, at)
  ctx.lineTo(x1, at)
  ctx.stroke()
}

/** The map's lines, under the bars they are in force for. Bars sharing a map share the ARRAY,
 * by reference (`levelMap` caches it per session), so one line per run of bars rather than
 * one per bar. */
export function drawLevelLines(
  ctx: CanvasRenderingContext2D,
  result: readonly LevelValue[],
  from: number,
  to: number,
  xAxis: Axis,
  yAxis: Axis,
  bounding: { width: number; height: number },
  chart: Chart
): void {
  const pitch = chart.getBarSpace().bar
  ctx.lineWidth = 1
  let runFrom = from
  let runLevels = result[from]?.levels
  for (let i = from + 1; i <= to + 1; i++) {
    const levels = i <= to ? result[i]?.levels : undefined
    if (levels === runLevels) continue
    if (runLevels) drawLevelRun(ctx, runLevels, runFrom, i - 1, xAxis, yAxis, bounding, pitch)
    runFrom = i
    runLevels = levels
  }
  ctx.setLineDash([])
}

/** The right-hand labels, on the newest map on screen: what every line IS, which is the whole
 * point of drawing the map. Coarsest first; a label that would collide with one already in
 * `taken` -- this map's own, or another layer's drawn before it -- is dropped rather than
 * overprinted. */
export function drawLevelLabels(
  ctx: CanvasRenderingContext2D,
  result: readonly LevelValue[],
  to: number,
  yAxis: Axis,
  bounding: { width: number; height: number },
  background: string | null,
  taken: number[] = []
): void {
  const latest = result[to]?.levels
  if (!latest) return
  ctx.textAlign = 'right'
  for (const level of [...latest].sort((a, b) => unitRank(b.unit) - unitRank(a.unit))) {
    const y = yAxis.convertToPixel(level.price)
    if (y < 8 || y > bounding.height - 16) continue
    if (taken.some((at) => Math.abs(at - y) < LABEL_GAP)) continue
    taken.push(y)
    chipText(ctx, level.label, bounding.width - 6, y - 6, UNIT_COLOR[level.unit], background)
  }
}

function drawLevelRun(
  ctx: CanvasRenderingContext2D,
  levels: readonly Level[],
  fromIndex: number,
  toIndex: number,
  xAxis: Axis,
  yAxis: Axis,
  bounding: { width: number; height: number },
  pitch: number
): void {
  const x0 = xAxis.convertToPixel(fromIndex) - pitch / 2
  const x1 = xAxis.convertToPixel(toIndex) + pitch / 2
  for (const level of levels) {
    const y = yAxis.convertToPixel(level.price)
    if (y < -20 || y > bounding.height + 20) continue
    ctx.globalAlpha = UNIT_ALPHA[level.unit]
    ctx.strokeStyle = UNIT_COLOR[level.unit]
    ctx.setLineDash(level.kind === 'mid' ? [2, 3] : level.kind === 'open' ? [] : [6, 3])
    lineTo(ctx, x0, x1, y)
  }
  ctx.setLineDash([])
}
