// PURE apart from the cache it keeps. Source bars -> volume at price, one small histogram per
// chart bar.
//
// A bar says how much volume traded and between which prices, never where in between. So every
// bar's volume is SPREAD over its range -- evenly, which is the only assumption that needs no
// data the bar does not carry -- and what makes that assumption harmless is spreading bars that
// are small against the rows they land in. That is why the source is a lower timeframe than the
// chart (source.ts picks it) and why this module works on source bars rather than on the chart's.
//
// The histogram is kept on a fixed price grid of height `q` (an ATOM: atom k covers
// [k*q, (k+1)*q)), per chart bar. Any range's profile is then the sum of its chart bars'
// histograms -- the visible range, a session, anything -- and the grouping into display rows
// happens only at draw time (profile.ts), so a scroll or a change of row count re-sums arrays
// and never re-reads a bar.

/** A source bar as the store holds it: `date` on the source's own wire clock. */
export interface SourceBar {
  date: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

/** The four prices and the volume -- what spreading reads off either kind of bar. */
export interface Spreadable {
  open: number
  high: number
  low: number
  close: number
  volume?: number | null
}

/** Volume at price for one chart bar. `up`/`down` are indexed from atom `first`; up is the
 * volume of bars that closed above their open, down below, and a bar that closed where it
 * opened is split evenly -- the volume is unsigned (OANDA's is a tick count), so this is a
 * bar-direction heuristic and nothing more. */
export interface Atoms {
  first: number
  up: Float64Array
  down: Float64Array
  total: number
  /** The part of `total` spread from the CHART bar, because its source bars did not account
   * for all of its volume: out of the source's reach, outside the fetch budget, or not
   * arrived yet. 0 when the source covered the bar. */
  coarse: number
}

/** A chart bar whose source bars account for less than this share of its volume has the
 * difference spread from the chart bar itself. Tolerance rather than exactness because two
 * reads of the same volume disagree slightly at the live edge (the chart's forming bar and the
 * source's come off different stream subscriptions) and a crypto candle settles late. */
export const REMAINDER_TOLERANCE = 0.02

/** The atom a price falls in. */
export function atomOf(price: number, q: number): number {
  return Math.floor(price / q)
}

function bounds(bar: Spreadable, q: number): [number, number] {
  const lo = Math.min(bar.low, bar.open, bar.close)
  const hi = Math.max(bar.high, bar.open, bar.close)
  return [atomOf(lo, q), atomOf(hi, q)]
}

/** Add `volume` of `bar` into `into`, evenly over [low, high]. The atoms it reaches must lie
 * inside `into` (the caller sized it from `bounds`). A bar with no range puts everything at
 * its close. */
export function spread(into: Atoms, bar: Spreadable, volume: number, q: number): void {
  if (!(volume > 0)) return
  const upShare = bar.close > bar.open ? 1 : bar.close < bar.open ? 0 : 0.5
  const low = Math.min(bar.low, bar.open, bar.close)
  const high = Math.max(bar.high, bar.open, bar.close)
  const range = high - low
  const last = into.up.length - 1
  if (!(range > q * 1e-9)) {
    const k = Math.min(last, Math.max(0, atomOf(bar.close, q) - into.first))
    into.up[k] += volume * upShare
    into.down[k] += volume * (1 - upShare)
    into.total += volume
    return
  }
  const k0 = atomOf(low, q)
  const k1 = atomOf(high, q)
  for (let k = k0; k <= k1; k++) {
    const overlap = Math.min(high, (k + 1) * q) - Math.max(low, k * q)
    if (!(overlap > 0)) continue
    const at = Math.min(last, Math.max(0, k - into.first))
    const v = (volume * overlap) / range
    into.up[at] += v * upShare
    into.down[at] += v * (1 - upShare)
  }
  into.total += volume
}

/** One chart bar's histogram: its source bars spread, plus whatever of the chart bar's own
 * volume they did not account for, spread over the chart bar. Null when there is no volume. */
export function slotAtoms(chartBar: Spreadable, sources: readonly Spreadable[], q: number): Atoms | null {
  let sourceVolume = 0
  for (const s of sources) if ((s.volume ?? 0) > 0) sourceVolume += s.volume as number
  const chartVolume = chartBar.volume ?? 0
  const remainder = chartVolume - sourceVolume
  const coarse = chartVolume > 0 && remainder > REMAINDER_TOLERANCE * chartVolume ? remainder : 0
  if (sourceVolume <= 0 && coarse <= 0) return null

  let kmin = Number.POSITIVE_INFINITY
  let kmax = Number.NEGATIVE_INFINITY
  const widen = (bar: Spreadable) => {
    const [a, b] = bounds(bar, q)
    if (a < kmin) kmin = a
    if (b > kmax) kmax = b
  }
  for (const s of sources) if ((s.volume ?? 0) > 0) widen(s)
  if (coarse > 0) widen(chartBar)
  if (!Number.isFinite(kmin) || !Number.isFinite(kmax) || kmax - kmin > MAX_ATOMS_PER_BAR) return null

  const size = kmax - kmin + 1
  const out: Atoms = { first: kmin, up: new Float64Array(size), down: new Float64Array(size), total: 0, coarse }
  for (const s of sources) spread(out, s, s.volume ?? 0, q)
  if (coarse > 0) spread(out, chartBar, coarse, q)
  return out
}

/** A bad print (a zero price, a decimal slip) can span millions of atoms; such a bar is left
 * out rather than allocated. */
const MAX_ATOMS_PER_BAR = 100_000

/** The first index of `n` ascending keys whose key is >= `target`. */
export function lowerBound(n: number, target: number, key: (i: number) => number): number {
  let lo = 0
  let hi = n
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (key(mid) < target) lo = mid + 1
    else hi = mid
  }
  return lo
}

/** The chart as the index sees it: each bar's OPEN INSTANT (a session-dated bar's wire date
 * with the schedule's shift taken off), the bars themselves, and where the last one ends. */
export interface ChartSlots {
  starts: readonly number[]
  bars: readonly Spreadable[]
  lastEnd: number
}

/** The source as the index sees it: ascending bars, and the shift from their dates to open
 * instants (non-zero only for a session-dated source). Null when the chart's own bars are
 * the source. */
export interface SourceSlice {
  bars: readonly SourceBar[]
  shift: number
}

/**
 * The per-chart-bar histograms for one pane, kept across calls so a live tick rebuilds one bar
 * rather than the whole history.
 *
 * `dirtyFrom` is the earliest open instant whose source bars changed since the last call
 * (`-Infinity` for everything, null for nothing); the chart's own changes are detected here.
 * The last chart bar is rebuilt on every call because the forming bar's volume and range move
 * with every tick and its remainder is computed from them.
 */
export class AtomIndex {
  private slots = new Map<number, Atoms | null>()
  private firstStart: number | null = null
  private lastStart: number | null = null
  private count = 0
  private q = 0

  update(chart: ChartSlots, source: SourceSlice | null, q: number, dirtyFrom: number | null): (Atoms | null)[] {
    const n = chart.starts.length
    if (n === 0) {
      this.reset(q)
      return []
    }
    let from = dirtyFrom ?? Number.POSITIVE_INFINITY
    // A different grid, or history loaded on the left (indices shift, and the first slot's
    // left neighbour now exists): rebuild everything. Rare -- a pan into older history.
    if (q !== this.q || chart.starts[0] !== this.firstStart || n < this.count) {
      this.reset(q)
      from = Number.NEGATIVE_INFINITY
    } else if (this.lastStart !== null && chart.starts[n - 1] !== this.lastStart) {
      // New bars on the right: the old last slot now ends at the next open, not at its own end.
      from = Math.min(from, this.lastStart)
    }
    from = Math.min(from, chart.starts[n - 1])

    // The first slot whose span reaches `from`.
    const rebuildFrom = Math.max(0, lowerBound(n, from, (j) => chart.starts[j]) - (from === Number.NEGATIVE_INFINITY ? 0 : 1))
    for (let i = rebuildFrom; i < n; i++) {
      const start = chart.starts[i]
      const end = i + 1 < n ? chart.starts[i + 1] : chart.lastEnd
      let inSlot: readonly SourceBar[] = []
      if (source) {
        const a = lowerBound(source.bars.length, start, (j) => source.bars[j].date - source.shift)
        const b = lowerBound(source.bars.length, end, (j) => source.bars[j].date - source.shift)
        inSlot = source.bars.slice(a, b)
      }
      this.slots.set(start, slotAtoms(chart.bars[i], inSlot, q))
    }
    this.firstStart = chart.starts[0]
    this.lastStart = chart.starts[n - 1]
    this.count = n

    const out = new Array<Atoms | null>(n)
    for (let i = 0; i < n; i++) out[i] = this.slots.get(chart.starts[i]) ?? null
    // Slots that fell off (a shorter chart after a reload) are dropped with the reset above;
    // nothing else ever removes one, so the map is bounded by the chart's length.
    return out
  }

  private reset(q: number): void {
    this.slots.clear()
    this.firstStart = null
    this.lastStart = null
    this.count = 0
    this.q = q
  }
}

/** The atom height: about an eighth of a typical bar's range, in whole ticks, so a typical
 * bar spans eight atoms and no display row is ever finer than the grid it is summed from. */
export function quantumFor(ranges: readonly number[], tick: number): number {
  const positive = ranges.filter((r) => r > 0 && Number.isFinite(r)).sort((a, b) => a - b)
  const t = tick > 0 ? tick : 1e-5
  if (positive.length === 0) return t
  const median = positive[positive.length >> 1]
  return Math.max(t, Math.round(median / 8 / t) * t)
}
