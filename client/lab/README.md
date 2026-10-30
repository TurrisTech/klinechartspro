# client/lab — the Strategy Lab

A page of the dashboard, at **`/lab`** (or `?app=lab`; the **Lab** button on the rail opens it in a
tab of its own), for developing a trading strategy's rules against history: which signals and
indicators it reads, how they join into **graphs** — the AREV21 outlier rank 85 overlay's cascade
from a root timeframe down to 3m/5m signals is the first preset — which nodes are **entries**, and
what happens after them. Built 2026-10-15 at the user's request ("a wdashboard subapp focused on
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

`model.ts` `Strategy`, in the order a run reads it:

| section | what | slots |
|---|---|---|
| `sources` | the **signal pool** | a *published* signal (any `GET /plugins/signals` family, read with the registry row's params — rank 85 is `arev21_outlier_rank` at `q = 0.85`) or a *rule event* (an alert-language rule, fires where it starts to hold), each on chosen timeframes, priced at the candle's body / wick / close, each label mapped to a top or a bottom |
| `graph` | how signals join | roots and which sources root; what a same-side root does (join / new / ignore); whether a signal stepping in a longer root's graph may root; reach (a graph only goes further); which parent (supersede / recent / nearest / root); the **step test**; when a graph ends early (after N root bars, or a condition at each close of a watched timeframe); read bounds |
| `entry` | which nodes are entries | the **entry test**; a **filter** (an alert rule read at the entry instant); which way a top / a bottom trades (default **against the signal**: a top sold, a bottom bought) |
| `exits` | trade management | stop and target (pips, ATR, R, or a price expression), breakeven, trailing stop, exit rules per direction, a time limit, close on an opposite entry |
| `sizing`, `costs`, `outcomes`, `pathInterval` | the account (with a leverage cap, default 50:1), what a trade pays beyond the spread (commission per million, slippage in pips, overnight financing), and the measures | |
| `window`, `holdout` | the last N days or a date range, and the end of it held back from fitting (the last N%, or from a date) | |

**Every rule of the overlay's graph is a slot whose default is that rule** — `rank85Strategy()`
builds exactly the overlay's graphs. Since wdashboard-server 0.56.0 the overlay's graph is the
server's (`services/mtfgraph.py`, `GET /mtf/graph`), and so is the reference: `graph.test.ts` runs
the lab's builder over `fixtures/graph_parity.json` -- generated signal pools and the graphs the
server builds from them, generated and checked in the server's `tests/mtfgraph/` and vendored by
`scripts/sync-engine-fixtures.sh` -- and `live.test.ts` (opt-in, `LAB_LIVE=<server>`) compares the
lab's 5m and 3m entries with the alert manager's graph-entry engine, which reads the server's
graph, on a real server. `runner.test.ts` holds a whole run's graphs to the default slots over the
same signals. The lab starts each root's walk where the server does (`graphStarts`, the server's
`walk_starts`): a longer root from its run in force at the shorter roots' starts, within the
strategy's read bound.

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

Four scopes: **step** (`child`, `parent`, `root`, `graph`), **entry** (`node`, `parent`, `root`,
`graph`), **end** (`bar`, `root`, `graph`) and **level** (`entry`, `node`, `parent`, `root`) — each
node with `price tf time depth is_root side source open high low close` and `raw.<field>` for what
its plugin wrote (`child.raw.p` is arev's P(up)); `dir` is +1 in a top graph, −1 in a bottom one.

## Module by module

| module | does | pure? |
|---|---|---|
| `model.ts` | the strategy, its defaults and presets, the slot scopes, `strategyProblems`, `readStrategy` | yes |
| `expr.ts` | the expression language | yes |
| `graph.ts` | the slotted graph builder (`buildRootGraphs`), `slotEnv` | yes |
| `events.ts` | the pool as `LabSignal`s: published points on their candles; rule events through the alert manager's `buildTrack` / `instants` / `stepInstant` | klinecharts templates |
| `readings.ts` | what `atr()` / `ind()` read | klinecharts templates |
| `entries.ts` | entries from graphs or events, the filter (`RuleAtInstant`) | klinecharts templates |
| `outcomes.ts` | forward returns, MFE/MAE, first touch of ±k ATR, on the path bars, mid prices | yes |
| `trades.ts` | entries as trades through the paper-trading fill engine (`client/replay/engine.ts`), plus breakeven, trailing, rule and time exits; the leverage cap, slippage, commission and financing (`financedCloses`) | yes |
| `runner.ts` | one run: check, read, signals → graphs → entries → filter → outcomes → trades; the holdout's split instant | — |
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

- **Window**: the last N days, or **from / to** two dates (UTC days, the last one included) -- the
  model's `range` window.
- **Editor**: a bar at the top names the sections (a click opens one and scrolls to it) and counts
  each one's problems, so a problem in a closed section is not hidden; *Expand / Collapse all*. In
  any expression slot's **Fields**, a click on a name writes it into the slot's field last typed
  in, at the cursor (a function up to its bracket).
- **Results**: the Entries and Trades tables sort on a header click (ascending, descending, back to
  time). The **stepper** beside the tabs -- or `[` / `]`, or the arrow keys on a row -- walks the
  chart through the rows in the order shown (on Summary / Equity: the entries in time), so the
  worst trades are a few key presses once sorted by R; a picked entry lands 40% across the chart, so
  what price did next is on screen. A click on the equity curve picks the trade closed there.
- **Problems** never wipe the last run: they show in a banner over its results, which stay, dimmed,
  and each problem links to its slot (the section opens, the field is focused). With Auto-run off,
  an edit marks the results out of date the same way; **Stop** (the Run button while a run is going)
  abandons a long run and keeps the last one.
- The bar between the chart and the results **drags** (arrow keys when focused; double-click for
  the default 42%), kept per device. Keys: `Ctrl+Enter` runs, `Ctrl+S` saves.
- A draft never saved is **Discarded**, not Deleted -- the same button, which is off for a fresh
  default nobody has touched.

## Researching a strategy (2026-10-20)

The user chose all of these when asked what the lab lacked:

- **Runs and the baseline** (`runs.ts`). Every run of a strategy in the session is kept -- the copy
  it ran, its figures and what changed since the run before ("Exits · stop", "Graph · step test
  3"). Pin one as the **baseline** and the Summary puts this run beside it, each change under its
  figure, green where better; **Restore** puts any version back in the draft. In the page only: a
  reload starts a new session.
- **Holdout** (header: *hold out the last N%* or *from a date*). Everything runs over the whole
  window; the Summary's figures table adds the fitting part and the holdout, the tables mark
  holdout rows, the equity curve marks the split. A sweep and a basket show the holdout's mean R
  and t beside the fitting part's figures -- choose on one, check on the other.
- **Sweep** (`sweep.ts`). One number of the draft over a range: every number the strategy holds is
  offered, including one written in a condition (the 8 of `parent.tf <= child.tf * 8`). Each value
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
  times; a strategy to a JSON file (**Export**) and back (**New… ▸ From a file**, always as a new
  strategy) -- how one moves between the dev and prod dashboards.

## Decisions worth not re-deriving

- **Knowable at the close.** A signal is placed at its candle's close (`get_interval_end`), where
  the overlay uses the next bar's open; the two order every pair of signals identically (they
  differ only across a market-closed gap, where nothing closes), which is all a graph compares —
  and the close is when an entry can be taken. `live.test.ts` is the check.
- **Entries fill at the entry bar's close**, at its bid (sell) or ask (buy), through the same engine
  as paper trading and replay. A path bar must close AT the entry — the path timeframe is the
  longest one the instrument's vendor stores (`/capabilities` `baseIntervals`, up to a day) tiling
  every entry's (`autoPathInterval`: 1m for 3m and 5m entries; 30m for 1h on schwab, whose 1h is a
  server fold and whose 5s does not exist); an entry
  no path bar closes at is refused, never moved.
- **Levels are computed from the mid close and filled on the bid/ask**: a long pays the spread in
  and is stopped on the bid. One R is measured from the fill. P&L is in the quote currency, as the
  engine counts it.
- **One parent, one entry per signal.** A signal that is an entry in two roots' graphs is one
  entry (the longest root's); the alert manager's graph-entry engine lists it once per graph.
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
