import type { IndicatorGroup } from '../../src'
import { capabilities } from '../capabilities'
import type { BindContext, BindingSpec, BindingState, IndicatorPlugin, PluginFacilities, SourceSpec } from '../plugins/types'
import { quoteSource } from './api'
import { registerSpreadIndicator, SPREAD_TEMPLATE_NAME, spreadPrecision, spreadUnit, spreadUnitLabel } from './spread'
import { registerBidAskIndicator, TEMPLATE_NAME } from './templates'

// The bid/ask of every bar, as a client plugin with two templates: the bid and ask closes on
// the price pane (QUOTE:bidask) and their spread in a sub-pane (QUOTE:spread). One source per
// binding, keyed by instrument and interval only, so both templates -- and two panes of one
// wall showing the same series -- share a store. Gated on `getbars.columns` -- the one server
// fact it needs -- and on nothing about the vendor: whether an instrument has quotes is
// answered by its bars (api.ts `quoteOf`), and the legend says so when none of the loaded
// bars do.

const NAMES = new Set([TEMPLATE_NAME, SPREAD_TEMPLATE_NAME])

function legend(prefix: string) {
  return (state: BindingState): string => {
    const store = state.sources[0]?.store
    switch (store?.phase) {
      case 'idle':
      case 'loading':
        return `${prefix} · loading`
      case 'error':
        return `${prefix} · error`
      default:
        return store && store.size === 0 ? `${prefix} · no quotes for this instrument` : prefix
    }
  }
}

export function createBidAskPlugin(): IndicatorPlugin {
  let facilities: PluginFacilities | null = null
  return {
    id: 'bidask',
    feature: 'getbars.columns',
    register(f: PluginFacilities): IndicatorGroup[] {
      facilities = f
      return [...registerBidAskIndicator(), ...registerSpreadIndicator()]
    },
    matches: (name) => NAMES.has(name),
    bind(ctx: BindContext): BindingSpec | null {
      if (!facilities || !NAMES.has(ctx.indicator.name)) return null
      const source = quoteSource(facilities, ctx.vendor, ctx.ticker, ctx.interval, capabilities().limits.maxBarsPerRequest)
      const precision = ctx.symbol.pricePrecision
      if (ctx.indicator.name === SPREAD_TEMPLATE_NAME) {
        // The unit is a calcParam, and calcParams are part of a binding's identity, so a unit
        // change rebinds and the precision below is re-applied.
        const unit = spreadUnit(ctx.indicator.calcParams)
        const pointSize = typeof precision === 'number' ? 10 ** -precision : 0
        return {
          sources: [source as SourceSpec],
          label: legend(`SPREAD ${spreadUnitLabel(unit)}`),
          extendData: () => ({ pointSize }),
          overrides: { precision: spreadPrecision(unit, precision) }
        }
      }
      return {
        sources: [source as SourceSpec],
        label: legend('BID/ASK'),
        overrides: typeof precision === 'number' ? { precision } : undefined
      }
    }
  }
}
