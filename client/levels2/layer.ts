import type { OverlayCreate } from 'klinecharts'
import { hasFeature, levels2CoverageFor } from '../capabilities'
import { withAlpha } from '../chartlayers/color'
import { applyEncodings, type LineAppearance } from '../chartlayers/encoding'
import type { ChartLayer, LayerContext } from '../chartlayers/types'
import { fetchZones, type Zone } from './api'
import {
  DEFAULT_LEVELS2_CONFIG,
  LEVELS2_FIELDS,
  LEVELS2_METRIC_NAMES,
  type Levels2Config,
  type Levels2MetricName
} from './config'

// A sibling of client/levels/layer.ts, not a fork of it: the same ChartLayer contract and the
// same controller, but the datum is a price BAND with a lifespan rather than a line with
// breaks, so it is drawn as one filled rectangle per zone -- from the instant it came into
// force to the instant it retired, or to the right edge while it is live -- instead of as a
// chain of stretches darkened per invalidation.

const ONE_DAY_MS = 86_400_000

// See client/levels/layer.ts on why this is much larger than the controller's fetch margin
// and why every coordinate is clamped into it: a rectangle with one corner a million bars
// off the pane is still filled pixel by pixel.
const DRAW_MARGIN_SPANS = 4

const METRICS: Record<Levels2MetricName, (zone: Zone, ctx: LayerContext) => number> = {
  score: (zone) => zone.score,
  touches: (zone) => zone.touches.length,
  breaks: (zone) => zone.breaks.length,
  ageDays: (zone, ctx) => (ctx.to - zone.effectiveAt) / ONE_DAY_MS,
  untouchedDays: (zone, ctx) => (ctx.to - (zone.touches.at(-1) ?? zone.effectiveAt)) / ONE_DAY_MS,
  members: (zone) => zone.members
}

function metricsFor(zone: Zone, ctx: LayerContext): Record<string, number> {
  const out: Record<string, number> = {}
  for (const name of LEVELS2_METRIC_NAMES) out[name] = METRICS[name](zone, ctx)
  return out
}

function colorFor(zone: Zone, config: Levels2Config): string {
  switch (config.base.colorMode) {
    case 'role':
      return config.base.roleColors[zone.role]
    case 'direction':
      return config.base.roleColors[zone.direction]
    case 'interval':
      return config.base.intervalColors[zone.interval] ?? zone.color
    default:
      return zone.color
  }
}

// The encodings are line-shaped (width, opacity) because that is what chartlayers/encoding
// exposes; here `width` is the border width and `opacity` a multiplier on the configured
// fill opacity, so one Encoding vocabulary serves both layers.
function baseAppearance(zone: Zone, config: Levels2Config): LineAppearance {
  return {
    color: colorFor(zone, config),
    pattern: 'solid',
    width: config.base.borderWidth,
    opacity: 1
  }
}

function drawWindow(ctx: LayerContext): { from: number; to: number } {
  const margin = (ctx.to - ctx.from) * DRAW_MARGIN_SPANS
  return { from: ctx.from - margin, to: ctx.to + margin }
}

function lifespanInWindow(zone: Zone, window: { from: number; to: number }): boolean {
  if (zone.effectiveAt > window.to) return false
  return zone.retiredAt === null || zone.retiredAt >= window.from
}

// One rectangle per zone: the library's own 'rect' overlay (src/extension/rect.ts), two
// diagonal corners, a 'polygon' figure styled stroke_fill. A live zone runs to the window's
// far edge (well off the pane, so its end is never seen); a retired one stops where it
// retired.
function zoneToOverlay(
  zone: Zone,
  appearance: LineAppearance,
  config: Levels2Config,
  window: { from: number; to: number }
): OverlayCreate {
  const retired = !zone.active
  const scale = retired ? config.retired.opacityScale : 1
  const fill = Math.min(1, config.base.fillOpacity * appearance.opacity * scale)
  const border = Math.min(1, config.base.borderOpacity * scale)
  const from = Math.max(zone.effectiveAt, window.from)
  const to = zone.retiredAt === null ? window.to : Math.min(zone.retiredAt, window.to)
  return {
    name: 'rect',
    paneId: 'candle_pane',
    // Server-computed reference bands, not user drawings.
    lock: true,
    extendData: zone,
    points: [
      { timestamp: from, value: zone.high },
      { timestamp: to, value: zone.low }
    ],
    styles: {
      polygon: {
        style: 'stroke_fill',
        color: withAlpha(appearance.color, fill),
        borderColor: withAlpha(appearance.color, border),
        borderSize: appearance.width,
        borderStyle: retired ? 'dashed' : 'solid',
        borderDashedValue: retired ? [4, 4] : []
      }
    }
  }
}

function requestedIntervals(config: Levels2Config): string[] {
  return Object.entries(config.intervals)
    .filter(([, visible]) => visible)
    .map(([code]) => code)
}

export const levels2Layer: ChartLayer<Zone, Levels2Config> = {
  id: 'levels2',
  label: 'Zones',
  defaults: DEFAULT_LEVELS2_CONFIG,
  fields: LEVELS2_FIELDS,

  available(symbol, vendor) {
    return hasFeature('levels2') && Boolean(levels2CoverageFor(vendor, symbol.ticker))
  },

  cacheKey(ctx, config) {
    return [ctx.vendor, ctx.symbol.ticker, requestedIntervals(config).slice().sort().join(','), config.showRetired].join(
      '|'
    )
  },

  // interval + founding bar + centre identifies a zone within a book (levels2.py: a zone's
  // key is (timestamp_bar, center)).
  datumKey(zone) {
    return `${zone.interval}|${zone.bornAt}|${zone.center}`
  },

  fetch(ctx, config, window) {
    const intervals = requestedIntervals(config)
    if (intervals.length === 0) return Promise.resolve([])
    return fetchZones({
      vendor: ctx.vendor,
      symbol: ctx.symbol.ticker,
      priceMin: window.priceMin,
      priceMax: window.priceMax,
      dateFrom: window.from,
      dateTo: window.to,
      intervals,
      includeRetired: config.showRetired
    })
  },

  toOverlays(data, ctx, config) {
    const window = drawWindow(ctx)
    const overlays: OverlayCreate[] = []
    for (const zone of data) {
      if (!(config.intervals[zone.interval] ?? true)) continue
      if (!zone.active && !config.showRetired) continue
      // Band intersects the visible price band; a pane holds more than it shows.
      if (zone.high < ctx.priceMin || zone.low > ctx.priceMax) continue
      if (!lifespanInWindow(zone, window)) continue
      const appearance = applyEncodings(baseAppearance(zone, config), metricsFor(zone, ctx), [
        config.emphasis.score,
        config.emphasis.touches
      ])
      overlays.push(zoneToOverlay(zone, appearance, config, window))
    }
    return overlays
  }
}
