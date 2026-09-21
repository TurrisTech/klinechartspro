// Where price and arev21's prediction disagree about a swing -- the rule, with no chart in it.
//
// The classic oscillator divergence with arev21's `p` as the oscillator. At each confirmed
// swing low in price, compare it with the swing low immediately before it:
//
//   * bull        -- price made a LOWER low and `p` at the new low is HIGHER than at the old one:
//                    the market went further down and the model grew less bearish about it.
//   * hidden_bull -- a HIGHER low with a LOWER `p`. Off unless `hidden` is set.
//
// and the mirror image at swing highs: `bear` is a higher high with a lower `p`, `hidden_bear` a
// lower high with a higher `p`.
//
// The swings are PRICE's, and `p` is read at them. A swing low is below each of the previous
// `left` lows and not undercut by the next `right`. `left` defaults to 10 because that is arev21's
// own lookback: a bar below the previous ten lows is a fresh extreme, which is exactly the bar
// arev21 samples on (wtradingresearch `indicators/wy/arev21.py`), so every swing compared is one
// the model's vote was fitted on. Pivoting on `p` instead -- the TradingView RSI-divergence
// recipe -- would put the swings wherever a k-NN vote wobbled, on a series that steps by 1/n.
//
// A divergence belongs to the bar that CONFIRMED it, `right` bars after its swing: before then
// the swing was not a swing. Charting packages usually draw the label back on the swing bar, which
// is `right` bars of hindsight on every signal (CLAUDE.md, "Effective timestamps"). Nothing here
// reads a bar after the confirming one, which `divergence.test.ts` asserts by cutting the series.
//
// Not a measured signal. The AREV programme's standing result is that every trigger on arev21's
// `p` lands at the same ~57% on its own next-sample target and ~0 pips gross
// (notes/research/arev21-outlier/README.md); this is a way of looking at the line, not a trade.

/** arev21's `lookback`: a bar is a sample when its high tops the previous this-many highs or its
 * low undercuts their lows. */
export const AREV21_LOOKBACK = 10

/** A vote from fewer neighbours than this is not the published calibration (the AREV panes'
 * signal floor, `wdashboard-server` `services/arev.MIN_NEIGHBOURS`), so a swing carrying one is
 * not compared. */
export const MIN_NEIGHBOURS = 50

export type Side = 'low' | 'high'
export type Label = 'bull' | 'hidden_bull' | 'bear' | 'hidden_bear'

export interface Rule {
  /** Bars a swing must beat on its left, strictly. */
  left: number
  /** Bars after a swing that must fail to undercut (top) it -- and so how many bars after the
   * swing its divergence is known. */
  right: number
  /** How far apart the two swings compared may be, in bars, inclusive. TradingView's
   * RSI-divergence defaults. */
  minGap: number
  maxGap: number
  /** How far `p` must move between the two swings to count, strictly. `p` steps by 1/200 at
   * arev21's k, so 0 counts a single vote. */
  minDp: number
  /** Also report hidden divergences (the trend-continuation reading). */
  hidden: boolean
}

/** The settings dialog's numbers, in calcParams order, each with its bounds. `hidden` is a 0/1
 * number because that dialog edits a flat numeric array. */
export const PARAMS = [
  { name: 'left', label: 'swing left bars', default: AREV21_LOOKBACK, min: 2, max: 100, isInt: true },
  { name: 'right', label: 'swing right bars', default: 5, min: 1, max: 50, isInt: true },
  { name: 'minGap', label: 'min bars between swings', default: 5, min: 1, max: 500, isInt: true },
  { name: 'maxGap', label: 'max bars between swings', default: 60, min: 2, max: 1000, isInt: true },
  { name: 'minDp', label: 'min p change', default: 0, min: 0, max: 0.5, isInt: false },
  { name: 'hidden', label: 'hidden (0/1)', default: 0, min: 0, max: 1, isInt: true }
] as const

export const DEFAULT_PARAMS: number[] = PARAMS.map((p) => p.default)

/** calcParams -> a rule: each number coerced and clamped, junk falling back to its default. The
 * dialog commits every keystroke, so half-typed values arrive here. An inverted gap window is
 * widened rather than left to match nothing. */
export function ruleOf(calcParams: readonly unknown[] | undefined): Rule {
  const value = (i: number): number => {
    const spec = PARAMS[i]
    const raw = calcParams?.[i]
    const n = typeof raw === 'number' || typeof raw === 'string' ? Number(raw) : Number.NaN
    const clamped = Math.min(spec.max, Math.max(spec.min, Number.isFinite(n) ? n : spec.default))
    return spec.isInt ? Math.round(clamped) : clamped
  }
  const minGap = value(2)
  return {
    left: value(0),
    right: value(1),
    minGap,
    maxGap: Math.max(minGap, value(3)),
    minDp: value(4),
    hidden: value(5) !== 0
  }
}

/** Per bar: a confirmed swing low (`side = 'low'`) or high.
 *
 * Strictly beyond each of the previous `left` values -- the same strict comparison arev21's
 * `RollingExtremes` makes -- and not undercut (topped) by the next `right`: an equal extreme later
 * does not unmake it, and is not a swing itself, since its own left side holds the equal one. The
 * first `left` bars and the last `right` are never swings: one lacks a history, the other has not
 * been confirmed. */
export function swings(values: ArrayLike<number>, left: number, right: number, side: Side): boolean[] {
  const n = values.length
  const out = new Array<boolean>(n).fill(false)
  const beyond = side === 'low' ? (a: number, b: number) => a < b : (a: number, b: number) => a > b
  for (let i = left; i + right < n; i++) {
    const v = values[i]
    if (!Number.isFinite(v)) continue
    let ok = true
    for (let j = i - left; j < i && ok; j++) ok = beyond(v, values[j])
    for (let j = i + 1; j <= i + right && ok; j++) ok = !beyond(values[j], v)
    out[i] = ok
  }
  return out
}

export interface Divergence {
  side: Side
  label: Label
  /** The bar that confirmed it: `swing + right`. */
  confirm: number
  /** The new swing, and the one it was compared with. */
  swing: number
  previous: number
}

/** Every divergence in the arrays, by bar index, in confirmation order within each side.
 *
 * Each swing is compared with the swing IMMEDIATELY before it on the same side, and only when
 * both carry a usable `p` and they are `minGap..maxGap` bars apart. Comparing with the previous
 * swing that happens to have a `p` would skip over whatever the skipped swing did to price and
 * call that a divergence. */
export function divergences(
  low: ArrayLike<number>,
  high: ArrayLike<number>,
  p: ArrayLike<number>,
  usable: ArrayLike<boolean>,
  rule: Rule
): Divergence[] {
  const out: Divergence[] = []
  for (const side of ['low', 'high'] as const) {
    const extreme = side === 'low' ? low : high
    const at = swings(extreme, rule.left, rule.right, side)
    let previous = -1
    for (let i = 0; i < at.length; i++) {
      if (!at[i]) continue
      const j = previous
      previous = i
      if (j < 0) continue
      const gap = i - j
      if (gap < rule.minGap || gap > rule.maxGap || !usable[i] || !usable[j]) continue
      const dp = p[i] - p[j]
      // At a low, disagreeing with a lower low means p ROSE; at a high, disagreeing with a
      // higher high means p FELL. The hidden kinds are the same two readings the other way up.
      const further = side === 'low' ? extreme[i] < extreme[j] : extreme[i] > extreme[j]
      const shy = side === 'low' ? extreme[i] > extreme[j] : extreme[i] < extreme[j]
      const against = side === 'low' ? dp > rule.minDp : dp < -rule.minDp
      const along = side === 'low' ? dp < -rule.minDp : dp > rule.minDp
      let label: Label | null = null
      if (further && against) label = side === 'low' ? 'bull' : 'bear'
      else if (rule.hidden && shy && along) label = side === 'low' ? 'hidden_bull' : 'hidden_bear'
      if (label) out.push({ side, label, confirm: i + rule.right, swing: i, previous: j })
    }
  }
  return out
}
