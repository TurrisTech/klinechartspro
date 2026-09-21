import { registerIndicator, type Indicator, type IndicatorTemplate, type KLineData } from 'klinecharts'
import type { IndicatorGroup } from '../../src'
import type { ArevPoint } from '../arev/api'
import { peekStore } from '../plugins/store'
import { drawLink, drawMark } from '../tsregistry/marks'
import type { RegistryStore } from '../tsregistry/store'
import { DIV_DEFAULTS, type DivConfig } from './config'
import { MIN_NEIGHBOURS, divergences, type Label, type Rule, type Side } from './divergence'

// The two halves of one argument, each a klinecharts template computed in the browser:
//
//   * DIV:arev21        -- a sub-pane: arev21's p, and for each divergence a line joining p at
//                          the two swings compared, with an arrow on the bar that confirmed it;
//   * DIV:arev21:price  -- the price pane: the same divergences as a line joining the two swings'
//                          lows (or highs), arrow below (above) the confirming candle.
//
// Nothing is asked of the server that the chart does not already ask for. The bars are the
// pane's own (`calc`'s dataList), and p is arev21's stored series through the registry's own
// source for it -- the very store an AREV21 pane on the same instrument reads, tiles first.
// Both read the pane's one DivConfig (config.ts) from extendData: the rule, and how the lines are
// drawn. calcParams stay empty, because klinecharts prints them into the legend.
//
// Computed over the bars the pane HOLDS, so a divergence within `left + right + maxGap` bars of
// the oldest loaded bar can change as older history loads: the swing it compared against may not
// have been visible yet. Everything later is final, and nothing reads past its confirming bar.

export const SUB_TEMPLATE = 'DIV:arev21'
export const PRICE_TEMPLATE = 'DIV:arev21:price'

export function isDivergenceIndicator(name: string): boolean {
  return name === SUB_TEMPLATE || name === PRICE_TEMPLATE
}

const P_COLOR = '#426EFF'
const NEUTRAL_COLOR = '#787B86'

export interface ExtendData {
  seriesKey: string
  rev: number
  config: DivConfig
}

/** One divergence on the bar that confirmed it: which kind, and the two swings as (bar index,
 * value) -- p in the sub-pane, the low or high in the price pane. */
export interface DivMark {
  side: Side
  label: Label
  from: { index: number; value: number }
  to: { index: number; value: number }
}

export type DivValue = { p?: number; mid?: number; __div?: DivMark[] }

type Kind = 'sub' | 'price'

function configOf(indicator: { extendData?: Partial<ExtendData> }): DivConfig {
  return indicator.extendData?.config ?? DIV_DEFAULTS
}

/** Bars -> values, for either pane. Exported for the tests. */
export function computeValues(
  dataList: readonly KLineData[],
  points: { get(date: number): ArevPoint | undefined } | undefined,
  rule: Rule,
  kind: Kind
): DivValue[] {
  const n = dataList.length
  const low = new Float64Array(n)
  const high = new Float64Array(n)
  const p = new Float64Array(n).fill(Number.NaN)
  const usable = new Array<boolean>(n).fill(false)
  for (let i = 0; i < n; i++) {
    const bar = dataList[i]
    low[i] = bar.low
    high[i] = bar.high
    const point = points?.get(bar.timestamp)
    if (point && typeof point.p === 'number' && Number.isFinite(point.p)) {
      p[i] = point.p
      usable[i] = point.n >= MIN_NEIGHBOURS
    }
  }
  // The p figure and the even line are the sub-pane's; the price pane declares no figures, so
  // nothing it returns can enter -- and flatten -- the candles' axis.
  const out: DivValue[] = new Array(n)
  for (let i = 0; i < n; i++) out[i] = kind === 'sub' ? { ...(Number.isFinite(p[i]) ? { p: p[i] } : {}), mid: 0.5 } : {}
  for (const d of divergences(low, high, p, usable, rule)) {
    const at = kind === 'sub' ? p : d.side === 'low' ? low : high
    const value = out[d.confirm]
    value.__div ??= []
    value.__div.push({
      side: d.side,
      label: d.label,
      from: { index: d.previous, value: at[d.previous] },
      to: { index: d.swing, value: at[d.swing] }
    })
  }
  return out
}

function calcFor(kind: Kind) {
  return (dataList: KLineData[], indicator: Indicator<DivValue, number, ExtendData>): DivValue[] => {
    const store = peekStore<RegistryStore<ArevPoint>>(indicator.extendData?.seriesKey)
    return computeValues(dataList, store?.values, configOf(indicator).rule, kind)
  }
}

/** Recompute when the data or the RULE changed; a line-style edit only redraws. */
function shouldUpdate(prev: Indicator<DivValue, number, ExtendData>, cur: Indicator<DivValue, number, ExtendData>) {
  const changed =
    prev.extendData?.seriesKey !== cur.extendData?.seriesKey ||
    prev.extendData?.rev !== cur.extendData?.rev ||
    JSON.stringify(configOf(prev).rule) !== JSON.stringify(configOf(cur).rule)
  return { calc: changed, draw: true }
}

function drawFor(kind: Kind): NonNullable<IndicatorTemplate<DivValue, number, ExtendData>['draw']> {
  return ({ ctx, chart, indicator, xAxis, yAxis }) => {
    const { rule, line } = configOf(indicator)
    const data = chart.getDataList()
    const range = chart.getVisibleRange()
    const size = Math.max(3, Math.min(9, chart.getBarSpace().bar * 0.45))
    // A divergence is carried by the bar `right` after its swing, so that bar can sit just off
    // the right edge while the line it draws is on screen: visit that far past the view.
    const last = Math.min(indicator.result.length - 1, range.realTo + rule.right)
    for (let i = Math.max(0, range.realFrom); i <= last; i++) {
      const value = indicator.result[i]
      const marks = value?.__div
      if (!marks) continue
      const x = xAxis.convertToPixel(i)
      for (const mark of marks) {
        const up = mark.side === 'low'
        const hidden = mark.label === 'hidden_bull' || mark.label === 'hidden_bear'
        const color = up ? line.bullColor : line.bearColor
        const alpha = hidden ? line.hiddenOpacity : 1
        const point = (end: { index: number; value: number }) => ({ x: xAxis.convertToPixel(end.index), y: yAxis.convertToPixel(end.value) })
        drawLink(ctx, point(mark.from), point(mark.to), color, { style: line.style, width: line.width, alpha })
        // The arrow on the confirming bar, pointing at what it marks: at p in the sub-pane, clear
        // of the candle in the price pane. Smaller for a hidden divergence, as its line is fainter.
        let y: number | null = null
        if (kind === 'sub') {
          if (value.p != null) y = yAxis.convertToPixel(value.p)
        } else {
          const candle = data[i]
          if (candle) y = up ? yAxis.convertToPixel(candle.low) + 4 : yAxis.convertToPixel(candle.high) - 4
        }
        if (y == null) continue
        const scale = hidden ? 0.7 : 1
        drawMark(ctx, { shape: up ? 'arrow-up' : 'arrow-down', size: scale }, x, y, size * scale, 'solid', color)
      }
    }
    // klinecharts assigns this to `isCover` and draws the declared figures only when it is
    // false: the sub-pane has its p line to keep, the price pane has none.
    return kind === 'price'
  }
}

/** The klinecharts template for one pane. Exported for the tests. */
export function buildTemplate(kind: Kind): IndicatorTemplate<DivValue, number, ExtendData> {
  const sub = kind === 'sub'
  return {
    name: sub ? SUB_TEMPLATE : PRICE_TEMPLATE,
    shortName: 'AREV21 DIVERGENCE',
    precision: sub ? 3 : 5,
    // Must stay empty: klinecharts prints calcParams into the legend, and the settings are the
    // pane's DivConfig, edited on the gear (plugin.ts).
    calcParams: [],
    shouldOhlc: false,
    shouldFormatBigNumber: false,
    visible: true,
    zLevel: 0,
    extendData: { seriesKey: '', rev: 0, config: DIV_DEFAULTS },
    series: sub ? 'normal' : 'price',
    figures: sub
      ? [
          { key: 'p', title: 'P(up): ', type: 'line' },
          { key: 'mid', title: 'even: ', type: 'line' }
        ]
      : [],
    // The AREV panes' own bounds: klinecharts only WIDENS a range by these, so a p that strays
    // further is still drawn whole. Only where there are figures -- pinning the price pane's
    // range would be pinning a pane this indicator does not own.
    minValue: sub ? 0.425 : null,
    maxValue: sub ? 0.575 : null,
    styles: sub
      ? {
          lines: [
            { color: P_COLOR, size: 1, style: 'solid' as never, smooth: false, dashedValue: [2, 2] },
            { color: NEUTRAL_COLOR, size: 1, style: 'dashed' as never, smooth: false, dashedValue: [2, 2] }
          ]
        }
      : null,
    shouldUpdate,
    calc: calcFor(kind),
    regenerateFigures: null,
    createTooltipDataSource: null,
    draw: drawFor(kind)
  }
}

let registered = false

export function registerDivergenceIndicators(): IndicatorGroup[] {
  if (!registered) {
    for (const kind of ['sub', 'price'] as const) registerIndicator(buildTemplate(kind))
    registered = true
  }
  const what =
    "Where price and arev21's p disagree at a swing: a lower low with a higher p is bullish, a higher high with a lower p bearish. Marked on the bar that confirmed the swing, computed in the browser; rule, line style, width and colours on the gear."
  return [
    {
      label: 'AREV21 divergence',
      main: false,
      items: [{ name: SUB_TEMPLATE, label: 'AREV21 DIVERGENCE', description: `${what} This pane: p, joined at the two swings.` }]
    },
    {
      label: 'AREV21 divergence · price pane',
      main: true,
      items: [{ name: PRICE_TEMPLATE, label: 'AREV21 DIVERGENCE (price)', description: `${what} This pane: the two swings joined on the candles.` }]
    }
  ]
}
