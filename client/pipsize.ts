import type { InstrumentConfig } from './symbols'

// One pip in price, or null for an instrument not priced in pips. The one rule for it, shared
// by the chart (SymbolInfo.pipSize, the price pane's ruler) and the trading panel
// (client/trading/instrument.ts): forex and metals carry a pip location, everything else is
// priced in price alone, whatever the vendor's record happens to hold.
export function pipSizeOf(config: InstrumentConfig | null | undefined): number | null {
  if (!config) return null
  const pipped = config.assetClass === 'forex' || config.assetClass === 'metal'
  return pipped && typeof config.forexPipLocation === 'number' ? 10 ** config.forexPipLocation : null
}
