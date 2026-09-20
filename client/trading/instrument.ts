import { cachedInstrumentConfig, instrumentConfig } from '../instrumentconfig'
import type { InstrumentConfig } from '../symbols'

// Per-instrument facts the trading panel needs to price in pips the OANDA way, cached by
// `vendor:TICKER` and fetched once from `GET /instrument`. A pip is the instrument's
// `forexPipLocation` decimal (EURUSD -4 → 0.0001, USDJPY -2 → 0.01); the display precision
// is one finer (the pipette). Non-forex instruments carry no pip location, so the panel
// falls back to price-only for them. The REQUEST is cached in client/instrumentconfig.ts,
// shared with the pane's own SymbolInfo lookup (before 2026-09-20 this module fetched
// `/instrument` a second time for every instrument on the wall); what is cached HERE is the
// derived, trading-shaped view of that config.

export interface InstrumentInfo {
  precision: number
  /** 10^forexPipLocation, e.g. 0.0001 for EURUSD; null when the instrument is not priced
   * in pips (assetClass other than forex/metal, or no config). */
  pipSize: number | null
  assetClass: string
  /** OANDA's margin requirement as a fraction of notional (0.0333 = 30:1); null when the
   * vendor states none. */
  marginRate: number | null
  /** Decimal places a units amount may carry (OANDA forex 0); a size computed from a risk
   * budget is floored to it. */
  unitsPrecision: number
}

const cache = new Map<string, InstrumentInfo>()
//: Precision-only hints from a pane's SymbolInfo, so the placeholder is right before the
//: full /instrument fetch (which also carries the pip size) lands.
const seeds = new Map<string, number>()
const inflight = new Set<string>()

function placeholder(vendorSymbol: string): InstrumentInfo {
  return { precision: seeds.get(vendorSymbol) ?? 5, pipSize: null, assetClass: 'forex', marginRate: null, unitsPrecision: 0 }
}

/** The cached info for `vendor:TICKER`, or a sane placeholder while it loads; `onLoad` fires
 * once the real config lands so the caller can redraw. */
export function instrumentInfo(vendorSymbol: string, onLoad?: () => void): InstrumentInfo {
  const hit = cache.get(vendorSymbol)
  if (hit) return hit
  const key = vendorSymbol.includes(':') ? vendorSymbol : `oanda:${vendorSymbol}`
  // Already fetched for the pane's own SymbolInfo: derive from it now rather than asking a
  // second time, which is what this module used to do for every instrument on the wall.
  const known = cachedInstrumentConfig(key)
  if (known !== undefined) {
    const info = known ? fromConfig(known) : placeholder(vendorSymbol)
    cache.set(vendorSymbol, info)
    return info
  }
  if (!inflight.has(vendorSymbol)) {
    inflight.add(vendorSymbol)
    void instrumentConfig(key)
      .then((config) => {
        cache.set(vendorSymbol, config ? fromConfig(config) : placeholder(vendorSymbol))
        // Only a real config is news to the caller: a placeholder is what it is already
        // drawing, so redrawing for one would be a redraw that changes nothing.
        if (config) onLoad?.()
      })
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
    assetClass: config.assetClass ?? 'forex',
    marginRate: typeof config.marginRate === 'number' && config.marginRate > 0 ? config.marginRate : null,
    unitsPrecision:
      typeof config.tradeUnitsPrecision === 'number' && config.tradeUnitsPrecision >= 0 ? config.tradeUnitsPrecision : 0
  }
}

/** Seed the placeholder precision from a SymbolInfo the pane already holds. */
export function seedInstrument(vendorSymbol: string, precision: number | undefined): void {
  if (precision !== undefined) seeds.set(vendorSymbol, precision)
}
