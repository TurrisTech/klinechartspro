import { registerIndicator, type IndicatorTemplate, type KLineData } from 'klinecharts'
import { registerIndicatorSettings, type IndicatorGroup } from '../../src'
import type { Level } from './calendar'
import { heathLevels, isLive, type HeathLevel, type HeathLevelSettings } from './heathlevels'
import {
  chartLevelMap,
  chipText,
  drawLevelLabels,
  drawLevelLines,
  LABEL_FONT,
  LABEL_GAP,
  lineTo,
  MUTED,
  paneBackground,
  type ExtendData
} from './levelmap'

// TT:heathlevels -- "Heath levels", the method's supply and demand lines (dossier §3), drawn
// on the price pane from the bars the pane already holds: a Heath level is a statement about
// one candle, so the chart has everything it needs.
//
// With its `calendar` switch on it also lays the objective calendar levels underneath -- the
// same map TradeTalk entries trades from (levelmap.ts), so the two can never disagree about a
// line. That half needs daily bars, which is the only reason this template is bound by the
// plugin host at all: switched off, its binding reads nothing.
//
// A level is an AREA, shaded: the origin candle's BODY, its open (the line the method draws)
// one edge and its close the other. The stop sits beyond the wick, outside the area, and is
// drawn as its own dotted line. The area starts at the candle it belongs to. Until the swing that defines it is
// confirmed -- `right` bars later -- the line is DASHED: that is the stretch where it exists in
// hindsight only, and dashing it is the difference between showing the method and flattering
// it. Solid from the confirming bar, dimmed once price has been back into the area ("a fresh,
// untested level is worth far more"), and gone at the first candle that passes entirely
// through it.

export const TEMPLATE_NAME = 'TT:heathlevels'

/** [left, right, sides, fresh only, stop line, fill, calendar]. `fill` and `calendar` were
 * appended rather than replacing anything, so a layout saved before either existed reads its
 * default. */
export const DEFAULT_PARAMS = [5, 5, 0, 0, 0, 12, 1]

function numberAt(calcParams: unknown[] | undefined, at: number, fallback: number): number {
  const raw = calcParams?.[at]
  const value = typeof raw === 'number' || typeof raw === 'string' ? Number(raw) : Number.NaN
  return Number.isFinite(value) ? value : fallback
}

export interface ChartSettings extends HeathLevelSettings {
  /** Opacity of the shaded area, in percent. 0 draws the edges only. */
  fill: number
  /** Lay the objective calendar levels under the supply and demand. */
  calendar: boolean
}

export function settingsOf(calcParams: unknown[] | undefined): ChartSettings {
  const sides = Math.min(2, Math.max(0, Math.round(numberAt(calcParams, 2, DEFAULT_PARAMS[2]))))
  return {
    left: Math.min(200, Math.max(1, Math.round(numberAt(calcParams, 0, DEFAULT_PARAMS[0])))),
    right: Math.min(200, Math.max(1, Math.round(numberAt(calcParams, 1, DEFAULT_PARAMS[1])))),
    sides: sides as HeathLevelSettings['sides'],
    freshOnly: Math.round(numberAt(calcParams, 3, DEFAULT_PARAMS[3])) !== 0,
    stopLine: Math.round(numberAt(calcParams, 4, DEFAULT_PARAMS[4])) !== 0,
    fill: Math.min(100, Math.max(0, numberAt(calcParams, 5, DEFAULT_PARAMS[5]))),
    calendar: Math.round(numberAt(calcParams, 6, DEFAULT_PARAMS[6])) !== 0
  }
}

export interface HeathValue {
  [key: string]: unknown
  /** Attached to the last bar only: every supply and demand, which `draw` reads back. */
  heath?: HeathLevel[]
  /** The calendar map in force on this bar, while the switch is on (levelmap.ts). */
  levels?: readonly Level[]
}

/** What the corner says when there is nothing to draw -- a silent pane and a broken one look
 * the same otherwise. */
export function emptyText(bars: number, settings: ChartSettings): string {
  if (bars === 0) return 'Heath levels · no bars'
  if (bars <= settings.left + settings.right) return `Heath levels · needs more than ${settings.left + settings.right} bars`
  return settings.freshOnly ? 'Heath levels · none untested in view' : 'Heath levels · no turn in view'
}

export function levelLabel(level: HeathLevel): string {
  return level.testedIndex === null ? level.side : `${level.side} · tested`
}

const FRESH_ALPHA = 0.95
const TESTED_ALPHA = 0.45
const STOP_ALPHA = 0.3

let registered = false

export function registerHeathLevelsIndicator(): IndicatorGroup['items'] {
  if (!registered) {
    const template: IndicatorTemplate<HeathValue, number, ExtendData> = {
      name: TEMPLATE_NAME,
      shortName: 'Heath levels',
      series: 'price',
      calcParams: [...DEFAULT_PARAMS],
      precision: 5,
      shouldOhlc: false,
      shouldFormatBigNumber: false,
      visible: true,
      zLevel: 0,
      // No figures: a supply line several percent above the candles would drag the y-axis up
      // with it the moment one formed.
      figures: [],
      minValue: null,
      maxValue: null,
      regenerateFigures: null,
      createTooltipDataSource: null,
      // No clock until the plugin host binds: a guessed zone would put every calendar line in
      // the wrong place without looking wrong.
      extendData: { seriesKey: '', rev: 0, clock: null, barMs: 0, tick: 0 },
      shouldUpdate: (prev, cur) => {
        const a = prev.extendData
        const b = cur.extendData
        const changed =
          a?.seriesKey !== b?.seriesKey || a?.rev !== b?.rev || JSON.stringify(prev.calcParams) !== JSON.stringify(cur.calcParams)
        return { calc: changed, draw: true }
      },
      calc: (dataList: KLineData[], indicator) => {
        const settings = settingsOf(indicator.calcParams)
        const values: HeathValue[] = dataList.map(() => ({}))
        if (settings.calendar) {
          const map = chartLevelMap(dataList, indicator.extendData, 'D')
          map?.forEach((levels, i) => {
            values[i].levels = levels
          })
        }
        const last = values[values.length - 1]
        if (last) last.heath = heathLevels(dataList, settings)
        return values
      },
      draw: ({ ctx, chart, indicator, bounding, xAxis, yAxis }) => {
        const data = chart.getDataList()
        const result = indicator.result
        const settings = settingsOf(indicator.calcParams)
        const levels = result[result.length - 1]?.heath ?? []
        const range = chart.getVisibleRange()
        const from = Math.max(0, range.realFrom - 1)
        const to = Math.min(data.length - 1, range.realTo + 1)
        const pitch = chart.getBarSpace().bar
        const { upColor, downColor } = chart.getStyles().candle.bar
        const background = paneBackground(chart)

        ctx.save()
        ctx.font = LABEL_FONT
        ctx.textBaseline = 'middle'
        // The calendar lines go UNDER the zones: supply and demand are the layer being read.
        if (settings.calendar && to >= from) drawLevelLines(ctx, result, from, to, xAxis, yAxis, bounding, chart)
        ctx.lineWidth = 1

        let drawn = 0
        const labels: Array<{ y: number; text: string; color: string; alpha: number }> = []
        for (const level of levels) {
          const lastIndex = level.brokenIndex === null ? data.length - 1 : level.brokenIndex
          if (lastIndex < from || level.originIndex > to) continue
          drawn++
          const color = level.side === 'supply' ? downColor : upColor
          const alpha = level.testedIndex === null ? FRESH_ALPHA : TESTED_ALPHA
          const y = yAxis.convertToPixel(level.price)
          const yClose = yAxis.convertToPixel(level.close)
          const yStop = yAxis.convertToPixel(level.stop)
          const xStart = xAxis.convertToPixel(level.originIndex) - pitch / 2
          const xConfirm = xAxis.convertToPixel(Math.min(level.confirmIndex, lastIndex))
          const xEnd = xAxis.convertToPixel(lastIndex) + pitch / 2

          // The area itself: the origin candle's BODY. A tested area is shaded at half
          // strength, the same statement the line makes.
          if (settings.fill > 0) {
            ctx.globalAlpha = (settings.fill / 100) * (level.testedIndex === null ? 1 : 0.5)
            ctx.fillStyle = color
            ctx.fillRect(xStart, Math.min(y, yClose), Math.max(1, xEnd - xStart), Math.max(1, Math.abs(yClose - y)))
          }

          ctx.strokeStyle = color
          ctx.globalAlpha = alpha
          // Hindsight half: the swing that defines this line had not happened yet.
          if (level.confirmIndex > level.originIndex && xConfirm > xStart) {
            ctx.setLineDash([2, 3])
            lineTo(ctx, xStart, xConfirm, y)
          }
          ctx.setLineDash([])
          if (xEnd > xConfirm) lineTo(ctx, xConfirm, xEnd, y)

          // The body's other edge, so the shaded band reads as a band even at low opacity.
          ctx.globalAlpha = alpha * 0.45
          lineTo(ctx, xStart, xEnd, yClose)

          // The stop sits beyond the wick, OUTSIDE the area: its own dotted line, drawn only
          // when asked for, since it is a third price on a chart the method keeps neat.
          if (settings.stopLine) {
            ctx.globalAlpha = STOP_ALPHA
            ctx.setLineDash([1, 2])
            lineTo(ctx, xStart, xEnd, yStop)
            ctx.setLineDash([])
          }

          // Only a level still standing at the right edge is named there.
          if (isLive(level, to) && y > 8 && y < bounding.height - 16) {
            labels.push({ y, text: levelLabel(level), color, alpha })
          }
        }

        // Right-hand labels: supply and demand first, then the calendar levels into whatever
        // room is left -- one shared list, so the two layers never overprint each other.
        ctx.textAlign = 'right'
        const taken: number[] = []
        for (const label of labels.sort((a, b) => b.alpha - a.alpha)) {
          if (taken.some((at) => Math.abs(at - label.y) < LABEL_GAP)) continue
          taken.push(label.y)
          chipText(ctx, label.text, bounding.width - 6, label.y - 6, label.color, background)
          ctx.globalAlpha = 1
        }
        if (settings.calendar && to >= from) drawLevelLabels(ctx, result, to, yAxis, bounding, background, taken)

        if (drawn === 0) {
          ctx.textAlign = 'right'
          ctx.textBaseline = 'bottom'
          ctx.globalAlpha = 0.85
          ctx.fillStyle = MUTED
          // Lifted clear of the TradeTalk entries line, which writes in the same corner.
          ctx.fillText(emptyText(data.length, settings), bounding.width - 6, bounding.height - 20)
        }
        ctx.restore()
        return true
      }
    }
    registerIndicator(template as never)
    registerIndicatorSettings(TEMPLATE_NAME, [
      { paramNameKey: 'Bars before a turn', precision: 0, min: 1, max: 200, default: DEFAULT_PARAMS[0] },
      { paramNameKey: 'Bars after a turn (confirmation)', precision: 0, min: 1, max: 200, default: DEFAULT_PARAMS[1] },
      { paramNameKey: 'Draw: 0 both, 1 supply, 2 demand', precision: 0, min: 0, max: 2, default: DEFAULT_PARAMS[2] },
      { paramNameKey: 'Fresh (untested) only (0/1)', precision: 0, min: 0, max: 1, default: DEFAULT_PARAMS[3] },
      { paramNameKey: 'Draw the stop line, beyond the wick (0/1)', precision: 0, min: 0, max: 1, default: DEFAULT_PARAMS[4] },
      { paramNameKey: 'Shading opacity %', precision: 0, min: 0, max: 100, default: DEFAULT_PARAMS[5] },
      { paramNameKey: 'Draw the calendar levels (0/1)', precision: 0, min: 0, max: 1, default: DEFAULT_PARAMS[6] }
    ])
    registered = true
  }
  return [
    {
      name: TEMPLATE_NAME,
      label: 'Heath levels (supply & demand)',
      description:
        'Supply and demand the way the TradeTalk method draws them: the OPEN of the last opposite-colour candle before a turn — the last up-close candle before a sell-off (supply), the last down-close candle before a rally (demand) — as a line, with that candle’s BODY shaded as the area and the stop beyond its wick. Dashed until the swing that defines it is confirmed, dimmed once price has been back into it, and erased when one candle passes entirely through it or a body crosses its far edge. Optionally with the objective calendar levels underneath — the yearly, quarterly, monthly, weekly and daily opens and the previous period’s high, low and midpoint. Params: bars before / after a turn, which side, fresh only, stop line, shading opacity, calendar levels on/off.'
    }
  ]
}
