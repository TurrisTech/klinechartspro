// The watch wire, as the server states it (`wdashboard-server/docs/watch.md`), plus the two
// helpers that turn one shape of watch -- a level on an instrument's price -- into something
// a chart can draw and a right-click can create.
//
// Nothing here defines WHEN a watch fires. That rule lives on the server now
// (`wdashboard_server/watch/conditions.py`), which is the point of moving the feature: the
// browser is a view onto watches, not the thing evaluating them, so a client-side copy of
// the crossing rule would be a second definition that could disagree.

export type WatchStatus = 'armed' | 'fired' | 'disabled'
export type WatchTrigger = 'edge' | 'level'
export type WatchRepeat = 'once' | 'always'

/** A leaf of the server's condition language, or a combinator over leaves. Opaque to most of
 * this module: only `priceLevel`/`priceCondition` below look inside one. */
export type Condition =
  | { field: string; op: string; value?: number | string | number[] }
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition }

export interface Watch {
  id: string
  /** Which source produces the events: `price`, `bar`, or a third-party one. */
  source: string
  /** What it watches, in that source's spelling: `oanda:EURUSD`, `oanda:EURUSD@1h`. */
  target: string
  condition: Condition
  name: string
  note: string
  enabled: boolean
  trigger: WatchTrigger
  repeat: WatchRepeat
  cooldownMs: number
  createdAt: number
  updatedAt: number
  armedAt: number
  status: WatchStatus
  lastFiredAt: number | null
  fireCount: number
}

export interface WatchDraft {
  source: string
  target: string
  condition: Condition
  name?: string
  note?: string
  trigger?: WatchTrigger
  repeat?: WatchRepeat
  cooldownMs?: number
  enabled?: boolean
}

/** One observable of a source, from `GET /watch/sources`. The client renders forms from
 * this rather than from a copy of the server's list. */
export interface SourceField {
  name: string
  label: string
  kind: 'number' | 'text'
  unit: string | null
  description: string
  choices: string[]
}

export interface WatchSource {
  id: string
  title: string
  description: string
  targetHint: string
  available: boolean
  fields: SourceField[]
}

// --- price watches ---------------------------------------------------------------------
//
// The chart draws a line for one particular shape of watch: the `price` source, a single
// leaf, on the `price` field, with a crossing or a comparison. Everything else a user can
// build through the API -- a bar's close, a combinator, a third-party source -- is a
// perfectly good watch that simply has no line, and the overlay layer skips it rather than
// guessing at a price to draw it at.

export const PRICE_SOURCE = 'price'
export const PRICE_FIELD = 'price'

/** Which way a level is watched. `crosses` is the default and the honest one for "tell me
 * when it gets there": the server seeds the baseline at arm time, so the side is decided by
 * where the market is, not by which button was pressed. */
export type PriceDirection = 'crosses' | 'crosses_above' | 'crosses_below'

export const PRICE_DIRECTIONS: Array<{ value: PriceDirection; label: string }> = [
  { value: 'crosses', label: 'Reaches (either way)' },
  { value: 'crosses_above', label: 'Rises through' },
  { value: 'crosses_below', label: 'Falls through' }
]

export function priceCondition(level: number, direction: PriceDirection = 'crosses'): Condition {
  return { field: PRICE_FIELD, op: direction, value: level }
}

/** The level a watch draws at, or null when it is not a plain price level. */
export function priceLevel(watch: Watch): number | null {
  if (watch.source !== PRICE_SOURCE) return null
  const leaf = watch.condition as { field?: string; op?: string; value?: unknown }
  if (leaf.field !== PRICE_FIELD || typeof leaf.value !== 'number') return null
  return Number.isFinite(leaf.value) ? leaf.value : null
}

export function priceDirection(watch: Watch): PriceDirection {
  const leaf = watch.condition as { op?: string }
  return leaf.op === 'crosses_above' || leaf.op === 'crosses_below' ? leaf.op : 'crosses'
}

/** `vendor:TICKER` — a `price` watch's target, and the key the chart groups by. */
export function instrumentTarget(vendor: string, symbol: string): string {
  return `${vendor}:${symbol}`
}
