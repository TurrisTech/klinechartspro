import { apiUrl, OhlcvApiError } from '../config'

// The multi-timeframe overlays' data, as the server builds it: `GET /mtf/graph`
// (wdashboard-server services/mtfgraph.py, 0.56.0).
//
// One read per overlay binding answers everything the pane draws: every signal of the family on
// every timeframe asked for, each at the instant it became knowable -- its candle's CLOSE, on the
// absolute clock -- and priced at its candle's body; and the signal graph between them, node by
// node, each with its parent and whether it is an entry (a star). The client places those
// instants on its own bars and draws them. Nothing here decides what a graph is any more.
//
// Until wdashboard-server 0.56.0 this module fetched each timeframe's votes and its bar grid, and
// the browser built the graph itself (client/mtf/graph.ts, now gone). The server builds each
// graph whole -- from the first signal of its root's run, wherever that is -- so the answer does
// not depend on where the chart is scrolled, and it caches it against the research feed's own
// cursor documents, revalidated with an ETag: a repeat of a read is a header exchange.

// The generation every overlay draws from. arev21 is the one sampled at fresh price extremes
// rather than at WMA crosses, which is what makes it worth reading across timeframes: its samples
// are a property of price alone, so a 4h extreme and a 1D extreme mean the same thing at two
// scales.
export const MTF_GENERATION = 'arev21' as const

// The timeframes offered in the picker: exactly the intervals arev21 has actually been
// generated on for EURUSD (verified on pg-algo.dev, 2026-08-23 — 3m, 5m, 15m, 30m, 1h,
// 4h, 8h and 1D, ~3.5M prediction rows in total), plus 20m and 2h (2026-09-19): the prod
// arev21 backfill of 2026-09-14 wrote both for the majors, the minors and BTCUSD, though
// EURUSD itself still has no 20m. Deliberately not every interval the
// server can serve bars for: a picker entry for 1W or 1M would be a checkbox that can
// only ever draw an empty pane, because no run has ever written those rows.
//
// Ordered shortest-first, and that order is load-bearing twice over — it is the order
// the picker lists them in, and it is what the template stacks a bar's marks by, so a 4h
// marker always sits closer to the candle than a 1D one.
export const MTF_INTERVALS = ['3m', '5m', '15m', '20m', '30m', '1h', '2h', '4h', '8h', '1D'] as const
export type MtfInterval = (typeof MTF_INTERVALS)[number]

export function isMtfInterval(code: string): code is MtfInterval {
  return (MTF_INTERVALS as readonly string[]).includes(code)
}

/** A signal as the server names it: its timeframe, its candle's date on that timeframe's own
 * wire clock, the instant it became knowable (absolute), and its height -- the top of its
 * candle's body for a top signal, the bottom for a bottom one. */
export interface MtfSignalRef {
  interval: string
  date: number
  knownAt: number
  price: number
}

/** One signal of the family on one timeframe: a marker. */
export interface MtfSignalRow extends MtfSignalRef {
  /** The published label: `'long'` argues up. */
  signal: 'long' | 'short'
  /** `'top'` for a long, `'bottom'` for a short -- which way a graph of it runs. */
  side: 'top' | 'bottom'
  p: number | null
  /** Whether some graph of the requested roots holds it ("hide signals outside the graph"). */
  inGraph: boolean
}

/** One node of one root's graph. A signal may be a node of several roots' graphs. */
export interface MtfNodeRow extends MtfSignalRef {
  root: string
  /** The instant of the graph's first node: names the graph within its root. */
  graph: number
  side: 'top' | 'bottom'
  /** A step -- not a root -- on 5m or shorter: drawn as a star. */
  entry: boolean
  /** What it steps from; null for a root of its graph. */
  parent: MtfSignalRef | null
}

export interface MtfGraphRequest {
  /** `vendor:SYMBOL`. */
  symbol: string
  /** The signal family, `plugin:variant` (`arev21_outlier:arev21_outlier_rank`). */
  source: string
  /** The source plugin's params, in its registry row's declared order. */
  params?: Record<string, number>
  timeframes: readonly string[]
  /** Root timeframes; none answers the markers alone. */
  roots: readonly string[]
  maxStep: number
  /** Absolute instants: what became knowable in `[from, to)`. */
  from: number
  to: number
  limit?: number
  /** The read clock. Omitted, the page-wide one applies (a replay's cursor); `null` reads past
   * it -- an alert's look-ahead. */
  asof?: number | null
}

export interface MtfGraphAnswer {
  signals: MtfSignalRow[]
  nodes: MtfNodeRow[]
  /** Where a capped answer continues, or null. */
  nextFrom: number | null
  /** The last instant at which every timeframe's answer is final -- nothing knowable at or
   * before it can still change -- or null when the server cannot say. */
  computedThrough: number | null
}

interface Envelope {
  s: 'ok' | 'no_data'
  signals?: MtfSignalRow[]
  nodes?: MtfNodeRow[]
  nextFrom?: number | null
  computedThrough?: number | null
}

/** One read of `GET /mtf/graph`. The browser's HTTP cache revalidates a repeat with the server's
 * ETag (`Cache-Control: no-cache`), so asking again costs a header exchange. */
export async function fetchMtfGraph(request: MtfGraphRequest): Promise<MtfGraphAnswer> {
  const url = apiUrl('/mtf/graph', {
    symbol: request.symbol,
    source: request.source,
    params: request.params && Object.keys(request.params).length > 0 ? JSON.stringify(request.params) : undefined,
    timeframes: request.timeframes.join(','),
    roots: request.roots.join(','),
    maxStep: request.maxStep,
    from: request.from,
    to: request.to,
    limit: request.limit,
    // Present-but-null keeps the page-wide clock off this read (config.ts `apiUrl`).
    ...(request.asof !== undefined ? { asof: request.asof } : {})
  })
  const response = await fetch(url)
  const body = (await response.json().catch(() => null)) as (Envelope & { code?: string; detail?: string; field?: string }) | null
  if (!response.ok || body === null) {
    throw new OhlcvApiError(response.status, body?.code ?? 'internal', body?.detail ?? `${response.status} from ${url.pathname}`, body?.field)
  }
  return {
    signals: body.signals ?? [],
    nodes: body.nodes ?? [],
    nextFrom: body.nextFrom ?? null,
    computedThrough: body.computedThrough ?? null
  }
}
