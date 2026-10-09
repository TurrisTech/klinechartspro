# client/alerts — the alert manager

Tell me when EURUSD's 1h RSI crosses below 30 while the close is above its 4h EMA(200). An
**alert** is a rule over values on one instrument, each read at a timeframe of its own, and
a policy for what happens when the rule holds. The **Alerts** button beside the bell opens the
manager: every alert, switch one on or off, re-arm one that fired, edit it, delete it (two
presses), or write a new one. In a **bar replay**, **Next alert** runs the replay to where the
next enabled alert on its instrument triggers.

Built 2026-10-04 at the user's request ("in klinechartspro, let's create an alert manager…
client alerts can subscribe indicator values, and simple or compound rules… the bar replay
feature should sport a Next alert button. Alerts can be enabled or disabled, or deleted"),
which also moved the condition language here ("aggregate condition language into alert
manager") and removed the replay's Next signal ("as we will have next alert").

## Two kinds, one manager

| kind | evaluated | fires | status |
|---|---|---|---|
| **client** | in this browser (`monitor.ts`), at every bar close | while a dashboard tab is open | built |
| **server** | by wdashboard-server | with every tab closed | **not built** — the Server tab says so |

The manager renders any `AlertSource` (`types.ts`), so server alerts are a second source in the
list, not a second manager. The server's **price watches** (`client/watch`, right-click the
chart) are what the server watches today; the Server tab points at them.

## What a rule reads

An **operand** is a value per bar of its timeframe, on the alert's instrument:

| kind | what | from |
|---|---|---|
| `bar` | open / high / low / close / volume | `/getbars` |
| `indicator` | a klinecharts built-in — MA, EMA, RSI, MACD, BOLL, KDJ… (24 of them) — with its params and the line (`rsi1`, `dif`) | computed **in the browser** from the bars by the chart's own template (`getIndicatorClass`, which `patches/klinecharts@10.0.3.patch` exports for this) |
| `series` | a stored registry row's series — AREV19…23 `p`, arev21_outlier, krev01 | `/plugins/{id}/values` |
| `signal` | a plugin's published label on a bar — `long`, `top` — or '' for none | `/plugins/{id}/values`' `signal` field |
| `graph` | a multi-timeframe overlay's **graph entry** on a 3m/5m bar -- the star the overlay draws, `top`/`bottom`, or '' | the overlay's own fetch and graph code, headless (`graphentry.ts`) |
| `time` | the clock at each bar close: **time of day** (minutes past midnight, typed HH:MM) or **weekday**, on a chosen zone | the bar's close, on that zone's wall clock |

A signal or a graph entry can be compared with **any side** (`is any side`, compiled to "not
the empty label").

**Graph entries** (2026-10-05, user: "an alert when there is a 3m or 5m signal at the end of a
graph"). An entry is what the AREV21 outlier rank 85 MTF overlay stars: a 3m or 5m signal
stepped to, through the graph, from a root (client/mtf/graph.ts `isEntry`). The alert runs the
overlay's OWN code on the overlay's own fetch -- `storeGraphSignals`, `buildRootGraphs`,
`isEntry` -- so it stars the bars the chart stars (`graphentry.test.ts` checks the two side by
side). What the alert keeps of its own is the graph's SETTINGS -- the timeframes it reads, its
roots, its largest step -- **copied from a pane when the condition is chosen** (the active pane
if it carries the overlay, else the first that does; user's choice, so a later change to the
pane does not change what the alert means), editable behind its Settings toggle, and copied
again on "Copy from pane". With no pane carrying the overlay it reads **every** timeframe rooted
at 1D: the overlay's own defaults switch on 1h and longer only, and a graph that cannot step
below 1h has no entry to find. The entry's own timeframe is always added to what it reads.
One difference from a pane is deliberate: a pane draws no timeframe finer than its chart, so a
15m chart shows no 5m stars; the alert builds from every timeframe it was given. An entry is
final once every timeframe the graph reads has been served past the instant it became knowable
(`GraphEntries.through`); a timeframe the server has served nothing for (dev computes no arev21
on 3m or 2h locally) is skipped rather than waited on.

**Time conditions** (2026-10-05, user: "also allow alerts based on time signals"): `Time of day
(New York) at 5m closes reaches 09:30` fires at the first close at or after 09:30, once a day;
`is between 08:00 and 11:00` is a window other conditions must fall in; `Weekday is Mon` the
same for days. Read at each bar CLOSE of the condition's timeframe, on the chosen zone's wall
clock (New York, London, Frankfurt, Tokyo, Sydney, UTC), so DST moves nothing. A window across
midnight is written as "is not between" its complement.

OBV and PVT are not offered: they are running sums from the first bar loaded, so their value
depends on where a window starts and never converges -- every alert reads a window, and a
review measured four OBV crossings landing on four different bars from the chart's. AVP needs
turnover, which these bars do not carry.

A **sparse** source -- krev writes a row only on a fresh extreme -- is read through how far it
has served (`compute.ts` `PointIndex.through`): a bar it evaluated past with no row is final
("no signal", which resets an edge), and only a bar after its newest row may still be written.
The search reads points a chunk ahead so a sparse source has usually served past the window.

The registry's computed `S:` rows are not offered: each needs the server to resolve a node
document per instance, and the built-ins cover the same indicators. A plugin's chart template
(`AREV:…`, `TS:…`) is a registered klinecharts indicator too, but its `calc` reads a store the
plugin host fills for a pane and computes nothing on bars of its own — so only the built-ins
are named (`catalogue.ts` `BUILTIN_INDICATORS`).

## The rule, and the one condition language

The editor edits a tree (`editable.ts`): groups — **all / any / none** of these hold — of
conditions, `left op right`, where `right` is a number, another operand, a `[low, high]` band
or a signal label. A simple alert is a group of one, and is **stored as the one condition**.

It is not evaluated by anything of its own. `rules.ts` compiles it to the **condition language**
(`conditions.ts`, the port of the server's `conditions.py`), the same documents a price watch
is: `all`/`any`/`not`, crossings, bands and the **tri-state** answer, where `null` (a field the
observation does not carry, a crossing with nothing to cross from) never fires and never resets
an edge. Two series are compared through their difference — `a crosses above b` is the field
`a - b` crossing 0 — which is exact for every operator offered against a series. The firing
policy (`policy.ts`: `edge`/`level`, `once`/`always`, the cooldown) is the port of the server's
`registry.py`, shared with the replay's price watches (`client/watch/local.ts`). Both are kept
honest by **data**: `fixtures/watch_cases.json`, generated by the server's own suite and
vendored by `scripts/sync-engine-fixtures.sh`.

A rule is **compiled on every write**: one that could never be evaluated (an empty group, a
series compared with itself, a signal compared with a number, a non-instrument) is refused when
it is written, with the reason, rather than stored as an alert that silently never fires.

## When, across timeframes — the effective instant

`timeline.ts`. A bar's value exists from its **close**, never from its label (CLAUDE.md
"Effective timestamps"): the instants a rule is evaluated at are every bar close of every
timeframe it reads, and at each one every operand reads its value on the latest bar **of its own
timeframe** that has closed by then. Bars of two timeframes closing at one instant land in one
observation. A missing value reads as **missing**, never as an older one — a 4h EMA still
warming up, or a server series not yet written for the newest bar, makes the leaf unknowable;
carrying the last value forward would compare today's close against yesterday's line.

`level` (the default) fires at every bar close where the rule holds — with a crossing operator
that is the crossing bar only, which is TradingView's "once per bar close". `edge` fires where
it **starts** holding: two AREV longs on consecutive bars are one episode to an edge trigger.

## Live: `monitor.ts`

Page-level (started once by `startAlerts`), so it keeps watching through a workspace switch
and through a bar replay. Per instrument and timeframe a running alert reads, one shared
**feed**: a history read deep enough for its indicators' lead-in (`catalogue.ts` `leadInBars`:
5 × the longest period + 50, capped at 1,200 bars), then the stream's **closed** bars — a
forming bar is never evaluated. An instant is evaluated once, in order, and **never on
history**: what is there when an alert starts is its baseline, as arming a watch seeds one.

An instant is **waited for** when something it needs has not arrived: a bar of another
timeframe due by then (its frame a second or two behind -- reading the previous bar instead is
the stale read the timeline refuses), or a server value on a bar closing then that the source
has not written yet. It is re-read every 30 s and evaluated anyway after 10 minutes, with the
value missing — late and never cannot be told apart from one
observation, so the wait is bounded (`notes/architecture/freshness-horizons.md`). A firing is
raised into the Notification Center tagged **`alert`**, and recorded on the alert (count, last
firing, `once` → fired).

A change that arrives during an evaluation re-runs it when it ends; an alert switched off,
edited or deleted while the server is being read says nothing; a runner needing more lead-in
than a shared feed has loaded waits for the deeper read before it seeds its baseline.

Known limits: **only while a tab is open** (that is what server alerts are for); **every open
tab evaluates and notifies on its own**; a firing while no tab was open is never caught up.

## A bar replay's Next alert: `search.ts`

`AlertSearch.next(alert, after, until)` answers "where does this rule next trigger?" by
reading **ahead of the cursor** — past the replay's read clock, as the replay's own bar caches
do — a chunk of 3,000 bars of the finest timeframe at a time, each with the lead-in its
indicators need, carrying the policy from chunk to chunk so the answer does not depend on
where a chunk began (tested against one whole-series evaluation). The instants at or before
the cursor are evaluated too — they are what an edge and a crossing compare against — but
cannot be the answer. Only the trigger counts: `once` and the cooldown are about not repeating
a notification and do not apply to "where next". The instants it seeds from are the last few
**bar closes** at or before the cursor, counted in bars (fetching further back when a weekend or
a hole leaves too few), never a span of time that a gap could leave empty.
`client/replay/alerts.ts` asks it for every
enabled alert on the replay's instrument and takes the earliest (each later search is bounded
by the best so far). Rows fetched stay in a `SpanCache` per series, so the next press refetches
nothing it already holds. A Stop is heard between chunks.

Verified in the browser against the local stack (2026-10-04): "Close 1h crosses above MA(30)
1h" stopped exactly on the bars where the chart's own MA30 is crossed, and "AREV arev21 signal
4h is long" on exactly the bars `/plugins/arev/signals` labels long. A server without closed
history in Postgres (the workstation stack without `OHLCV_TILES_URL`) has no bars to evaluate
at before its retention edge — the deployed servers read those from the tiles.

## Persistence

Account-wide, like the starred timeframes — not part of a workspace, so an edit is written at
once, not on the workspace's Save: the `alerts` key of `/preferences`, or this browser's
localStorage where the server has no preferences store. A stored row whose rule no longer
compiles is dropped with a warning. If the stored list **cannot be read** (a failed
`/preferences` read answers `{}`), nothing is written until it can -- the manager says so --
because a save would replace the stored list with what this tab holds. The replay never writes an alert: Next alert only reads
them, and a replay's own price watches stay in its state blob.

## Pieces

| file | what it is |
|---|---|
| `types.ts` | The model: `Operand`, `Rule`, `AlertDefinition`, `Alert`, the `AlertSource` seam. |
| `conditions.ts` | PURE. The condition language (moved from `client/watch/evaluate.ts`). |
| `policy.ts` | PURE. The firing policy, shared with `client/watch/local.ts`. |
| `rules.ts` | PURE. Operand keys, compile to the language, the sentence a rule reads as. |
| `editable.ts` | PURE. The editor's tree (all / any / none groups) and back. |
| `timeline.ts` | PURE. Tracks → instants on the effective clock; `stepInstant`, `scan`. |
| `catalogue.ts` | What can be read and what it is called; lead-in per operand; the server catalogue. |
| `compute.ts` | Values per bar: built-ins through klinecharts, server points by bar date. |
| `data.ts` | `/getbars` and `/plugins/{id}/values` past the read clock; `SpanCache`. |
| `search.ts` | `AlertSearch`, `earliestHit` — Next alert's look-ahead. |
| `graphentry.ts` | `GraphEntryEngine`: an MTF overlay's graph entries, headless, and how far they are final. |
| `store.ts` | `ClientAlertStore`: the list, validation on write, persistence. |
| `monitor.ts` | `AlertMonitor`: live evaluation at bar close, notifications. |
| `editor.ts` | DOM. The rule editor. |
| `manager.ts` | DOM. The window: Client / Server tabs, the list, the editor in place. |
| `index.ts` | `startAlerts` (page) and `mountAlertManager` (wall: the button and the window). |

Debug hook: `window.__wdAlerts.list()` / `.running()` / `.flush()`.

Tests: `bun test client/alerts` — the language's and the policy's parity fixtures, compile and
refusals, the timeline across timeframes, the chunked search against a whole-series
evaluation, the store, the monitor over a fake stream (closed bars only, never on history,
edge vs level, `once`, waiting on a late server value), and the manager and editor in happy-dom.
