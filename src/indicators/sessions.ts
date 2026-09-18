/**
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at

 * http://www.apache.org/licenses/LICENSE-2.0

 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type { Chart, IndicatorTemplate, KLineData, TooltipLegend } from 'klinecharts'

import type { SymbolInfo } from '../types'

/**
 * SESSIONS -- the trading sessions of the instrument's asset class, shaded on the price pane.
 *
 * Parameters: [fill, ribbon, week], default [8, 1, 1].
 *
 * Which sessions are drawn follows the instrument's asset class (`SymbolInfo.market`, the
 * normalised class the server stores on the instrument's configuration):
 *
 *   forex / metal / cfd / crypto  Tokyo 09:00-18:00 JST, London 08:00-17:00 London time,
 *                                 New York 08:00-17:00 New York time -- the three centres a
 *                                 24-hour market is usually described by. Crypto has no
 *                                 exchange hours at all; these are the desks that move it.
 *   equity                        pre-market 04:00-09:30, regular 09:30-16:00, after hours
 *                                 16:00-20:00, all New York time.
 *
 * Every session is a wall-clock span in ITS OWN zone, Monday to Friday there, so London
 * opens at 08:00 whether that is 07:00Z (summer) or 08:00Z (winter) -- the zone rule, not a
 * UTC offset, is what the chart applies. A session covers a bar when the two half-open spans
 * intersect, so a 4h bar from 05:00Z to 09:00Z is a London bar in winter and one from 04:00Z
 * to 08:00Z is not: the session opens exactly as that bar closes. Nothing is drawn on a
 * daily or coarser chart, where every bar spans every session.
 *
 * `fill` is the opacity, in percent, of a band behind the bars of each session (0 turns it
 * off; overlaps -- London into New York -- stack and read darker). `ribbon` (0 or 1) adds a
 * labelled strip per session along the bottom of the pane. Colours are fixed per session
 * rather than themed so a session reads the same on every pane of a wall.
 *
 * `week` (0 or 1) draws a dashed line, labelled with the week's Monday, where each trading
 * week opens -- on intraday AND daily charts. That instant is the weekly candle's open on the
 * instrument's own schedule, never a constant: forex Sunday 17:00 New York, crypto Monday
 * 00:00 UTC, US equities Monday 09:00 New York (the 09:00 anchor, not the 09:30 open). It is
 * read off `SymbolInfo.timezone` + `dayGeometry`; an instrument without them gets no line.
 *
 * Everything is computed in `draw` and the tooltip from the bars on screen -- a session is a
 * fact about the clock, not about the series -- so `calc` produces no values and nothing
 * here enters the y-axis. The zone offsets that `Intl` resolves are memoised per quarter hour
 * (bounded), which is what makes a few thousand visible 1m bars cheap.
 */

export interface TradingSession {
  id: string
  label: string
  /** IANA zone the open/close are read on. */
  timezone: string
  /** Minutes after local midnight, half-open [open, close). */
  open: number
  close: number
  color: string
}

const minutes = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

export const GLOBAL_SESSIONS: readonly TradingSession[] = [
  { id: 'tokyo', label: 'Tokyo', timezone: 'Asia/Tokyo', open: minutes('09:00'), close: minutes('18:00'), color: '#f06292' },
  { id: 'london', label: 'London', timezone: 'Europe/London', open: minutes('08:00'), close: minutes('17:00'), color: '#42a5f5' },
  { id: 'newyork', label: 'New York', timezone: 'America/New_York', open: minutes('08:00'), close: minutes('17:00'), color: '#ffb74d' }
]

export const US_EQUITY_SESSIONS: readonly TradingSession[] = [
  { id: 'premarket', label: 'Pre-market', timezone: 'America/New_York', open: minutes('04:00'), close: minutes('09:30'), color: '#ba68c8' },
  { id: 'regular', label: 'Regular', timezone: 'America/New_York', open: minutes('09:30'), close: minutes('16:00'), color: '#42a5f5' },
  { id: 'afterhours', label: 'After hours', timezone: 'America/New_York', open: minutes('16:00'), close: minutes('20:00'), color: '#90a4ae' }
]

/** The session set for an asset class as the server spells it (`AssetClass` in wmarkettypes:
 * forex, metal, cfd, equity, crypto). Anything unknown reads as the 24-hour set. */
export function sessionsFor(assetClass: string | undefined): readonly TradingSession[] {
  return assetClass === 'equity' ? US_EQUITY_SESSIONS : GLOBAL_SESSIONS
}

const MINUTE_MS = 60_000
const DAY_MS = 86_400_000
const OFFSET_BUCKET_MS = 15 * MINUTE_MS
const OFFSET_CACHE_LIMIT = 50_000

const formatters = new Map<string, Intl.DateTimeFormat>()
const offsets = new Map<string, number>()

function formatterFor(timezone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timezone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric'
    })
    formatters.set(timezone, formatter)
  }
  return formatter
}

/** The zone's UTC offset in minutes at `ms`, positive east of Greenwich. Resolved through
 * `Intl` once per quarter hour per zone: a transition lands on a quarter hour in every zone
 * in use, and the cache is emptied rather than grown past `OFFSET_CACHE_LIMIT`. */
export function zoneOffsetMinutes(timezone: string, ms: number): number {
  const bucket = Math.floor(ms / OFFSET_BUCKET_MS)
  const key = `${timezone}|${bucket}`
  let offset = offsets.get(key)
  if (offset === undefined) {
    const at = bucket * OFFSET_BUCKET_MS
    const parts = formatterFor(timezone).formatToParts(new Date(at))
    const part = (type: Intl.DateTimeFormatPartTypes): number => Number(parts.find((p) => p.type === type)?.value)
    const asUtc = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour') % 24, part('minute'), part('second'))
    offset = Math.round((asUtc - at) / MINUTE_MS)
    if (offsets.size >= OFFSET_CACHE_LIMIT) offsets.clear()
    offsets.set(key, offset)
  }
  return offset
}

export interface WallClock {
  /** Days since 1970-01-01 on the zone's calendar. */
  day: number
  /** 0 Sunday .. 6 Saturday. */
  weekday: number
  minuteOfDay: number
}

export function wallClock(timezone: string, ms: number): WallClock {
  const local = ms + zoneOffsetMinutes(timezone, ms) * MINUTE_MS
  const day = Math.floor(local / DAY_MS)
  return { day, weekday: weekdayOf(day), minuteOfDay: Math.floor((local - day * DAY_MS) / MINUTE_MS) }
}

// 1970-01-01 was a Thursday.
const weekdayOf = (day: number): number => (((day + 4) % 7) + 7) % 7
const isTradingDay = (day: number): boolean => {
  const weekday = weekdayOf(day)
  return weekday >= 1 && weekday <= 5
}

/** Whether `session` is in progress during any part of the bar [openMs, openMs + spanMs).
 * Both spans are half-open, so a bar that closes exactly as the session opens is not
 * covered. A bar may reach the next local day's session; a weekend day's never counts. */
export function sessionCoversBar(session: TradingSession, openMs: number, spanMs: number): boolean {
  const localOpen = openMs + zoneOffsetMinutes(session.timezone, openMs) * MINUTE_MS
  const localClose = localOpen + Math.max(spanMs, 1)
  const firstDay = Math.floor(localOpen / DAY_MS)
  const lastDay = Math.floor((localClose - 1) / DAY_MS)
  for (let day = firstDay; day <= lastDay; day++) {
    if (!isTradingDay(day)) continue
    const start = day * DAY_MS + session.open * MINUTE_MS
    const end = day * DAY_MS + session.close * MINUTE_MS
    if (localOpen < end && localClose > start) return true
  }
  return false
}

const PERIOD_MS: Partial<Record<string, number>> = { second: 1000, minute: MINUTE_MS, hour: 60 * MINUTE_MS }

interface Plan {
  sessions: readonly TradingSession[]
  spanMs: number
}

/** What to draw on this chart: its asset class's sessions and its bar span, or null on a
 * daily-or-coarser period, where every bar spans every session and there is nothing to show. */
function planFor(chart: Chart): Plan | null {
  const period = chart.getPeriod()
  const unit = period ? PERIOD_MS[period.type] : undefined
  if (period === null || unit === undefined) return null
  const market = chart.getSymbol()?.market
  return { sessions: sessionsFor(typeof market === 'string' ? market : undefined), spanMs: unit * period.span }
}

/** The clock a week boundary is read on: the instrument's zone, the hours from the midnight
 * that dates a session to that session's open, and whether bars are dated by their open
 * (intraday) or by the session date itself (daily -- the wire's canonical date, already that
 * midnight on the instrument's clock). */
export interface WeekClock {
  timezone: string
  openOffset: number
  sessionDated: boolean
}

/** The week clock for this chart, or null where there is nothing to mark: a weekly or coarser
 * period (every bar is a week or more), or an instrument whose schedule the chart was not
 * given -- a guessed zone would put the line in the wrong place without looking wrong. */
function weekClockFor(chart: Chart): WeekClock | null {
  const period = chart.getPeriod()
  if (period === null) return null
  const sessionDated = period.type === 'day'
  if (!sessionDated && PERIOD_MS[period.type] === undefined) return null
  // The chart holds the pro SymbolInfo spread whole (ChartPane's toChartSymbol).
  const symbol = chart.getSymbol() as SymbolInfo | null
  const timezone = symbol?.timezone
  const day = symbol?.dayGeometry
  if (!timezone || !day) return null
  return { timezone, openOffset: day.openOffset, sessionDated }
}

/** The trading week a bar belongs to, as Monday-based weeks since the epoch of its SESSION
 * date. A bar before its day's open (forex Sunday 17:00, an equity pre-market bar) belongs
 * to the session its open offset names, so the Sunday-evening forex bars are Monday's. */
export function sessionWeek(ms: number, clock: WeekClock): number {
  const local = ms + zoneOffsetMinutes(clock.timezone, ms) * MINUTE_MS
  const shifted = clock.sessionDated ? local : local - clock.openOffset * 60 * MINUTE_MS
  const day = Math.floor(shifted / DAY_MS)
  // 1970-01-01 was a Thursday: day + 3 counts from the Monday before it.
  return Math.floor((day + 3) / 7)
}

/** Indices in [from, to] whose bar opens a new trading week relative to the bar before it.
 * `from` is never itself a start: with no earlier bar there is nothing to change from. */
export function weekStarts(bars: readonly KLineData[], from: number, to: number, clock: WeekClock): number[] {
  const starts: number[] = []
  let previous = from >= 1 ? sessionWeek(bars[from - 1].timestamp, clock) : undefined
  for (let i = Math.max(from, 0); i <= to; i++) {
    const week = sessionWeek(bars[i].timestamp, clock)
    if (previous !== undefined && week !== previous) starts.push(i)
    previous = week
  }
  return starts
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** The Monday a week index names, as "14 Sep". */
export function weekLabel(week: number): string {
  const monday = new Date((week * 7 - 3) * DAY_MS)
  return `${monday.getUTCDate()} ${MONTHS[monday.getUTCMonth()]}`
}

const WEEK_COLOR = '#9e9e9e'

const DEFAULT_FILL = 8
const DEFAULT_RIBBON = 1
const DEFAULT_WEEK = 1

function percentParam(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.min(100, Math.max(0, value)) / 100 : fallback / 100
}

const RIBBON_ROW = 12
const RIBBON_GAP = 1
const RIBBON_PAD = 4

/** Inclusive index runs of bars the session covers, so a session is one rectangle per
 * stretch rather than one per bar. */
export function coveredRuns(session: TradingSession, bars: readonly KLineData[], from: number, to: number, spanMs: number): Array<[number, number]> {
  const runs: Array<[number, number]> = []
  let start = -1
  for (let i = from; i <= to; i++) {
    if (sessionCoversBar(session, bars[i].timestamp, spanMs)) {
      if (start < 0) start = i
    } else if (start >= 0) {
      runs.push([start, i - 1])
      start = -1
    }
  }
  if (start >= 0) runs.push([start, to])
  return runs
}

const pad2 = (n: number): string => String(n).padStart(2, '0')

export interface SessionsResult {
  [key: string]: number | undefined
}

const sessions: IndicatorTemplate<SessionsResult, number> = {
  name: 'SESSIONS',
  shortName: 'SESSIONS',
  series: 'price',
  calcParams: [DEFAULT_FILL, DEFAULT_RIBBON, DEFAULT_WEEK],
  precision: 0,
  shouldOhlc: false,
  // No figures: nothing enters the y-axis, and the tooltip is built below.
  figures: [],
  calc: (dataList: KLineData[]) => dataList.map(() => ({})),
  createTooltipDataSource: ({ chart, indicator, crosshair }) => {
    const plan = planFor(chart)
    const legends: TooltipLegend[] = []
    const bar = crosshair.dataIndex === undefined ? undefined : chart.getDataList()[crosshair.dataIndex]
    if (plan === null) {
      legends.push({ title: 'Sessions: ', value: 'intraday charts only' })
    } else if (bar) {
      for (const session of plan.sessions) {
        const clock = wallClock(session.timezone, bar.timestamp)
        const open = sessionCoversBar(session, bar.timestamp, plan.spanMs)
        const time = `${pad2(Math.floor(clock.minuteOfDay / 60))}:${pad2(clock.minuteOfDay % 60)}`
        legends.push({
          title: { text: `${session.label}: `, color: session.color },
          value: { text: `${open ? '●' : '○'} ${time}`, color: session.color }
        })
      }
    }
    return {
      name: indicator.shortName,
      calcParamsText: `(${indicator.calcParams.join(',')})`,
      legends,
      features: chart.getStyles().indicator.tooltip.features
    }
  },
  draw: ({ ctx, chart, indicator, bounding, xAxis }) => {
    const plan = planFor(chart)
    const fill = percentParam(indicator.calcParams[0], DEFAULT_FILL)
    const ribbon = indicator.calcParams[1] !== 0
    // Absent on a layout saved before the parameter existed: it reads as the default, on.
    const week = (indicator.calcParams[2] ?? DEFAULT_WEEK) !== 0
    const clock = week ? weekClockFor(chart) : null
    const shading = plan !== null && (fill > 0 || ribbon)
    if (!shading && clock === null) return true

    const bars = chart.getDataList()
    const range = chart.getVisibleRange()
    const from = Math.max(0, range.realFrom - 1)
    const to = Math.min(bars.length - 1, range.realTo + 1)
    if (to < from) return true
    const pitch = chart.getBarSpace().bar

    ctx.save()
    ctx.textBaseline = 'middle'
    ctx.textAlign = 'left'
    ctx.font = 'bold 10px sans-serif'
    const sessionList = shading && plan !== null ? plan.sessions : []
    const spanMs = plan?.spanMs ?? 0
    const rows = sessionList.length
    sessionList.forEach((session, row) => {
      const rowTop = bounding.height - RIBBON_PAD - (rows - row) * (RIBBON_ROW + RIBBON_GAP)
      for (const [a, b] of coveredRuns(session, bars, from, to, spanMs)) {
        const x0 = xAxis.convertToPixel(a) - pitch / 2
        const x1 = xAxis.convertToPixel(b) + pitch / 2
        ctx.fillStyle = session.color
        if (fill > 0) {
          ctx.globalAlpha = fill
          ctx.fillRect(x0, 0, x1 - x0, bounding.height)
        }
        if (ribbon) {
          ctx.globalAlpha = 0.9
          ctx.fillRect(x0, rowTop, x1 - x0, RIBBON_ROW)
          // The label sits at the run's visible start: a run that began off-screen keeps
          // its name at the left edge rather than losing it with the bars.
          const labelX = Math.max(x0, 0) + 4
          if (x1 - labelX > ctx.measureText(session.label).width + 4) {
            ctx.globalAlpha = 1
            ctx.fillStyle = '#ffffff'
            ctx.fillText(session.label, labelX, rowTop + RIBBON_ROW / 2)
          }
        }
      }
    })
    if (clock !== null) {
      // The line sits on the boundary between the last bar of one week and the first of the
      // next -- the weekend gap, on a market that has one, collapses onto it.
      ctx.strokeStyle = WEEK_COLOR
      ctx.fillStyle = WEEK_COLOR
      ctx.lineWidth = 1
      ctx.setLineDash([4, 3])
      ctx.globalAlpha = 0.9
      ctx.textBaseline = 'top'
      for (const i of weekStarts(bars, from, to, clock)) {
        const x = Math.round(xAxis.convertToPixel(i) - pitch / 2) + 0.5
        ctx.beginPath()
        ctx.moveTo(x, 0)
        ctx.lineTo(x, bounding.height)
        ctx.stroke()
        ctx.fillText(weekLabel(sessionWeek(bars[i].timestamp, clock)), x + 3, 3)
      }
    }
    ctx.restore()
    return true
  }
}

export default sessions
