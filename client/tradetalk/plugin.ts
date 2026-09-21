import type { IndicatorGroup, SymbolInfo } from '../../src'
import type { BindContext, BindingSpec, BindingState, IndicatorPlugin, PluginFacilities, SourceSpec } from '../plugins/types'
import { dailySource } from './api'
import type { SessionClock } from './calendar'
import { registerHeathLevelsIndicator } from './heathtemplate'
import { isTradeTalkIndicator, registerTradeTalkIndicator, TEMPLATE_NAME } from './templates'

// TradeTalk as a client plugin: one template on the price pane, one source (daily bars), and
// no server change of any kind -- the rule, the level map and the drawing are all in the
// browser (README.md).
//
// It is not gated on a capability: `/getbars` is the oldest route there is, and the daily
// bars mostly come from the chart tiles anyway. What it does need is the instrument's own
// schedule -- the zone and day geometry the server resolves from Postgres and sends with the
// symbol -- because every level here is a calendar candle and a calendar candle is a
// statement about a session. Without it nothing is drawn, and the legend says so, rather
// than a guessed zone putting every boundary an hour or seven out.

const INTERVAL_PATTERN = /^(\d+)([mhDWMY])$/

/** Whether bars of this interval are dated by their SESSION (daily and coarser, which the
 * wire dates canonically) rather than by their open. */
export function isSessionDated(interval: string): boolean {
  const unit = INTERVAL_PATTERN.exec(interval)?.[2]
  return unit === 'D' || unit === 'W' || unit === 'M' || unit === 'Y'
}

/** The clock this chart's bars are dated to sessions on, or null for an instrument whose
 * schedule the chart was not given. */
export function clockFor(symbol: SymbolInfo, interval: string): SessionClock | null {
  const timezone = symbol.timezone
  const geometry = symbol.dayGeometry
  if (!timezone || !geometry) return null
  return { timezone, openOffset: geometry.openOffset, sessionDated: isSessionDated(interval) }
}

export function createTradeTalkPlugin(): IndicatorPlugin {
  let facilities: PluginFacilities | null = null

  const label = (clock: SessionClock | null) => (state: BindingState): string => {
    if (clock === null) return 'TradeTalk · no schedule for this instrument'
    const store = state.sources[0]?.store
    switch (store?.phase) {
      case 'idle':
      case 'loading':
        return 'TradeTalk · daily levels loading'
      case 'error':
        return 'TradeTalk · daily levels unavailable'
      default:
        return 'TradeTalk'
    }
  }

  return {
    id: 'tradetalk',
    feature: null,
    register(f: PluginFacilities): IndicatorGroup[] {
      facilities = f
      // Two templates in one picker group. The entries indicator is bound by the host (it
      // reads daily bars); Heath levels needs nothing but the pane's own candles, so it is
      // registered here and deliberately NOT matched -- an unmatched template is left to
      // klinecharts, which is all it wants.
      const groups = registerTradeTalkIndicator()
      const levels = registerHeathLevelsIndicator()
      if (groups[0]) groups[0].items = [...groups[0].items, ...levels]
      return groups
    },
    matches: isTradeTalkIndicator,
    bind(ctx: BindContext): BindingSpec | null {
      const f = facilities
      if (!f || ctx.indicator.name !== TEMPLATE_NAME) return null
      const clock = clockFor(ctx.symbol, ctx.interval)
      const precision = ctx.symbol.pricePrecision
      const tick = typeof precision === 'number' ? 10 ** -precision : 0
      const barMs = f.resolutionDurationMs(ctx.interval)
      return {
        sources: [dailySource(ctx.vendor, ctx.ticker) as SourceSpec],
        label: label(clock),
        extendData: () => ({ clock, barMs, tick }),
        // The template declares a 5-digit precision so it never TIGHTENS the price axis
        // (klinecharts takes the minimum of the pane's indicator precisions); the
        // instrument's own is applied here, as the bid/ask plugin does.
        overrides: typeof precision === 'number' ? { precision } : undefined
      }
    }
  }
}
