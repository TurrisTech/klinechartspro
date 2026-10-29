// THE NEXT LANDING, READ BY THE SERVER BEFORE THE PRESS.
//
// The look-ahead knows where the next Next alert press will land (alerts.ts), and the session
// says so as soon as it does (`ReplaySessionOptions.warmLanding`). What a landing costs is mostly
// its first read of a region of history the server has not built yet: the MTF overlays'
// `/mtf/graph` reads the signals of every graph root's run back from the window -- often months
// -- and walks them: against prod data, EURUSD's rank 85 overlay took 0.2-4.9 s for a landing a
// week to two months on, against ~50 ms once the server holds the region. So each overlay's read
// at the landing is sent ahead, under the read clock the landing will set, for the server to
// build and keep (`PluginHost.warmAhead`, plugin.ts `warm`), and the press's own read is then a
// slice of what it holds.
//
// The rules a warm-up keeps:
// - in the background, and after the wall's own reads: it waits until no pane is loading bars
//   through the replay's datafeed and no plugin read is in flight, on two looks in a row -- a
//   reloaded pane's bars arrive before its overlays' reads go out, and in between the wall looks
//   idle. The bars the user is looking at are read before those of bars they may never press to;
// - not while an advance runs, nor once the cursor is there: a press that got there first reads
//   the landing itself;
// - one landing at a time: a later call drops one still waiting, and the host sends nothing for a
//   store already warmed for that instant -- the server keeps only a few spans of one overlay
//   configuration (wdashboard-server services/mtfgraph.py MAX_SPANS = 3: a live chart, the region
//   the replay stands in, the one it lands in next), so a stale warm-up costs one of them;
// - never on a live wall: only a replay session says where it will land.

/** What the warm-up needs from the wall: client/replay/index.ts wires it to the plugin host, the
 * feed hub and the session. Structural, so a test hands in a stub. */
export interface LandingWall {
  /** Resolves once no plugin read is in flight, or at `timeoutMs` (`PluginHost.settled`). */
  settled(timeoutMs: number): Promise<void>
  /** Bar loads the panes have in flight through the replay's datafeed (`ReplayFeedHub`). */
  loadsInFlight(): number
  /** An advance is running. */
  busy(): boolean
  /** Where the replay stands. */
  cursor(): number
  /** Send the warm-up for a read clock of `at`; resolves with how many reads went out
   * (`PluginHost.warmAhead` over `ReplayFeedHub.landingRange`). */
  warm(at: number): Promise<number>
}

/** The longest a warm-up waits for the wall to go quiet. Past it, it is sent anyway: a wall still
 * reading after this long is itself reading a cold region, and the next press would be another. */
export const LANDING_QUIET_TIMEOUT_MS = 5_000

/** Between two looks at whether the wall is quiet. */
export const LANDING_QUIET_POLL_MS = 50

export class LandingWarmer {
  private ticket = 0

  constructor(
    private readonly wall: LandingWall,
    private readonly timing: { timeoutMs: number; pollMs: number } = { timeoutMs: LANDING_QUIET_TIMEOUT_MS, pollMs: LANDING_QUIET_POLL_MS }
  ) {}

  /** Warm what the wall will read at `at` once the wall is quiet. Resolves with how many reads
   * went out: none when a later call, an advance, a press landing there or `dispose` got there
   * first. */
  async warm(at: number): Promise<number> {
    const ticket = ++this.ticket
    const deadline = Date.now() + this.timing.timeoutMs
    let calm = 0
    while (calm < 2 && Date.now() < deadline) {
      await this.wall.settled(Math.max(0, deadline - Date.now()))
      calm = this.wall.loadsInFlight() === 0 ? calm + 1 : 0
      if (calm < 2) await new Promise((resolve) => setTimeout(resolve, this.timing.pollMs))
      if (ticket !== this.ticket) return 0
    }
    // A press under way, or one that has landed there since: the panes read it themselves.
    if (this.wall.busy() || this.wall.cursor() >= at) return 0
    return this.wall.warm(at)
  }

  /** Drop any warm-up still waiting (the replay was left). */
  dispose(): void {
    this.ticket++
  }
}
