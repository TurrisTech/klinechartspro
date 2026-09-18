import { registerIndicator, type IndicatorTemplate, type KLineData } from 'klinecharts'
import { registerIndicatorSettings, type IndicatorGroup } from '../../src'
import { peekStore, type WindowStore } from '../plugins/store'
import type { QuotePoint } from './api'

// QUOTE:spread -- the bid/ask spread of every bar, in its own sub-pane.
//
// The sub-pane sibling of QUOTE:bidask, reading the SAME store (one source key per
// instrument and interval, `api.ts`), so showing both costs one read. The value is the
// spread at the bar's close, ask close minus bid close: the quote standing at the instant
// the mid close is, the same one the price-pane lines show. A bar without a quote holds no
// value and the line breaks there; an instrument with none (coinbase, schwab) draws
// nothing and the legend says so.
//
// Params [unit], default [1]:
//   0  price     -- in the instrument's own price units (0.00017)
//   1  points    -- in units of the instrument's last displayed digit, 10^-pricePrecision
//                   (EURUSD at 5 digits: 17 points = 1.7 pips)
//   2  bp        -- basis points of the close mid, the unit that compares across instruments

export const SPREAD_TEMPLATE_NAME = 'QUOTE:spread'

export const UNIT_PRICE = 0
export const UNIT_POINTS = 1
export const UNIT_BP = 2
export const DEFAULT_UNIT = UNIT_POINTS

const UNIT_LABEL = ['price', 'points', 'bp'] as const

const LINE = '#FF9800'

export interface SpreadExtendData {
  seriesKey: string
  rev: number
  /** 10^-pricePrecision of the instrument, set by the binding; what one point is worth. */
  pointSize: number
}

export interface SpreadValue {
  spread?: number
}

/** The unit param, snapped to one of the three; the default for anything unreadable. */
export function spreadUnit(calcParams: unknown[] | undefined): number {
  const raw = calcParams?.[0]
  const unit = typeof raw === 'number' || typeof raw === 'string' ? Math.round(Number(raw)) : Number.NaN
  return unit === UNIT_PRICE || unit === UNIT_POINTS || unit === UNIT_BP ? unit : DEFAULT_UNIT
}

export function spreadUnitLabel(unit: number): string {
  return UNIT_LABEL[unit] ?? UNIT_LABEL[DEFAULT_UNIT]
}

/** The display precision of a unit: the instrument's own for price, one decimal for points
 * (a fractional point is a real quote only on a finer feed, and costs nothing), two for bp. */
export function spreadPrecision(unit: number, pricePrecision: number | undefined): number {
  if (unit === UNIT_PRICE) return typeof pricePrecision === 'number' ? pricePrecision : 5
  return unit === UNIT_BP ? 2 : 1
}

/** One bar's close spread in `unit`, or nothing for a bar without a quote. */
export function spreadValue(point: QuotePoint | undefined, unit: number, pointSize: number): SpreadValue {
  if (!point) return {}
  const raw = point.ac - point.bc
  if (unit === UNIT_POINTS) return pointSize > 0 ? { spread: raw / pointSize } : {}
  if (unit === UNIT_BP) {
    const mid = (point.ac + point.bc) / 2
    return mid > 0 ? { spread: (raw / mid) * 10_000 } : {}
  }
  return { spread: raw }
}

function calc(dataList: KLineData[], indicator: { extendData?: SpreadExtendData; calcParams?: unknown[] }): SpreadValue[] {
  const store = peekStore<WindowStore<QuotePoint>>(indicator.extendData?.seriesKey)
  if (!store) return dataList.map(() => ({}))
  const unit = spreadUnit(indicator.calcParams)
  const pointSize = indicator.extendData?.pointSize ?? 0
  return dataList.map((d) => spreadValue(store.values.get(d.timestamp), unit, pointSize))
}

let registered = false

export function registerSpreadIndicator(): IndicatorGroup[] {
  if (!registered) {
    const template: IndicatorTemplate<SpreadValue, number, SpreadExtendData> = {
      name: SPREAD_TEMPLATE_NAME,
      shortName: 'SPREAD',
      precision: 1,
      calcParams: [DEFAULT_UNIT],
      shouldOhlc: false,
      shouldFormatBigNumber: false,
      visible: true,
      zLevel: 0,
      extendData: { seriesKey: '', rev: 0, pointSize: 0 },
      series: 'normal',
      figures: [{ key: 'spread', title: 'spread: ', type: 'line' }],
      // A spread is never negative on a real quote, so the axis starts at zero and a
      // widening reads against it rather than against the window's own minimum.
      minValue: 0,
      maxValue: null,
      styles: {
        lines: [{ color: LINE, size: 1, style: 'solid', smooth: false, dashedValue: [2, 2] }]
      },
      shouldUpdate: (prev, cur) => {
        const a = prev.extendData
        const b = cur.extendData
        const changed =
          a?.seriesKey !== b?.seriesKey ||
          a?.rev !== b?.rev ||
          a?.pointSize !== b?.pointSize ||
          JSON.stringify(prev.calcParams) !== JSON.stringify(cur.calcParams)
        return { calc: changed, draw: true }
      },
      calc: calc as IndicatorTemplate<SpreadValue, number, SpreadExtendData>['calc'],
      regenerateFigures: null,
      createTooltipDataSource: null,
      draw: null
    }
    registerIndicator(template)
    registerIndicatorSettings(SPREAD_TEMPLATE_NAME, [
      { paramNameKey: 'Unit: 0 price, 1 points, 2 bp', precision: 0, min: 0, max: 2, default: DEFAULT_UNIT }
    ])
    registered = true
  }
  return [
    {
      label: 'Quotes · sub-pane',
      main: false,
      items: [
        {
          name: SPREAD_TEMPLATE_NAME,
          label: 'Bid / ask spread',
          description:
            'The spread (ask close minus bid close) of each bar. Param: unit -- 0 price, 1 points (the last displayed digit; 10 points = 1 pip on a 5-digit pair), 2 basis points of the mid. Drawn only where the vendor stores real quotes (OANDA today); coinbase and schwab bars carry none.'
        }
      ]
    }
  ]
}
