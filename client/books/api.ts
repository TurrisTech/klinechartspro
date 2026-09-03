import type { Page, PluginFacilities, SourceSpec } from '../plugins/types'
import { isTiledMetric, pointsFromTiles } from './tiles'

// The client half of the server's `books` plugin (`GET /plugins/books/values`,
// wdashboard-server services/books.py): OANDA's 20-minute client order/position book
// snapshots, served one point per snapshot the chart can see. Every point's `date` is the
// bar it rides on (wire clock) and `ts` is the snapshot's own absolute instant — the
// overlay anchors drawing to `ts`, never to the bar, so a book is drawn where it happened.
//
// Consecutive bars serving the same snapshot are deduplicated server-side; a template that
// wants "the book active at this bar" forward-fills in `calc` (templates.ts).

export const BOOK_KINDS = ['order', 'position'] as const
export type BookKind = (typeof BOOK_KINDS)[number]

/** OANDA publishes both books every 20 minutes (:00/:20/:40 UTC). */
export const GRID_MS = 20 * 60 * 1000

/** Buckets fetched either side of the snapshot price for the profile metric. */
export const PROFILE_DEPTH = 40

/** `near`'s default half-window, percent of the snapshot price (the flow pane's calcParam). */
export const DEFAULT_FLOW_RANGE_PCT = 2

export interface BookTotalsPoint {
  date: number
  /** The snapshot's absolute instant (epoch ms), not wire-dated. */
  ts: number
  /** Percent of all client orders/positions on each side, summed over the whole book. */
  long: number
  short: number
}

export interface BookNearPoint {
  date: number
  ts: number
  /** The snapshot price the split is made at. */
  price: number
  longBelow: number
  longAbove: number
  shortBelow: number
  shortAbove: number
}

/** One bucket: [price, long %, short %]. Sparse and unevenly spaced — the vendor omits
 * empty buckets. */
export type BookBucket = [number, number, number]

export interface BookProfilePoint {
  date: number
  ts: number
  price: number
  /** The bucket width, in price. */
  width: number
  buckets: BookBucket[]
}

function fetchBooks<P extends { date: number }>(
  facilities: PluginFacilities,
  kind: BookKind,
  vendor: string,
  ticker: string,
  interval: string,
  params: Record<string, unknown>
): (range: { from: number; to: number }, limit: number) => Promise<Page<P>> {
  const fromApi = (range: { from: number; to: number }, limit: number) =>
    facilities.points<P>({
      pluginId: 'books',
      vendorSymbol: `${vendor}:${ticker}`,
      resolution: interval,
      from: range.from,
      to: range.to,
      limit,
      variant: kind,
      params
    })

  const metric = String(params.metric ?? 'totals')
  // `near` is a sum over a radius the tiles do not carry, so it stays on the API outright
  // rather than half-answering from tiles.
  if (!isTiledMetric(metric)) return fromApi

  // Tiles first, the same join `client/history.ts` makes for bars. Tiles hold every closed
  // period, so they answer the historical part of any window and only the period currently
  // forming is missing; when the window crosses that boundary the two halves are joined
  // rather than the whole window being handed back to the API. The split is exact — tiles
  // run to `coveredTo` exclusive and the API is asked from `coveredTo` — so no point can
  // be served twice or dropped between them.
  return async (range, limit) => {
    const tiled = await pointsFromTiles<P & (BookTotalsPoint | BookProfilePoint)>(
      metric,
      kind,
      vendor,
      ticker,
      interval,
      range.from,
      range.to
    )
    if (tiled === null) return fromApi(range, limit)
    const points = tiled.points as unknown as P[]
    if (tiled.coveredTo >= range.to) {
      // `limit` is the server's cap on one page; applying it here keeps a tiled read and
      // an API read paging identically, and `nextFrom` continues from the last point.
      const capped = points.slice(0, limit)
      const more = capped.length < points.length
      return { points: capped, nextFrom: more ? capped[capped.length - 1].date + 1 : null }
    }
    const rest = await fromApi({ from: tiled.coveredTo, to: range.to }, limit)
    return { ...rest, points: [...points, ...rest.points] }
  }
}

/** The profile source for one kind on one instrument/interval — shared by the depth
 * overlay and the hover viewer, which is why the key carries everything that decides the
 * data and nothing else (both leave `createStore` to the host's default `WindowStore`,
 * satisfying the same-factory rule). */
export function profileSource(
  facilities: PluginFacilities,
  kind: BookKind,
  vendor: string,
  ticker: string,
  interval: string
): SourceSpec<BookProfilePoint> {
  return {
    id: 'profile',
    key: `books|profile|${kind}|${vendor}:${ticker}|${interval}|d${PROFILE_DEPTH}`,
    resolution: interval,
    fetch: fetchBooks<BookProfilePoint>(facilities, kind, vendor, ticker, interval, {
      metric: 'profile',
      depth: PROFILE_DEPTH
    })
  }
}

export function totalsSource(
  facilities: PluginFacilities,
  kind: BookKind,
  vendor: string,
  ticker: string,
  interval: string
): SourceSpec<BookTotalsPoint> {
  return {
    id: 'totals',
    key: `books|totals|${kind}|${vendor}:${ticker}|${interval}`,
    resolution: interval,
    fetch: fetchBooks<BookTotalsPoint>(facilities, kind, vendor, ticker, interval, {
      metric: 'totals'
    })
  }
}

export function nearSource(
  facilities: PluginFacilities,
  kind: BookKind,
  vendor: string,
  ticker: string,
  interval: string,
  rangePct: number
): SourceSpec<BookNearPoint> {
  return {
    id: 'near',
    key: `books|near|${kind}|${vendor}:${ticker}|${interval}|r${rangePct}`,
    resolution: interval,
    fetch: fetchBooks<BookNearPoint>(facilities, kind, vendor, ticker, interval, {
      metric: 'near',
      range: rangePct
    })
  }
}

/** Milliseconds of one intraday bar, or null for session-dated intervals (1D and
 * coarser), whose bars have no fixed duration a snapshot instant can be placed inside. */
export function intradayMs(interval: string): number | null {
  const match = /^(\d+)(m|h)$/.exec(interval)
  if (!match) return null
  const n = Number(match[1])
  return match[2] === 'm' ? n * 60_000 : n * 3_600_000
}
