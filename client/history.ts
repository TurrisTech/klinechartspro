import type { KLineData } from 'klinecharts'
import { capabilities } from './capabilities'
import { apiGet } from './config'
import { barToKLineData, isNoData, type GetBarsResponse } from './ohlcv'
import { barsFromTiles } from './tiles'

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
  limit: number | null
): Promise<KLineData[]> {
  // Tiles first, when they cover the whole window. They only ever hold *closed* calendar
  // periods, so anything reaching the live edge returns null here and is served below —
  // which is the same path the forming bar and the websocket already use. A tile answer is
  // byte-for-byte the same bars, so this is invisible to every caller above.
  //
  // `limit` still has to be honoured: it means "the last n bars", and the widening loop
  // below depends on that anchoring. Trimming here rather than skipping tiles keeps a
  // limited request cacheable.
  const tiled = await barsFromTiles(vendorSymbol, resolution, from, to)
  if (tiled !== null) return limit === null ? tiled : tiled.slice(-limit)

  const body = await apiGet<GetBarsResponse>('/getbars', {
    symbol: vendorSymbol,
    resolution,
    from,
    to,
    // Bounding the reply by bar count rather than by range is what makes widening safe: a
    // widened window that turns out to straddle dense data would otherwise blow the
    // maxBarsPerRequest cap and 413. `limit` keeps the LAST n bars and skips that check --
    // which only suits a query anchored at `to` (direction: 'older', below). `null` omits
    // the param outright, relying on the caller having bounded the range itself instead.
    limit: limit === null ? undefined : Math.min(limit, capabilities().limits.maxBarsPerRequest)
  })
  // `no_data` is the documented empty answer; `[]` is never sent.
  if (isNoData(body) || !Array.isArray(body)) return []
  return body.map(barToKLineData)
}

// A history fetch covers one fixed-size window, and KLineChart Pro treats an empty response
// as "no more history exists", permanently disabling further pagination. But an empty
// window just as often means a real trading gap: FX closes ~48h every weekend, comfortably
// longer than one 500-bar window at 1m. So on an empty result, widen before reporting
// genuine exhaustion.
//
// `direction` picks which end of [from, to] moves as the window widens, and therefore which
// end `limit`'s server-side `tail(limit)` keeps bars nearest to:
// - 'older' (default): holds `to`, widens `from` backwards. Suits a query anchored at `to`
//   (ChartPane's plain/forward loads, and a seek reload's own newest edge) -- `tail(limit)`
//   keeps exactly the bars nearest that anchor.
// - 'newer': holds `from`, widens `to` forwards. Suits ChartPane's backward-paging branch,
//   anchored at `from` (one period past the bar the chart already holds at that seam).
//   `tail(limit)` would keep bars nearest the widened (far) edge instead -- the wrong end,
//   opening a hole at the seam -- so callers pass `limit: null` for this direction and rely
//   on the narrow nominal range to stay under the server's cap on its own.
export async function fetchBarsWidened(
  vendorSymbol: string,
  resolution: string,
  from: number,
  to: number,
  limit: number | null,
  direction: 'older' | 'newer' = 'older'
): Promise<KLineData[]> {
  const toMs = Math.trunc(to)
  const fromMs = Math.trunc(from)
  const span = toMs - fromMs
  if (span <= 0) return fetchBars(vendorSymbol, resolution, fromMs, toMs, limit)

  let widened = span
  for (let attempt = 0; ; attempt++) {
    const windowFrom = direction === 'older' ? toMs - widened : fromMs
    const windowTo = direction === 'newer' ? fromMs + widened : toMs
    const bars = await fetchBars(vendorSymbol, resolution, windowFrom, windowTo, limit)
    if (bars.length > 0 || attempt >= MAX_WIDENING_ATTEMPTS) return bars
    widened *= 2
  }
}
