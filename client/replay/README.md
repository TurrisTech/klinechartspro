# client/replay — bar replay

Replay stored history from a chosen instant on any wall, stepping a clock forward — by any
timeframe or multiple, or to the next occurrence of an armed signal — with the account,
orders and fills behaving exactly as they do in paper trading. The fill engine runs **in the
client** (a TypeScript port of `wdashboard_server/sim/engine.py`); the server only clamps its
reads to the cursor (`asof`) and keeps the state blob.

## Modules

Everything below the glue line is testable with no chart, no network and no DOM.

| module | role |
|---|---|
| `timeframes.ts` | PURE. Interval algebra (`divides`, `gcdInterval`, `defaultBase`, `validateBase`, `finerStored`) and the boundary math mirroring wmarkettypes' `Interval` (`intervalStart` / `intervalEnd` / `nextIntervalStart` / `isMarketOpen`, `advanceTarget`) on the New York wall clock. Parity asserted against `fixtures/boundaries.json`, generated from wmarkettypes. |
| `engine.ts` | PURE. The port of `engine.py`: same types (the wire's `SimOrder`/`SimTrade`), same events, same ids (`o1`, `t2`, …), no I/O. Parity asserted by running `fixtures/engine_cases.json` — the *same file* the Python suite runs. |
| `clock.ts` | PURE. `planAdvance(cursor, request, armed)` → target / stopAt / reason; `intersectsWorking` (the descend-to-finer rule); `hasWorking`. |
| `cache.ts` | `BarCache` per (instrument, timeframe) over an injected `BarSource`: a contiguous run ahead of an anchor; **walked** (`ensure`/`take`) or **seeked** (`seek`: dump and reload), never a partial append onto a stale run. `composeForming`, `nonWeekendGaps`. |
| `signals.ts` | `SignalBook`: catalogue, starred set, armed set (a signal is armed *on a resolution*), `nextSignalAt` over an injected `SignalSource`, keyed off `effective`. |
| `pick.ts` | PURE. `randomStart`: a uniform instant out of a range, snapped down to a base candle open. The rng is injected. |
| `persist.ts` | The state blob (`serialize`/`restore`) and the page-level replay intent. |
| `watches.ts` | Price watches over the walk: the `price` source built from base bars, and the local backend `client/watch` draws. |
| — glue — | |
| `source.ts` | `HttpBarSource` (`/getbars columns=all`, paged, 413-split) and `HttpSignalSource` (`/plugins/{id}/signals`). The only module here that fetches. Both read past the page-wide read clock on purpose (`asof: null`). |
| `feed.ts` | `ReplayDatafeed` (the pane datafeed: history clamped by the read clock, windows re-anchored to end at the cursor, no stream) and `ReplayFeedHub` (pushes stepped bars into every pane — see "the v1 bug" below). Also `inertStream`. |
| `session.ts` | `ReplayTradingSession implements TradingSession` over the engine and the caches, and the `ReplayController` the controls drive. Owns the walk. |
| `controls.ts` | The controls that fill the window (`../chrome/window.ts`), and the start dialog (plain DOM, `kc-*`/`wd-replay-*`). |
| `index.ts` | `mountBarReplay` — mirrors `mountPaperTrading` on the shared `mountTradingDock`; `startReplayFlow`, `bootReplay`, `clearReplay`. |

## The controls

A **dockable window** (`../chrome/window.ts`), floating over the chart by default — a strip
nailed inside the account panel cost the wall ~90px it never gave back, and the wall is the
thing being replayed. On screen there is only what every step uses:

```
+-------------------------------------------------+
| ::  REPLAY  Aug 20, 19:00  [Step] [Exit]  ^ ⇲   |   the title bar is the drag handle
+-------------------------------------------------+
| ADVANCE [1h v] x [1]   [Next signal]            |
| Advanced 1 bar                                  |   only once an advance has stopped
| [Signals 2] [Base 1h] [Account]                 |   one panel open at a time
+-------------------------------------------------+
```

Step is in the TITLE BAR, so the window rolled up to that bar alone (36px tall) still steps.
The signal list, the base timeframe and pause-on-fill are behind their toggles; **Account**
shows and hides the account window, which starts **closed** — an advance that produced events
(a fill, a close) opens it itself, on the tab the event landed in.

**Docked** (the ⇲ control, or dragged onto the bottom of the chart) the rows lay out along one
line instead of stacking, and the controls sit *above* the account window in the column
(`order` 10 against 20). Everything else about the two modes — the drag, the roll-up, the
persistence — belongs to the window, not here.

## Choosing where to start

The start dialog takes a date, a balance and a base. Next to the date is **Random**, and under
it an optional **date range** it draws from — unchecked, that is the last two years ending a
day before the newest bar.

A draw is `from + random() * span` floored to a `base` candle open, and nothing else. It is
**not** filtered to market-open instants and the store is **not** probed first: a draw in the
weekend snaps onto the candle that most recently opened, which is what the wall draws for any
such instant anyway, and a draw the store has no bars for opens an empty wall you press Random
again on. Both are cases the client already handles, so neither is worth carrying here.

The range's two bounds are **days**, inclusive of both (From is that day's first instant, To
its last): a draw range does not need a time of day, and two `datetime-local`s side by side in
a 28rem dialog render their value under the picker icon.

Because the snap is a floor, a pick can sit up to one candle before the range's own start.

## The clock

A replay has a **cursor**. `config.ts`'s `setReadClock(cursor)` makes `apiUrl` add
`asof=<cursor>` to *every* read the client makes — bars, indicator values, plugin points,
levels, signals — in one place. The server (`services/asof.py`) answers only what had closed
by then, plus the forming bar rebuilt from finer stored rows. After a step, `index.ts` moves
the clock, pushes bars, then `pluginHost.invalidateFrom(oldCursor)` so every plugin store
forgets the coverage that clock made incomplete. **Each source forgets from its own interval's
horizon, not from the cursor** (`plugins/horizon.ts`): the answer it got was final only through
the bar IT had forming, so a stop at 11:15 leaves a 15m source whole and a 1h source one bar
short. Forgetting from the cursor instead left every coarser pane's forming bar filed as
fetched-and-empty for good — a permanent blank column in its sub-pane, one per stop.
**Levels are refetched only when the cursor crosses a
daily boundary**: they are computed on 1W/1M, so one can only appear or be spent at a 17:00
market-day close. Invalidating them every step cost three slow `/levels` reads per 15-minute
step, which saturated the browser's six-connection budget and starved the panes' own history
loads.

## The base timeframe

The interval the engine walks. It must be a common denominator of every pane interval and
stored for the instrument (`validateBase`); the default is the GCD of the intervals in use
floored to the coarsest stored interval dividing it (`defaultBase`): 3m+5m → 1m, 1h+4h → 1h,
15m+1h → 1m, 1D+1W → 1D.

## Advancing

`advanceBy(request)`: plan the target on the boundary rules (`advanceTarget`, never a
timedelta), ask the signal book for armed occurrences in `(cursor, target]`, stop at the
earliest of those (**an intervening signal wins**), else the target; then **walk or seek**.

**Walk vs seek.** `canFill` (clock.ts) asks whether any bar could produce an event — a
resting limit/stop, or an open trade carrying a stop loss or take profit. When it is false
the account cannot change however the price moves, so the advance **seeks**: the cursor lands
on the same instant, `quoteAt` takes the closing quote there, and `AdvanceResult.walked` is
false. (A months-long "next signal" jump used to feed ~10⁵ bars to the engine for nothing —
measured at 5s per 20 market days at a 1m base.) When it is true the advance **walks** base
bars from the cache, feeding each to the engine — or, when a candle's band intersects a working order or
an open trade's stop/target, the finer stored bars inside it instead (recursively; a per-span
refinement that never lowers the base). "Pause on fill" stops at the filling bar. `nextSignal`
is an advance to the end of the data.

## Price watches

The same lines, the same right-click, the same dialog and the same Notification Center as a
live wall — over the replay's market instead of the server's. `client/watch` is a **view**
over a `WatchApi`; `watches.ts` is a second implementation of that interface
(`LocalWatchRegistry`, a port of the server's registry policy) plus the source that feeds it.
`client/index.ts` hands one or the other to `mountPriceWatches`; nothing in `client/watch`
knows which.

**The observations are the base bars the engine walks.** Not the pane's interval (three panes
would give three answers), not a refinement's finer parts (whether an order happens to be
resting must not change when a watch fires), and not the forming bar (which is rebuilt as the
cursor moves). A base bar becomes a `price` observation — mid, bid, ask, spread — carrying the
bar's **range** as `Sample`'s low/high band, which is what lets a level between two closes be
seen at all: a wick through it counts, exactly as it does for the server's `bar` source.
Consequence worth stating: a watch is answered at the base interval, so a 1h base sees a 1h
bar's range and a 5s base a 5s one.

Three things follow, each of which was a decision:

- **An armed watch makes the advance WALK.** `canFill` asks whether the *account* could
  change; with nothing resting and nothing protected an advance seeks, which would step over
  the whole span a watch was placed to see. `ReplayObserver.needsBars()` is the other half of
  that question, and `session.ts` ORs the two.
- **A watch is seeded from the bar the cursor stands on** (`session.barAt`), because arming a
  crossing without a baseline makes it fire on its first bar. A restored session keeps the
  STORED baseline instead — the reading the watch was armed with — which is the same decision
  the server's `restore()` makes.
- **The event clock is the bar's close, never the wall clock.** A session replaying 2024 has
  a 2024 cooldown. The notification itself is still *dated* when it was raised, so it sorts
  with everything else in the centre; the replay instant is in its body and in `data.eventAt`.

Watches ride in the state blob (`persist.ts` `watches`), baseline and all, so a reload finds
them where they were — status, fire count and all. **Their notifications do not**: those are
raised locally and the centre holds no persistence of its own, so the alert rows are gone
after a reload while the grey line that raised them is still there.

**Nothing here reaches `/watch`.** A replay watch is created, evaluated, fired and stored
entirely in this tab: `LocalWatchRegistry` imports nothing that fetches, and the rows are
persisted in the replay's own `sim` state blob, which the server keeps opaque. Exit rebuilds
the wall, `mountPriceWatches` falls back to `loadWatches()` and the live wall is drawing the
server's watches again — the replay's are gone with the session that held them. The one thing
that does cross over is a **notification**, because the centre is a page-level singleton and a
row about something that happened should not vanish when you leave; it is tagged `replay`
rather than `watch` so it cannot be mistaken for an alert about the live market.

A replay walks one instrument, so `canWatch` refuses any other pane's — a stored line nothing
could ever evaluate is worse than a menu that says why.

## The v1 bug, and why it cannot recur

v1 pushed bars through a forming-bar path gated by a separately maintained `newest`
watermark that drifted from the chart. Here the hub keeps no watermark: what to push is
computed from `chart.getDataList().at(-1)` every time, the chart's tail is asserted against
what was pushed after every step (`PushReport.problem`), and a jump longer than
`SEEK_THRESHOLD_BARS` reloads the pane's window at the cursor (`chart.resetData()`, clean
seek) instead of appending. Grid alignment: a composed forming bar is labelled by
`intervalStart` (+7h for daily-and-coarser, `toWireDate`), the same label `/getbars` gives the
whole bar.

## Persistence

`sim_session` with `mode='replay'` via `PUT /sim/sessions/{id}/state` (optimistic `rev`); the
blob holds cursor, engine state, base, advance setting, pause-on-fill, starred and armed
sets. The intent (session id + cursor) lives in `sessionStorage` so it survives the wall
rebuild entering/leaving replay needs.

## Tests

`bun test client/replay`: fixtures parity (engine + boundaries), the base table and
rejections, boundary math across Friday 17:00, the planner's signal-beats-target precedence,
the intersection rule descending / not descending, cache walk-vs-seek, the session walk
(fake source, fake signals), persist round trip, and `watches.test.ts` — a real session over a
synthetic path: an armed watch forcing the walk, firing on the base bar that reaches the
level, the band (a level between two closes), the blob round trip and the one-instrument
refusal. The firing RULE is tested against the server's own fixtures in `client/watch`. `scripts/sync-engine-fixtures.sh` vendors the
fixtures from wdashboard-server; `--check` (run by `fixtures.test.ts`) fails if they differ.
