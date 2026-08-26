import { apiGet } from '../config'

// wdashboard-server's mtf01 surface (services/mtf01.py): the multi-timeframe cascade a
// hand-run research script (wtradingresearch bin/mtf01_generate.py) persisted to the algo
// DB. Nothing is computed on request and there is no live stream — new rows appear when
// the script is re-run.
//
// mtf01 chains arev21's red down arrows across three tiers of timeframes: an 8h/4h/1h
// arrow ARMS a context whose floor is min(open, close) of its candle, a 1h/30m/15m arrow
// CONFIRMS it, and a 5m/3m arrow TRIGGERS a laddered short targeting that floor.
//
// **Every row is timed by when it became actionable, not by the candle it came from.** A
// bar labelled T on a 4h chart is the candle BEGINNING at T; its signal exists only at
// T + 4h. `effective` (and a trade's `triggeredAt`) is that instant, and `date` is the bar
// of the CHART YOU ARE LOOKING AT that was open then — which is why an 8h arrow lands
// eight hours to the right of its own label on a 5m chart. `barDate` is the arrow's own
// candle on its own interval, for matching against what the AREV pane draws there.

export const MTF01_GENERATION = 'mtf01'

export type Stage = 'htf' | 'mtf' | 'ltf'

/** 'target' and 'stop' are the two barriers; 'expired' closed at the market; 'open' has
 * not resolved in the data generated so far. */
export type TradeOutcome = 'target' | 'stop' | 'expired' | 'open'

export interface Mtf01Event {
  /** The chart's own bar this draws on: the bar open when the arrow became actionable. */
  date: number
  stage: Stage
  /** The timeframe the arrow was on — 8h, 15m, 5m … */
  interval: string
  /** The arrow's own candle, on its own interval's wire clock. */
  barDate: number
  /** When it became knowable: its candle's close. */
  effective: number
  /** arev21's P(price rises); a red arrow is always below 0.5. */
  p: number
  n: number
  /** min(open, close) of the arrow's candle — the floor it establishes. */
  bodyLow: number
  /** Did the cascade take it? A rejected arrow carries `reason`. */
  accepted: boolean
  reason: string | null
  /** Accepted arrows only: when the context it created would have timed out, and when
   * it actually ended (null while still live at the end of the generated data). */
  expiresAt: number | null
  endedAt: number | null
  endReason: string | null
}

export interface Mtf01Trade {
  /** The chart's own bar this draws on: the bar open at `triggeredAt`. */
  date: number
  triggeredAt: number
  ltfInterval: string
  barDate: number
  htfInterval: string
  htfBarDate: number
  mtfInterval: string
  mtfBarDate: number
  triggerPrice: number
  stop: number
  target: number
  /** The entry ladder: the trigger close, then sell limits up the risk band. */
  entries: number[]
  swingHigh: number
  atr: number
  /** How many ladder levels price actually reached. */
  fills: number
  avgEntry: number | null
  exitPrice: number | null
  outcome: TradeOutcome
  resolvedAt: number | null
  /** Short, so `avgEntry - exitPrice`: positive is a profit, in price units. */
  pnlPrice: number | null
}

/** One tier configuration an instrument holds rows for. A parameter sweep writes several,
 * and the cascade selector needs this list BEFORE it can ask for values -- which is why
 * the server keeps it on a route of its own rather than in the values envelope. */
export interface Mtf01Cascade {
  cascade: string
  events: number
  trades: number
  firstAt: number | null
  lastAt: number | null
}

export async function fetchMtf01Cascades(vendorSymbol: string): Promise<Mtf01Cascade[]> {
  const body = await apiGet<{ cascades: Mtf01Cascade[] }>('/strategy/cascades', {
    symbol: vendorSymbol,
    generation: MTF01_GENERATION
  })
  return body.cascades ?? []
}
