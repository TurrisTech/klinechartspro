import type { KLineData } from 'klinecharts'
import { capabilities } from './capabilities'
import { apiGet } from './config'
import { barToKLineData, isNoData, type GetBarsResponse } from './ohlcv'

// How many times an empty window may be widened before we accept that history really is
// exhausted. Each attempt DOUBLES the span, so the reach is 2^6 = 64x the chart's own
// window — and because the window is sized in bars, that scales with the interval on its
// own: ~22 days of lookback at 1m, decades at 1D. A fixed wall-clock cap cannot do both.
const MAX_WIDENING_ATTEMPTS = 6

async function fetchBars(
  vendorSymbol: string,
  resolution: string,
  from: number,
  to: number,
  limit: number
): Promise<KLineData[]> {
  const body = await apiGet<GetBarsResponse>('/getbars', {
    symbol: vendorSymbol,
    resolution,
    from,
    to,
    // Bounding the reply by bar count rather than by range is what makes widening safe: a
    // widened window that turns out to straddle dense data would otherwise blow the
    // maxBarsPerRequest cap and 413. `limit` keeps the LAST n bars and skips that check.
    limit: Math.min(limit, capabilities().limits.maxBarsPerRequest)
  })
  // `no_data` is the documented empty answer; `[]` is never sent.
  if (isNoData(body) || !Array.isArray(body)) return []
  return body.map(barToKLineData)
}

// A history fetch covers one fixed-size window, and KLineChart Pro treats an empty response
// as "no more history exists", permanently disabling further pagination. But an empty
// window just as often means a real trading gap: FX closes ~48h every weekend, comfortably
// longer than one 500-bar window at 1m. So on an empty result, widen backwards before
// reporting genuine exhaustion.
export async function fetchBarsWidened(
  vendorSymbol: string,
  resolution: string,
  from: number,
  to: number,
  limit: number
): Promise<KLineData[]> {
  const toMs = Math.trunc(to)
  const fromMs = Math.trunc(from)
  const span = toMs - fromMs
  if (span <= 0) return fetchBars(vendorSymbol, resolution, fromMs, toMs, limit)

  let windowFrom = fromMs
  let widened = span
  for (let attempt = 0; ; attempt++) {
    const bars = await fetchBars(vendorSymbol, resolution, windowFrom, toMs, limit)
    if (bars.length > 0 || attempt >= MAX_WIDENING_ATTEMPTS) return bars
    widened *= 2
    windowFrom = toMs - widened
  }
}
