import type { ReplayBar } from '../bars/cache'
import type { BidAskBar } from './engine'

/** A bar as the fill engine folds it: its bid and ask, or its mid on both sides where the store has
 * no quotes. The one conversion, for bar replay's walk (replay/session.ts) and the Lab's simulated
 * trades (lab/trades.ts) alike -- the Lab kept a byte-for-byte copy until 2026-11-28, because the
 * replay's lived in a module it could not import. */
export function toBidAsk(bar: ReplayBar, symbol: string): BidAskBar {
  const bid = bar.bid ?? { o: bar.o, h: bar.h, l: bar.l, c: bar.c }
  const ask = bar.ask ?? { o: bar.o, h: bar.h, l: bar.l, c: bar.c }
  return {
    symbol,
    time: bar.open,
    end: bar.end,
    bidOpen: bid.o,
    bidHigh: bid.h,
    bidLow: bid.l,
    bidClose: bid.c,
    askOpen: ask.o,
    askHigh: ask.h,
    askLow: ask.l,
    askClose: ask.c
  }
}
