# client/replay — bar replay

Replay stored history from a chosen instant on any wall, stepping a clock forward — by any
timeframe or multiple, or to where the next of your alerts triggers (**Next alert**) — with the account,
orders and fills behaving exactly as they do in paper trading. The fill engine runs **in the
client** (a TypeScript port of `wdashboard_server/sim/engine.py`); the server only clamps its
reads to the cursor (`asof`) and keeps the state blob.

## Modules

Everything below the glue line is testable with no chart, no network and no DOM.

| module | role |
|---|---|
| `timeframes.ts` | PURE. Interval algebra (`divides`, `gcdInterval`, `defaultBase`, `validateBase`, `finerStored`) and the boundary math mirroring wmarkettypes' `Interval`, for all three schedules the store carries (`schedule*`), and the **`CandleGrid`** the replay asks every boundary question of: those functions bound to one instrument's zone and day geometry (`gridOf`, `gridFor(symbolInfo)`). Parity asserted against `fixtures/boundaries.json`, generated from wmarkettypes. The unparameterised `intervalStart`/… are the FX week, kept for the FX-only callers outside the replay. |
| `engine.ts` | PURE. The port of `engine.py`: same types (the wire's `SimOrder`/`SimTrade`), same events, same ids (`o1`, `t2`, …), no I/O. Parity asserted by running `fixtures/engine_cases.json` — the *same file* the Python suite runs. |
| `clock.ts` | PURE. `planAdvance(cursor, request, alert)` → target / stopAt / reason; `intersectsWorking` (the descend-to-finer rule); `canFill`. |
| `cache.ts` | `BarCache` per (instrument, timeframe) over an injected `BarSource`: a contiguous run ahead of an anchor; **walked** (`ensure`/`take`) or **seeked** (`seek`: dump and reload), never a partial append onto a stale run. `composeForming`, `nonWeekendGaps`. |
| `alerts.ts` | `ReplayAlerts`: the user's enabled client alerts on this instrument (`client/alerts`) and the search that finds where the next one triggers -- what Next alert runs to. |
| `pick.ts` | PURE. `randomStart`: a uniform instant out of a range, snapped down to a base candle open. The rng is injected. |
| `results.ts` | PURE. `replayResults`: the session's score from its snapshot -- net and realised P&L, win rate, averages, profit factor, expectancy, best/worst, the max drawdown of the realised curve -- and the rows the Results panel draws. |
| `player.ts` | PURE. `ReplayPlayer`: Play/Pause -- the Step pressed again and again at a pace, stopping on any stop that is not the target. The step, the sleep and the "has the wall caught up" wait are injected. |
| `format.ts` | PURE. `formatClock`: an instant on the New York clock WITH its weekday ("Sat, Sep 26, 20:00"). |
| `persist.ts` | The state blob (`serialize`/`restore`) and the page-level replay intent. |
| `watches.ts` | Price watches over the walk: the `price` source built from base bars, and the local backend `client/watch` draws. |
| — glue — | |
| `source.ts` | `HttpBarSource` (`/getbars columns=all`, paged, 413-split). The only module here that fetches bars. It reads past the page-wide read clock on purpose (`asof: null`), and so does the alert search built on it. |
| `feed.ts` | `ReplayDatafeed` (the pane datafeed: history clamped by the read clock, windows re-anchored to end at the cursor, no stream) and `ReplayFeedHub` (pushes stepped bars into every pane — see "the v1 bug" below). Also `inertStream`. |
| `session.ts` | `ReplayTradingSession implements TradingSession` over the engine and the caches, and the `ReplayController` the controls drive. Owns the walk. |
| `controls.ts` | The controls that fill the window (`../chrome/window.ts`), their keys, and the start dialog (plain DOM, `kc-*`/`wd-replay-*`). |
| `pickbar.ts` | The start dialog's **On chart**: hover a bar, see what the replay will hide, click it. |
| `index.ts` | `mountBarReplay` — mirrors `mountPaperTrading` on the shared `mountTradingDock`; `startReplayFlow`, `bootReplay`, `clearReplay`. |

## The controls

A **dockable window** (`../chrome/window.ts`), floating over the chart by default — a strip
nailed inside the account panel cost the wall ~90px it never gave back, and the wall is the
thing being replayed. On screen there is only what every step uses:

```
+--------------------------------------------------------------+
| ::  REPLAY  EURUSD  Thu, Aug 20, 19:00                 ^ ⇲   |   the title bar: the drag handle
+--------------------------------------------------------------+
| [▶] [ Step ]  [1h v] × [1]  every [1 s v]                    |   transport
| [Next alert]  Stepped 1h                                     |   the status, once there is one
|--------------------------------------------------------------|
| [Alerts 2] [Base 1h] [Results] [Account] [Trade]   Exit replay |   the alert manager; one panel
+--------------------------------------------------------------+
```

**The title bar acts on nothing** (user, 2026-10-04: "move the Step and play button out of the
title area"): it names the instrument and the replay's clock and carries the window's own roll-up
and dock controls, so a press on the drag handle is only ever a drag. Play and Step lead the body,
**each beside the setting it uses** — the Step button reads as the label of "1h × 1", the pace
belongs to Play — and Exit ends the footer, as far from them as the card allows. Rolled up, the
window shows the clock and the keys still play and step. The clock carries the **weekday**: a
cursor lands in the FX weekend as readily as anywhere, and "Sep 26, 20:00" does not say nothing
trades then.

**An advance shows only once it has run for 300 ms** (`BUSY_REVEAL_MS`), or reports walk
progress, or a Stop is pressed. A one-candle step lands well inside that, and flipping Step to a
red Stop and greying the rest out on every press — twice a second while playing — was noise. In
that first moment a press on Step is ignored rather than taken as a Stop, so a double click
cannot cancel the step it is waiting on. While playing, the status reads **"Playing every ½ s"**,
which gives way to why the play stopped.

**Keys** (TradingView's, so the hands already know them): **Shift+→** is Step — Stop while an
advance runs, but a held key's *repeat* never cancels the step it is waiting on — and
**Shift+↓** is Play/Pause. Shift+→ is also klinecharts' own "scroll right"; on a replay wall
the replay takes it (a `window` listener in the capture phase, which stops the event before
klinecharts' `document` listener hears it). A key typed into a field is the field's.

**Play** (`player.ts`) presses Step again and again, one step every `EVERY` (¼ s to 5 s,
remembered per browser), and **stops by itself on anything but reaching the target** — a fill
pause, a firing watch, a cancel, the end of the data: each is the replay
saying "look at this". The pace is a floor, not a metronome: the next step also waits for the
plugin host to settle (`pluginHost.settled`, bounded at 5 s), because every step moves the read
clock and every plugin on every pane refetches its forming bar — a ¼ s pace must not queue
reads faster than the server answers them. A Step, Next alert or Exit pressed by hand ends the
play. (In a background tab Chrome stretches the pace to its timer clamp, ~1 s; nobody is
watching it there.)

**Results** is the third panel: net P&L large, then the session's figures in the trading kit's
`FigureList` (`results.ts`) -- closed trades, win rate, profit factor, expectancy, average win and
loss, best and worst, the max drawdown of the realised balance curve, what is open, how much
market time has been replayed. It follows the account between advances too (`subscribe`), so a
trade closed from the chart re-scores at once. Before the first close it shows only the open
position and the time replayed: a column of dashes is noise.

**The wall is framed** while a replay is mounted: a thin edge in the replay's orange round the
chart grid (`.wd-replay-wall`, on the container), so the wall reads as history at a glance however
far away or rolled up the controls are. Round the grid rather than each pane: every pane is on the
one replay clock, and a per-pane edge would collide with the active pane's ring.

**Exit takes two presses** — the trading kit's `Arming`, the same rule as its own irreversible
buttons: nothing lists a replay to reopen, and Exit sits beside Step, the button pressed most.
The rail's Replay button does the same while in replay, and the rail's stream status reads
**replay** (orange) instead of a green "live" under a chart frozen in the past.

The status line says what was asked — **"Stepped 1h"**, **"Stepped 3 × 15m"** — not how the
session did it: whether the span was walked or seeked (nothing working could fill) is the
engine's business, and "Jumped — nothing working" on an ordinary one-candle step read as an
error.

**Next alert** (2026-10-04) replaced Next signal and its Signals panel (user: "let's remove
bar replay's next signal feature as we will have next alert"). It runs to where the next of the
user's **enabled client alerts on this instrument** triggers -- the alert manager's list
(`client/alerts`), opened from the **Alerts** toggle, whose badge counts them. A published
signal is something an alert reads (`AREV arev21 signal 4h is long`), so "the next AREV21
long" is an alert of one condition; a rule may combine it with anything else. With only price
watches armed it still runs, to the first watch that fires. With neither it is disabled, and
**with nothing ahead it does not move** ("No alert triggers before the end of the data"): a
replay cannot step back, and running to the end of the data on a search that found nothing
would spend the session. While it searches, the status reads "Looking for the next alert…
reached <date>" and Stop abandons the search before anything moves.

The base timeframe and pause-on-fill are behind their toggle; **Account**
shows and hides the account window, which starts **closed** — an advance that produced events
(a fill, a close) opens it itself, on the tab the event landed in.

**Docked** (the ⇲ control, or dragged onto the bottom of the chart) the rows lay out along one
line instead of stacking, with Exit at the far right, and the controls sit *above* the account window in the column
(`order` 10 against 20). Everything else about the two modes — the drag, the roll-up, the
persistence — belongs to the window, not here.

## Choosing where to start

The start dialog opens **centred on the app**, even on a page wide enough that other body-level
cards open over the active pane (`../chrome/focus.ts`): a replay rebuilds the whole wall on one
clock, so the dialog that starts it belongs to no single pane (user, 2026-10-04). It **drags by
its title** (`../chrome/drag.ts`) and keeps that place through an On chart pick; only a click that
starts *and* ends on the backdrop closes it, because a drag released over the backdrop arrives as
a click there.

The start dialog takes a date, a balance and a base. Next to the date are **On chart** and
**Random**, and under them an optional **date range** Random draws from — unchecked, that is
the last two years ending a day before the newest bar.

**On chart** (`pickbar.ts`) is how a start is usually found: the dialog steps aside, the bars
right of the pointer are shaded out with the start written under them, and a click on a bar
picks it. **The bar clicked is the last one the replay opens with** — the start is its close
(`intervalEnd` of the pane's own interval, from the wire date), which is the replay's own rule
for what a pane shows. Nothing laid over the chart takes the pointer, so a drag still pans and
the wheel still zooms while looking; only a click (under klinecharts' 5px of travel) picks, and
it is stopped in the capture phase before `ChartPane`'s click-to-scroll would re-centre the
rest of the wall on it. Escape or the hint's Cancel goes back to the dialog unchanged.

The **default** start is a week before the newest bar, on a base candle open (the instant Start
will use, not the minute the dialog opened at) and **inside the market week**: a week before a
weekend afternoon is a weekend afternoon, so `defaultStartAt` backs off an hour at a time to
the last candle that opened while the market traded. (This replay's `intervalStart` floors an
intraday instant by arithmetic — Saturday 20:22 is Saturday 20:00 — so the floor alone does not
do it.) Enter starts from any field.

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

## Every instrument on its own schedule

A replay walks its instrument on **that instrument's** candle grid -- its own zone and day
geometry, resolved by the server from Postgres and carried on `SymbolInfo` (`timezone`,
`dayGeometry`). A `CandleGrid` (`timeframes.ts`) answers every boundary question on it, and every
module that floors, steps, labels or dates a bar takes one:

- the **session** -- advance targets, its base and refinement caches -- for the walked instrument;
- the **feed hub** -- each pane on the grid of the instrument *it* shows (a replay wall can mix
  them), so a coinbase pane's forming day is labelled at UTC midnight, the label `/getbars`
  gives the whole bar, while an FX pane beside it forms from 17:00 New York;
- the **bar source** -- a wire label to a candle's open and close, and the `from`/`to` shift;
- the **start dialog** -- default start, Random, and every typed date, read on the instrument's
  clock and named: "Start (UTC)" for a coinbase pair. The replay's clock reads there too, as the
  chart does;
- the **chart pick** -- a bar's close on its pane's own grid;
- the **plugin host's horizons** -- what each source forgets after a step, per pane.

**No schedule is never guessed** (CLAUDE.md: never hardcode a zone). The replay refuses to start
("No market hours for X"), a replay wall whose instrument has none is left, a pane without one gets
no forming bar (reported, not labelled), and a horizon without one falls back to an instant earlier
than any schedule could need -- forgetting too much costs a refetch, too little a permanent hole.

Before 2026-10-04 all of this ran on the FX week: a coinbase replay closed its days at 17:00 New
York, skipped its weekends and labelled forming bars where the server does not. Checked after the
change on `coinbase:BTCUSD` from Friday 22:00 UTC: steps land on Saturday's hours, and a 1D pane's
forming bar composed from the 1h base equals the server's `asof` rebuild in all five fields at each
step; EURUSD steps and labels exactly as before (pinned by `timeframes.test.ts`, which sweeps the
FX grid against the old functions).

## The base timeframe

The interval the engine walks. It must be a common denominator of every pane interval and
stored for the instrument (`validateBase`); the default is the GCD of the intervals in use
floored to the coarsest stored interval dividing it (`defaultBase`): 3m+5m → 1m, 1h+4h → 1h,
15m+1h → 1m, 1D+1W → 1D.

## Advancing

`advanceBy(request)`: plan the target on the boundary rules (`advanceTarget`, never a
timedelta) and stop there; then **walk or seek**. `nextAlert()` is the same advance to the
end of the data, planned to stop at the alert the search found first
(`client/alerts/search.ts`: ahead of the cursor, a chunk of bars at a time, every rule with
its indicators' lead-in), which is effective strictly after the cursor. An alert on a
timeframe finer than the base triggers inside a base bar; the stop is that **base bar's close**
-- later, never earlier -- because the walk moves in whole base bars and a cursor left mid-bar
would let the next advance fill against price action from before it. Only Next alert
searches: a Step is not stopped by an alert, only by a fill pause or a firing watch.

**Walk vs seek.** `canFill` (clock.ts) asks whether any bar could produce an event — a
resting limit/stop, or an open trade carrying a stop loss or take profit. When it is false
the account cannot change however the price moves, so the advance **seeks**: the cursor lands
on the same instant, `quoteAt` takes the closing quote there, and `AdvanceResult.walked` is
false. (A months-long jump used to feed ~10⁵ bars to the engine for nothing —
measured at 5s per 20 market days at a 1m base.) When it is true the advance **walks** base
bars from the cache, feeding each to the engine — or, when a candle's band intersects a working order or
an open trade's stop/target, the finer stored bars inside it instead (recursively; a per-span
refinement that never lowers the base). "Pause on fill" stops at the filling bar, and **any
advance — Step or Next alert — stops at the first bar a price watch fires on** (stop reason
`watch`; see below).

**Stopping a long advance.** While an advance runs, the title bar's Step button reads **Stop**
and calls `cancel()`; the advance stops at its next natural place — **between two whole base
bars**, or before moving at all if Next alert is still searching — with reason `cancel` and
the cursor on the last bar walked, exactly where a fill pause would leave it. A seek (nothing
could fill, nothing watched) is one read and is not interrupted. Two things had to change for a
Stop to be hearable at all, and each was a bug before it was a feature:

- **The walk fetches a page at a time** (`WALK_CHUNK_BARS`, about one server page). It used to
  `ensure` the whole span before reading its first bar, so a year at a 1m base was a minute of
  download with nothing checking in between.
- **The walk hands the event loop back every `WALK_YIELD_MS` (50 ms).** Once its bars are cached
  a walk is synchronous end to end — every `await` in it resolves as a microtask — so a click
  could not even be delivered until it finished. `session.test.ts` pins this with a timer that
  can only fire mid-walk if the walk yields (it fails with the yield disabled).

A cancel that lands before anything moved does not call `onAdvanced`: nothing the chart shows
changed, and telling it the clock moved would make every plugin forget and refetch.

**A walk says how far it has got** (user's call, 2026-09-20: the date, not a percentage or a bar
count). Without it a months-long 1m walk showed a frozen chart and a Stop button, and "working"
could not be told from "hung". `walkedTo` is the close of the last base bar walked — never
`reach`, so the date shown is never past where a Stop would leave the cursor — reported at the
top of every page (before it downloads) and at the yields, at most every `WALK_PROGRESS_MS`
(250 ms), and null for a seek. The controls show it in the status row as **"Walking… reached
Wed, Mar 04, 10:32"**, never in the title bar: the chart is not drawn there until the advance
lands. Two traps:

- **The clock reads `advanceFrom` while busy, not `cursor`.** The session moves `cursor` bar
  by bar mid-walk, so any re-render (a Stop click) used to show the walk's reach as if it
  were the chart's position.
- **A report patches its one line; it does not re-render.** Reports go out as
  `onControlChange('walk')`, and a full render rebuilds the title bar, replacing the Stop
  button several times a second — a press released on the replacement is no click at all.

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
- **A firing watch stops the advance, Step and Next alert alike.** `onBar` returns what it
  raised (`ObserverStop[]`), and the walk breaks on the first bar that raised anything, so the
  cursor lands on that base bar's close with reason `watch` — a Step short of its target, or
  on its last bar (still reported as `watch`, not `target`). `armedStops()` is what enables Next
  alert with no alert. Order when two land on one bar: a fill pause, then the alert the
  advance was planned to stop at, then the watch (whose notification is raised
  either way). Stopping a Step too was the user's call (2026-09-15): walking on past a firing
  puts the cursor, and every pane, somewhere other than where it happened.
- **The event clock is the bar's close, never the wall clock.** A session replaying 2024 has
  a 2024 cooldown. The notification itself is still *dated* when it was raised, so it sorts
  with everything else in the centre; the replay instant is in its body and in `data.eventAt`.

Watches ride in the state blob (`persist.ts` `watches`), baseline and all, so a reload finds
them where they were — status, fire count and all. **The blob is written on every mutation**
(create, edit, arm, delete — `ReplayWatches` hands the store a `WatchApi` that saves after
each), not only on the next advance: a watch is placed by a chart gesture, and until that was
added a reload before stepping lost it. A re-read is not a mutation and writes nothing. **Their notifications do not**: those are
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
blob holds cursor, engine state, base, advance setting, pause-on-fill and the replay's price
watches. A blob written while Next signal existed also carries `starred` and `armed`; `restore`
ignores them (not a version bump, which would have thrown those replays away). The alerts are
not in the blob: they are the account's, and the replay only reads them. The intent (session id + cursor) lives in `sessionStorage` so it survives the wall
rebuild entering/leaving replay needs.

## Tests

`bun test client/replay`: fixtures parity (engine + boundaries), the base table and
rejections, boundary math across Friday 17:00, the planner's alert-beats-target precedence,
the intersection rule descending / not descending, cache walk-vs-seek, the session walk
(fake source, fake alerts: Next alert seeks to the hit, stays put with nothing ahead, runs on
for a watch, Stop during the search), persist round trip (an old blob with signal stops), and `watches.test.ts` — a real session over a
synthetic path: an armed watch forcing the walk, firing on the base bar that reaches the
level, the band (a level between two closes), the blob round trip and the one-instrument
refusal. The firing RULE is tested against the server's own fixtures in `client/watch`.
`controls.test.ts` renders the controls and the start dialog into a real DOM (happy-dom,
registered for that file only and removed after it) over a fake `ReplayController`: which
controller call every gesture makes, when each button is usable, Step becoming Stop, every stop
reason's wording, the search's progress line, the Alerts toggle, the base
refusal, Play (pace, self-stop on every reason, the settle wait, a hand-pressed Step ending it),
the keys (kept from the chart, the repeat that must not cancel, a field's own keys), Exit's two
presses, and the dialog's New York clock on both sides of DST, its weekend default, On chart,
Enter, its refusals and Random's range. `results.test.ts` pins the score (the split, the averages, an infinite profit factor, the
drawdown read in close order, open trades kept out of the closed figures). `feed.test.ts` pins the
hub on a coinbase pane's own grid, and the refusal for a pane with no market hours.
`timeframes.test.ts` pins `CandleGrid` against the wmarkettypes fixture for all three schedules,
sweeps the FX grid against the old functions, and steps crypto through a weekend and equities
across an overnight. `player.test.ts` pins the player alone (one loop however
it is toggled, pause mid-step, an error ends it). happy-dom applies no stylesheet, so anything
that hinges on CSS (`[hidden]` against a `display: flex`, as the dialog's backdrop is) is checked
in the browser, not here. `scripts/sync-engine-fixtures.sh` vendors the
fixtures from wdashboard-server; `--check` (run by `fixtures.test.ts`) fails if they differ.
