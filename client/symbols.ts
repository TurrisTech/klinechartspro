import type { SymbolInfo } from '../src'
import { offeredIntervalCodes } from './periods'
import { apiGet } from './config'
import { dayGeometryOf, tradingWeekOf } from './time/daygeometry'
import { pipSizeOf } from './pipsize'
import { type InstrumentConfig, instrumentConfig } from './instrumentconfig'

// wdashboard-server has no vendor/exchange field name of its own — `/search` returns
// `description` as "{vendor}:{symbol}". We fold vendor into SymbolInfo.exchange since
// getbars/WS-stream take vendor and symbol as separate fields, same as this API does.

interface SearchResult {
  symbol: string
  description: string
  type: string
  config?: InstrumentConfig | null
}

// Deliberately NO symbol-derived fallback. This client used to compute precision as
// "endsWith('JPY') ? 3 : 5", which is a quoting convention rather than a fact: it is wrong
// for EUR/HUF (3 decimals, no JPY in the name), for metals and for CFDs. When the server
// has no configuration for an instrument, leaving pricePrecision undefined lets
// KLineChartPro apply its own default — a visibly coarse price beats a confidently wrong
// one, and it keeps there being exactly one source of truth for precision: the vendor.
function resolvePrecision(
  config: InstrumentConfig | null | undefined,
  ticker: string
): number | undefined {
  if (config) return config.displayPrecision
  console.warn(`[symbols] no instrument config for ${ticker}; using the chart's default precision`)
  return undefined
}

// The asset class is stored, not inferred. This used to be a copy of wdashboard-server's
// vendor-type lookup table — a third copy of the same mapping, after wmarkettypes' and the
// server's — which meant a vendor adding an instrument type had to be taught to all three.
// wmarketdata now normalises it once at ingestion and it travels on the config.
function assetClassOf(config: InstrumentConfig | null | undefined): string {
  return config?.assetClass ?? 'forex'
}

function toSymbolInfo(result: SearchResult): SymbolInfo {
  // A bare description names the ticker in `symbol` instead: the vendor is the default one.
  const { vendor, ticker: symbol } = result.description.includes(':')
    ? splitInstrumentKey(result.description)
    : { vendor: DEFAULT_VENDOR, ticker: result.symbol }
  const config = result.config
  return {
    ticker: symbol,
    exchange: vendor,
    market: result.type,
    type: config?.instrumentType,
    shortName: symbol,
    // The vendor's own spelling ("EUR/USD") when known, so the picker reads the way the
    // broker writes it rather than as a raw concatenation.
    name: config?.displayName ?? result.description,
    pricePrecision: resolvePrecision(config, symbol),
    // Not configuration: the OHLCV contract declares volume integer-valued on every path.
    volumePrecision: 0,
    // The market's own clock, from the effective schedule the server resolved. A pane
    // showing this instrument displays on it (UTC for a Coinbase pair), and its
    // daily-and-coarser session dates are read on it -- the FX +7h/-New-York rules do
    // not apply to a market whose days run midnight to midnight.
    timezone: config?.marketHours?.timezone,
    dayGeometry: dayGeometryOf(config?.marketHours) ?? undefined,
    // And when its rows count, which a fold of finer bars must filter on (replay/feed.ts).
    tradingWeek: tradingWeekOf(config?.marketHours) ?? undefined,
    // The periods this instrument can be charted at. Capabilities are loaded before any
    // symbol is resolved (index.ts boot), and an instrument the server does not name for a
    // scoped code -- 5s anywhere but the fed FX pairs -- is simply not offered it.
    periods: offeredIntervalCodes(vendor, symbol),
    pipSize: pipSizeOf(config) ?? undefined
  }
}

// -- the instrument key ------------------------------------------------------------------------
//
// `vendor:TICKER` ('oanda:EURUSD', 'coinbase:BTCUSD', 'schwab:$SPX') is how an instrument is named
// everywhere a string has to carry it: the server's `symbol=` parameters, the paper engine's and a
// replay's instrument, an alert's target, the Lab's strategies. These are its one spelling and its
// one parse, so a reader and a writer cannot disagree about it.

/** The vendor a bare ticker means. Older deep links and stored layouts named only the ticker, from
 * before this client served anything but OANDA (and a stored pane still leaves its vendor out when
 * it is this one, layout.ts), so a key or a SymbolInfo that names no vendor is read as OANDA rather
 * than refused. */
export const DEFAULT_VENDOR = 'oanda'

/** The `vendor:TICKER` key, spelled exactly as given: no case is changed. */
export function instrumentKey(vendor: string, ticker: string): string {
  return `${vendor}:${ticker}`
}

/**
 * A key's two halves, split at its first ':'. A bare ticker (no ':') is DEFAULT_VENDOR's; a key
 * that has one is taken as written, so ':EURUSD' has an empty vendor and 'oanda:' an empty ticker
 * -- the callers that refuse those check for them, rather than this guessing.
 */
export function splitInstrumentKey(key: string): { vendor: string; ticker: string } {
  const at = key.indexOf(':')
  return at < 0 ? { vendor: DEFAULT_VENDOR, ticker: key } : { vendor: key.slice(0, at), ticker: key.slice(at + 1) }
}

/** A key's ticker, for a label: the whole string when it names no vendor. */
export function tickerOf(key: string): string {
  return splitInstrumentKey(key).ticker
}

export function symbolVendor(symbol: SymbolInfo): string {
  return symbol.exchange ?? DEFAULT_VENDOR
}

/** The instrument key of a pane's symbol. */
export function symbolKey(symbol: SymbolInfo): string {
  return instrumentKey(symbolVendor(symbol), symbol.ticker)
}

// GET /search requires the `query` param even when empty (empty string = list everything),
// so always set it.
export async function fetchSymbols(search = ''): Promise<SymbolInfo[]> {
  // `vendor: ''` means EVERY vendor. /search takes a single vendor and defaults it to
  // 'oanda', so omitting the parameter did not mean "all" — it meant "oanda only", and the
  // picker could therefore never find a coinbase or schwab instrument. Searching "BTC"
  // returned nothing while coinbase:BTCUSD was sitting in the store, and the same for
  // schwab:$SPX; both were reachable by deep link, which is why it went unnoticed.
  //
  // The server side already supports this — its vendor filter is applied only `if vendor`,
  // so an empty string skips it and searches the vendor table whole. Nothing needed to
  // change there.
  const results = await apiGet<SearchResult[]>('/search', { query: search, vendor: '' })
  return Array.isArray(results) ? results.map(toSymbolInfo) : []
}

// Resolve one instrument without running a search first — what the initial symbol needs,
// since it is named in configuration rather than picked from search results.
export async function fetchSymbolInfo(ticker: string, vendor = DEFAULT_VENDOR): Promise<SymbolInfo> {
  // Shared with the trading panel's own reader (client/instrumentconfig.ts): one request per
  // instrument per page, not one per caller per hydration. It never rejects -- a failure
  // reads as `null` here, exactly as the try/catch this replaced did.
  const key = instrumentKey(vendor, ticker)
  const config = await instrumentConfig(key)
  return toSymbolInfo({
    symbol: ticker,
    description: key,
    // `/instrument` answers with the configuration alone, not the coarse asset class that
    // `/search` results carry, so derive it the same way the server does rather than
    // assuming forex — this client is pointed at metals and CFDs too.
    type: assetClassOf(config),
    config
  })
}

export const DEFAULT_SYMBOL_TICKER = 'EURUSD'
