import type { IndicatorGroup } from '../../src'
import { AXIS_GAP } from '../plugins/draw'
import type { BindContext, BindingSpec, BindingState, IndicatorPlugin, PluginFacilities } from '../plugins/types'
import { MTF01_GENERATION, type Mtf01Event } from './api'
import { isMtf01Indicator, registerMtf01Indicators } from './templates'
import { Mtf01Store } from './store'
import { phaseLabel } from '../plugins/legend'
import { gridFor } from '../time/timeframes'
import { instrumentKey } from '../instrumentkey'

// mtf01 as a client plugin: one sub-pane template over one source, and that source reads
// TWO kinds of row from one response -- the cascade events in `points`, the trades they
// produced in the declared `trades` array (wdashboard_server/plugins/api.py, "Multiple
// arrays"). `Mtf01Store` holds both and dedupes each by its own identity, because a row is
// placed on the bar it became ACTIONABLE on: several arrows from different timeframes
// routinely land on one bar of a coarse chart, and the two arrays are capped independently
// by the server, so a page boundary drawn by one overlaps the other.
//
// A cascade is the strategy's own identity and one instrument can hold several (a
// parameter sweep is exactly that). It is part of the source key: switching cascade is
// looking at different data, not a redraw of the same data.

function mtf01SourceKey(vendor: string, ticker: string, interval: string, cascade: string | null): string {
  return `${MTF01_GENERATION}|${instrumentKey(vendor, ticker)}|${interval}|${cascade ?? 'default'}`
}

export function createMtf01Plugin(): IndicatorPlugin {
  let facilities: PluginFacilities | null = null
  return {
    id: 'mtf01',
    feature: 'strategy',
    register(f: PluginFacilities): IndicatorGroup[] {
      facilities = f
      return registerMtf01Indicators()
    },
    matches: isMtf01Indicator,
    bind(ctx: BindContext): BindingSpec | null {
      const f = facilities
      if (!f) return null
      const base = MTF01_GENERATION.toUpperCase()
      // Not yet settable from the pane's settings; the server picks the most recently
      // active cascade when none is named, and echoes back which it chose.
      const cascade: string | null = null
      // The pane's instrument's own candle grid, as plain data: the template places a context's
      // end (an instant) on the bar that was open then, which from 1D up is not the bar whose
      // wire label precedes it.
      const schedule = gridFor(ctx.symbol)?.schedule ?? null
      return {
        sources: [
          {
            id: MTF01_GENERATION,
            key: mtf01SourceKey(ctx.vendor, ctx.ticker, ctx.interval, cascade),
            resolution: ctx.interval,
            createStore: (key) => new Mtf01Store(key),
            fetch: (range, limit) =>
              f.points<Mtf01Event>({
                pluginId: 'mtf01',
                vendorSymbol: instrumentKey(ctx.vendor, ctx.ticker),
                resolution: ctx.interval,
                from: range.from,
                to: range.to,
                limit,
                variant: MTF01_GENERATION,
                // The second kind of row. Named here, so `Page.arrays.trades` is always
                // present -- empty against a server that sent none, rather than undefined.
                arrays: ['trades'],
                ...(cascade ? { params: { cascade } } : {})
              })
          }
        ],
        label: (state: BindingState) => phaseLabel(base, [state.sources[0]?.store]) ?? base,
        // The P&L label's unit, from the instrument's configuration as the pane's SymbolInfo
        // carries it (client/symbols.ts): its pip where it is priced in pips, else its display
        // precision. Never a constant -- a JPY cross's pip is 0.01, a crypto pair has none.
        extendData: () => ({
          chartInterval: ctx.interval,
          schedule,
          pip: ctx.symbol.pipSize ?? null,
          pricePrecision: ctx.symbol.pricePrecision ?? null
        }),
        yAxisGap: AXIS_GAP
      }
    }
  }
}
