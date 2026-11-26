import { getReadClock } from '../config'
import { dayGeometryOf } from '../daygeometry'
import { instrumentConfig } from '../instrumentconfig'
import { answerableTo, knownThrough } from '../plugins/horizon'
import type { Page, Range } from '../plugins/types'
import { gridFor } from '../replay/timeframes'

// The one read every tile family makes: the tiles for what they hold of a window, the API for
// the rest. Tiles hold every CLOSED partition, so they answer the historical part of any window
// and only the partition still forming is missing; a window crossing that edge is answered from
// both rather than handed to the API whole, so a pan through history costs no network for the
// part already in the bucket and any gap left in the result is a real one. The split is exact:
// the tiles answer `[from, coveredTo)` and the API is asked from `coveredTo`, so nothing is
// served twice or dropped between them.
//
// The chart's bars, the book points and a tiered indicator's points each made this join for
// themselves until 2026-10-11, and they had drifted three ways apart: a page capped differently
// in each, and under a bar replay the indicators gave the tiles up, the books filtered them and
// the bars did nothing -- a pane reloaded at the cursor drew the bar forming there whole, with
// the high, low and close it would only reach later, because nothing clamps a tile.

/** What the tiles hold from the start of a window, ascending: every item of `[from, coveredTo)`
 * -- or, when the read was given a limit, at least the first `limit` of them. */
export interface Tiled<T> {
  items: T[]
  /** Exclusive: the tiles answer up to here, on the clock `date` reads. Past the window's `to`
   * when the tiles reach beyond it. */
  coveredTo: number
}

/** Under a bar replay's read clock, how far one series can be read (`readHorizon`), on the
 * clock `date` reads. */
export interface ReadHorizon {
  /** The date of the bar forming at the clock (`plugins/horizon.ts` `knownThrough`): the tiles
   * stop here, because they hold that bar whole. */
  at: number
  /** Exclusive: nothing dated here or later can be answered at all (`answerableTo`) -- `at`
   * itself when the bar forming at the clock opens exactly at it, the next bar's date when that
   * one bar is all the server can still add. Unbounded when the schedule is unknown. */
  answersTo: number
}

export interface TiledRead<T> {
  /** The window, wire clock, `to` exclusive. */
  range: Range
  /** At most this many items, or null for all of them. */
  limit: number | null
  /** Which end `limit` keeps: the FIRST n -- a plugin's page, read forwards from `from` and
   * continued from `nextFrom` -- or the LAST n, a chart window anchored at `to` (the server's
   * `limit` keeps that end of `/getbars` too). */
  keep: 'first' | 'last'
  date: (item: T) => number
  /** The tiles' share of `range`, or null when they hold nothing from its start. Given a limit
   * only when reading forwards with nothing to `admit`: the first n items are then all a
   * forward page can use. */
  tiles: (range: Range, limit: number | null) => Promise<Tiled<T> | null>
  /** The API's answer for `range`, `limit` as `keep` means it. */
  api: (range: Range, limit: number | null) => Promise<Page<T>>
  /** Under a bar replay, where the tiles stop and where any answer at all does
   * (`readHorizon`); null live. */
  horizon?: Promise<ReadHorizon | null> | ReadHorizon | null
  /** Items no caller may be handed whichever half they came from (the bar labels that are not
   * a candle open), tested before `limit` is applied so a page still holds n of the rest. */
  admit?: Promise<((item: T) => boolean) | null>
}

/** One read of `read.range`: the tiles for what they hold of it, the API for the rest. */
export async function readTiled<T>(read: TiledRead<T>): Promise<Page<T>> {
  const { range, limit, keep, date } = read
  const hint = keep === 'first' && read.admit === undefined ? limit : null
  const [tiled, horizon, admit] = await Promise.all([read.tiles(range, hint), read.horizon ?? null, read.admit ?? null])
  const pick = (items: T[]): T[] => select(items, keep, limit, admit)

  // Under a bar replay the tiles stop at the bar forming at the clock: the API, clamped by the
  // server to what had closed (`services/asof.py`) and rebuilding the forming bar from the rows
  // that had, answers from there. The horizon is the host's own (`plugins/horizon.ts`): the
  // bar forming at the clock, a bar early inside a market-closed window -- which costs only that
  // the API serves one bar the tiles hold.
  //
  // ...and the API is asked no further than anything can be answered (`answersTo`). Past the
  // bar forming at the clock nothing exists yet, and where that bar opened exactly at the clock
  // it holds nothing either, so a read of that stretch is a round trip for an empty answer. The
  // chart's widening sent one per attempt, in a row (`history.ts`): a pane reloaded after a Step
  // was seen on prod making eleven `/getbars 5s` before it drew (2026-10-28), and a newer-in-time
  // page from a Saturday cursor on prod's EURGBP 5s tiles makes four, every one `no_data`. That
  // stretch is not asked for, and a window reaching past it asks only up to it -- which also
  // makes every widening attempt's remainder the same request.
  const coveredTo = tiled === null ? range.from : Math.min(tiled.coveredTo, horizon?.at ?? Number.POSITIVE_INFINITY)
  const end = Math.min(range.to, horizon?.answersTo ?? Number.POSITIVE_INFINITY)
  if (tiled === null || coveredTo <= range.from) {
    if (end <= range.from) return { points: [], nextFrom: null }
    const page = await read.api({ from: range.from, to: end }, limit)
    return { ...page, points: pick(page.points) }
  }
  const items = coveredTo < tiled.coveredTo ? tiled.items.filter((item) => date(item) < coveredTo) : tiled.items

  let ask = limit
  if (keep === 'first' && limit !== null) {
    // A full page from the tiles alone continues from its last item, whatever lies past them.
    const page = pick(items)
    if (page.length >= limit) return { points: page, nextFrom: date(page[page.length - 1]) + 1 }
    ask = limit - page.length
  }
  if (coveredTo >= end) return { points: pick(items), nextFrom: null }
  const rest = await read.api({ from: coveredTo, to: end }, ask)
  return { ...rest, points: pick(items.concat(rest.points)) }
}

/** `items` without the ones `admit` refuses, cut to `limit` at `keep`'s end -- found walking
 * from that end, so a wide window does not test every row it will discard (at 5s a week of tile
 * rows is ~70k bars, and each bar-label test is a timezone conversion). */
function select<T>(items: T[], keep: 'first' | 'last', limit: number | null, admit: ((item: T) => boolean) | null): T[] {
  if (admit === null) {
    if (limit === null || items.length <= limit) return items
    return keep === 'first' ? items.slice(0, limit) : items.slice(-limit)
  }
  if (limit === null) return items.filter(admit)
  const kept: T[] = []
  if (keep === 'first') {
    for (let index = 0; index < items.length && kept.length < limit; index++) if (admit(items[index])) kept.push(items[index])
    return kept
  }
  for (let index = items.length - 1; index >= 0 && kept.length < limit; index--) if (admit(items[index])) kept.push(items[index])
  return kept.reverse()
}

/** Under a bar replay's read clock, how far `resolution` on `vendorSymbol` can be read: where its
 * tiles stop (the WIRE date of the bar forming at the clock) and where any answer does, on the
 * instrument's own grid. Null live -- without waiting on anything, so a live read is never held
 * up by a schedule lookup. */
export function readHorizon(vendorSymbol: string, resolution: string): Promise<ReadHorizon> | null {
  const clock = getReadClock()
  if (clock === null) return null
  return instrumentConfig(vendorSymbol).then((config) => {
    const hours = config?.marketHours
    const grid = gridFor({ timezone: hours?.timezone, dayGeometry: dayGeometryOf(hours) ?? undefined })
    return { at: knownThrough(resolution, clock, grid), answersTo: answerableTo(resolution, clock, grid) }
  })
}
