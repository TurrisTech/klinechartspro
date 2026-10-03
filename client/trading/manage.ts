import type { SimTrade } from './api'
import { formatPrice, formatUnits, formatUnitsShort } from './format'
import type { TradeActionsView } from './kit'
import { CLOSE_FRACTIONS, fractionUnits, reverseOrder } from './levels'
import { closingPrice, type PricingContext, protectionValid } from './metrics'
import type { TradingSession } from './session'

// Managing an open trade, the same from the pane's card and from the position popup: what each of
// `TradeActions`' buttons may do right now, and the two-step reverse. The confirmation (a second
// press, unless one-click trading is on) is the caller's; this is what happens after it.

/** What the action row says about `trade` now. */
export function tradeActionsView(trade: SimTrade, ctx: PricingContext, armed: string | null): TradeActionsView {
  const precision = ctx.info.precision
  // Breakeven moves the stop to the entry, which the engine accepts only once the market is past
  // the entry in the trade's favour.
  const mark = closingPrice(trade.side, ctx.quote)
  let breakeven: string | null = null
  if (trade.stopLoss === trade.entryPrice) breakeven = 'The stop is already at the entry'
  else if (mark === null) breakeven = 'No price yet'
  else if (!protectionValid(trade.side, 'stop', trade.entryPrice, mark)) breakeven = 'Available once the price is past the entry in your favour'
  const reverse = reverseOrder(trade, ctx.quote, precision)
  const opposite = trade.side === 'buy' ? 'short' : 'long'
  return {
    id: trade.id,
    armed,
    breakeven,
    breakevenTitle: `Move the stop to the entry, ${formatPrice(trade.entryPrice, precision)}`,
    reverse: reverse === null ? 'No price yet' : null,
    reverseTitle: `Close it and go ${opposite} ${formatUnits(trade.units)} at market, the stop and target carried across`,
    fractions: CLOSE_FRACTIONS.map((fraction) => {
      const units = fractionUnits(trade.units, fraction, ctx)
      return {
        fraction,
        units,
        title: fraction === 1 ? `Close the whole trade, ${formatUnits(trade.units)} units` : `Close ${units !== null ? formatUnits(units) : '—'} of ${formatUnits(trade.units)} units`
      }
    })
  }
}

/** Close `fraction` of a trade (the whole of it at 1). */
export function closeFraction(session: TradingSession, trade: SimTrade, fraction: number, ctx: PricingContext): Promise<void> {
  const units = fractionUnits(trade.units, fraction, ctx)
  if (units === null) return Promise.reject(new Error('Too small to split'))
  return session.closeTrade(trade.id, units < trade.units ? units : undefined)
}

/** Reverse a trade: the opposite market order FIRST, then the close -- so a refused order leaves
 * the trade as it was rather than leaving the user flat. Returns what happened, for a flash. */
export async function reverseTrade(session: TradingSession, trade: SimTrade, ctx: PricingContext): Promise<string> {
  const plan = reverseOrder(trade, ctx.quote, ctx.info.precision)
  if (!plan) throw new Error('No price yet to reverse at')
  await session.placeOrder({
    symbol: trade.symbol,
    side: plan.side,
    type: 'market',
    units: plan.units,
    stopLoss: plan.stopLoss,
    takeProfit: plan.takeProfit,
    label: trade.label ?? undefined
  })
  const now = plan.side === 'buy' ? 'long' : 'short'
  try {
    await session.closeTrade(trade.id)
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'refused'
    throw new Error(`Opened the ${now} but the old trade did not close (${reason}): both are open`)
  }
  const dropped = (trade.stopLoss !== null && plan.stopLoss === undefined) || (trade.takeProfit !== null && plan.takeProfit === undefined)
  return `Reversed: ${now} ${formatUnitsShort(plan.units)}${dropped ? ' (a level could not be carried across)' : ''}`
}
