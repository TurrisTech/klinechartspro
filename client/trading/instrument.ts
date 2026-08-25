import { apiGet } from '../config'
import type { InstrumentConfig } from '../symbols'

// Per-instrument facts the trading panel needs to price in pips the OANDA way, cached by
// `vendor:TICKER` and fetched once from `GET /instrument`. A pip is the instrument's
// `forexPipLocation` decimal (EURUSD -4 → 0.0001, USDJPY -2 → 0.01); the display precision
// is one finer (the pipette). Non-forex instruments carry no pip location, so the panel
// falls back to price-only for them. `/instrument` has no client cache of its own, so this
// module is the one.

export interface InstrumentInfo {
  precision: number
  /** 10^forexPipLocation, e.g. 0.0001 for EURUSD; null when the instrument is not priced
   * in pips (assetClass other than forex/metal, or no config). */
  pipSize: number | null
  assetClass: string
}

const cache = new Map<string, InstrumentInfo>()
//: Precision-only hints from a pane's SymbolInfo, so the placeholder is right before the
//: full /instrument fetch (which also carries the pip size) lands.
const seeds = new Map<string, number>()
const inflight = new Set<string>()

function placeholder(vendorSymbol: string): InstrumentInfo {
  return { precision: seeds.get(vendorSymbol) ?? 5, pipSize: null, assetClass: 'forex' }
}

/** The cached info for `vendor:TICKER`, or a sane placeholder while it loads; `onLoad` fires
 * once the real config lands so the caller can redraw. */
export function instrumentInfo(vendorSymbol: string, onLoad?: () => void): InstrumentInfo {
  const hit = cache.get(vendorSymbol)
  if (hit) return hit
  if (!inflight.has(vendorSymbol)) {
    inflight.add(vendorSymbol)
    const [vendor, ticker] = vendorSymbol.includes(':')
      ? vendorSymbol.split(':', 2)
      : ['oanda', vendorSymbol]
    void apiGet<InstrumentConfig>('/instrument', { symbol: `${vendor}:${ticker}` })
      .then((config) => {
        cache.set(vendorSymbol, fromConfig(config))
        onLoad?.()
      })
      .catch(() => cache.set(vendorSymbol, placeholder(vendorSymbol)))
      .finally(() => inflight.delete(vendorSymbol))
  }
  return placeholder(vendorSymbol)
}

function fromConfig(config: InstrumentConfig): InstrumentInfo {
  const isForex = config.assetClass === 'forex' || config.assetClass === 'metal'
  return {
    precision: config.displayPrecision ?? 5,
    pipSize:
      isForex && typeof config.forexPipLocation === 'number'
        ? 10 ** config.forexPipLocation
        : null,
    assetClass: config.assetClass ?? 'forex'
  }
}

/** Seed the placeholder precision from a SymbolInfo the pane already holds. */
export function seedInstrument(vendorSymbol: string, precision: number | undefined): void {
  if (precision !== undefined) seeds.set(vendorSymbol, precision)
}
