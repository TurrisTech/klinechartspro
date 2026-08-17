import type { PaneOptions, PaneSnapshot, Period, SymbolInfo } from '../src'
import { hasFeature } from './capabilities'
import { availablePeriods, defaultPeriod } from './periods'
import { loadPreferences, savePreference } from './preferences'
import { fetchSymbolInfo, symbolVendor } from './symbols'

// The wall's `layout` preference key -- symbol/period/indicators per pane, the active pane,
// the two sync toggles, and which layout preset was in use. Free-form JSON under the same
// 64 KiB /preferences document as starredTimeframes; a realistic 12-pane layout is on the
// order of 2 KiB, so field names are kept short but not cryptic.
const LAYOUT_KEY = 'layout'
const LOCAL_STORAGE_KEY = 'wd.layout'
const LAYOUT_VERSION = 1

interface PersistedPane {
  s: string // symbol ticker, e.g. 'EURUSD'
  v?: string // vendor; omitted when 'oanda' (client/symbols.ts symbolVendor's own default)
  p: string // Period.text -- which IS the server's resolution code ('1h', '1D')
  mi?: string[] // main indicator names, omitted when empty
  si?: string[] // sub indicator names, omitted when empty
}

interface PersistedLayout {
  version: number
  preset: string
  active: number // index into panes
  panes: PersistedPane[]
  sync: { crosshair: boolean; time: boolean }
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
  sync: { crosshair: boolean; time: boolean }
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
// "no persisted layout" instead of throwing, so a schema change can't leave a client stuck
// unable to boot until the field is cleared.
function isPersistedLayout(value: unknown): value is PersistedLayout {
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
    typeof (layout.sync as Record<string, unknown>).time === 'boolean'
  )
}

// `hasFeature('preferences')` is dev-only -- prod's wdashboard-server has no appstate
// database, so /preferences 404s there. The server blob is authoritative when advertised;
// localStorage is the fallback everywhere else. Never throws: a parse/fetch failure here
// should degrade to no persisted layout (the caller's own single-symbol default), not block
// the chart from opening.
export async function loadLayout(): Promise<PersistedLayout | null> {
  try {
    if (hasFeature('preferences')) {
      const data = await loadPreferences()
      const value = data[LAYOUT_KEY]
      return isPersistedLayout(value) ? value : null
    }
    const raw = window.localStorage.getItem(LOCAL_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as unknown
    return isPersistedLayout(parsed) ? parsed : null
  } catch (err) {
    console.warn('[layout] load failed, using defaults', err)
    return null
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
  const panes: HydratedPane[] = layout.panes.map((pane, index) => ({
    symbol: symbols[index],
    period: periods.find((item) => item.text === pane.p) ?? defaultPeriod(periods),
    mainIndicators: pane.mi ?? ['MA'],
    subIndicators: pane.si ?? ['VOL']
  }))

  return {
    preset: layout.preset,
    active: Math.min(Math.max(layout.active, 0), panes.length - 1),
    panes,
    sync: layout.sync
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

// Dirty-checked: `active` changes on every pane click, and without this a click-around
// session would generate a PUT (or a localStorage write) per click regardless of debounce.
let lastWritten = ''

export function saveLayout(
  preset: string,
  panes: PaneSnapshot[],
  active: number,
  sync: { crosshair: boolean; time: boolean }
): void {
  const layout: PersistedLayout = {
    version: LAYOUT_VERSION,
    preset,
    active,
    panes: panes.map(toPersistedPane),
    sync
  }
  const serialized = JSON.stringify(layout)
  if (serialized === lastWritten) return
  lastWritten = serialized

  if (hasFeature('preferences')) savePreference(LAYOUT_KEY, layout)
  // Always ALSO written locally, not only when the server feature is absent: prod has no
  // appstate database today, so this is the only persistence prod gets, and it costs nothing
  // extra to keep it as a same-tab-reload fallback even where the server copy is authoritative.
  try {
    window.localStorage.setItem(LOCAL_STORAGE_KEY, serialized)
  } catch (err) {
    console.warn('[layout] localStorage save failed', err)
  }
}
