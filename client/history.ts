import type { KLineData } from 'klinecharts'
import { capabilities } from './capabilities'
import { apiGet, getReadClock, OhlcvApiError, type QueryParams } from './config'
import { instrumentConfig } from './instrumentconfig'
import { legalCandleOpens } from './marketclosed'
import { barToKLineData, isNoData, type GetBarsResponse, type OHLCVBar } from './ohlcv'
import { barsFromTiles } from './tiles'
import { readHorizon, readTiled } from './tiles/join'

// How many times an empty window may be widened before we accept that history really is
// exhausted. Each attempt DOUBLES the span, so the reach is 2^6 = 64x the chart's own
// window — and because the window is sized in bars, that scales with the interval on its
// own: ~22 days of lookback at 1m, decades at 1D. A fixed wall-clock cap cannot do both.
const MAX_WIDENING_ATTEMPTS = 6

// ...but no reach may stop short of a week. A gap that is a market closing is at most a
// weekend -- 48h for FX -- and 64x a 500-bar window is only ~44h at 5s, so without this floor
// a 5s chart reported "no more history" at the first weekend it met, in both directions.
// At 1m and above the 64x reach is already past it and nothing changes.
const MIN_WIDENING_REACH_MS = 7 * 86_400_000

// The ceiling the floor cannot push past, whatever the window: a reach of 2^24 windows.
const MAX_WIDENING_ATTEMPTS_HARD = 24

/**
 * One window of bars: tiles for the closed part, the API for whatever is left
 * (`tiles/join.ts`), the last `limit` of them when given.
 *
 * Exported because the plugins' own bar reads (`plugins/bars.ts`) and the AREV21 MTF overlay's
 * bar GRID need the same thing, and the overlay used to ask `/getbars` directly, which meant
 * panning through tiled history still hit the API once per grid window per source timeframe.
 *
 * Under a bar replay the tiles stop at the bar forming at the clock and the API -- clamped to
 * it, the forming bar rebuilt from the rows that had closed -- answers from there, for the chart
 * and for every plugin alike.
 */
export function fetchBars(
  vendorSymbol: string,
  resolution: string,
  from: number,
  to: number,
  limit: number | null
): Promise<KLineData[]> {
  return readBars(vendorSymbol, resolution, from, to, limit, null)
}

/** `/getbars` answers already asked for, by request, for the life of one widening: an answer
 * is the same each time it is asked within it, and a widening asks the same remainder once per
 * attempt (`fetchBarsWidened`). */
type GetbarsAnswers = Map<string, Promise<KLineData[]>>

async function readBars(
  vendorSymbol: string,
  resolution: string,
  from: number,
  to: number,
  limit: number | null,
  answers: GetbarsAnswers | null
): Promise<KLineData[]> {
  // The schedule lookup is started alongside the tile read rather than before it: both are
  // cached for the life of the page, so only the first window per instrument pays anything at
  // all, and overlapping them makes that first one cost the larger of the two, not the sum.
  const config = instrumentConfig(vendorSymbol)
  const getbars = async (range: { from: number; to: number }, last: number | null): Promise<KLineData[]> => {
    const body = await apiGet<GetBarsResponse>('/getbars', {
      symbol: vendorSymbol,
      resolution,
      from: range.from,
      to: range.to,
      // Bounding the reply by bar count rather than by range is what makes widening safe: a
      // widened window that turns out to straddle dense data would otherwise blow the
      // maxBarsPerRequest cap and 413. `limit` keeps the LAST n bars and skips that check --
      // which only suits a query anchored at `to` (direction: 'older', below). `null` omits
      // the param outright, relying on the caller having bounded the range itself instead.
      limit: last === null ? undefined : Math.min(last, capabilities().limits.maxBarsPerRequest)
    })
    // `no_data` is the documented empty answer; `[]` is never sent.
    return isNoData(body) || !Array.isArray(body) ? [] : body.map(barToKLineData)
  }
  const page = await readTiled<KLineData>({
    range: { from, to },
    limit,
    keep: 'last',
    date: (bar) => bar.timestamp,
    tiles: (range) => barsFromTiles(vendorSymbol, resolution, range.from, range.to),
    api: async (range, last) => {
      if (answers === null) return { points: await getbars(range, last), nextFrom: null }
      // The read clock is part of the request: `apiGet` sends it as `asof`, and an advance
      // landing mid-widening makes the same range a different question.
      const key = `${range.from}|${range.to}|${last}|${getReadClock()}`
      let answer = answers.get(key)
      if (answer === undefined) {
        answer = getbars(range, last)
        answers.set(key, answer)
      }
      return { points: await answer, nextFrom: null }
    },
    horizon: readHorizon(vendorSymbol, resolution),
    // Market-closed labels are dropped from both halves, before `limit`'s tail: trimming first
    // would hand back fewer than `limit` bars.
    admit: config.then((c) => legalCandleOpens(resolution, c?.marketHours))
  })
  return page.points
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

  // Each attempt is a read of its own, and the part of it past the tiles goes to the API again
  // every time. Under a bar replay that is the same request on every attempt: 'older' holds the
  // end the tiles stop short of, and 'newer' widens past what the clock lets be answered, where
  // the join asks only up to it (`tiles/join.ts`). A remainder is re-asked only because the
  // attempt came back empty, and it would come back empty again -- so it is asked once.
  const answers: GetbarsAnswers = new Map()
  let widened = span
  for (let attempt = 0; ; attempt++) {
    const windowFrom = direction === 'older' ? toMs - widened : fromMs
    const windowTo = direction === 'newer' ? fromMs + widened : toMs
    const bars = await readBars(vendorSymbol, resolution, windowFrom, windowTo, limit, answers)
    if (bars.length > 0 || attempt >= MAX_WIDENING_ATTEMPTS_HARD) return bars
    if (attempt >= MAX_WIDENING_ATTEMPTS && widened >= MIN_WIDENING_REACH_MS) return bars
    widened *= 2
  }
}

/**
 * `/getbars` over `[from, to)` on the wire clock, split in halves wherever the server answers
 * 413 -- a span denser than its nominal length promised (5s bars over a busy hour, say) -- down
 * to `minSpanMs`. No `limit`: it keeps the LAST n bars, the wrong end for a read that pages
 * forwards. `get` is the API getter to use (a plugin's facilities, or a read past the replay
 * clock with `asof: null` in `params`).
 */
export async function getbarsSplit(
  get: <T>(path: string, params?: QueryParams) => Promise<T>,
  params: QueryParams & { from: number; to: number },
  minSpanMs: number
): Promise<OHLCVBar[]> {
  try {
    const body = await get<GetBarsResponse>('/getbars', params)
    return isNoData(body) || !Array.isArray(body) ? [] : (body as OHLCVBar[])
  } catch (err) {
    if (err instanceof OhlcvApiError && err.code === 'too_large' && params.to - params.from > minSpanMs) {
      const mid = params.from + Math.floor((params.to - params.from) / 2)
      const [a, b] = await Promise.all([
        getbarsSplit(get, { ...params, to: mid }, minSpanMs),
        getbarsSplit(get, { ...params, from: mid }, minSpanMs)
      ])
      return [...a, ...b]
    }
    throw err
  }
}
