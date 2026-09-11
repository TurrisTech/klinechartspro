import { apiGet } from '../config'

// The timeseries indicator registry, as wdashboard-server serves it
// (`GET /indicators/registry`, services/tsregistry.py; the schema and the rows are
// wtradingindicators' migration 0006 and indicators/apps/tsregistry.py).
//
// This is the ONLY list of server indicators the client has. Before it, the app knew the
// AREV generations, krev01 and the registry series by name, in three parallel modules of
// ~300 lines each that differed mostly in their colours and their threshold constants --
// and every one of those constants was a second copy of a number the server also held. A
// row here says where an indicator's series are, what each one means and how to draw it, so
// the chart lists and draws an indicator it has never heard of.
//
// An entry names the wire its points come from (`wire.plugin` / `wire.variant`), which is
// how the AREV and krev generations keep being served by the readers that own their
// published signal refs while anything new is served by the generic one. The client does
// not care which; it asks the wire the registry gave it.

/** Where an indicator's rows live. The client uses `kind` only to tell a COMPUTED entry --
 * which takes params, resolves to a node document and streams -- from a stored one, and
 * `foldBy` to know that several rows share a bar. */
export interface RegistrySource {
  kind: 'computed' | 'table' | 'indicator_values' | 'parquet'
  schema?: string
  table?: string
  timestampColumn?: string
  /** The point field distinguishing several rows on one bar (krev01's `side`). A series key
   * is then two-part: `top.p` is the field `p` of the row whose fold field reads `top`. */
  fold_by?: string | null
  app?: string
}

export interface RegistryWire {
  plugin: string
  variant?: string | null
}

/** A predicate over a POINT -- never SQL. One object's comparisons must all hold; a list of
 * them must all hold. A missing or null field fails every comparison, so "no vote on this
 * bar" is never drawn as a vote of zero. */
export type Predicate = PredicateTerm | PredicateTerm[]
export interface PredicateTerm {
  field: string
  eq?: unknown
  ne?: unknown
  gt?: number
  gte?: number
  lt?: number
  lte?: number
}

export type MarkShape =
  | 'arrow-up'
  | 'arrow-down'
  | 'triangle-up'
  | 'triangle-down'
  | 'circle'
  | 'square'
  | 'diamond'
  | 'cross'

/** One per-bar mark. The first whose `when` holds is drawn, so the order is the rule. */
export interface MarkSpec {
  /** Present when this mark is also a PUBLISHED signal; absent means presentation only. */
  id?: string
  label?: string
  when?: Predicate
  shape: MarkShape
  color?: string
  /** Multiplier on the bar-spacing-derived size. */
  size?: number
  /** `series:<key>` draws at another series' value on the bar; `bar:low|high|close` against
   * the candle. */
  anchor?: string
  /** A point field whose value is written beside the mark. */
  labelField?: string
  fill?: { field: string; map: Record<string, 'solid' | 'hollow' | 'pending'>; default?: 'solid' | 'hollow' | 'pending' }
}

export interface RegistrySeries {
  /** The field on the wire, and the accessor: dotted for a folded source. */
  key: string
  label: string
  description: string
  role: 'value' | 'reference' | 'signal' | 'meta'
  render: 'line' | 'hold' | 'histogram' | 'marker' | 'none'
  pane: 'main' | 'sub' | null
  color: string | null
  lineStyle: 'solid' | 'dashed'
  lineWidth: number
  /** role='reference': the flat line's value. */
  constant: number | null
  marks: MarkSpec[] | null
  /** Drop the value on bars where this does not hold. */
  gate: Predicate | null
  visible: boolean
}

export interface RegistryParam {
  name: string
  type: 'int' | 'float'
  default: number
  min: number | null
  max: number | null
  description: string
}

export interface RegistryIndicator {
  name: string
  /** The klinecharts template name. Part of a saved wall document, so it is stated by the
   * registry rather than derived here -- changing one silently empties a saved pane. */
  template: string
  title: string
  description: string
  tags: string[]
  pane: 'main' | 'sub'
  source: RegistrySource
  wire: RegistryWire
  feature: string | null
  params: RegistryParam[]
  inputs: Array<Record<string, unknown>>
  inputLabels: string[]
  dependsOn: string[]
  valueRange: [number, number] | null
  axisGap: { top: number; bottom: number } | null
  precision: number | null
  displayOrder: number
  enabled: boolean
  series: RegistrySeries[]
}

export interface RegistryResponse {
  indicators: RegistryIndicator[]
  serverTime: number
}

let cached: Promise<RegistryIndicator[]> | null = null

/** The registry, fetched once per page. A server without the route (or without an algo
 * database) answers nothing, and the picker then offers no server indicators -- which is
 * the honest degrade, and the reason this resolves to an empty list rather than throwing. */
export function loadRegistry(): Promise<RegistryIndicator[]> {
  if (!cached) {
    cached = apiGet<RegistryResponse>('/indicators/registry')
      .then((body) => body.indicators ?? [])
      .catch(() => {
        cached = null
        return []
      })
  }
  return cached
}

/** `point.top.p` for `"top.p"`. */
export function readField(point: unknown, key: string): unknown {
  if (point == null || typeof point !== 'object') return undefined
  const dot = key.indexOf('.')
  if (dot < 0) return (point as Record<string, unknown>)[key]
  const head = (point as Record<string, unknown>)[key.slice(0, dot)]
  if (head == null || typeof head !== 'object') return undefined
  return (head as Record<string, unknown>)[key.slice(dot + 1)]
}

function term(t: PredicateTerm, point: unknown): boolean {
  const value = readField(point, t.field)
  if (value == null) return false
  if ('eq' in t && value !== t.eq) return false
  if ('ne' in t && value === t.ne) return false
  if (typeof t.gt === 'number' && !(typeof value === 'number' && value > t.gt)) return false
  if (typeof t.gte === 'number' && !(typeof value === 'number' && value >= t.gte)) return false
  if (typeof t.lt === 'number' && !(typeof value === 'number' && value < t.lt)) return false
  if (typeof t.lte === 'number' && !(typeof value === 'number' && value <= t.lte)) return false
  return true
}

/** Whether `point` satisfies `predicate`. Mirrors the server's `evaluate_predicate` exactly
 * -- both sides read the same rows and must agree about which bars carry a mark. */
export function matches(predicate: Predicate | null | undefined, point: unknown): boolean {
  if (predicate == null) return true
  return Array.isArray(predicate) ? predicate.every((t) => term(t, point)) : term(predicate, point)
}
