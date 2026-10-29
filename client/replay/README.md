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
| `timeframes.ts` | PURE. Interval algebra (`divides`, `gcdInterval`, `defaultBase`, `validateBase`, `finerStored`, `storedLadderFor`) and the boundary math mirroring wmarkettypes' `Interval`, for all three schedules the store carries (`schedule*`), and the **`CandleGrid`** the replay asks every boundary question of: those functions bound to one instrument's zone and day geometry (`gridOf`, `gridFor(symbolInfo)`). Parity asserted against `fixtures/boundaries.json`, generated from wmarkettypes. The unparameterised `intervalStart`/… are the FX week, kept for the FX-only callers outside the replay. |
| `engine.ts` | PURE. The port of `engine.py`: same types (the wire's `SimOrder`/`SimTrade`), same events, same ids (`o1`, `t2`, …), no I/O. Parity asserted by running `fixtures/engine_cases.json` — the *same file* the Python suite runs. |
| `clock.ts` | PURE. `planAdvance(cursor, request, alert)` → target / stopAt / reason; `intersectsWorking` (the descend-to-finer rule); `canFill`; Go to's `goToInstant` (a time of day on the instrument's clock: next trading day, next occurrence, a date), `isTradingDay` and `onBaseBoundary`. |
| `cache.ts` | `BarCache` per (instrument, timeframe) over an injected `BarSource`: a contiguous run ahead of an anchor; **walked** (`ensure`/`take`) or **seeked** (`seek`: dump and reload), never a partial append onto a stale run; `cover` past the run's end is a seek too. `composeLadder`/`composeSpans` (which stored bars a forming candle is made of), `composeForming`, `nonWeekendGaps`. |
| `alerts.ts` | `ReplayAlerts`: every one of the user's enabled client alerts, on whatever instrument it watches (`client/alerts`) and the search that finds where the next one triggers -- what Next alert runs to -- run AHEAD in the background after every advance (the look-ahead), so a press usually finds its answer waiting. |
| `pick.ts` | PURE. `randomStart`: a uniform instant out of a range, snapped down to a base candle open. The rng is injected. |
| `results.ts` | PURE. `replayResults`: the session's score from its snapshot -- net and realised P&L, win rate, averages, profit factor, expectancy, best/worst, the max drawdown of the realised curve -- and the rows the Results panel draws. |
| `player.ts` | PURE. `ReplayPlayer`: Play/Pause -- the Step pressed again and again at a pace, stopping on any stop that is not the target. The step, the sleep and the "has the wall caught up" wait are injected. |
| `format.ts` | PURE. `formatClock`: an instant on the New York clock WITH its weekday ("Sat, Sep 26, 20:00"). |
| `persist.ts` | The state blob (`serialize`/`restore`) and the page-level replay intent. |
| `watches.ts` | Price watches over the walk: the `price` source built from base bars, the local backend `client/watch` draws, the Go to panel's stop price (one watch of its own), and `quietOver` -- what lets the walk skim. |
| `landing.ts` | `LandingWarmer`: WHEN the next landing is warmed on the server -- once the wall is quiet, never while an advance runs, one landing at a time. The wall it waits on and the warm-up it sends are injected. |
| `follow.ts` | PURE. Following the chart to another instrument: what keeps the replay where it is (`FollowBlockers`), which pane change is a request (`followRequest`), the target resolved as a mount resolves it (`followTarget`), the base it walks there (`followBase`) and the blob moved to it (`movedState`). |
| — glue — | |
| `source.ts` | `HttpBarSource` (`/getbars columns=all`, paged, 413-split). The only module here that fetches bars. It reads past the page-wide read clock on purpose (`asof: null`), and so does the alert search built on it. `probeStoredIntervals`: which of the stored ladder an instrument holds -- one bar per interval its vendor stores (`storedLadderFor` against `/capabilities` `baseIntervals`), never one the server would only fold. |
| `feed.ts` | `ReplayDatafeed` (the pane datafeed: history clamped by the read clock, windows re-anchored to end just past the bar forming at the cursor, no stream) and `ReplayFeedHub` (pushes stepped bars into every pane — see "the v1 bug" below — and says what each pane will hold at a landing, `landingRange`). Also `inertStream`. |
| `session.ts` | `ReplayTradingSession implements TradingSession` over the engine and the caches, and the `ReplayController` the controls drive. Owns the walk, and the follow (`follow`: one attempt at a time, for the newest request). |
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
| [Alerts 2] [Go to] [Base 1h] [Results] [Account] [Trade]  Exit replay |   the alert manager; one panel
|--------------------------------------------------------------|
| TIME  [06:00] [next trading day v] [Go]  Fri, Oct 23, 06:00  |   the Go to panel, when open:
| PRICE [1.12650    ] [Stop here] [Run]  stops at 1.1265 ×     |   a time, and a stop price
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
user's **enabled client alerts** triggers -- every one on the alert manager's list
(`client/alerts`), opened from the **Alerts** toggle, whose badge counts them, on whatever
instrument each watches. Since 2026-10-28 (user: "next alert should be just the next alert
according to the Alerts popup, not on current chart"): until then only the replayed instrument's
alerts counted, so a replay of EURGBP had no Next alert for an alert on EURUSD, and switching a
pane's symbol mid-replay changed nothing, since the replay kept the instrument it started on (it
follows the active pane since 2026-10-29: "Following the chart to another instrument", below).
Each alert is searched on its own instrument's bars and schedule; the stop's notification names
that instrument.

**A stop loss or take profit hit is another Next alert** (2026-10-28; user: "when price hits a stop
or take profit, that is also another next alert").
- **It stops the run:** Next alert, and Run to a price, end at the first fill or close -- a stop
  loss or take profit hit, a resting order filled -- whatever Pause on fill says. Step and Play
  still pause only with it set. The controls name what happened: "Stop loss hit", "Take profit
  hit", "Order filled".
- **It enables the button:** a resting order or a protected trade counts like an alert
  (`workingStops`), so Next alert works with no alert at all and runs to the fill.
- **Nothing found:** a run that meets nothing before the end of the data is taken back, the
  account included (`Engine.restore`). Nothing filled, so the account only ever took quotes.
- **Limit and stop orders count** (user: "also a limit trade is part of next alert"): a resting
  limit or stop order filling ends the run as a stop loss does ("Order filled").
- **The skim covers fills:** a candle whose bid/ask range reaches no resting order, stop loss or
  take profit goes to the engine whole (`quietOver`, `intersectsWorking`). Only its quote and
  clock move, as over the bars inside it. A level of the skim longer than the span is not read.
- **Gaps:** the range is taken from the last quote on, because a price can gap through a level
  that no candle's range then holds. A buy limit at 1.0900 is filled at Sunday's 1.0800 open after
  Friday's 1.1000 close. Measured against the first cut, which used the candle's own range: that
  skipped the gap, filled it silently, and took the whole run back as "nothing ahead".
  - Anything the engine still reports on a candle handed over whole is kept, and ends the run.

On prod EURGBP 5s, a long whose take profit is hit 2.5 days out: the same close (06:00:05,
0.86912) by 24 candles and bars in 4 ms, against 30,006 base bars in 44 ms walked. A published
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
loads. And the boundary itself reads once per instrument, not once per pane: every view asks in
the same task, and `levels/api.ts` sends one read of the union of their windows (six panes on
EURUSD or EURGBP at 2023 clocks: 6 reads and 1.4-2.3 s before, 1 read and 0.44-0.79 s after).

**A pane's own history read ends just past the bar forming at the cursor** (`feed.ts`,
`plugins/horizon.ts` `answerableTo`), on the wire clock its bars are dated by. That is the cursor
itself for an intraday pane, but a forex day forming from Tuesday 17:00 is dated Wednesday 00:00:
ending the window at the cursor left a 1D pane reloaded between 17:00 and midnight without its
forming candle (prod EURGBP, 2023-10-24 19:00 New York). The read through the tiles
(`tiles/join.ts`) then asks `/getbars` for **nothing that cannot be answered**: past that bar
nothing exists, and on its open -- where a Step leaves every pane whose interval divides the Step's --
not even that bar. The chart's widening (`history.ts` `fetchBarsWidened`) used to send one such
empty read per attempt, one after another: a 5s pane's newer-in-time page from a Saturday cursor
made four on prod, and a pane reloaded after a 1h Step was seen making eleven. What a widening
still has to ask is the same request on every attempt, and it is asked once.

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

## Following the chart to another instrument

The user, 2026-10-29: a replay of EURGBP, the pane switched to EURUSD, and nothing followed --
the replay went on walking EURGBP under a chart that showed EURUSD, because the session, its
watches and its title bar were all built from the blob's `symbol` and only a new replay changed
it. **Now the replay follows the active pane** (`follow.ts`, `session.follow`): pick another
instrument on the active pane and the replay walks that one, **at the same cursor, in the same
session and the same paper account** -- the blob is written for the new instrument and the wall is
rebuilt from it the way a reload rebuilds it (`bootReplay`, `mountBarReplay`), so the new
instrument's market hours and stored intervals are resolved exactly as at a mount, and nothing
else in the replay had to learn that an instrument can change. A replay still walks one
instrument, and `canWatch` still refuses every other pane's watches; what changed is only which.

**It follows only when nothing is open on the instrument it walks**: no open trade, no pending
order, no armed price watch (the stop price included). Each of those is evaluated by the walk and
by nothing else, so leaving one behind would leave a stop loss nothing could hit, an order nothing
could fill, a line nothing could fire. Otherwise the replay keeps walking the old instrument and
the controls show a notice between Next alert and the footer, in the watch line's orange:

```
The replay walks EURGBP, not EURUSD: EURGBP has 1 open trade and 1 armed price watch.
Close or remove them to follow EURUSD, or exit the replay.          [Follow EURUSD] ×
```

What keeps it is read live, so closing the last trade turns the same notice into "Nothing is open
on it any more" and enables **Follow EURUSD**. The follow is a button rather than automatic once the
last trade closes: a stop loss hit mid-Play would otherwise rebuild the wall under the user. **×**
keeps walking EURGBP and drops the notice; picking EURGBP again on the pane does the same.

Which change is a request (`followRequest`): a symbol picked on the **active** pane, for an
instrument other than the one walked. A wall that follows its active pane fans the pick out to
the other panes, each reported in turn, and those are not requests; nor is activating a pane that
already shows another instrument -- a replay wall can mix instruments, and a click on a pane is
not a choice of what to walk. One more is made at a mount (`followOnMount`): a wall that comes
back with **no** pane on the instrument walked -- Revert after a follow, a reload that let the
unsaved draft go, a workspace switched mid-replay -- has moved its active pane off it as surely as
a pick does, so the replay follows (or says why not) rather than walk an instrument nobody can
see. It converges in one rebuild: the wall the follow rebuilds shows what it walks.

Before anything is written the new instrument is resolved as a mount resolves it, and a reason
not to follow is said in the same notice rather than met at the mount -- where it would have
LEFT the replay, throwing the session away: no market hours for it ("No market hours for X"),
nothing stored for it at the cursor, or nothing stored that fits the panes. The base is the one
walked now when the new instrument stores it, it tiles the panes and no candle of it straddles the
cursor on the new instrument's grid; otherwise the coarsest stored interval that does
(`followBase`). Measured on prod at Mon 2023-10-16 06:00 New York: EURGBP and EURUSD hold
5s/1m/1h/1D, XAU_USD and coinbase BTCUSD 1m/1h/1D only -- so a 5s replay of EURGBP followed to gold
walks 1m. The straddle is the cross-schedule case: a 1D base followed from the FX week (17:00 New
York) to a coinbase pair (midnight UTC) stands inside a coinbase day, so it walks 1h; the session
keeps its cursor on a base boundary everywhere else (`onBaseBoundary`, `alertStop`), and a follow
keeps it there by choosing the base, not by moving the cursor. The mount the follow rebuilds into
takes the follow's own probe of the store rather than asking again (the same instrument at the same
instant, a moment later): those four one-bar reads took 93-294 ms against prod from here.

**What the account keeps of the instrument left** (`movedState`):
- **its closed trades and their P&L** -- the session's history; Results scores them with the rest.
  The balance adds each instrument's P&L in its own quote currency, as paper trading's does;
- **its last quote**, frozen at the cursor it was left at. It marks nothing (nothing is open on it)
  and prices nothing: the session now refuses an order on any instrument but the one it walks
  ("This replay walks EURUSD only") -- the engine's "no price yet" used to be what refused those.

What it drops: the instrument left's price watches (none armed by then; fired or switched off,
nothing could evaluate them again), and a quote of the instrument followed kept from an earlier
walk of it -- the price of then, not of now -- so the new wall quotes it at the cursor
(`primeQuote`).

**The races** a follow has to survive (the first three pinned by `follow.test.ts`, the last two
by `mount.test.ts`):
- **An advance in flight** lands first (Play stops: no advance starts while a follow is being made,
  nor any order), and what it left open is looked at again before anything is written.
- **A newer pick** while one is being made is taken up by the same attempt -- one at a time,
  always for the newest -- and only its blob is written.
- **Withdrawn while the blob is being written** (the pane picked back, or ×): the walked
  instrument's blob is written back over it, and the session saves as before.
- **Nothing saves over the moved blob**: once it is queued the old session writes nothing more,
  and a stale-rev save (`409`, another tab) now resyncs and writes again at once rather than
  waiting for a next change a follow never has.
- **Exit while a save is in flight** (a follow's, or the last step's): a save landing after Exit
  no longer writes back the replay intent Exit cleared, which put the next rebuild or reload back
  into the replay just left.

A `?symbol=` link opens a scratch wall built from the link alone, so its rebuild would have put
the pane back on the linked instrument under a replay walking another; the scratch wall now keeps
its last layout in memory for the rebuild (still saving nothing; a reload starts from the link
again, and the replay follows it back as any wall moved off its instrument). Entering and leaving
replay on such a wall keeps its changes too, which it did not.

## The base timeframe

The interval the engine walks. It must be a common denominator of every pane interval and
stored for the instrument (`validateBase`); the default is the GCD of the intervals in use
floored to the coarsest stored interval dividing it (`defaultBase`): 3m+5m → 1m, 1h+4h → 1h,
15m+1h → 1m, 1D+1W → 1D.

"Stored" is the probe's answer (`probeStoredIntervals`): of `STORED_LADDER`, the intervals the
instrument's vendor stores according to `/capabilities` `baseIntervals` and that hold a bar near
the cursor. Until 2026-10-29 the probe asked about the whole ladder, and `/getbars` answers an
interval it folds as readily as one it stores -- so schwab's 1h, a fold of its 30m, was offered
as a base, used as a rung of every 4h/1D forming candle and as a step of the refinement, each
time answering from whichever fold its period landed in (the browser's keeps the 09:00-09:30
pre-market half hour of a stored read, the server's drops it: prod SPY's 09:00 hour differed in
open and volume on 15 of 15 days, and no other hour did). A schwab wall now walks 1m or 1D.

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

**Go to** (2026-10-26, the user: "go to a certain time, for example, 6am of the next trading
day"). The **Go to** panel takes a time of day on the instrument's own clock and which day:
**next trading day** (the default -- the first day after the cursor's own calendar day that the
market trades, so 06:00 from Wednesday 05:05 or Wednesday 20:00 is Thursday 06:00, and from
Friday it is Monday), **next time** (the next time the clock reads it on a trading day, today
included) or **on date**. The target is shown before you press Go, and the time and the choice
of day are remembered per browser (`wd.replay.goTo`; a date is not -- it is stale by the next
replay). It is an ordinary advance to an instant (`AdvanceRequest` `{ to }`), so a fill pause or a
firing watch stops it sooner, exactly as for a Step; `session.goTo` moves the instant onto the
base's grid first (`onBaseBoundary`: a base candle's open stays, anything inside a candle goes to
its close -- later, never earlier, the rule a finer alert follows). A trading day is one the
schedule is open at the middle of the session it dates (`isTradingDay`): 05:00 New York for the
FX week, so Sunday -- open only from 17:00, for Monday's session -- does not count; 12:30 for US
equities; every day for a continuous schedule.

**Next alert looks ahead** (2026-10-26). A search is pure look-ahead: its answer from `after` --
the first trigger H in `(after, until]` -- is also the answer from any later instant before H (no
alert triggers in between, and whether one triggers at an instant is decided by the bar closes
before it, which are the same whatever the search started from). So after every advance the
session calls `warmAlerts()` and `ReplayAlerts` starts the next search in the background, while
the chart loads and the user reads it; a Next alert pressed later takes that answer -- or, still
running, waits for it and shows its progress -- and a Step that stays short of H keeps it good.
One search runs at a time (they share `AlertSearch`'s caches): a look-ahead is dropped when the
cursor passes its hit, when an alert's rule or trigger is edited or one is switched on or off,
when a Stop is pressed while it is awaited (its null is not kept as "nothing ahead"), or when the
replay is left. Measured on a six-pane EURUSD wall with a 3m/5m rank-85 star alert (local
stack): a press to a nearby star stopped in 87-210 ms, the panes' own catching-up being all of
it; the searches themselves -- 0.4-0.5 s each against prod, ~2 s cold -- now run while nobody is
waiting. `client/alerts/README.md` has what made the searches themselves faster.

**What a press lands on is read ahead too** (2026-10-28). Measured on prod's EURUSD (the Tablet
wall: 1h, 5m and 3m with the rank 85 overlay, base 1m, the 5m star alert), the time a press took
was its landing's reads, one round trip after another: the base bar a seek takes its quote from,
before the cursor moved; then the bars the forming candles are made of; then the reloaded panes'
windows; then the overlays' reads, which for a reloaded pane waited out the plugin host's 250 ms
range debounce. Three changes:
- `ReplayAlerts.prefetch` resolves to the instant its search found, and `warmAlerts` reads the base
  bar there (`landing`, `alertStop`): the seek's quote no longer waits for the press.
- `ReplayFeedHub.push` reloads a pane too far behind (`reloadIfFar`) before it reads anything
  else: a reload is the pane's own read of its window and needs none of the bars the other
  panes' forming candles are made of.
- The plugin host covers a pane whose bars were replaced whole (both ends moved) at once, not
  after the debounce, which is kept for pans and new bars (`client/plugins/host.ts`).

On the same eight stops from Fri 2023-01-06 04:25 New York, until the last read reaching the
landing was done: 530, 181, 202, 341, 1,014, 532, 276 and 190 ms on `main`; 372, 57, 147, 188,
427, 296, 136 and 119 ms with these. What is left is mostly the server's `/mtf/graph` (up to
~0.85 s for the 5m overlay on a cold read) and, after a jump short enough to append, the forming
candle's read before the overlays'.

**...and so are the overlays there, on the server** (2026-10-29). The server's `/mtf/graph` cache
(wdashboard-server 0.56.1's read-ahead, 0.56.2's three spans) makes every read of a region it has
built 6-13 ms, but the FIRST read of a region is the expensive one: it reads the signals of every
graph root's run back from the window, often months, and walks them. A Next alert jumping weeks
or months lands in such a region, and every overlay on the wall waited for it. Measured against
prod data (a local server on `2e5cb73`, EURUSD 3m, 5m and 1h panes with the rank 85 overlay, roots
1D 8h 4h 2h): a landing a week to two months on took **0.2-4.9 s** per overlay read, and 0.3-2.0 s
until all three panes were drawn.

The landing is known before the press (the look-ahead above), so it is warmed then:
- The session tells the wall where a press would land (`ReplaySessionOptions.warmLanding`, the
  same `alertStop` instant the press stops on), whenever the look-ahead has found it and no
  advance is running -- a press that got there first reads it itself. The wall also asks again
  when its panes change (`BarReplayController.sync`), for a pane mounted since.
- `ReplayFeedHub.landingRange` says what each pane will hold there, by the rule the push follows
  (`reloads`): the 500-bar window a reload loads, from at or before its first bar, or the pane's
  bars to the landing's for a jump short enough to append.
- `PluginHost.warmAhead` asks each source that offers it (`SourceSpec.warm`; the MTF overlays) for
  the window it will read there under the landing's clock, and sends ONE read per store over the
  union of its panes' windows, `asof` the landing and `limit` 1 -- the server builds and keeps the
  whole window whatever the limit, so the body is one signal -- past the HTTP cache (`no-store`: a
  revalidation would be answered with a 304 before anything was built). The answer is thrown
  away, never filed: it lies past the chart's clock, and a store holding it would draw it early.
  A store already warmed for that instant over as much sends nothing, so the ask after every
  Step short of the landing costs nothing.
- `LandingWarmer` (`landing.ts`) sends it once the wall is quiet -- no pane loading bars through
  the replay's datafeed and no plugin read in flight, on two looks 50 ms apart (a reloaded pane's
  bars arrive before its overlays ask, and in between the wall looks idle) -- or after 5 s
  regardless. Not while an advance runs or once the cursor is at the landing; a later landing
  drops one still waiting, and so does leaving the replay.

The server keeps three spans per overlay configuration (`MAX_SPANS`), least recently used out
first: a live chart, the region a replay stands in and the one it lands in next. A warm-up that
fits in the server's 400-day entry span with the region last read (after a press, the one the
replay stands in) is built as an extension of it and takes no span at all; a farther one takes the
newest span and leaves the region the replay stands in second, so it never evicts that. A landing
costs the server a span whether it is warmed or not -- the warm-up builds it sooner -- except one
never pressed to (a Step past it, an alert edited), which one warm-up at a time keeps to one.
Measured on one configuration read by a live chart and by a replay warming and then landing on
three stops three weeks apart, a Step between each warm-up and its press: the live chart's reads
stayed at 22-38 ms and the Steps at 18-97 ms (27-118 ms with no warm-ups), the presses 18-38 ms
against 696-795 ms.

Headless through these modules against the same server -- a real session, plugin host, MTF
plugin and feed hub, the look-ahead stubbed to know the landing, six landings a week to two months
on with the three panes reloaded there, each mode on a freshly started server: from the press
until every overlay was covered, **253, 1,004, 2,359, 1,054, 704 and 2,007 ms cold; 52, 52, 103,
102, 102 and 102 ms warmed** (the host's settle poll is 50 ms), the warm-up itself 0.2-2.1 s in
the background before the press. What each store held after the landing was identical cold and
warmed, row for row.

**Future data is held in memory, a whole tile at a time** (2026-10-28; user: "bar replay should
cache future data. the base timeframe should be pulled, so a whole tile from the current replay
time to the end of the tile should be in memory. alerts should be cached into the future as well.
other timeframes should be cached as well to test price alerts").
- **Bars** come through `TiledBarSource` (`tiled.ts`), one per page, for the walk, the skim, the
  quote probe and every pane's catch-up. The alert search and the Strategy Lab read through it too.
  - A read with bid and ask (`'all'`) loads a stored interval's whole tile and its `side=bidask`
    half (the same rows, never fetched by the chart) and holds them decoded AS COLUMNS
    (`MAX_HELD_BARS` rows, least recently used out first). A read builds `ReplayBar`s only for the
    rows it returns (`barsBetween`, by binary search), and the columns are decoded one at a time
    with the page handed a turn between (`decodeColumns`). The first cut (client-a117849) decoded
    both halves whole and built every bar at once: 240-440 ms main-thread blocks per 5s week, a
    Run to a price three weeks out held 1.8 s of long tasks on prod. Columnar, the same reads
    decode in under a quarter of the time (a warm-up of four tiles 925 → 234 ms headless).
  - Loading one tile starts the next. After every advance the session warms the base and the
    skim's coarser intervals (1D, 1h, 1m over a 5s base) at the cursor (`warmAlerts` → `warm`).
  - Mid-only reads (`'core'`) take `barsFromTiles`, folding 3m or 4h out of a stored interval.
  - What no tile covers -- the forming period, an untiled interval, a tile that will not load --
    comes from `/getbars`, as everything did before.

  Measured against `/getbars` on prod: EURGBP 5s, 1m, 1h, 1D and EURUSD 5s with bid/ask, and
  EURGBP 3m and 5m mid, windows reaching into the open period -- every field equal.
- **Alerts:** `ReplayAlerts` keeps a chain of triggers, each search starting from the last hit,
  `ALERTS_AHEAD` (5) ahead of the cursor, topped up after every press. A press inside the chain
  takes its hit at once. A Step past its end, or an edit, starts a new chain from the cursor.
- **Price watches** are tested on the coarsest candles first and finer ones only where one could
  fire (the skim, below). Its 1D, 1h and 1m candles are now these held tiles, not a server read per
  level per advance.

Measured on prod data:
- Run to a stop price 2.5 days out at a 5s base (EURGBP from Mon 2023-10-16 06:00 New York):
  612 ms and 6 server reads before, **5 ms and none** with the tiles warm; the same stop.
- The browser (EURUSD Tablet wall, 1m base, five Next alert presses from Fri 2023-01-06 04:25):
  - the cursor moved 24-122 ms after the click;
  - no bar was read from the server, except one 3m pane reload across the weekend;
  - what is left is the overlays' own reads (138-527 ms);
  - heap 57 MB.
- **Cold**, a tile is fetched and decoded whole: ~0.4-0.9 s for a 5s week with its quote half,
  paid once per week a replay enters (in the background when the warm got there first).

**A quote across a weekend is looked for from Friday's close** (2026-10-28). A seek lands on the
base bar that closed at or before the cursor (`barAt`), probing back 50 base bars and widening
eightfold. From Sunday's open that widening walked back through the closed weekend: at a 5s base
the fifth probe read ~12 days of 5s bars, page after page, to find Friday's last one (prod EURGBP,
a Step from Saturday 11:27 to Sunday's open: 63 reads, 20 s before the cursor moved; `barAt` alone
12.3 s). The probe now goes one session at a time on the instrument's own schedule: back from the
cursor -- or from the close of the session it falls after, when the market is shut -- widening, but
never into the closed window before the session; a session with no bar closed by then hands over
to the close of the one before. The first cut (`client-7944be9`) anchored only at that close, which
missed the case the Step actually lands on, Sunday's first 5s close (17:00:05), inside Monday's
session with nothing closed yet: still 12.9 s and five probes on prod, now 135 ms and two.

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
could ever evaluate is worse than a menu that says why. (A follow changes which instrument that
is, never how many: the new wall's watches are the new instrument's.)

### Stopping at a price, quickly (2026-10-26)

The user: "we want bar replay to stop at a certain price. this feature should work quickly."

**The stop price is a watch.** The Go to panel's **Price** row (`Stop here`, or Enter) places,
moves or removes ONE replay watch of its own -- `price crosses P`, fired once, marked by its note
(`STOP_PRICE_NOTE`) -- so it is the same line on the chart (draggable), the same row in the
Notification Center, and it stops Step, Play, Next alert and Go to with no stop logic of its own.
**Run** runs on until a watch fires (or a fill pauses it), however far that is. Its placeholder is
the current mid, because the `price` field is the mid of bid and ask -- what the stop compares.

**The skim** is what makes it quick. An armed watch used to make every advance walk every base
bar (the seek shortcut would step over it), so a stop a month away at a 1m base was a month of
1m bars fetched a page at a time and handed over one by one. Now, when nothing could fill
(`canFill` false) and only the watches need the bars, `session.skim` reads the stored intervals
coarser than the base that tile it (`summaryIntervals`: 1D then 1h over 1m), coarsest first,
and asks the observer about each whole candle: **quiet** (`quietOver`) -- no watch could fire on
any bar inside it -- and the candle is handed over as one bar and the cursor moves past it;
otherwise it descends a level, down to the base bars, which are handed over exactly as the walk
hands them. The head before the first whole candle, the tail after the last and a hole in the
coarser store descend the same way; a stretch the market is closed throughout is passed over.
"Quiet" is `neverWithin` (`client/alerts/conditions.ts`), which claims it only where it can be
shown: `>`/`>=`/`<`/`<=` against a band that does not reach the level, a crossing with the
level strictly outside the band and the reading before on the same side; nothing for `inside`,
`==`, `changed`, `not` or a field with no band (`spread`) -- those walk, as before. The coarse
band holds every finer one because the observation is the mid of the bid and ask bands, and a
small slack (`SUMMARY_SLACK`, a quarter pip on EURUSD) covers a coarse candle stored a tick
short. **The answer is the walk's**: `skim.test.ts` holds it against a brute-force walk over a
synthetic week at eleven levels, and against prod EURUSD bars (2026-10-26, headless, Run from
2025-01-07 15:00Z) the skim and the walk stopped on the same minute for levels 2, 2 and 8 weeks
ahead in **0.29 / 0.31 / 0.53 s and 4 reads against 1.4 / 2.6 / 6.1 s and up to 21**. In the
browser (local stack) a level first reached 3.5 days ahead took four reads, about 0.2 s, to
find its minute.

**With nothing that could fill, a walk does not feed the engine** at all -- it can learn nothing
from the bars -- and it is quoted once where the advance lands (the close of the last bar handed
over: the state a fed walk would have left it in). That is also what makes the next rule cheap:

**A run that no watch stops is taken back.** Next alert with no alert ahead, or Run, used to run
to the end of the data when a watch was armed and never fired -- which spends the replay, since
a replay cannot step back. Now, when nothing could fill, it is taken back whole: the cursor and
the watches as they were (`restoreState`), reason `none` ("The price is not reached before the
end of the data" / "No alert triggers…"), nothing told the chart. The same rule as Next alert's
"never moves on nothing" (2026-10-04); a run with something that could fill still runs, for the
fill.

## The v1 bug, and why it cannot recur

v1 pushed bars through a forming-bar path gated by a separately maintained `newest`
watermark that drifted from the chart. Here the hub keeps no watermark: what to push is
computed from `chart.getDataList().at(-1)` every time, the chart's tail is asserted against
what was pushed after every step (`PushReport.problem`), and a jump longer than
`SEEK_THRESHOLD_BARS` reloads the pane's window at the cursor (`chart.resetData()`, clean
seek, sent before any other read of the push) instead of appending. That threshold was 300 and is **100** since 2026-10-26: every bar
appended recalculates every indicator on the pane over every bar it holds, ~2.4 ms a bar on a
six-pane wall with the usual overlays, so a 10-hour Go to that appended ~340 bars stopped in
1.26 s, and reloading the panes past 60 bars stopped it in 0.34 s. **The panes are pushed
concurrently** (they were one after another, a round trip each); the bars their forming
bars are composed from are read once first, one range per instrument and interval for every
pane, because those caches are shared and a pane reading one itself would re-anchor it under
another's read. Grid alignment: a composed forming bar is labelled by
`intervalStart` (+7h for daily-and-coarser, `toWireDate`), the same label `/getbars` gives the
whole bar.

**A forming candle is made of the coarsest stored bars that fit** (2026-10-26). `composeLadder`
picks every stored interval between the base and the pane's that tiles one and is tiled by the
other, and `composeSpans` hands each the whole candles of it that closed by the cursor, from
where the coarser one stopped: a 1D pane at 06:12:35 on a 5s base is 1h bars from 17:00, 1m bars
from 06:00 and 5s bars from 06:12 -- 13 + 12 + 7 bars where it was 9,360. It is the same candle:
the store's coarser candles are its finer ones aggregated (every hour and minute of five prod
symbol-days agreed in all five fields), so the 45 forming 1h/4h/1D candles of a run of prod Go
tos came out identical before and after. What the store holds is the walked instrument's probed
ladder (`hub.setStored`), and for any other instrument on the wall a probe of its own at the
cursor; with neither, the base alone, as before.

**Whether it is the same candle depends on the vendor**, measured on prod 2026-10-29 for each
stored interval against its finer stored ones aggregated (every field, bid/ask included; the
numbers are in `composeLadder`'s comment). **oanda** is exact: 1D against 1h on 1,003 session-days
of seven instruments 2010-2026, against 1m and 5s too. **coinbase** is exact in price on its
backfilled history; its volumes are rounded to whole units interval by interval, so a coarser rung
is the *more* accurate volume (a BTC minute is ~2 BTC). **schwab** is not and cannot be: its daily
is the exchange's official bar (auction close, consolidated volume 1.2-2.1x the minutes'), not an
aggregate of anything stored. It stays the rung of a 1W/1M candle anyway, because the week is
folded from those days (94 of 94 SPY weeks equal): composed from minutes instead, the forming week
would end as a different bar from the one that replaces it, and show about a third less volume for
every finished day than the 1D pane beside it. Its 1h is no rung at all now (see "The base
timeframe"): simulated over 15 SPY sessions at every minute 10:00-16:00, 5,295 of 5,415 forming 1D
candles built with it differed from the 1m base alone (volume, up to 0.85%), and all 5,415 where
the hour came from the server's fold (open, low and high too); without it, none. And `BarCache.cover` now seeks when asked for a
range past the end of its run: it used to extend from its own end, so after a jump of a day the
5s cache read every bar of the gap -- about 11,000, a page after another -- for a candle that
needed the last minute of it. Measured headless against prod (EURGBP, six panes 3m..1D, 5s base):
the push after a Go to "06:00 next trading day" took **30-109 ms** reading 400 1m bars, against
**482-616 ms** reading ~11,000 5s bars.

## Persistence

`sim_session` with `mode='replay'` via `PUT /sim/sessions/{id}/state` (optimistic `rev`); the
blob holds cursor, engine state, base, advance setting, pause-on-fill and the replay's price
watches. A blob written while Next signal existed also carries `starred` and `armed`; `restore`
ignores them (not a version bump, which would have thrown those replays away). Its `symbol` is
the instrument walked NOW: a follow rewrites it (and `vendor`, and `base` when it had to change),
while the server's own record of the session keeps the one it was created with. The alerts are
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
hub on a coinbase pane's own grid, the refusal for a pane with no market hours, and a forex day
pane's reload window reaching the day forming since 17:00.
`feed.test.ts` also holds `landingRange` to what the push really leaves (an append's range equal
to the chart's after it, a reload predicted exactly where the push reloads) and counts the panes'
bar loads; `landing.test.ts` pins when a warm-up is sent (two quiet looks, not while an advance
runs nor once a press has landed there, a later landing or leaving dropping one waiting, the
deadline).
`timeframes.test.ts` pins `CandleGrid` against the wmarkettypes fixture for all three schedules,
sweeps the FX grid against the old functions, and steps crypto through a weekend and equities
across an overnight. It runs in about 0.4 s: the next candle after a closed window is found by
jumping to where the market reopens rather than stepping through it a candle at a time, which for
5s was 34,560 steps across an FX weekend and took the fixture test past bun's 5 s limit under load.
`e2e.test.ts` is the one test `bun test` skips: a whole wall over a real server and a real tile
bucket (`REPLAY_E2E`, `REPLAY_E2E_TILES`; its header has the commands) -- a Step with nothing
working seeks, a walk with resting orders skims and descends to the 5s bars for the fills, every
bar the session reads comes out of the tiles, Next alert jumps, and the state persists. `skim.test.ts` holds the skim to the walk's answer -- a real session and
real `ReplayWatches` over a synthetic week whose 1h and 1D candles are folded from its 1m bars:
the same stopping minute as a brute-force walk at eleven levels, a sliver of the base bars read,
a Step stopping there too, a run that never reaches its level taken back with the stop still
armed, no skim with only the base stored, and a Stop heard (it fails with `neverWithin` made to
skip, and with the descent removed). `follow.test.ts` pins following the chart: the blockers and their wording, which pane change is
a request, the base chosen (kept, replaced when not stored, finer across a straddle, none), the
blob moved (same cursor and account, the old quote kept, a stale one of the target dropped) and
read back by `restore`; then a real session -- followed with nothing open, the rebuild asked for
once and nothing saved after; refused for an open trade, a pending order, an armed watch and an
instrument that cannot be walked, each said and each followed once it is gone; an order on
another instrument refused; and the three races above. `mount.test.ts` mounts `mountBarReplay`
for real over a fake one-pane wall and a stubbed server (happy-dom, this file only): a pick on the
active pane writes one blob walking the new instrument at the same cursor and asks for one
rebuild, whose mount takes the follow's probe; an open trade writes nothing and shows the notice;
a wall mounted with no pane on the instrument walked follows its active pane; a `409` still
writes the blob; a save after Exit leaves the intent cleared. `controls.test.ts` renders the
notice in each state. `goto.test.ts` pins Go to's day rule on all three schedules
and across the DST change, and `onBaseBoundary`; `alerts.test.ts` pins the look-ahead (reused
from a later cursor short of its hit, not past it; stale on an edit; a press waiting on it; a
Stop's null never kept; one search at a time); `controls.test.ts` covers the Go to panel. `player.test.ts` pins the player alone (one loop however
it is toggled, pause mid-step, an error ends it). `source.test.ts` pins the stored-ladder probe:
a server that answers every interval (as prod folds schwab's 1h) still yields only what the vendor
stores, an interval finer than the vendor's floor is never asked, and a server stating no
`baseIntervals` is probed for the whole ladder as before. happy-dom applies no stylesheet, so anything
that hinges on CSS (`[hidden]` against a `display: flex`, as the dialog's backdrop is) is checked
in the browser, not here. `scripts/sync-engine-fixtures.sh` vendors the
fixtures from wdashboard-server; `--check` (run by `fixtures.test.ts`) fails if they differ.
