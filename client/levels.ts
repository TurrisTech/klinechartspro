import type { Chart, OverlayCreate } from 'klinecharts'
import type { SymbolInfo } from '../src'
import { levelsCoverageFor } from './capabilities'
import { apiGet } from './config'
import { symbolVendor } from './symbols'

// `GET /levels` — precomputed support/resistance price levels. Mirrors the `Level` model in
// schemas.py.
export interface Level {
  interval: string
  price: number
  direction: 'support' | 'resistance'
  bornAt: number
  effectiveAt: number
  invalidations: number[]
  active: boolean
  // '#rrggbb' advisory hint keyed off the interval the level was computed on, so levels
  // from the same timeframe read as a set.
  color: string
}

// Every overlay this module creates carries this groupId, which is what lets a redraw
// remove exactly its own lines and nothing the user has drawn.
const LEVELS_GROUP_ID = 'wdashboard-levels'

// The server computes levels over the full price history, so an unbounded query returns
// bands nowhere near the current price. Ask for a window around the visible range instead.
const PRICE_WINDOW_FRACTION = 0.06

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

export async function fetchLevels(
  vendor: string,
  symbol: string,
  priceMin: number,
  priceMax: number,
  dateFrom: number,
  dateTo: number
): Promise<Level[]> {
  const levels = await apiGet<Level[]>('/levels', {
    vendor,
    symbol,
    price_min: priceMin,
    price_max: priceMax,
    // Required by the schema even though the server currently ignores their values.
    date_from: isoDate(dateFrom),
    date_to: isoDate(dateTo)
  })
  return Array.isArray(levels) ? levels : []
}

function overlayFor(level: Level): OverlayCreate {
  return {
    name: 'horizontalStraightLine',
    groupId: LEVELS_GROUP_ID,
    paneId: 'candle_pane',
    // These are server-computed reference lines, not user drawings: dragging one would
    // imply it means something, and it would silently diverge from what the server says.
    lock: true,
    points: [{ value: level.price }],
    styles: {
      line: {
        color: level.color,
        // A spent level still marks a price that mattered, so it stays on the chart — but
        // dashed, so it cannot be mistaken for one that is still in play.
        style: level.active ? 'solid' : 'dashed',
        size: 1
      }
    }
  }
}

// Replaces whatever this module drew last. Levels are only fetched for instruments
// /capabilities reports coverage for — asking for anything else is a guaranteed 400.
export async function drawLevels(chart: Chart, symbol: SymbolInfo): Promise<number> {
  chart.removeOverlay({ groupId: LEVELS_GROUP_ID })

  const vendor = symbolVendor(symbol)
  if (!levelsCoverageFor(vendor, symbol.ticker)) return 0

  // Scope the query to what is actually on screen, not to every bar paginated in so far:
  // the price window is the whole filter the server applies, and a window spanning years of
  // loaded history returns bands far from anything the user is looking at.
  const data = chart.getDataList()
  const range = chart.getVisibleRange()
  const visible = data.slice(Math.max(0, range.realFrom), Math.max(0, range.realTo) + 1)
  if (visible.length === 0) return 0

  let low = Number.POSITIVE_INFINITY
  let high = Number.NEGATIVE_INFINITY
  for (const bar of visible) {
    if (bar.low < low) low = bar.low
    if (bar.high > high) high = bar.high
  }
  if (!Number.isFinite(low) || !Number.isFinite(high)) return 0

  const pad = Math.max((high - low) * PRICE_WINDOW_FRACTION, high * 1e-4)
  const levels = await fetchLevels(
    vendor,
    symbol.ticker,
    low - pad,
    high + pad,
    visible[0].timestamp,
    visible[visible.length - 1].timestamp
  )
  if (levels.length === 0) return 0

  chart.createOverlay(levels.map(overlayFor))
  return levels.length
}

export function clearLevels(chart: Chart): void {
  chart.removeOverlay({ groupId: LEVELS_GROUP_ID })
}
