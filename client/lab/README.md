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
| `entry` | which nodes are entries | the **entry test**; a **filter** (an alert rule read at the entry instant); which way a top / a bottom trades |
| `exits` | trade management | stop and target (pips, ATR, R, or a price expression), breakeven, trailing stop, exit rules per direction, a time limit, close on an opposite entry |
| `sizing`, `outcomes`, `pathInterval` | the account and the measures | |

**Every rule `client/mtf/graph.ts` hard-codes is a slot whose default is that rule** — `rank85Strategy()`
builds exactly the overlay's graphs. That is checked three ways: `graph.test.ts` runs both builders
over 720 generated signal pools; `runner.test.ts` compares a whole run's graphs with the overlay's
builder over the same signals; and `live.test.ts` (opt-in, `LAB_LIVE=<server>`) compares the lab's
5m and 3m entries with the alert manager's graph-entry engine — the overlay's own fetch and graph
code — on a real server (equal on dev EURUSD, 30 days, three root sets, 2026-10-15).

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
| `trades.ts` | entries as trades through the paper-trading fill engine (`client/replay/engine.ts`), plus breakeven, trailing, rule and time exits | yes |
| `runner.ts` | one run: check, read, signals → graphs → entries → filter → outcomes → trades | — |
| `data.ts` | `LabData` / `HttpLabData`: bars through the tiled path (bid/ask through `/getbars?columns=all`), `GET /plugins/{id}/signals`, points; held per page (`TailCache`) | — |
| `store.ts` | saved strategies under `/preferences` (localStorage without it), one key each plus an index; saves announced on a BroadcastChannel | — |
| `catalogue.ts` | signal families with their registry params, the indicators a rule may compute, timeframes | — |
| `editor.ts`, `results.ts`, `page.ts`, `overlay.ts` | the page (DOM) | — |
| `plugin.ts` | a saved strategy on a dashboard pane | — |
| `alertentries.ts` | a saved strategy's entries as an alert operand | — |

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
- **One parent, one entry per signal.** A signal that is an entry in two roots' graphs is one
  entry (the longest root's); the alert manager's graph-entry engine lists it once per graph.
- **Saving is explicit**, as a workspace's is; a dashboard pane and an alert read the SAVED
  strategy, so an experiment in the lab changes nothing else until it is kept. The page asks before
  closing only for a draft the user changed.
- **A span's tail is read again** whenever the data layer extends it forward: a span read up to now
  ends on a bar still forming, which a closed-bars read leaves out (`TailCache`).
- **A lab rule offers no graph entries and no strategy entries**: the graph is the lab's own job,
  and a strategy reading a strategy is circular.
- **Not built**: running one strategy over a basket of instruments, parameter sweeps, walk-forward;
  server-side evaluation (everything runs in the browser — 30 days of the rank 85 pool on dev reads
  in ~8 s cold and re-runs with no request).
