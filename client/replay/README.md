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
| `persist.ts` | The state blob (`serialize`/`restore`) and the page-level replay intent. |
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
(fake source, fake signals), persist round trip. `scripts/sync-engine-fixtures.sh` vendors the
fixtures from wdashboard-server; `--check` (run by `fixtures.test.ts`) fails if they differ.
