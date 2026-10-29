import { apiGetResponse, getReadClock } from '../config'
import { parseWatermark, type Watermark } from './freshness'

// `GET /levels` — precomputed support/resistance price levels. Mirrors the `Level` model in
// wdashboard-server's schemas.py.
export interface Level {
  interval: string
  price: number
  direction: 'support' | 'resistance'
  bornAt: number
  effectiveAt: number
  invalidations: number[]
  active: boolean
  // '#rrggbb' advisory hint keyed off the interval the level was computed on, so levels
  // from the same timeframe read as a set. Only used when LevelsConfig.base.colorMode is
  // 'server' — see client/levels/config.ts.
  color: string
}

/** wdashboard-server levels.py: LEVELS_COMPUTED_THROUGH_HEADER. Named in the server's CORS
 * `expose_headers`, without which a cross-origin `fetch` could not read it. */
const COMPUTED_THROUGH_HEADER = 'X-Levels-Computed-Through'

export interface FetchLevelsParams {
  vendor: string
  symbol: string
  priceMin: number
  priceMax: number
  dateFrom: number
  dateTo: number
  /** Omitted (undefined) = every allowlisted interval, matching the server's own default. */
  intervals?: string[]
  /** ohlcv.py:946 defaults this to false server-side — omitted here means the same thing. */
  includeInvalidated?: boolean
}

// ONE `/levels` read per instrument, shared by every pane on it. A wall of panes on one symbol
// is the common case, and whatever makes one of them re-read makes all of them re-read at the
// same moment: a replay step across a day boundary invalidates every pane at once
// (replay/index.ts), and a workspace opening, a pan of a wall that shares its time axis or a
// new candle opening on every intraday pane at 17:00 all land together too. Each pane asks for
// its own price band and date window, so until 2026-10-29 that was one read per pane -- six
// to eight at once on a six-pane wall, each a CPU-bound sync route on the one server process
// (wdashboard-server ohlcv.py `levels_route`), queued behind each other. Six-pane EURUSD and
// EURGBP walls on prod at four 2023 replay clocks: a day boundary took 1.4-2.3 s as six reads
// and takes 0.44-0.79 s as one read of their union -- usually the widest pane's own window,
// which already contains every other pane's.
//
// So the asks are gathered per instrument and per everything else that decides the answer --
// the interval set, `include_invalidated` and the read clock -- and sent as one read of the
// UNION of their windows (the smallest rectangle of the price/time plane containing them all).
// Each ask is then answered with exactly what the server would have sent for its own window,
// picked out of the union's answer by the server's own filter (`levelsIn`, below), so a pane
// holds -- and draws -- precisely what it did when it asked alone. (Under a replay clock with
// spent levels shown, less a lookahead the server's own answer had: see `levelsIn`.)
//
// Three things make an ask share instead of read:
//
// - a read IN FLIGHT whose window already contains it: the ask waits on that read;
// - asks made within `GATHER_MS` of each other: one read of their union;
// - a window READ RECENTLY under the same clock that contains it: the ask re-reads THAT window,
//   not its own. Nothing is kept here but the window -- the answer is the browser's, which
//   holds it under that URL and revalidates it with the server's ETag (`Cache-Control:
//   no-cache`, ohlcv.py), so while the book has not changed the read is a 304 with no body
//   and the server does almost nothing. A pane that asked alone for its own window would send
//   a URL the browser has never seen and pay a full read.
//
// Still not a cache with a lifetime of its own: no answer outlives its read here. Deciding when
// an answer stops being current belongs to the layer (levels/layer.ts's `staleAt`), and
// whether it has actually changed to the server's ETag.

/** The rectangle of the price/time plane a `/levels` read covers, on the wire's clock. */
export interface LevelsWindow {
  priceMin: number
  priceMax: number
  dateFrom: number
  dateTo: number
}

/** How long an ask waits for others to join it before its read is sent. The panes of a wall
 * re-read from their own debounce timers (chartlayers/controller.ts), which a shared event
 * starts together but which still fire as separate tasks; a few milliseconds is enough to
 * gather them and is nothing against a read that takes hundreds. A replay's invalidation asks
 * from every pane in one task, which any wait at all would gather. */
export const GATHER_MS = 5

/** How many recently read windows are remembered per instrument and clock. A wall's union is
 * the one that matters; a handful more cover a pane panned off on its own without letting the
 * list grow with a session's history. */
const RECENT_READS = 4

/** One read sent: the window it asked for, and its answer. */
interface Read {
  window: LevelsWindow
  answer: Promise<Level[]>
}

/** An ask waiting for the read that will answer it. */
interface Ask {
  window: LevelsWindow
  resolve(levels: Level[]): void
  reject(err: unknown): void
}

/** What one instrument under one clock and one set of parameters is doing right now. Deleted
 * as soon as it is idle, so this never holds more than the reads in flight. */
interface Shared {
  /** Pinned at the first ask and sent explicitly: the asks were made under it, and a gathered
   * read is sent `GATHER_MS` later, by which time a replay may have moved the clock. */
  clock: number | null
  reads: Read[]
  /** The asks gathered for the next read, or `null` when none is pending. */
  gathering: Ask[] | null
}

const shared = new Map<string, Shared>()

/** Recently read windows per instrument and parameters, newest first -- under ONE clock, the
 * last one read at: a replay steps through clocks and a window read under an old one says
 * nothing about the current. Windows only; see above. */
const recent = new Map<string, { clock: number | null; windows: LevelsWindow[] }>()

/** Everything in the request that decides which levels exist apart from the window. The read
 * clock decides it too, and `fetchLevels` adds it. */
function parametersKey(params: FetchLevelsParams): string {
  return JSON.stringify([params.vendor, params.symbol, params.intervals ?? null, params.includeInvalidated ?? false])
}

function windowOf(params: FetchLevelsParams): LevelsWindow {
  return { priceMin: params.priceMin, priceMax: params.priceMax, dateFrom: params.dateFrom, dateTo: params.dateTo }
}

function covers(outer: LevelsWindow, inner: LevelsWindow): boolean {
  return (
    outer.priceMin <= inner.priceMin &&
    outer.priceMax >= inner.priceMax &&
    outer.dateFrom <= inner.dateFrom &&
    outer.dateTo >= inner.dateTo
  )
}

/** The smallest window containing every one of `windows` (non-empty). */
function unionOf(windows: LevelsWindow[]): LevelsWindow {
  return windows.reduce((union, window) => ({
    priceMin: Math.min(union.priceMin, window.priceMin),
    priceMax: Math.max(union.priceMax, window.priceMax),
    dateFrom: Math.min(union.dateFrom, window.dateFrom),
    dateTo: Math.max(union.dateTo, window.dateTo)
  }))
}

/**
 * What the server answers for `window`, picked out of its answer for a window containing it.
 *
 * Its own filter, restated (wdashboard-server ohlcv.py `levels_route`, services/levels.py
 * `LevelsBook.band` and `build_level`): the price in `[priceMin, priceMax]`, inclusive at both
 * ends, and the level's LIFESPAN intersecting `[dateFrom, dateTo]` -- confirmed no later than
 * `dateTo`, and, if it is spent, its last invalidation no earlier than `dateFrom`. The server
 * compares on the store's clock after moving the window back by the interval's wire offset;
 * the wire dates here are the store's moved forward by that same offset, so comparing them
 * with the window as sent is the same comparison. The order of the answer is kept, and so is
 * every number in it: the prices are the doubles the server parsed the same decimal strings
 * into.
 *
 * One thing is not restated, because the wire does not carry it: under a read clock the
 * server tests a level's lifespan BEFORE it clamps the level to the clock (ohlcv.py
 * `_clamp_level_asof`), so whether a level is in a window can depend on invalidations that
 * have not happened yet at the clock. Here the test is made on the level as the clock left it,
 * which is the answer without that lookahead, and it differs from the server's in two places:
 *
 * - a level already spent at the clock and invalidated again after it was sent for a window
 *   starting after its last invalidation AS OF the clock; it is left out here. Only with spent
 *   levels shown, and never on screen: everything it draws ends before the window, and the
 *   window starts before the view. Prod EURUSD at 2023-06-14 12:00Z, six panes: 43 such
 *   levels across three panes, each ending 6 to 179 days before its pane's window.
 * - a level still active at the clock whose final, spending invalidation is a candle that has
 *   not closed yet was left out of a window starting after that candle's date -- on a pane
 *   looking at the last few days only, while a wider pane on the same instrument drew it. It is
 *   kept here, on every pane whose window it crosses.
 */
export function levelsIn(levels: Level[], window: LevelsWindow): Level[] {
  return levels.filter((level) => {
    if (level.price < window.priceMin || level.price > window.priceMax) return false
    if (level.effectiveAt > window.dateTo) return false
    const end = level.active ? undefined : level.invalidations.at(-1)
    return end === undefined || end >= window.dateFrom
  })
}

export function fetchLevels(params: FetchLevelsParams): Promise<Level[]> {
  const window = windowOf(params)
  // The replay's read clock is not a parameter of this call -- `apiUrl` adds it to every read
  // -- but it decides the answer, so two asks under different clocks never share. A replay
  // step moves the clock and immediately invalidates the layer, which is exactly the moment an
  // old-clock read could still be in flight.
  const clock = getReadClock()
  const key = JSON.stringify([clock, parametersKey(params)])
  let entry = shared.get(key)
  if (!entry) {
    entry = { clock, reads: [], gathering: null }
    shared.set(key, entry)
  }
  const running = entry.reads.find((read) => covers(read.window, window))
  if (running) return running.answer.then((levels) => pick(levels, running.window, window))
  const target = entry
  return new Promise<Level[]>((resolve, reject) => {
    if (target.gathering === null) {
      target.gathering = []
      setTimeout(() => send(key, params), GATHER_MS)
    }
    target.gathering.push({ window, resolve, reject })
  })
}

/** Sends the one read that answers every ask gathered under `key`. */
function send(key: string, params: FetchLevelsParams): void {
  const entry = shared.get(key)
  const asks = entry?.gathering
  if (!entry || !asks) return
  entry.gathering = null
  const wanted = unionOf(asks.map((ask) => ask.window))
  const window = recentlyRead(params, entry.clock, wanted) ?? wanted
  remember(params, entry.clock, window)
  const answer = requestLevels(params, window, entry.clock)
  const read: Read = { window, answer }
  entry.reads.push(read)
  const settle = (): void => {
    entry.reads = entry.reads.filter((other) => other !== read)
    if (entry.reads.length === 0 && entry.gathering === null && shared.get(key) === entry) shared.delete(key)
  }
  // `void` the chained promise: it exists only to clear the entry, and an unhandled
  // rejection on it would be reported separately from the ones the callers already see.
  void answer.then(settle, settle)
  for (const ask of asks) answer.then((levels) => ask.resolve(pick(levels, window, ask.window)), ask.reject)
}

/** `levelsIn`, except that an ask for exactly the window that was read is handed the answer
 * as it came: a pane that asked alone gets the server's own answer, with nothing restated. */
function pick(levels: Level[], read: LevelsWindow, asked: LevelsWindow): Level[] {
  return covers(asked, read) ? levels : levelsIn(levels, asked)
}

function recentlyRead(params: FetchLevelsParams, clock: number | null, wanted: LevelsWindow): LevelsWindow | null {
  const held = recent.get(parametersKey(params))
  if (!held || held.clock !== clock) return null
  return held.windows.find((window) => covers(window, wanted)) ?? null
}

function remember(params: FetchLevelsParams, clock: number | null, window: LevelsWindow): void {
  const key = parametersKey(params)
  const held = recent.get(key)
  // A window inside the new one is answered by it from now on, so it is dropped rather than
  // kept to crowd out one that is not.
  const older = held && held.clock === clock ? held.windows.filter((other) => !covers(window, other)) : []
  recent.set(key, { clock, windows: [window, ...older].slice(0, RECENT_READS) })
}

/** How many `/levels` reads are in flight right now, across every instrument. Test seam; also
 * the number to watch if `/levels` traffic ever looks higher than the instrument count
 * explains. */
export function levelsRequestsInFlight(): number {
  let count = 0
  for (const entry of shared.values()) count += entry.reads.length
  return count
}

// How far the indicator feed has computed, per instrument, as of the last answer this client
// got for it. A server fact, kept because `/levels` is where it is stated and `staleAt` is
// where it is needed; `null` until a first answer arrives, and for a server that does not
// send the header at all (`levels/freshness.ts` degrades to the calendar horizon on both).
//
// Keyed by instrument, not by request window: the watermark is a property of the series, so
// every pane on one symbol reads the same one and the narrowest band read updates it.
const watermarks = new Map<string, Watermark>()

function instrumentKey(vendor: string, symbol: string): string {
  return `${vendor.toLowerCase()}:${symbol.toUpperCase()}`
}

export function levelsComputedThrough(vendor: string, symbol: string): Watermark | null {
  return watermarks.get(instrumentKey(vendor, symbol)) ?? null
}

async function requestLevels(params: FetchLevelsParams, window: LevelsWindow, clock: number | null): Promise<Level[]> {
  const { data: levels, response } = await apiGetResponse<Level[]>('/levels', {
    vendor: params.vendor,
    symbol: params.symbol,
    price_min: window.priceMin,
    price_max: window.priceMax,
    // All-digit strings are read as epoch ms server-side (ohlcv.py's
    // _parse_levels_date: `text.isdigit()` -> int(text)); a 'YYYY-MM-DD' string would
    // instead be localized to America/New_York midnight, which silently shifts the window
    // away from the visible-range timestamps it was derived from.
    date_from: window.dateFrom,
    date_to: window.dateTo,
    intervals: params.intervals?.join(','),
    include_invalidated: params.includeInvalidated ? 'true' : undefined,
    // The clock the asks were made under, stated rather than left to `apiUrl`: `null` sends
    // no `asof` at all, which is a live read.
    asof: clock
  })
  const watermark = parseWatermark(response.headers.get(COMPUTED_THROUGH_HEADER))
  if (watermark !== null) watermarks.set(instrumentKey(params.vendor, params.symbol), watermark)
  return Array.isArray(levels) ? levels : []
}
