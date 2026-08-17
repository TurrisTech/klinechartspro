import type { OverlayCreate } from 'klinecharts'
import { levelsCoverageFor, hasFeature } from '../capabilities'
import type { ChartLayer, LayerContext } from '../chartlayers/types'
import { applyEncodings, toLineStyle, type LineAppearance } from '../chartlayers/encoding'
import { fetchLevels, type Level } from './api'
import {
  DEFAULT_LEVELS_CONFIG,
  LEVELS_FIELDS,
  LEVELS_METRIC_NAMES,
  type LevelsConfig,
  type LevelsMetricName
} from './config'

const ONE_DAY_MS = 86_400_000

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

function levelToOverlay(level: Level, ctx: LayerContext, config: LevelsConfig): OverlayCreate {
  const appearance = applyEncodings(baseAppearance(level, config), metricsFor(level, ctx), [
    config.emphasis.invalidations,
    config.emphasis.age
  ])
  return {
    name: 'horizontalStraightLine',
    paneId: 'candle_pane',
    // These are server-computed reference lines, not user drawings: dragging one would
    // imply it means something, and it would silently diverge from what the server says.
    lock: true,
    points: [{ value: level.price }],
    // Stashes the source datum on the overlay so future code (a click handler, a tooltip)
    // can read it back without re-deriving it from the price/groupId alone.
    extendData: level,
    styles: { line: toLineStyle(appearance) }
  }
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

export const levelsLayer: ChartLayer<Level, LevelsConfig> = {
  id: 'levels',
  label: 'Levels',
  defaults: DEFAULT_LEVELS_CONFIG,
  fields: LEVELS_FIELDS,

  available(symbol, vendor) {
    return Boolean(levelsCoverageFor(vendor, symbol.ticker))
  },

  queryKey(ctx, config) {
    const requested = requestedIntervals(config)
    const intervalsKey = requested ? requested.slice().sort().join(',') : 'all'
    return [
      ctx.vendor,
      ctx.symbol.ticker,
      ctx.priceMin.toFixed(5),
      ctx.priceMax.toFixed(5),
      ctx.from,
      ctx.to,
      intervalsKey,
      config.showSpent
    ].join('|')
  },

  fetch(ctx, config) {
    return fetchLevels({
      vendor: ctx.vendor,
      symbol: ctx.symbol.ticker,
      priceMin: ctx.priceMin,
      priceMax: ctx.priceMax,
      dateFrom: ctx.from,
      dateTo: ctx.to,
      intervals: requestedIntervals(config),
      includeInvalidated: config.showSpent
    })
  },

  toOverlays(data, ctx, config) {
    return data
      .filter((level) => config.intervals[level.interval] ?? true)
      .map((level) => levelToOverlay(level, ctx, config))
  }
}
