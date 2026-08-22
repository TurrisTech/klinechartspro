import type { PaneOptions, PaneSnapshot, Period, SymbolInfo } from '../src'
import { availablePeriods, defaultPeriod } from './periods'
import { DEFAULT_SYMBOL_TICKER, fetchSymbolInfo, symbolVendor } from './symbols'

// The SHAPE of one wall document -- symbol/period/indicators per pane, the active pane, the
// two sync toggles, and which layout preset was in use. Where a document is stored, and how
// many of them a user keeps, is client/workspaces/store.ts's problem, not this file's: a
// layout used to be a single `layout` preference key and is now the `layout` field of a
// workspace, and nothing here had to change for that.
//
// A realistic 12-pane layout is on the order of 2 KiB, so field names are kept short but not
// cryptic -- a user's whole workspace set shares one 64 KiB /preferences document.
const LAYOUT_VERSION = 1

interface PersistedPane {
  s: string // symbol ticker, e.g. 'EURUSD'
  v?: string // vendor; omitted when 'oanda' (client/symbols.ts symbolVendor's own default)
  p: string // Period.text -- which IS the server's resolution code ('1h', '1D')
  mi?: string[] // main indicator names, omitted when empty
  si?: string[] // sub indicator names, omitted when empty
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

const live = (names: string[]): string[] => names.filter((name) => !RETIRED_INDICATORS.has(name))

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
  const panes: HydratedPane[] = layout.panes.map((pane, index) => ({
    symbol: symbols[index],
    period: periods.find((item) => item.text === pane.p) ?? defaultPeriod(periods),
    mainIndicators: live(pane.mi ?? ['MA']),
    subIndicators: live(pane.si ?? ['VOL'])
  }))

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
    subIndicators: pane.subIndicators
  }
}

function toPersistedPane(pane: PaneSnapshot): PersistedPane {
  const vendor = symbolVendor(pane.symbol)
  return {
    s: pane.symbol.ticker,
    ...(vendor === 'oanda' ? {} : { v: vendor }),
    p: pane.period.text,
    ...(pane.mainIndicators.length > 0 ? { mi: pane.mainIndicators } : {}),
    ...(pane.subIndicators.length > 0 ? { si: pane.subIndicators } : {})
  }
}

/** The live wall, as a document. */
export function toPersistedLayout(
  preset: string,
  panes: PaneSnapshot[],
  active: number,
  sync: { crosshair: boolean; time: boolean; auto: boolean }
): PersistedLayout {
  return { version: LAYOUT_VERSION, preset, active, panes: panes.map(toPersistedPane), sync }
}

/** A one-line description of a stored layout, for the workspace switcher's rows. */
export function describeLayout(layout: PersistedLayout): string {
  const count = layout.panes.length
  const first = layout.panes[Math.min(Math.max(layout.active, 0), count - 1)]
  const panes = count === 1 ? '1 pane' : `${count} panes`
  return `${panes} · ${first.s} ${first.p}`
}
