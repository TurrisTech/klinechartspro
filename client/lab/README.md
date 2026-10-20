# client/lab — the Strategy Lab

A page of the dashboard, at **`/lab`** (or `?app=lab`; the **Lab** button on the rail opens it in a
tab of its own), for developing a trading strategy's rules against history: which signals and
indicators it reads, written as **rules** -- each one the AREV21 outlier rank 85 overlay's cascade
from one root timeframe down to 3m/5m signals, one side, one way, long rules apart from short ones
-- and what happens after their entries. Built 2026-10-15 at the user's request ("a wdashboard subapp focused on
development and refinement of trading strategies … the main feature is the development of rules
based on signals and indicators … we should be able to develop the graph in the arev21 mtf
indicator"), with four choices of theirs:

| question | the user's answer |
|---|---|
| how deep rule authoring goes | **editable rule slots**: each rule a preset or a condition in a closed expression language |
| how a rule is judged | **all three**: entry outcomes, simulated trades, and the chart |
| what may be a graph node | **any published signal, and events defined from indicators** |
| where a good rule goes | **back to the wall and the alerts** |

## The model: a strategy is data

`model.ts` `Strategy` (version 2 since 2026-10-20), in the order a run reads it:

| section | what | slots |
|---|---|---|
| `sources` | the **signals** rules follow | a *published* signal (any `GET /plugins/signals` family, read with the registry row's params — rank 85 is `arev21_outlier_rank` at `q = 0.85`) or a *rule event* (an alert-language rule, fires where it starts to hold), priced at the candle's body / wick / close, each label mapped to a top or a bottom. A source has no timeframes of its own: it is read on the ones its rules use |
| `rules` | the **rules**, long and short apart | each one: on/off, which way it trades, the source it follows and **which side** (a top or a bottom), its **root** timeframe, the shorter timeframes it **steps** through, the ones it **enters** on, an **only-when** filter (an alert rule read at the entry instant) -- and behind *More*: the longest step (`maxStep`, 8), "beyond every node before it" (`reach`), where a signal hangs from (supersede / recent / nearest / root), what a same-side root does (join / new / ignore), an early end (after N root bars, or a condition), and conditions of its own on a step or an entry |
| `lookback` | read bounds | 300 root bars back for the graph in force at the window's start, at most 10,000 bars of a step |
| `exits` | trade management | stop and target (pips, ATR, R, or a price expression), a time limit -- and behind *More*: breakeven, trailing stop, exit rules per direction, close on an opposite entry |
| `sizing`, `costs`, `outcomes`, `pathInterval` | the account (with a leverage cap, default 50:1), what a trade pays beyond the spread (commission per million, slippage in pips, overnight financing), and the measures | |
| `window`, `holdout` | the last N days or a date range, and the end of it held back from fitting (the last N%, or from a date) | |

### Rules (2026-10-20)

The user asked: "take the arev21 mtf and split it so we can have simpler easier to understand rules.
for example each root could be its own rule. the longs can be a separate set of rules from the
shorts", and "take a look at the ux and simplify it". Until then a strategy held ONE graph over
several roots and both sides, with the rules that let several roots share it (a signal stepping in a
longer root's graph roots nothing in a shorter one) and a last setting mapping tops and bottoms to
long and short.

A rule is now one **root**, one **side** and one **direction**: "Long · 1D -- from 1D bottoms, step
down through 8h ... 3m, buy at 5m and 3m". `rules.ts` compiles it to the slotted builder's spec (one
root, rooted by its source alone, the overlay's step test with the rule's `maxStep`, an entry test
"on one of its entry timeframes"), and the runner builds each rule's graphs on their own and keeps
those of its side. A rule with no steps has no graph: every signal of its side on the root is an
entry (the rule-event preset, RSI on 1h).

- **Default: against the signal** (user, 2026-10-15) -- a long rule follows the bottoms, a short rule
  the tops (`followsFor`); the card says "against the signal" or "with the signal".
- **Rules are independent.** The same 5m signal can be an entry of a 1D rule and of a 1h rule. Each
  rule is measured **alone** -- its own outcomes, its own account (`RuleRun`) -- and the strategy is
  every rule's entries on **one account**, a signal taken once: by the first rule listed, long rules
  before short ones. A sweep or a basket compares whole runs and skips the per-rule accounts
  (`perRule: false`).
- **The overlay is still the reference.** A long and a short rule from one root at their defaults
  are the overlay's graphs from that root, split by side (`runner.test.ts`), and `live.test.ts` holds
  their 5m and 3m entries to the server's graph-entry engine root by root -- equal on dev EURUSD over
  30 days, 2026-10-20: 1D 16/44, 8h 16/44, 4h 17/43, 2h 0/0 (dev has no 2h rank signals), 1h 45/96.
  The overlay with SEVERAL roots at once is no longer something a strategy builds.
- **Version-1 strategies migrate on read** (`migrateV1`): a rule per root and side, each with the
  graph's settings; the step test's presets become fields (`parent.tf <= child.tf * N` is `maxStep`,
  `node.tf <= tf('5m')` is the entries on 5m and shorter) and anything else stays a condition of the
  rule's own; a graph-off strategy becomes a pair of event rules per timeframe. Each rule keeps the
  version-1 direction, so an old strategy that bought the tops reads "with the signal".

The graph builder itself (`graph.ts`, a port of the server's `services/mtfgraph.py`) and its
parity with the server are unchanged: `graph.test.ts` still runs it over
`fixtures/graph_parity.json`, generated signal pools and the graphs the server builds from them,
generated and checked in the server's `tests/mtfgraph/` and vendored by
`scripts/sync-engine-fixtures.sh`. Each root's walk starts where the server's does (`graphStart`, the
server's `run_start`), within the strategy's read bound.

### The expression language (`expr.ts`)

A slot that is not a preset is written as a condition:

```
(child.price - parent.price) * dir > 0.5 * atr(14)
root.tf >= tf('8h') and graph.entries == 0
```

A closed grammar, parsed and walked — no `eval`: numbers, `'strings'`, `true`/`false`, the dotted
names the slot offers (`model.ts` `SCOPES` — the editor's "Fields" lists them with what each
means), `+ - * / %`, comparisons, `and`/`or`/`not`, and functions: `abs min max round tf`, and
`atr(period, 'tf')` / `ind('EMA', 'ema1', 'tf', 200)`, which read an indicator at the latest bar
CLOSED by the instant (the effective-timestamp rule) — computed by the chart's own templates
(`readings.ts`). Unknown values (a root has no parent; an indicator warming up) propagate with
Kleene logic, and a condition holds only when exactly `true`.

A rule's own conditions (its *More*), an early end, and a price-expression stop or target are
written in it. Four scopes: **step** (`child`, `parent`, `root`, `graph`), **entry** (`node`, `parent`, `root`,
`graph`), **end** (`bar`, `root`, `graph`) and **level** (`entry`, `node`, `parent`, `root`) — each
node with `price tf time depth is_root side source open high low close` and `raw.<field>` for what
its plugin wrote (`child.raw.p` is arev's P(up)); `dir` is +1 in a top graph, −1 in a bottom one.

## Module by module

| module | does | pure? |
|---|---|---|
| `model.ts` | the strategy and its rules, their defaults and presets, the slot scopes, `strategyProblems`, `readStrategy` and `migrateV1` | yes |
| `rules.ts` | a rule as the graph builder's spec, its entry test, its signals, its timeframes | yes |
| `expr.ts` | the expression language | yes |
| `graph.ts` | the slotted graph builder (`buildRootGraphs`), `slotEnv` | yes |
| `events.ts` | the pool as `LabSignal`s: published points on their candles; rule events through the alert manager's `buildTrack` / `instants` / `stepInstant` | klinecharts templates |
| `readings.ts` | what `atr()` / `ind()` read | klinecharts templates |
| `entries.ts` | a rule's entries from its graphs or its events, the filter (`RuleAtInstant`) | klinecharts templates |
| `outcomes.ts` | forward returns, MFE/MAE, first touch of ±k ATR, on the path bars, mid prices | yes |
| `trades.ts` | entries as trades through the paper-trading fill engine (`client/replay/engine.ts`), plus breakeven, trailing, rule and time exits; the leverage cap, slippage, commission and financing (`financedCloses`) | yes |
| `runner.ts` | one run: check, read (each source and timeframe once, longest first), then rule by rule signals → graphs → entries → filter, outcomes → trades for the rules together and each alone; the holdout's split instant | — |
| `stats.ts` | a mean's t-statistic and its seeded bootstrap interval | yes |
| `figures.ts` | a run (or its fitting part, or its holdout) as one row of figures, which way each is better, and a change between two | yes |
| `changes.ts` | what an edit changed, in the editor's words | yes |
| `sweep.ts`, `sweepview.ts` | every number a strategy holds (a signal's parameter, a number written in a condition, a stop, a cost...), a sweep over one, and its panel | logic yes |
| `basket.ts`, `basketview.ts` | one strategy over many instruments (the 7 majors, the 28 FX pairs), the pooled trades, and its panel | logic yes |
| `runs.ts` | this session's runs, the baseline, and the Runs panel | history yes |
| `figtable.ts` | rows of figures as a table, each change under its value | — |
| `export.ts` | entries and trades as CSV, a strategy to and from a JSON file | but `download` |
| `data.ts` | `LabData` / `HttpLabData`: bars through the tiled path (bid/ask through `/getbars?columns=all`), `GET /plugins/{id}/signals`, points; held per page (`TailCache`) | — |
| `store.ts` | saved strategies under `/preferences` (localStorage without it), one key each plus an index; saves announced on a BroadcastChannel | — |
| `catalogue.ts` | signal families with their registry params, the indicators a rule may compute, timeframes | — |
| `editor.ts`, `results.ts`, `page.ts`, `overlay.ts` | the page (DOM) | — |
| `plugin.ts` | a saved strategy on a dashboard pane | — |
| `alertentries.ts` | a saved strategy's entries as an alert operand | — |

## Using the page

- **Header**: the strategy, its name, **Save**, and **⋯** (New: the rank 85 rules, rule events, a copy,
  from a file; Export to a file; Revert; Delete) on the left; the instrument, the window -- the last N
  days, or **from / to** two dates (UTC days, the last one included) -- **Run** and **Options**
  (Auto-run, a holdout, what the chart shows) on the right. A click outside a menu closes it.
- **Editor**: Long rules, Short rules, Exits first; Signals, Account, Outcomes and Notes closed below.
  A rule card reads as a sentence -- *From* [root] [bottoms (short)] *against the signal*, *Steps*
  (the chips carry each timeframe's signals in the last run), *Buys at* / *Sells at*, *Only when* --
  with its on/off, Copy and Remove; *More* holds the rest. Switching a step off takes it out of the
  entries; a new root keeps the steps still under it; **+ Long rule** takes the overlay's next root
  not yet used. A bar at the top names the sections (a click opens one and scrolls to it) and counts
  each one's problems, so a problem in a closed section is not hidden; *Expand / Collapse all*. In
  any expression slot's **Fields**, a click on a name writes it into the slot's field last typed
  in, at the cursor (a function up to its bracket).
- **Results**: the Summary opens on the run's counts and the rules -- each alone, then all of them on
  one account -- with **Details** (what price did after the entries, the simulated account, month by
  month) one click away, kept open or closed per device. The Entries and Trades tables name each
  row's rule and sort on a header click (ascending, descending, back to time). The **stepper** beside
  the tabs -- or `[` / `]`, or the arrow keys on a row -- walks the chart through the rows in the
  order shown (on Summary / Equity: the entries in time), so the worst trades are a few key presses
  once sorted by R; a picked entry lands 40% across the chart, so what price did next is on screen.
  A click on the equity curve picks the trade closed there.
- **Problems** never wipe the last run: they show in a banner over its results, which stay, dimmed,
  and each problem links to its slot (the section opens, a rule's *More* too, the field is focused).
  With Auto-run off, an edit marks the results out of date the same way; **Stop** (the Run button
  while a run is going) abandons a long run and keeps the last one.
- The bar between the chart and the results **drags** (arrow keys when focused; double-click for
  the default 42%), kept per device. Keys: `Ctrl+Enter` runs, `Ctrl+S` saves.
- A draft never saved is **Discarded**, not Deleted -- the same item, which is off for a fresh
  default nobody has touched.

## Researching a strategy (2026-10-20)

The user chose all of these when asked what the lab lacked:

- **Runs and the baseline** (`runs.ts`). Every run of a strategy in the session is kept -- the copy
  it ran, its figures and what changed since the run before ("Exits · stop", "Long · 1D ·
  steps"). Pin one as the **baseline** and the Summary puts this run beside it, each change under its
  figure, green where better; **Restore** puts any version back in the draft. In the page only: a
  reload starts a new session.
- **Holdout** (Options: *hold out the last N%* or *from a date*). Everything runs over the whole
  window; the Summary's figures table adds the fitting part and the holdout, the tables mark
  holdout rows, the equity curve marks the split. A sweep and a basket show the holdout's mean R
  and t beside the fitting part's figures -- choose on one, check on the other.
- **Sweep** (`sweep.ts`). One number of the draft over a range: every number the strategy holds is
  offered, by its rule (a rule's longest step, its end, a number written in its own conditions). Each value
  is a full run of a copy; the draft is untouched until **Use**.
- **Basket** (`basket.ts`). The draft on every instrument of a list, two at a time, each through
  its own data layer (dropped with its run, so 28 instruments' bars are never held at once); the
  rows and the pooled trades. The presets keep only what the server offers and say what they left
  out -- dev carries 4 OANDA instruments, prod 30.
- **Significance** (`stats.ts`). Mean R per trade and forward pips per horizon with their t and a
  bootstrap 95% interval, seeded so a re-run moves nothing; the trades month by month. Both assume
  independent samples, which entries close together are not -- the page says so.
- **Costs and the leverage cap** (`trades.ts`). P&L, R and the balance are net of commission and
  financing; slippage is in the prices (and so in the pips); a target is a limit and never slips.
  Financing is charged at each daily close held through for the days to the next close, so a
  Friday close carries the weekend (OANDA books it on Wednesday for FX -- the same over a week).
  Positions are cut to the cap of the balance in notional: before it, 1% risk on a ~1-pip stop
  opened ~60:1. Costs default to none; the cap to 50:1.
- **Files** (`export.ts`). CSV of the entries or the trades (the table shown), raw values and UTC
  times; a strategy to a JSON file (**⋯ ▸ Export to a file**) and back (**⋯ ▸ From a file**, always as a new
  strategy) -- how one moves between the dev and prod dashboards.

## Decisions worth not re-deriving

- **Knowable at the close.** A signal is placed at its candle's close (`get_interval_end`), where
  the overlay uses the next bar's open; the two order every pair of signals identically (they
  differ only across a market-closed gap, where nothing closes), which is all a graph compares —
  and the close is when an entry can be taken. `live.test.ts` is the check.
- **Entries fill at the entry bar's close**, at its bid (sell) or ask (buy), through the same engine
  as paper trading and replay. A path bar must close AT the entry — the path timeframe is the
  longest stored one tiling every entry's (`autoPathInterval`: 1m for 3m and 5m entries); an entry
  no path bar closes at is refused, never moved.
- **Levels are computed from the mid close and filled on the bid/ask**: a long pays the spread in
  and is stopped on the bid. One R is measured from the fill. P&L is in the quote currency, as the
  engine counts it.
- **One parent; one entry per signal on the account.** A signal that is an entry of two rules is
  each rule's when the rule is measured alone, and once on the strategy's account (the first rule
  listed); the alert manager's graph-entry engine lists it once per graph.
- **Saving is explicit**, as a workspace's is; a dashboard pane and an alert read the SAVED
  strategy, so an experiment in the lab changes nothing else until it is kept. The page asks before
  closing only for a draft the user changed.
- **A span's tail is read again** whenever the data layer extends it forward: a span read up to now
  ends on a bar still forming, which a closed-bars read leaves out (`TailCache`).
- **A lab rule offers no graph entries and no strategy entries**: the graph is the lab's own job,
  and a strategy reading a strategy is circular.
- **Not built**: walk-forward (a holdout is one split; rolling ones would build on it), a sweep of
  two numbers at once, and server-side evaluation (everything runs in the browser — 30 days of the
  rank 85 pool on dev reads in ~8 s cold and re-runs with no request; a sweep's later values read
  only what their number changes).
