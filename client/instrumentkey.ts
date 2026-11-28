// THE INSTRUMENT KEY. `vendor:TICKER` ('oanda:EURUSD', 'coinbase:BTCUSD', 'schwab:$SPX') is how an
// instrument is named everywhere a string has to carry it: the server's `symbol=` parameters, the paper engine's and a
// replay's instrument, an alert's target, the Lab's strategies. These are its one spelling and its
// one parse, so a reader and a writer cannot disagree about it.
//
// PURE, and imports nothing at runtime: the modules that must load without a `window` (the paper
// metrics, the watch types, the Lab's model) use it too, which symbols.ts -- it reads `window` at
// import, through config.ts -- could not offer.

import type { SymbolInfo } from '../src'

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
