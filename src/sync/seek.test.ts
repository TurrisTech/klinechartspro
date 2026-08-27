import { describe, expect, test } from 'bun:test'
import { LIVE_EDGE_FRACTION, resolveSeekReach } from './seek'

// The one decision a synced pane has to make on its own, because the bus cannot: is a seek
// target it cannot scroll to somewhere it could FETCH, or is it simply later than the market
// has got? Getting that wrong is what put the current bar two bars from the left edge with a
// screenful of blank future after it -- klinecharts clamps the scroll rather than honouring it.

const NEWEST = 1_700_000_000_000
const MINUTE = 60_000
// Where a pane at rest keeps its current bar, and a little either side of it.
const AT_REST = LIVE_EDGE_FRACTION
const RIGHT_OF_REST = 0.95
const JAMMED_LEFT = 0.02

describe('resolveSeekReach', () => {
  test("a target inside or before this pane's tail reloads, as click-to-scroll always has", () => {
    expect(resolveSeekReach(NEWEST - 500 * MINUTE, NEWEST, false, RIGHT_OF_REST)).toBe('reload')
    // The tail itself is reachable, not past the edge -- the boundary is strict.
    expect(resolveSeekReach(NEWEST, NEWEST, false, RIGHT_OF_REST)).toBe('reload')
  })

  test('a pane with no data yet reloads whatever the target is', () => {
    expect(resolveSeekReach(NEWEST + MINUTE, undefined, false, null)).toBe('reload')
  })

  test('past a PARKED tail still reloads: that tail is not the live edge', () => {
    // A pane parked in history by an earlier seek holds bars that stop well short of the
    // present, so a target newer than them is very likely a real instant with real bars.
    expect(resolveSeekReach(NEWEST + 500 * MINUTE, NEWEST, true, RIGHT_OF_REST)).toBe('reload')
    expect(resolveSeekReach(NEWEST + 500 * MINUTE, NEWEST, true, JAMMED_LEFT)).toBe('reload')
  })

  test('past a live tail whose current bar is at rest: leave the pane exactly as it is', () => {
    expect(resolveSeekReach(NEWEST + MINUTE, NEWEST, false, RIGHT_OF_REST)).toBe('stay')
    expect(resolveSeekReach(NEWEST + MINUTE, NEWEST, false, AT_REST)).toBe('stay')
    // However far into the future the click pointed -- there is nothing further to go to.
    expect(resolveSeekReach(NEWEST + 5_000 * MINUTE, NEWEST, false, RIGHT_OF_REST)).toBe('stay')
  })

  test('a current bar that is not at rest comes back to the default position', () => {
    // Scrolled off the tail entirely -- off to the RIGHT, which scores arbitrarily high.
    expect(resolveSeekReach(NEWEST + MINUTE, NEWEST, false, 4.2)).toBe('live-edge')
    expect(resolveSeekReach(NEWEST + MINUTE, NEWEST, false, null)).toBe('live-edge')
    // ON SCREEN but jammed against the left edge -- the state this whole rule exists to
    // undo, and the one 'is it visible?' used to answer 'yes, leave it there' to.
    expect(resolveSeekReach(NEWEST + MINUTE, NEWEST, false, JAMMED_LEFT)).toBe('live-edge')
    // Anywhere short of the default position, not just the pathological end of it.
    expect(resolveSeekReach(NEWEST + MINUTE, NEWEST, false, LIVE_EDGE_FRACTION - 0.01)).toBe(
      'live-edge'
    )
  })
})
