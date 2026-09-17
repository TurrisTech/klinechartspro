import { registerIndicator, type IndicatorTemplate, type KLineData } from 'klinecharts'
import { registerIndicatorSettings, type IndicatorGroup } from '../../src'
import { peekStore, type WindowStore } from '../plugins/store'
import type { QuotePoint } from './api'

// QUOTE:bidask -- the bid and the ask of every bar on the price pane.
//
// Params [band], default [15]: the opacity, in percent, of the spread shaded between the bid
// close and the ask close (0 turns it off). The ask close (red) and the bid close (blue) are
// always drawn as lines, and the legend reads both.
//
// A close rather than an OHLC: a bar's bid/ask close is the quote standing when it closed,
// the same instant its mid close is, so the three read against each other on one vertical.
// A bar without a quote (`api.ts` `quoteOf`) holds no value and the lines break there,
// which is also what an instrument with no quotes at all shows: nothing, and a legend saying
// so. Like every app-registered template, `calc` computes nothing -- it reads the store the
// plugin host filled.

export const TEMPLATE_NAME = 'QUOTE:bidask'
export const DEFAULT_BAND = 15

const ASK = '#EF5350'
const BID = '#2962FF'
const BAND = '120, 123, 134'

export interface ExtendData {
  seriesKey: string
  rev: number
}

export interface QuoteValue {
  ask?: number
  bid?: number
}

/** What one bar shows: its bid and ask closes, or nothing for a bar without a quote. */
export function quoteValue(point: QuotePoint | undefined): QuoteValue {
  return point ? { ask: point.ac, bid: point.bc } : {}
}

/** The band opacity in percent, clamped; the default for anything unreadable. */
export function bandOpacity(calcParams: unknown[] | undefined): number {
  const raw = calcParams?.[0]
  const band = typeof raw === 'number' || typeof raw === 'string' ? Number(raw) : Number.NaN
  return Number.isFinite(band) ? Math.max(0, Math.min(100, band)) : DEFAULT_BAND
}

function calc(dataList: KLineData[], indicator: { extendData?: ExtendData }): QuoteValue[] {
  const store = peekStore<WindowStore<QuotePoint>>(indicator.extendData?.seriesKey)
  if (!store) return dataList.map(() => ({}))
  return dataList.map((d) => quoteValue(store.values.get(d.timestamp)))
}

let registered = false

export function registerBidAskIndicator(): IndicatorGroup[] {
  if (!registered) {
    const template: IndicatorTemplate<QuoteValue, number, ExtendData> = {
      name: TEMPLATE_NAME,
      shortName: 'BID/ASK',
      precision: 5,
      calcParams: [DEFAULT_BAND],
      shouldOhlc: false,
      shouldFormatBigNumber: false,
      visible: true,
      zLevel: 0,
      extendData: { seriesKey: '', rev: 0 },
      series: 'price',
      // Both are prices, so entering the y-axis range is harmless -- the spread never
      // widens the pane past the candles by more than itself.
      figures: [
        { key: 'ask', title: 'ask: ', type: 'line' },
        { key: 'bid', title: 'bid: ', type: 'line' }
      ],
      minValue: null,
      maxValue: null,
      styles: {
        lines: [
          { color: ASK, size: 1, style: 'solid', smooth: false, dashedValue: [2, 2] },
          { color: BID, size: 1, style: 'solid', smooth: false, dashedValue: [2, 2] }
        ]
      },
      shouldUpdate: (prev, cur) => {
        const a = prev.extendData
        const b = cur.extendData
        const changed =
          a?.seriesKey !== b?.seriesKey || a?.rev !== b?.rev || JSON.stringify(prev.calcParams) !== JSON.stringify(cur.calcParams)
        return { calc: changed, draw: true }
      },
      calc: calc as IndicatorTemplate<QuoteValue, number, ExtendData>['calc'],
      regenerateFigures: null,
      createTooltipDataSource: null,
      // The spread band, one quadrilateral per pair of neighbouring quoted bars, under the
      // lines. Returns FALSE so the declared figures still render (klinecharts assigns the
      // return to `isCover`).
      draw: ({ ctx, chart, indicator, xAxis, yAxis }) => {
        const band = bandOpacity(indicator.calcParams)
        if (band <= 0) return false
        const range = chart.getVisibleRange()
        const result = indicator.result
        const last = Math.min(result.length - 1, range.realTo)
        ctx.save()
        ctx.fillStyle = `rgba(${BAND}, ${band / 100})`
        for (let i = Math.max(0, range.realFrom - 1); i < last; i++) {
          const cur = result[i]
          const next = result[i + 1]
          if (cur?.ask == null || cur.bid == null || next?.ask == null || next.bid == null) continue
          const x0 = xAxis.convertToPixel(i)
          const x1 = xAxis.convertToPixel(i + 1)
          ctx.beginPath()
          ctx.moveTo(x0, yAxis.convertToPixel(cur.ask))
          ctx.lineTo(x1, yAxis.convertToPixel(next.ask))
          ctx.lineTo(x1, yAxis.convertToPixel(next.bid))
          ctx.lineTo(x0, yAxis.convertToPixel(cur.bid))
          ctx.closePath()
          ctx.fill()
        }
        ctx.restore()
        return false
      }
    }
    registerIndicator(template)
    registerIndicatorSettings(TEMPLATE_NAME, [{ paramNameKey: 'Spread band opacity %', precision: 0, min: 0, max: 100, default: DEFAULT_BAND }])
    registered = true
  }
  return [
    {
      label: 'Quotes · price pane',
      main: true,
      items: [
        {
          name: TEMPLATE_NAME,
          label: 'Bid / ask',
          description:
            'The bid (blue) and ask (red) at each bar close, with the spread shaded between them. Param: spread band opacity %. Drawn only where the vendor stores real quotes (OANDA today); coinbase and schwab bars carry none.'
        }
      ]
    }
  ]
}
