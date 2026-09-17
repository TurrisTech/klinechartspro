import type { IndicatorGroup } from '../../src'
import { capabilities } from '../capabilities'
import type { BindContext, BindingSpec, BindingState, IndicatorPlugin, PluginFacilities, SourceSpec } from '../plugins/types'
import { quoteSource } from './api'
import { registerBidAskIndicator, TEMPLATE_NAME } from './templates'

// The bid/ask of every bar on the price pane, as a client plugin. One source per binding,
// keyed by instrument and interval, so two panes of one wall showing the same series share a
// store. Gated on `getbars.columns` -- the one server fact it needs -- and on nothing about
// the vendor: whether an instrument has quotes is answered by its bars (api.ts `quoteOf`),
// and the legend says so when none of the loaded bars do.

export function createBidAskPlugin(): IndicatorPlugin {
  let facilities: PluginFacilities | null = null
  return {
    id: 'bidask',
    feature: 'getbars.columns',
    register(f: PluginFacilities): IndicatorGroup[] {
      facilities = f
      return registerBidAskIndicator()
    },
    matches: (name) => name === TEMPLATE_NAME,
    bind(ctx: BindContext): BindingSpec | null {
      if (!facilities || ctx.indicator.name !== TEMPLATE_NAME) return null
      const source = quoteSource(facilities, ctx.vendor, ctx.ticker, ctx.interval, capabilities().limits.maxBarsPerRequest)
      const precision = ctx.symbol.pricePrecision
      return {
        sources: [source as SourceSpec],
        label: (state: BindingState) => {
          const store = state.sources[0]?.store
          switch (store?.phase) {
            case 'idle':
            case 'loading':
              return 'BID/ASK · loading'
            case 'error':
              return 'BID/ASK · error'
            default:
              return store && store.size === 0 ? 'BID/ASK · no quotes for this instrument' : 'BID/ASK'
          }
        },
        overrides: typeof precision === 'number' ? { precision } : undefined
      }
    }
  }
}
