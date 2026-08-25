import type { OverlayCreate } from 'klinecharts'
import { levelsCoverageFor, hasFeature } from '../capabilities'
import { darkenToward } from '../chartlayers/color'
import type { ChartLayer, LayerContext } from '../chartlayers/types'
import { applyEncodings, toLineStyle, type LineAppearance } from '../chartlayers/encoding'
import { nextSessionAnchor } from '../replay/timeframes'
import { fetchLevels, type Level } from './api'
import {
  DEFAULT_LEVELS_CONFIG,
  LEVELS_FIELDS,
  LEVELS_METRIC_NAMES,
  type LevelsConfig,
  type LevelsMetricName
} from './config'

const ONE_DAY_MS = 86_400_000

// Floor on how dark a stretch can get, in HSL lightness. A level may hold ten invalidations
// (levels.py's LEVELS_MAX_INVALIDATIONS), and unbounded the later stretches of one would walk
// all the way to black — invisible on a dark chart, which reads as "no level here" rather
// than as "heavily tested". A floor on the RESULT rather than on the step is what keeps that
// true for a color that is already dark, like the 1W green, as well as for a light one.
const MIN_LIGHTNESS = 0.18

// How far off screen a stretch is still drawn and still reaches, in whole visible spans per
// side. It is NOT the controller's fetch margin, and must be much larger than it: a redraw is
// debounced, so between a pan and the redraw that follows it the chart shows lines built for
// where the view USED to be, and wherever those lines stop is a visible wall of ends. Four
// spans is past what one drag can reveal — a drag pans at most a pane width, since the
// pointer cannot leave the window — with room left for a few zoom-out notches on top. It
// still bounds the longest stroke to about nine pane widths, which matters because a spent
// level is dashed by default and a dash pattern is walked over the whole stroke.
const DRAW_MARGIN_SPANS = 4

// A level's raw metrics, computed once per redraw against the current view (ctx.to is the
// visible range's right edge — see chartlayers/types.ts on why age is measured against
// that, not wall-clock time).
const METRICS: Record<LevelsMetricName, (level: Level, ctx: LayerContext) => number> = {
  invalidations: (level) => level.invalidations.length,
  ageDays: (level, ctx) => (ctx.to - level.effectiveAt) / ONE_DAY_MS,
  untouchedDays: (level, ctx) => (ctx.to - (level.invalidations.at(-1) ?? level.effectiveAt)) / ONE_DAY_MS,
  intervalRank: (level) => LEVELS_INTERVAL_RANK[level.interval] ?? 0
}

// Kept separate from config.ts's display-order list: this is "how far apart the timeframes
// are for encoding purposes," not "what order to show them in a settings panel."
const LEVELS_INTERVAL_RANK: Record<string, number> = { '1D': 0, '1W': 1, '1M': 2 }

function metricsFor(level: Level, ctx: LayerContext): Record<string, number> {
  const out: Record<string, number> = {}
  for (const name of LEVELS_METRIC_NAMES) out[name] = METRICS[name](level, ctx)
  return out
}

function colorFor(level: Level, config: LevelsConfig): string {
  switch (config.base.colorMode) {
    case 'direction':
      return config.base.directionColors[level.direction]
    case 'interval':
      return config.base.intervalColors[level.interval] ?? level.color
    default:
      return level.color
  }
}

function baseAppearance(level: Level, config: LevelsConfig): LineAppearance {
  // A spent level still marks a price that mattered, so it stays on the chart — dimmed and
  // (by default) dashed, so it can't be mistaken for one still in play.
  const spent = !level.active
  return {
    color: colorFor(level, config),
    pattern: spent ? config.spent.pattern : config.base.pattern,
    width: config.base.width,
    opacity: spent ? config.base.opacity * config.spent.opacityScale : config.base.opacity
  }
}

// One unbroken stretch of a level's life. It opens where the level was confirmed, and every
// invalidation closes one stretch and opens the next; `to: null` marks the final stretch of a
// level that is still live, which has no end and is therefore drawn as a ray rather than a
// segment. `touches` is how many invalidations are already behind the stretch, which is both
// its position in the chain and how many darkening steps it carries.
interface LevelSpan {
  from: number
  to: number | null
  touches: number
}

function spansFor(level: Level): LevelSpan[] {
  const bounds = [level.effectiveAt, ...level.invalidations]
  const spans: LevelSpan[] = level.invalidations.map((_, index) => ({
    from: bounds[index],
    to: bounds[index + 1],
    touches: index
  }))
  if (level.active) {
    spans.push({ from: bounds[bounds.length - 1], to: null, touches: level.invalidations.length })
  }
  // Unreachable against a real server — spent means at least LEVELS_MAX_INVALIDATIONS + 1 of
  // them, and the wire list only ever drops the confirmation instant — but a spent level with
  // an empty list would otherwise vanish silently instead of degrading to a single ray.
  if (spans.length === 0) spans.push({ from: level.effectiveAt, to: null, touches: 0 })
  return spans
}

// Each invalidation is a price interaction that leaves the level a little more worn, so each
// successive stretch is drawn a step darker than the one before it. Lightness, not alpha:
// alpha is already spoken for by the age encoding and by spent dimming, and stacking the two
// on one channel would make "old" and "often tested" indistinguishable.
function darkenedBy(appearance: LineAppearance, config: LevelsConfig, touches: number): LineAppearance {
  const amount = config.base.darkenPerInvalidation * touches
  if (amount <= 0) return appearance
  return { ...appearance, color: darkenToward(appearance.color, amount, MIN_LIGHTNESS) }
}

// The span of time a stretch is drawn across: the visible range plus DRAW_MARGIN_SPANS of
// slack on each side. Anything outside it is neither drawn nor reached into.
function drawWindow(ctx: LayerContext): { from: number; to: number } {
  const margin = (ctx.to - ctx.from) * DRAW_MARGIN_SPANS
  return { from: ctx.from - margin, to: ctx.to + margin }
}

// klinecharts turns an overlay point's timestamp into an x coordinate by binary-searching the
// loaded bars, and EXTRAPOLATES at a uniform bar cadence for any timestamp outside them
// (StoreImp.timestampToDataIndex). Most stretches cross the first loaded bar — a level
// confirmed in 2003 shown on a chart holding a few hundred 1h bars is the normal case, not
// the edge case — and that one would be handed an x of about -1e6, or -7e7 on a 1m chart.
// Canvas clips such a line correctly but still strokes it, and a dashed spent level walks its
// dash pattern across every one of those pixels, which is enough to lock up the tab. Clamping
// each end into the drawing window fixes that at no visual cost: the clamped end still sits
// DRAW_MARGIN_SPANS screens off-pane, so the part anyone can see is identical, and no
// coordinate is ever more than that margin outside the chart.
function spanToOverlay(
  level: Level,
  span: LevelSpan,
  appearance: LineAppearance,
  window: { from: number; to: number }
): OverlayCreate {
  const shared = {
    paneId: 'candle_pane',
    // These are server-computed reference lines, not user drawings: dragging one would
    // imply it means something, and it would silently diverge from what the server says.
    lock: true,
    // Stashes the source datum on the overlay so future code (a click handler, a tooltip)
    // can read it back without re-deriving it from the price/groupId alone.
    extendData: level,
    styles: { line: toLineStyle(appearance) }
  }
  const from = Math.max(span.from, window.from)
  if (span.to !== null) {
    return {
      ...shared,
      name: 'horizontalSegment',
      points: [
        { timestamp: from, value: level.price },
        { timestamp: Math.min(span.to, window.to), value: level.price }
      ]
    }
  }
  // horizontalRayLine draws from its first point to the edge of the pane, and reads its
  // second point only for the direction — so that one just has to land strictly to the right,
  // which a full window past the window's own end does even for a stretch starting at it.
  return {
    ...shared,
    name: 'horizontalRayLine',
    points: [
      { timestamp: from, value: level.price },
      { timestamp: window.to + (window.to - window.from), value: level.price }
    ]
  }
}

// A stretch that is entirely off one side of the drawing window contributes nothing, and on a
// long history most of a level's stretches are exactly that.
function spanInWindow(span: LevelSpan, window: { from: number; to: number }): boolean {
  if (span.from > window.to) return false
  return span.to === null || span.to >= window.from
}

// The 'intervals' request param only narrows what the server sends when it advertises
// support for it (client/capabilities.ts: 'levels.intervals'); otherwise every allowlisted
// interval always comes back and per-timeframe visibility is a paint-time filter instead
// (toOverlays, below) — either way the toggle works, only whether it saves a request differs.
function requestedIntervals(config: LevelsConfig): string[] | undefined {
  if (!hasFeature('levels.intervals')) return undefined
  return Object.entries(config.intervals)
    .filter(([, visible]) => visible)
    .map(([code]) => code)
}

// When a fetched level book can FIRST be out of date. Levels are computed on 1W and 1M only
// (wdashboard-server levels.py: LEVELS_INTERVAL_ALLOWLIST), so a level can only appear, or
// take another invalidation, or be spent, when a weekly or monthly candle CLOSES — and every
// one of those closes is at 17:00 on a market day. Between two 17:00s the server is holding
// the same book (it says so itself now: `/levels` is keyed by the feed's own watermark), so
// refetching is asking the same question again.
//
// The alternative the controller falls back to is a five-minute timer, which on a chart left
// open through a session meant a full refetch per pane roughly a hundred times a day, each
// one several hundred KB, to be handed back what the pane already had. Erring one way is
// deliberate: a Saturday 17:00 is not a candle boundary and expiring there costs one
// revalidation, while missing a Friday 17:00 would draw last week's levels.
export function levelsStaleAt(fetchedAt: number): number {
  return nextSessionAnchor(fetchedAt)
}

export const levelsLayer: ChartLayer<Level, LevelsConfig> = {
  id: 'levels',
  label: 'Levels',
  defaults: DEFAULT_LEVELS_CONFIG,
  fields: LEVELS_FIELDS,

  available(symbol, vendor) {
    return Boolean(levelsCoverageFor(vendor, symbol.ticker))
  },

  // Deliberately window-free: the price band and date range a pane has fetched are the
  // controller's business (it extends them rather than replacing them), so only the levers
  // that change WHICH levels exist belong here.
  cacheKey(ctx, config) {
    const requested = requestedIntervals(config)
    const intervalsKey = requested ? requested.slice().sort().join(',') : 'all'
    return [ctx.vendor, ctx.symbol.ticker, intervalsKey, config.showSpent].join('|')
  },

  // A level is one entry of the server's per-interval price-keyed map (ohlcv.py's
  // `levels_by_price.irange`), so interval + price identifies it within a computation;
  // bornAt distinguishes the same price recomputed onto a different candle.
  datumKey(level) {
    return `${level.interval}|${level.price}|${level.bornAt}`
  },

  staleAt: levelsStaleAt,

  fetch(ctx, config, window) {
    return fetchLevels({
      vendor: ctx.vendor,
      symbol: ctx.symbol.ticker,
      priceMin: window.priceMin,
      priceMax: window.priceMax,
      dateFrom: window.from,
      dateTo: window.to,
      intervals: requestedIntervals(config),
      includeInvalidated: config.showSpent
    })
  },

  toOverlays(data, ctx, config) {
    const window = drawWindow(ctx)
    const overlays: OverlayCreate[] = []
    for (const level of data) {
      if (!(config.intervals[level.interval] ?? true)) continue
      // A pane holds every level it has fetched, which reaches past the current view — the
      // whole point of keeping the window, since re-entering ground already covered then
      // costs no request. Which of them this view actually contains is decided here instead.
      if (level.price < ctx.priceMin || level.price > ctx.priceMax) continue
      const appearance = applyEncodings(baseAppearance(level, config), metricsFor(level, ctx), [
        config.emphasis.invalidations,
        config.emphasis.age
      ])
      for (const span of spansFor(level)) {
        if (!spanInWindow(span, window)) continue
        overlays.push(spanToOverlay(level, span, darkenedBy(appearance, config, span.touches), window))
      }
    }
    return overlays
  }
}
