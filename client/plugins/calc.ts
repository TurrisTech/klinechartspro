import type { KLineData } from 'klinecharts'

// klinecharts recalculates EVERY indicator on a pane for every live tick, over every bar the pane
// holds -- `shouldUpdate` is not consulted on that path. A plugin template's `calc` reads the
// bars' TIMESTAMPS and the stores the host keeps (whose changes reach it as a new `extendData`
// carrying the host's `rev`), never the bars' prices, so a tick that only moves the forming
// bar cannot change its result. Recomputing it anyway is O(bars) per indicator per tick per
// pane; the AREV21 MTF overlay alone once cost a six-pane wall 1.7 s of main thread a minute
// (2026-10-07).
//
// This keeps a template's last result while nothing it is computed from moved, and hands back
// the SAME array, which also keeps the legend's width scan (patches/klinecharts) from running
// again. A template whose result depends on a bar's prices -- the divergence's swings, the
// volume profile, TradeTalk -- must not use it for its whole `calc`, but may memoise the PART of
// a pass that reads only timestamps and stores (`timestampMemo`): TradeTalk's calendar map.

/** What a value was computed from: klinecharts replaces the bar array on a reload or a page of
 * history and mutates it in place on a tick, so a new bar shows as a longer list; the host
 * replaces `extendData` whenever a store or a setting changes; a params edit replaces
 * `calcParams`. */
interface Held<D> {
  data: KLineData[]
  length: number
  first: number | undefined
  last: number | undefined
  extendData: unknown
  rev: unknown
  calcParams: unknown
  result: D
}

/** `compute`, reused while the pane holds the same bars, the same `extendData` (and its `rev`)
 * and the same `calcParams` -- one value per indicator. */
export function timestampMemo<R, I extends { extendData?: unknown; calcParams?: unknown }>(
  compute: (dataList: KLineData[], indicator: I) => R
): (dataList: KLineData[], indicator: I) => R {
  const held = new WeakMap<object, Held<R>>()
  return (dataList, indicator) => {
    const first = dataList[0]?.timestamp
    const last = dataList[dataList.length - 1]?.timestamp
    const rev = (indicator.extendData as { rev?: unknown } | undefined)?.rev
    const prev = held.get(indicator)
    if (
      prev &&
      prev.data === dataList &&
      prev.length === dataList.length &&
      prev.first === first &&
      prev.last === last &&
      prev.extendData === indicator.extendData &&
      prev.rev === rev &&
      prev.calcParams === indicator.calcParams
    ) {
      return prev.result
    }
    const result = compute(dataList, indicator)
    held.set(indicator, { data: dataList, length: dataList.length, first, last, extendData: indicator.extendData, rev, calcParams: indicator.calcParams, result })
    return result
  }
}

/** A template's whole `calc`, reused on a tick that cannot change it (see above). */
export function timestampCalc<D, I extends { extendData?: unknown; calcParams?: unknown }>(
  calc: (dataList: KLineData[], indicator: I) => D[]
): (dataList: KLineData[], indicator: I) => D[] {
  return timestampMemo(calc)
}
