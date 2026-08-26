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
  // Tiles first. They hold every closed calendar period, so they answer the historical part
  // of any window; only the period currently forming is missing from them. When the window
  // crosses that boundary the two halves are joined rather than the whole window being
  // handed to the API — so a pan into recent history still costs no network for the part
  // already on disk, and any gap left in the result is a real market gap.
  //
  // The split is exact: tiles run to `coveredTo` exclusive and the API is asked from
  // `coveredTo`, so no bar can be served twice or dropped between them.
  const tiled = await barsFromTiles(vendorSymbol, resolution, from, to)
  if (tiled !== null && tiled.coveredTo > to) {
    // `limit` means "the last n bars", which the server would have applied for us.
    return limit === null ? tiled.bars : tiled.bars.slice(-limit)
  }

  const body = await apiGet<GetBarsResponse>('/getbars', {
    symbol: vendorSymbol,
    resolution,
    from: tiled === null ? from : tiled.coveredTo,
    to,
    // Bounding the reply by bar count rather than by range is what makes widening safe: a
    // widened window that turns out to straddle dense data would otherwise blow the
    // maxBarsPerRequest cap and 413. `limit` keeps the LAST n bars and skips that check --
    // which only suits a query anchored at `to` (direction: 'older', below). `null` omits
    // the param outright, relying on the caller having bounded the range itself instead.
    limit: limit === null ? undefined : Math.min(limit, capabilities().limits.maxBarsPerRequest)
  })
  // `no_data` is the documented empty answer; `[]` is never sent.
  const fetched = isNoData(body) || !Array.isArray(body) ? [] : body.map(barToKLineData)
  if (tiled === null) return fetched
  // The forming period can legitimately hold no bars yet (a request landing in a weekend,
  // or moments after a period opens), which is not a reason to discard the tiled history.
  const joined = tiled.bars.concat(fetched)
  return limit === null ? joined : joined.slice(-limit)
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
