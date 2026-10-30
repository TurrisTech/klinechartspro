import type { SymbolInfo } from '../../../src'
import type { Condition } from '../../alerts/conditions'
import { PRICE_FIELD, PRICE_SOURCE, type Watch } from '../../watch/types'
import type { AlertTarget } from '../types'

// PURE. What a PRICE ALERT on a chart layer's line is -- a level, or any other price a layer
// offers (types.ts `LayerAlerts`): a price watch of one shape, which holds when the price
// ENTERS the line's alert zone -- the price plus or minus its buffer -- from either side.
//
//   { any: [ { field: 'price', op: 'crosses_above', value: price - buffer },
//            { field: 'price', op: 'crosses_below', value: price + buffer } ] }
//
// Rising through the zone's floor or falling through its ceiling is arriving. Leaving is
// neither (rising through the ceiling, falling through the floor), so a price that wanders
// about inside the zone raises nothing more until it has left and come back -- which is what
// the buffer is for. A zero buffer puts both edges on the price, which is `crosses`, but it is
// still spelled as the pair: the watch keeps one shape whatever its buffer, and the chart's
// price-watch lines (client/watch/overlays.ts, a single `price` leaf only) never draw it a
// second time over the layer's own.
//
// It is a watch like any other, so it is evaluated where every watch is: in the server on a
// live wall, which is what lets it fire with the tab closed, and against the walked bars on a
// replay wall (client/replay/watches.ts). The crossing baseline is the server's to seed when
// the watch is armed, so nothing here decides which side of the zone the market is on.
//
// The shape is the identity. Nothing is stored to say which line a watch belongs to: the
// zone's middle IS the line's price, so a line is enabled while a watch of this shape on its
// instrument is centred on it -- to half a tick, since the middle is recomputed from two rounded
// edges. Two lines at one price (a 1W and a 1M level) share one alert, which is what an alert on
// a price means -- and an alert outlives the line it was set on, so a bell is drawn for every
// alert in view whether or not its line still is (view.ts).

/** The middle and the two edges of an alert zone. */
export interface Zone {
  low: number
  high: number
  /** The line's price. */
  center: number
  /** The buffer, in price: `high - center`. */
  half: number
}

/** What a buffer is counted in on one instrument: its pip where it is priced in pips (forex
 * and metals, `SymbolInfo.pipSize`), otherwise its smallest displayed increment. */
export interface ZoneUnit {
  size: number
  label: 'pips' | 'ticks'
}

export function zoneUnit(symbol: Pick<SymbolInfo, 'pipSize' | 'pricePrecision'>): ZoneUnit {
  if (typeof symbol.pipSize === 'number' && symbol.pipSize > 0) return { size: symbol.pipSize, label: 'pips' }
  return { size: 10 ** -(symbol.pricePrecision ?? 5), label: 'ticks' }
}

// Two digits past the instrument's own: an edge then carries a quarter pip on a five-digit pair
// exactly, and `0.0001 * 3` reaches the wire as 0.0003 rather than 0.00030000000000000003.
function rounded(value: number, precision: number): number {
  return Number(value.toFixed(Math.min(12, Math.max(0, precision + 2))))
}

/** The zone a buffer of `pips` makes around `price`, its edges rounded for the wire. */
export function zoneAround(price: number, pips: number, unit: ZoneUnit, precision: number): Zone {
  const half = Math.max(0, pips) * unit.size
  const low = rounded(price - half, precision)
  const high = rounded(price + half, precision)
  return { low, high, center: price, half: (high - low) / 2 }
}

/** The condition that holds when price enters `zone`. */
export function zoneCondition(zone: Pick<Zone, 'low' | 'high'>): Condition {
  return {
    any: [
      { field: PRICE_FIELD, op: 'crosses_above', value: zone.low },
      { field: PRICE_FIELD, op: 'crosses_below', value: zone.high }
    ]
  }
}

interface Leaf {
  field?: unknown
  op?: unknown
  value?: unknown
}

function edge(term: Leaf | undefined, op: string): number | null {
  if (!term || term.field !== PRICE_FIELD || term.op !== op) return null
  return typeof term.value === 'number' && Number.isFinite(term.value) ? term.value : null
}

/** The zone a watch is the alert of, or null when it is not a price alert of this shape. */
export function zoneOf(watch: Watch): Zone | null {
  if (watch.source !== PRICE_SOURCE) return null
  const terms = (watch.condition as { any?: unknown }).any
  if (!Array.isArray(terms) || terms.length !== 2) return null
  const low = edge(terms[0] as Leaf, 'crosses_above')
  const high = edge(terms[1] as Leaf, 'crosses_below')
  if (low === null || high === null || low > high) return null
  // Ten places is far below any instrument's tick and above the noise of halving a sum, so the
  // middle of 1.0895 and 1.0905 is the 1.09 a bell is drawn at, not 1.0899999999999999.
  return { low, high, center: Number(((low + high) / 2).toFixed(10)), half: (high - low) / 2 }
}

/** Whether `zone` is the alert of the line at `price`: its middle within half a tick. */
export function centredOn(zone: Zone, price: number, precision: number): boolean {
  return Math.abs(zone.center - price) <= 10 ** -precision / 2
}

/** The buffer in the instrument's unit, to a hundredth: what the editor and the hover show. */
export function zonePips(zone: Pick<Zone, 'half'>, unit: ZoneUnit): number {
  return Math.round((zone.half / unit.size) * 100) / 100
}

/** `±5 pips · 1.08450–1.08550`, or `at the price` for a zone of no width. */
export function describeZone(zone: Zone, unit: ZoneUnit, precision: number): string {
  const pips = zonePips(zone, unit)
  if (pips <= 0) return 'at the price'
  return `±${pips} ${unit.label} · ${zone.low.toFixed(precision)}–${zone.high.toFixed(precision)}`
}

/** The alert's name, which is the notification's title: the line it was set on. */
export function alertName(ticker: string, target: AlertTarget, precision: number): string {
  return `${ticker} ${target.label} ${target.price.toFixed(precision)}`
}

/** The alert's note, which the notification's body ends with. */
export function alertNote(zone: Zone, unit: ZoneUnit, precision: number): string {
  return `alert zone ${describeZone(zone, unit, precision)}`
}
