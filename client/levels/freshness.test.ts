import { describe, expect, test } from 'bun:test'
import {
  caughtUp,
  lastClose,
  levelsStaleAt,
  MAX_RECHECK_MS,
  MIN_RECHECK_MS,
  parseWatermark,
  recheckDelay,
  SETTLE_WINDOW_MS
} from './freshness'
import { nextSessionAnchor } from '../replay/timeframes'

// When to look at a level book again. The rule has to answer three questions and it must
// answer all of them definitely: is the book current, is a late one worth waiting for, and
// when exactly is the next check-in. The third is the one that bites — "poll until it turns
// up" has no answer when it never turns up.

/** Epoch ms of a wall-clock reading in New York. Spelled out rather than imported, so the
 * expectations do not lean on the code under test. */
function ny(text: string, offsetHours: number): number {
  const sign = offsetHours < 0 ? '-' : '+'
  const hh = String(Math.abs(offsetHours)).padStart(2, '0')
  return Date.parse(`${text.replace(' ', 'T')}:00.000${sign}${hh}:00`)
}
const EDT = -4
const EST = -5
const MINUTE = 60_000
const HOUR = 3_600_000

// 2026-08-21 is a Friday, so the week's candle closes at 17:00 that day; the month's closes
// at 17:00 on 2026-08-31, a Monday — the shape that makes this worth doing, since a Monday
// close leaves the rest of the week to be wrong in.
const FRIDAY_CLOSE = ny('2026-08-21 17:00', EDT)
const MONDAY_MONTH_CLOSE = ny('2026-08-31 17:00', EDT)

/** The wire states a watermark as the last consumed bar's canonical date (open + 7h). */
function wire(openText: string, offset = EDT): number {
  return ny(openText, offset) + 7 * HOUR
}

describe('lastClose', () => {
  test('mid-week, the week that closed last Friday', () => {
    expect(lastClose('1W', ny('2026-08-25 09:30', EDT))).toBe(FRIDAY_CLOSE)
  })

  test('exactly ON a close, that close -- not the one before it', () => {
    // The instant a client refreshes at. Reporting the previous close here would declare the
    // feed caught up at the only moment it cannot possibly be.
    expect(lastClose('1W', FRIDAY_CLOSE)).toBe(FRIDAY_CLOSE)
    expect(lastClose('1M', MONDAY_MONTH_CLOSE)).toBe(MONDAY_MONTH_CLOSE)
  })

  test('a millisecond before a close, the one before it', () => {
    expect(lastClose('1W', FRIDAY_CLOSE - 1)).toBe(ny('2026-08-14 17:00', EDT))
  })

  test('over the weekend, still Friday -- no candle closes in the closed window', () => {
    expect(lastClose('1W', ny('2026-08-22 12:00', EDT))).toBe(FRIDAY_CLOSE)
    expect(lastClose('1W', ny('2026-08-23 16:00', EDT))).toBe(FRIDAY_CLOSE)
  })

  test('monthly closes on the last MARKET day, not the last calendar day', () => {
    // August 2026 ends on a Monday, so the month's candle closes then and not on the 30th.
    expect(lastClose('1M', ny('2026-09-02 10:00', EDT))).toBe(MONDAY_MONTH_CLOSE)
  })

  test('it is never in the future', () => {
    for (const at of [
      ny('2026-08-21 16:59', EDT),
      FRIDAY_CLOSE,
      ny('2026-08-22 03:00', EDT),
      ny('2026-11-01 12:00', EST),
      ny('2026-03-08 12:00', EDT)
    ]) {
      for (const code of ['1W', '1M']) expect(lastClose(code, at)).toBeLessThanOrEqual(at)
    }
  })
})

describe('caughtUp', () => {
  test('a feed that consumed the week that just closed is caught up', () => {
    // The bar opening Sunday 2026-08-16 17:00 is the one that closed Friday 17:00.
    expect(caughtUp('1W', wire('2026-08-16 17:00'), ny('2026-08-25 09:30', EDT))).toBe(true)
  })

  test('a feed one bar behind is not', () => {
    expect(caughtUp('1W', wire('2026-08-09 17:00'), ny('2026-08-25 09:30', EDT))).toBe(false)
  })

  test('"declared, nothing consumed yet" is never caught up', () => {
    // 0 is the server's sentinel for a series with no values. Taking the close of "the bar
    // at the epoch" would be meaningless, so it is answered directly.
    expect(caughtUp('1W', 0, ny('2026-08-25 09:30', EDT))).toBe(false)
    expect(caughtUp('1W', -1, ny('2026-08-25 09:30', EDT))).toBe(false)
  })
})

describe('recheckDelay', () => {
  test('proportional to how long the close has gone unanswered, floored and capped', () => {
    expect(recheckDelay(0)).toBe(MIN_RECHECK_MS)
    expect(recheckDelay(10 * MINUTE)).toBe(5 * MINUTE)
    expect(recheckDelay(4 * HOUR)).toBe(MAX_RECHECK_MS)
  })

  test('never below the floor -- the first minute must not become a poll loop', () => {
    for (const late of [0, 1, 1000, MIN_RECHECK_MS, 59_000]) {
      expect(recheckDelay(late)).toBeGreaterThanOrEqual(MIN_RECHECK_MS)
    }
  })

  test('never above the cap -- a long outage stays at two cheap revalidations an hour', () => {
    for (const late of [HOUR, 5 * HOUR, 400 * HOUR]) {
      expect(recheckDelay(late)).toBeLessThanOrEqual(MAX_RECHECK_MS)
    }
  })
})

describe('levelsStaleAt -- caught up', () => {
  const caught = { '1W': wire('2026-08-16 17:00'), '1M': wire('2026-07-31 17:00') }

  test('the horizon is the next 17:00, the earliest a book can change', () => {
    const at = ny('2026-08-25 09:30', EDT)
    expect(levelsStaleAt(at, caught)).toBe(ny('2026-08-25 17:00', EDT))
  })

  test('a live tick stream does not move it -- no candle closed', () => {
    const first = ny('2026-08-25 09:30', EDT)
    expect(levelsStaleAt(first + 1000, caught)).toBe(levelsStaleAt(first, caught))
  })
})

describe('levelsStaleAt -- behind, and worth waiting for', () => {
  // The gap this whole module exists for: 17:00 is when the candle closes, and the levels for
  // it do not exist until the bar has been downloaded, stored, published, consumed and
  // written. A client that refreshes at 17:00:01 lands inside that.
  const behind = { '1W': wire('2026-08-09 17:00') }

  test('seconds after the close, look again in the floor delay', () => {
    const at = FRIDAY_CLOSE + 5_000
    expect(levelsStaleAt(at, behind)).toBe(at + MIN_RECHECK_MS)
  })

  test('minutes after, back off proportionally', () => {
    const at = FRIDAY_CLOSE + 20 * MINUTE
    expect(levelsStaleAt(at, behind)).toBe(at + 10 * MINUTE)
  })

  test('the delay is capped, so a long wait does not become a long silence', () => {
    const at = MONDAY_MONTH_CLOSE + 5 * HOUR
    expect(levelsStaleAt(at, { '1M': wire('2026-06-30 17:00') })).toBe(at + MAX_RECHECK_MS)
  })

  test('the SOONEST interval wins when only one is behind', () => {
    const at = MONDAY_MONTH_CLOSE + 2 * HOUR
    const both = { '1W': wire('2026-08-16 17:00'), '1M': wire('2026-06-30 17:00') }
    // 1W closed the previous Friday and is caught up; 1M closed two hours ago and is not.
    expect(levelsStaleAt(at, both)).toBe(at + MAX_RECHECK_MS)
  })

  test('the horizon is never past the calendar one, whatever the constants are tuned to', () => {
    // With today's numbers the polling branch always lands first (the settle window plus the
    // capped delay is under a day), so the clamp is a guard rather than a live path. It is
    // the contract all the same: a horizon further out than knowing nothing at all would be
    // worse than useless.
    const stuck = { '1W': wire('2026-08-09 17:00'), '1M': wire('2026-06-30 17:00') }
    for (let minutes = 0; minutes < 60 * 26; minutes += 7) {
      const at = FRIDAY_CLOSE + minutes * MINUTE
      const horizon = levelsStaleAt(at, stuck)
      expect(horizon).toBeGreaterThan(at)
      expect(horizon).toBeLessThanOrEqual(nextSessionAnchor(at))
    }
  })
})

describe('levelsStaleAt -- behind, and NOT coming', () => {
  // The case that makes "poll until the watermark moves" wrong: a bar that is not written
  // today looks exactly like one that is thirty seconds away. The feed pod may be down, the
  // month may never have been backfilled (dev's 1M books for 27 symbols are nearly empty by
  // design), the instrument may have stopped trading.

  test('past the settle window, stop asking and take the calendar horizon', () => {
    const at = FRIDAY_CLOSE + SETTLE_WINDOW_MS
    expect(levelsStaleAt(at, { '1W': wire('2026-08-09 17:00') })).toBe(
      ny('2026-08-22 17:00', EDT)
    )
  })

  test('a series that has never been backfilled does not poll forever', () => {
    // 1M at the epoch, asked mid-month: the last monthly close was weeks ago, so this is not
    // a bar on its way. One horizon, at the next 17:00, for as long as it stays that way.
    const at = ny('2026-08-18 11:00', EDT)
    expect(levelsStaleAt(at, { '1M': 0 })).toBe(ny('2026-08-18 17:00', EDT))
  })

  test('an interval the server did not name is nothing to wait for', () => {
    // The server omits an interval it has no series for. An empty header is a definite "this
    // server computes none of what you asked for" -- not "computed through the epoch".
    const at = FRIDAY_CLOSE + MINUTE
    expect(levelsStaleAt(at, {})).toBe(ny('2026-08-22 17:00', EDT))
  })

  test('a server that says nothing at all degrades to the calendar horizon', () => {
    const at = FRIDAY_CLOSE + MINUTE
    expect(levelsStaleAt(at, null)).toBe(ny('2026-08-22 17:00', EDT))
  })

  test('however long the outage, there is always a next check-in and it is bounded', () => {
    // A month of a dead feed, walked one horizon at a time. Every close is a fresh chance for
    // the feed to have recovered, so each one re-opens the settle window and is polled at --
    // deliberately. What must not happen is unbounded polling.
    let at = FRIDAY_CLOSE
    const stuck = { '1W': wire('2026-08-09 17:00'), '1M': wire('2026-06-30 17:00') }
    const gaps: number[] = []
    const deadline = FRIDAY_CLOSE + 30 * 24 * HOUR
    while (at < deadline && gaps.length < 10_000) {
      const next = levelsStaleAt(at, stuck)
      expect(next).toBeGreaterThan(at) // always forward: a horizon at or before now spins
      gaps.push(next - at)
      at = next
    }
    // Against a flat 30s poll's 86,400 over the same month.
    expect(gaps.length).toBeLessThan(250)
    // And it is not *mostly* rapid polling: at least half the waits are the full cap or the
    // day-long calendar horizon. The short ones are the first hour after each close, which is
    // exactly where a feed that is merely late would turn up.
    const sorted = [...gaps].sort((a, b) => a - b)
    expect(sorted[Math.floor(sorted.length / 2)]).toBeGreaterThanOrEqual(MAX_RECHECK_MS)
  })
})

describe('levelsStaleAt -- DST', () => {
  test('the calendar horizon is a wall-clock 17:00 through both transitions', () => {
    const caught = { '1W': wire('2026-10-25 17:00', EDT) }
    const autumn = ny('2026-10-31 18:00', EDT) // fall-back is 2026-11-01
    expect(levelsStaleAt(autumn, caught)).toBe(ny('2026-11-01 17:00', EST))
    const spring = ny('2026-03-07 18:00', EST) // spring-forward is 2026-03-08
    expect(levelsStaleAt(spring, { '1W': wire('2026-03-01 17:00', EST) })).toBe(
      ny('2026-03-08 17:00', EDT)
    )
  })
})

describe('parseWatermark', () => {
  test('reads what the server writes', () => {
    expect(parseWatermark('1M=1782878400000,1W=1787529600000')).toEqual({
      '1M': 1782878400000,
      '1W': 1787529600000
    })
    expect(parseWatermark('1W=0')).toEqual({ '1W': 0 })
  })

  test('an EMPTY header is an answer; an ABSENT one is not', () => {
    // Empty: the server answered and named no interval -- nothing to wait for. Absent: an
    // older server, or a header a cross-origin fetch could not read -- we know nothing.
    expect(parseWatermark('')).toEqual({})
    expect(parseWatermark(null)).toBeNull()
    expect(parseWatermark(undefined)).toBeNull()
  })

  test('it never throws on a header it cannot make sense of', () => {
    expect(parseWatermark('garbage')).toEqual({})
    expect(parseWatermark('1W=,=5,,1M=7')).toEqual({ '1M': 7 })
    expect(parseWatermark('1W=notanumber')).toEqual({})
  })
})
