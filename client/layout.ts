import type {
  PaneOptions,
  PaneSnapshot,
  PaneViewState,
  PaneYAxisRange,
  Period,
  SymbolInfo
} from '../src'
import { availablePeriods, defaultPeriod } from './periods'
import { fromStoredMtfConfig, toStoredMtfConfig, type MtfConfig, type StoredMtfConfig } from './mtf/config'
import { DEFAULT_SYMBOL_TICKER, fetchSymbolInfo, symbolVendor } from './symbols'

// The SHAPE of one wall document -- per pane its symbol/period/indicators, those indicators'
// parameters and where the pane was looking, plus the active pane, the two sync toggles and
// which layout preset was in use. Where a document is stored, and how many of them a user
// keeps, is client/workspaces/store.ts's problem, not this file's: a layout used to be a
// single `layout` preference key and is now the `layout` field of a workspace, and nothing
// here had to change for that.
//
// A realistic 12-pane layout is on the order of 2 KiB, so field names are kept short but not
// cryptic -- a user's whole workspace set shares one 64 KiB /preferences document.
//
// `version` is deliberately NOT bumped by the addition of per-pane parameters and view state:
// both are optional and both are validated on the way out, so a document written by either
// client reads correctly in the other -- an older one simply ignores the two new fields, and
// a newer one treats their absence as "never saved", which mounts the pane exactly where it
// used to mount. A bump would buy nothing and would strand every existing workspace.
const LAYOUT_VERSION = 1

interface PersistedPane {
  s: string // symbol ticker, e.g. 'EURUSD'
  v?: string // vendor; omitted when 'oanda' (client/symbols.ts symbolVendor's own default)
  p: string // Period.text -- which IS the server's resolution code ('1h', '1D')
  mi?: string[] // main indicator names, omitted when empty
  si?: string[] // sub indicator names, omitted when empty
  ip?: Record<string, number[]> // indicator template name -> calcParams, omitted when empty
  vw?: PersistedView // where this pane was looking, omitted for a pane never read back
  // The AREV21 multi-timeframe overlay's settings for THIS pane -- which timeframes it
  // draws and each one's colour and sizes. Its own field rather than a slot in `ip`
  // because those are klinecharts calcParams (a flat numeric array); this is a record per
  // timeframe, which is the whole reason that overlay owns a settings panel of its own.
  // Omitted for a pane that has never been configured, which reads as the defaults.
  mtf?: StoredMtfConfig
}

// One pane's view -- the library's PaneViewState, minus what is not worth storing. Kept
// deliberately small because the whole workspace SET shares one 64 KiB document and a wall of
// 12 panes is one of twelve walls: a following-the-market pane is 30 bytes here, and only a
// pane parked in history or carrying a hand-scaled price axis pays for more.
interface PersistedView {
  bs: number // bar space, px per bar -- the time axis's zoom
  live: boolean // was the newest bar on screen
  at?: number // anchor timestamp; written only when !live, which is the only time it is read
  f?: number // the on-screen fraction `at` was under
  y?: {
    t?: string // y axis type: 'normal' | 'percentage' | 'logarithm'
    r?: boolean // reversed
    // The candle pane's hand-scaled price range, only when the user actually scaled it. Same
    // field names as the library's PaneYAxisRange, so this is a copy and not a mapping.
    range?: PaneYAxisRange
  }
}

export interface PersistedLayout {
  version: number
  preset: string
  active: number // index into panes
  panes: PersistedPane[]
  // `auto` is optional on the way IN and always written on the way out -- a document written
  // before auto sync existed must still validate (see isPersistedLayout), and the honest
  // answer for one is "auto sync was not on", which is also its default.
  sync: { crosshair: boolean; time: boolean; auto?: boolean }
}

export interface HydratedPane {
  symbol: SymbolInfo
  period: Period
  mainIndicators: string[]
  subIndicators: string[]
  indicatorParams: Record<string, number[]>
  /** Undefined for a pane never configured; the overlay seeds those itself. */
  mtfConfig?: MtfConfig
  view: PaneViewState | null
}

export interface HydratedLayout {
  preset: string
  active: number
  panes: HydratedPane[]
  sync: { crosshair: boolean; time: boolean; auto: boolean }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function isPersistedPane(value: unknown): value is PersistedPane {
  if (!value || typeof value !== 'object') return false
  const pane = value as Record<string, unknown>
  if (typeof pane.s !== 'string' || typeof pane.p !== 'string') return false
  if (pane.v !== undefined && typeof pane.v !== 'string') return false
  if (pane.mi !== undefined && !isStringArray(pane.mi)) return false
  if (pane.si !== undefined && !isStringArray(pane.si)) return false
  // `ip` and `vw` are checked on the way OUT instead (see hydrateView / hydrateIndicatorParams):
  // a malformed view is worth losing on its own, whereas failing the whole pane here would
  // cost the user their symbol, timeframe and indicators over a bad number.
  return true
}

// Tolerant: an older or newer client's document (extra keys, a bumped `version`) degrades to
// "not a layout" instead of throwing, so a schema change can't leave a client stuck unable to
// boot until the field is cleared. A workspace whose layout fails this is dropped from the
// set rather than mounted half-formed.
export function isPersistedLayout(value: unknown): value is PersistedLayout {
  if (!value || typeof value !== 'object') return false
  const layout = value as Record<string, unknown>
  return (
    typeof layout.version === 'number' &&
    typeof layout.preset === 'string' &&
    typeof layout.active === 'number' &&
    Array.isArray(layout.panes) &&
    layout.panes.length > 0 &&
    layout.panes.every(isPersistedPane) &&
    typeof layout.sync === 'object' && layout.sync !== null &&
    typeof (layout.sync as Record<string, unknown>).crosshair === 'boolean' &&
    typeof (layout.sync as Record<string, unknown>).time === 'boolean' &&
    ['boolean', 'undefined'].includes(typeof (layout.sync as Record<string, unknown>).auto)
  )
}

// The wall a brand-new workspace opens on: one pane, the default instrument and timeframe,
// both sync toggles on. Deliberately the same thing the client mounted before any layout was
// ever persisted, so "New workspace" and "first ever visit" land on the same chart.
export function defaultLayout(ticker: string = DEFAULT_SYMBOL_TICKER): PersistedLayout {
  return {
    version: LAYOUT_VERSION,
    preset: '1',
    active: 0,
    panes: [{ s: ticker, p: defaultPeriod(availablePeriods()).text, mi: ['MA'], si: ['VOL'] }],
    sync: { crosshair: true, time: true, auto: false }
  }
}

// Templates that were once picked and no longer exist. A layout is persisted per user and
// outlives the code that wrote it, so a name retired here would otherwise be handed to
// klinecharts forever -- warning on every pane mount, and unremovable, since a name the
// picker no longer offers has no checkbox to untick.
//
// 'KREV:krev01' was the price-pane half of the KREV indicator, folded into the sub-pane
// template 'KREV:krev01:p' (see client/krev/templates.ts).
const RETIRED_INDICATORS = new Set(['KREV:krev01'])

// Templates that were replaced rather than retired, and whose saved names are MIGRATED so
// the pane keeps the overlay it had. 'MTF:arev21:<timeframe>' was one price-pane template
// per timeframe, ticked from the picker; they are now a single 'MTF:arev21' whose
// timeframes are a setting (client/mtf/templates.ts), so several saved names can collapse
// onto one and the result has to be deduplicated -- klinecharts keys an indicator by name
// per pane, and handing it the same one three times creates one and warns twice.
//
// What does NOT survive is WHICH timeframes were ticked: the eight names carried that, and
// the one template carries it in the pane's `mtf` field instead, which a layout written
// against the eight has nothing to put in. Such a pane comes back on the defaults.
const MTF_LEGACY_PREFIX = 'MTF:arev21:'
const MTF_TEMPLATE = 'MTF:arev21'

const live = (names: string[]): string[] => {
  const kept: string[] = []
  for (const name of names) {
    if (RETIRED_INDICATORS.has(name)) continue
    const mapped = name.startsWith(MTF_LEGACY_PREFIX) ? MTF_TEMPLATE : name
    if (!kept.includes(mapped)) kept.push(mapped)
  }
  return kept
}

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'number' && Number.isFinite(item))
}

// Indicator parameters for templates the pane still carries. A name the picker retired, or a
// value that is not a finite number, is dropped rather than handed to klinecharts -- calcParams
// go straight into an indicator's own calculation, where a NaN silently produces an empty line.
function hydrateIndicatorParams(pane: PersistedPane): Record<string, number[]> {
  const stored = pane.ip
  if (!stored || typeof stored !== 'object') return {}
  const params: Record<string, number[]> = {}
  for (const [name, value] of Object.entries(stored)) {
    if (RETIRED_INDICATORS.has(name) || !isNumberArray(value)) continue
    params[name] = [...value]
  }
  return params
}

const Y_AXIS_RANGE_KEYS = [
  'from', 'to', 'range', 'realFrom', 'realTo', 'realRange',
  'displayFrom', 'displayTo', 'displayRange'
] as const

function hydrateYAxisRange(value: unknown): PaneYAxisRange | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  // All nine or none: a partial range is not a price window, and klinecharts reads every
  // field of it without checking.
  if (!Y_AXIS_RANGE_KEYS.every((key) => typeof record[key] === 'number' && Number.isFinite(record[key]))) {
    return undefined
  }
  return Object.fromEntries(Y_AXIS_RANGE_KEYS.map((key) => [key, record[key]])) as unknown as PaneYAxisRange
}

// A view that doesn't validate degrades to no view at all, which mounts the pane at the live
// edge -- the same place a pane with no saved view has always mounted.
function hydrateView(pane: PersistedPane): PaneViewState | null {
  const stored = pane.vw
  if (!stored || typeof stored !== 'object') return null
  if (typeof stored.bs !== 'number' || !Number.isFinite(stored.bs) || stored.bs <= 0) return null
  if (typeof stored.live !== 'boolean') return null
  const anchor = typeof stored.at === 'number' && Number.isFinite(stored.at) ? stored.at : undefined
  const fraction = typeof stored.f === 'number' && Number.isFinite(stored.f) ? stored.f : undefined
  const range = hydrateYAxisRange(stored.y?.range)
  return {
    barSpace: stored.bs,
    live: stored.live,
    ...(anchor !== undefined ? { anchor } : {}),
    ...(fraction !== undefined ? { fraction } : {}),
    yAxis: {
      ...(typeof stored.y?.t === 'string' ? { type: stored.y.t } : {}),
      ...(typeof stored.y?.r === 'boolean' ? { reverse: stored.y.r } : {}),
      ...(range ? { range } : {})
    }
  }
}

// Resolves a persisted layout's tickers into full SymbolInfo (pricePrecision and the rest are
// vendor-sourced, never persisted -- see client/symbols.ts's own note on why). Deduplicated by
// `vendor:ticker` and resolved in parallel: a 12-pane layout typically names far fewer
// distinct instruments than panes, and there is no /instrument batch endpoint to fold this
// into one request the way /getbars/batch could.
export async function hydrateLayout(layout: PersistedLayout): Promise<HydratedLayout> {
  const periods = availablePeriods()
  const resolved = new Map<string, Promise<SymbolInfo>>()
  const symbolFor = (pane: PersistedPane): Promise<SymbolInfo> => {
    const vendor = pane.v ?? 'oanda'
    const key = `${vendor}:${pane.s}`
    let promise = resolved.get(key)
    if (!promise) {
      promise = fetchSymbolInfo(pane.s, vendor)
      resolved.set(key, promise)
    }
    return promise
  }

  const symbols = await Promise.all(layout.panes.map(symbolFor))
  const panes: HydratedPane[] = layout.panes.map((pane, index) => {
    const mtfConfig = fromStoredMtfConfig(pane.mtf)
    return {
      symbol: symbols[index],
      period: periods.find((item) => item.text === pane.p) ?? defaultPeriod(periods),
      mainIndicators: live(pane.mi ?? ['MA']),
      subIndicators: live(pane.si ?? ['VOL']),
      indicatorParams: hydrateIndicatorParams(pane),
      // Merged onto the defaults and validated field by field: this is a stored document, so
      // a malformed one must read as "never configured" rather than reach the drawing code
      // as a half-object.
      ...(mtfConfig ? { mtfConfig } : {}),
      view: hydrateView(pane)
    }
  })

  return {
    preset: layout.preset,
    active: Math.min(Math.max(layout.active, 0), panes.length - 1),
    panes,
    sync: { ...layout.sync, auto: layout.sync.auto ?? false }
  }
}

export function toPaneOptions(pane: HydratedPane): PaneOptions {
  return {
    symbol: pane.symbol,
    period: pane.period,
    mainIndicators: pane.mainIndicators,
    subIndicators: pane.subIndicators,
    indicatorParams: pane.indicatorParams,
    ...(pane.view ? { view: pane.view } : {})
  }
}

// Only parameters that belong to an indicator the pane still shows, and only finite numbers:
// klinecharts' calcParams are `unknown[]` at the type level, but every template this client
// mounts takes numbers, and a string that round-trips through JSON would come back and be
// calculated with.
function toPersistedIndicatorParams(pane: PaneSnapshot): Record<string, number[]> | undefined {
  const mounted = new Set([...pane.mainIndicators, ...pane.subIndicators])
  const params: Record<string, number[]> = {}
  for (const [name, values] of Object.entries(pane.indicatorParams)) {
    if (!mounted.has(name) || !isNumberArray(values)) continue
    params[name] = values
  }
  return Object.keys(params).length > 0 ? params : undefined
}

function toPersistedView(view: PaneViewState | null): PersistedView | undefined {
  if (!view) return undefined
  const range = view.yAxis?.range
  const y = {
    ...(view.yAxis?.type && view.yAxis.type !== 'normal' ? { t: view.yAxis.type } : {}),
    ...(view.yAxis?.reverse ? { r: true } : {}),
    ...(range ? { range } : {})
  }
  return {
    bs: view.barSpace,
    live: view.live,
    // The anchor is what a NON-live pane comes back to; a live one comes back to the tail as
    // it stands then, so storing where the tail used to be would only make the document
    // bigger and the reader wonder which of the two wins.
    ...(!view.live && typeof view.anchor === 'number' ? { at: view.anchor, f: view.fraction } : {}),
    ...(Object.keys(y).length > 0 ? { y } : {})
  }
}

function toPersistedPane(pane: PaneSnapshot): PersistedPane {
  const vendor = symbolVendor(pane.symbol)
  const indicatorParams = toPersistedIndicatorParams(pane)
  const view = toPersistedView(pane.view)
  return {
    s: pane.symbol.ticker,
    ...(vendor === 'oanda' ? {} : { v: vendor }),
    p: pane.period.text,
    ...(pane.mainIndicators.length > 0 ? { mi: pane.mainIndicators } : {}),
    ...(pane.subIndicators.length > 0 ? { si: pane.subIndicators } : {}),
    ...(indicatorParams ? { ip: indicatorParams } : {}),
    ...(view ? { vw: view } : {})
  }
}

/** The live wall, as a document. */
/** `mtfByPane` is keyed by pane index and comes from the overlay's controller: the AREV21
 * settings are app state the library has never heard of, so unlike everything else here they
 * cannot be read off a PaneSnapshot. A pane absent from the map keeps whatever it had. */
export function toPersistedLayout(
  preset: string,
  panes: PaneSnapshot[],
  active: number,
  sync: { crosshair: boolean; time: boolean; auto: boolean },
  mtfByPane: Record<number, MtfConfig> = {}
): PersistedLayout {
  return {
    version: LAYOUT_VERSION,
    preset,
    active,
    panes: panes.map((pane, index) => {
      const persisted = toPersistedPane(pane)
      const mtf = mtfByPane[index] ? toStoredMtfConfig(mtfByPane[index]) : undefined
      return mtf ? { ...persisted, mtf } : persisted
    }),
    sync
  }
}

/** A one-line description of a stored layout, for the workspace switcher's rows. */
export function describeLayout(layout: PersistedLayout): string {
  const count = layout.panes.length
  const first = layout.panes[Math.min(Math.max(layout.active, 0), count - 1)]
  const panes = count === 1 ? '1 pane' : `${count} panes`
  return `${panes} · ${first.s} ${first.p}`
}
