import type { SymbolInfo } from '../src'
import { apiGet } from './config'

// wdashboard-server has no vendor/exchange field name of its own — `/search` returns
// `description` as "{vendor}:{symbol}". We fold vendor into SymbolInfo.exchange since
// getbars/WS-stream take vendor and symbol as separate fields, same as this API does.

// The vendor's own configuration for an instrument (wdashboard-server's
// InstrumentConfigModel, sourced from OANDA via wmarketdata). This is where display
// precision comes from — see resolvePrecision below for why it is not computed here.
export interface InstrumentConfig {
  vendor: string
  symbol: string
  displayName: string
  instrumentType: string
  displayPrecision: number
  pipLocation: number
  tradeUnitsPrecision: number
  minimumTradeSize: number | null
  marginRate: number | null
}

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

// Mirrors wdashboard-server's _ASSET_CLASS_BY_INSTRUMENT_TYPE, for the one path that
// receives a config without the server's own `type` alongside it.
const ASSET_CLASS_BY_INSTRUMENT_TYPE: Record<string, string> = {
  CURRENCY: 'forex',
  METAL: 'metal',
  CFD: 'cfd'
}

function assetClassOf(config: InstrumentConfig | null | undefined): string {
  return (config && ASSET_CLASS_BY_INSTRUMENT_TYPE[config.instrumentType]) ?? 'forex'
}

function toSymbolInfo(result: SearchResult): SymbolInfo {
  const [vendor, symbol] = result.description.includes(':')
    ? result.description.split(':', 2)
    : ['oanda', result.symbol]
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
    volumePrecision: 0
  }
}

export function symbolVendor(symbol: SymbolInfo): string {
  return symbol.exchange ?? 'oanda'
}

// GET /search requires the `query` param even when empty (empty string = list everything),
// so always set it.
export async function fetchSymbols(search = ''): Promise<SymbolInfo[]> {
  const results = await apiGet<SearchResult[]>('/search', { query: search })
  return Array.isArray(results) ? results.map(toSymbolInfo) : []
}

// Resolve one instrument without running a search first — what the initial symbol needs,
// since it is named in configuration rather than picked from search results.
export async function fetchSymbolInfo(ticker: string, vendor = 'oanda'): Promise<SymbolInfo> {
  let config: InstrumentConfig | null = null
  try {
    config = await apiGet<InstrumentConfig>('/instrument', { symbol: `${vendor}:${ticker}` })
  } catch (err) {
    console.warn(`[symbols] /instrument failed for ${vendor}:${ticker}`, err)
  }
  return toSymbolInfo({
    symbol: ticker,
    description: `${vendor}:${ticker}`,
    // `/instrument` answers with the configuration alone, not the coarse asset class that
    // `/search` results carry, so derive it the same way the server does rather than
    // assuming forex — this client is pointed at metals and CFDs too.
    type: assetClassOf(config),
    config
  })
}

export const DEFAULT_SYMBOL_TICKER = 'EURUSD'
