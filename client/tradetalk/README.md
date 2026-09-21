# TradeTalk entries (`TT:entries`)

Where the **TradeTalk** method — the YouTube channel `@tradetalk1`, host Heath — would enter,
drawn on the price pane. Client-only: the rule, the level map and the drawing are all computed
in the browser, and the only thing it reads that the chart does not already hold is **daily
bars**, off `/getbars` (and the chart tiles in front of it). **No server change of any kind.**

The method it implements is the dossier built from the channel's complete long-form archive
(237 videos, 2020-11 → 2026-08): `/workspace/notes/research/tradetalk-heath-method.md`, published
at <https://claude.ai/code/artifact/2f402fe4-1f56-4eaf-b6f4-caa263d328d3>. Section numbers below
are that document's. **Nothing in the method is validated** — every performance claim in the
corpus is self-reported — and this indicator does not validate it either. It shows what the rules
say, faithfully, so the rules can be looked at.

## The rule, and where each half of it comes from

Two of his five setups share one mechanic, so they are one rule here:

> **Setup 2, "his favourite" (§7)** — Price runs *below* a swing low or support, triggering sell
> stops. That candle *closes back above* the level. Enter when the **high of the stop-run candle**
> is taken out. Stop below the **low of the stop-run candle** — *"if price goes back down to those
> lows then it is continuation and not a stop run."*

> **Setup 1, the CTM entry (§7)** — Wait for a pullback into a level *in the direction of trend*;
> wait for price to show it will trade away — *"wicks through the level, bodies closing on the
> right side"*; enter when a candle takes out the high of the last counter-trend candle; stop below
> its low; target the next opposing level, minimum 2:1.

So, on every bar:

| step | the rule | the code |
|---|---|---|
| sweep | a candle **opens** on one side of an objective level, **trades through** it and **closes back** on the side it opened | `signalAt` in `rules.ts` |
| which level | the coarsest unit swept, then the more significant kind, then the nearest to the close | `pickLevel` |
| entry | a stop order at the signal candle's extreme, filled when a **later** bar takes it out (strictly — "takes out" is the same test his *trending candle* is defined by), at the trigger or at the open if the bar gapped past it | the order loop in `computeTradeTalk` |
| stop | the signal candle's other extreme | same |
| target | "the next opposing level", or the high/low of the day when that is nearer (§8); with nothing beyond, the minimum reward stands in and the label says `no level` (at an all-time high he switches to Fibonacci extensions, which this does not draw) | `nextTarget` |
| refuse | reward:risk under the minimum — *"if the geometry doesn't give you 2:1, there is no trade"* (§9) | `signalAt` |
| half size | another objective level sits between entry and stop, "because price usually runs it first" (§9) | `signalAt` |
| cancel | price goes back through the signal candle's other extreme before the order fills — that was continuation | the order loop |
| one at a time | no new entry while a position is open — *"one trade a day is enough"* (§9) | the order loop |
| bias | *"the daily 21 EMA is the day-trade bias switch"*; above/below the **yearly open** is the structural bias (§3.4, §5) | `biasOf`, `yearOpen` |
| hours | *"nothing after 11:00 a.m. ET"*, no Asian session, no weekends (§8, §13) — applied to the bar that would FILL, and only on charts of an hour or less | `inTradingWindow` |

**The level map (§3.4)** is his mature framework: *"for each of yearly, quarterly, monthly, weekly,
daily he marks five data points: open, high, low, close and midpoint"*. Per unit this draws **the
open of the period in progress** and **the high, low and midpoint of the one before it**, labelled
the way he labels lines (`2026 open`, `Q3 open`, `Aug high`, `last week mid`, `prev day low`) —
*"so no line is ever ambiguous"*. Two deliberate omissions:

- **the close** — on a 24-hour market it is the next open to within a weekend gap, so it is a
  second line on one price;
- **the developing high and low of the period in progress** — price is *at* them by definition
  whenever it makes a new one, which is not a line to trade against. The day's running high and
  low are used, but as **targets**, which is what §8 uses them for.

Two prices that agree are one line, kept under the coarser unit's name (`dedupeLevels`): at a year
boundary the yearly, quarterly, monthly and weekly opens are all the same number.

## The other family: Heath levels (`TT:heathlevels`)

A second template in the same plugin, and a different kind of line. The calendar map above is
§3.4; this is **§3.2, supply and demand** — what his community named "Heath levels", and the
half of the method that is about one candle rather than one calendar period:

> I only draw my supply and demand zones with a **single line at the open**… because I like to
> keep my charts neat. Also this gives me pinpoint accuracy when taking my entries, giving me
> the ability to have the smallest stop loss distance to increase position size. — #73

| | |
|---|---|
| **supply** (above price) | the **open** of the last **up-close** candle before a sell-off |
| **demand** (below price) | the **open** of the last **down-close** candle before a rally |
| stop | above the wick **high** (supply) or below the wick **low** (demand) of that same candle |
| worth | "a **fresh, untested** level is worth far more than one price has already visited" |

Two words in that definition have to be made mechanical, and both are parameters rather than
opinions buried in the code. **"Before a turn"** is a swing top or bottom, found with the same
rule the chart's own Tops and Bottoms indicator uses (`swingMask`, `left`/`right`) — so a level
is knowable only `right` bars after the candle that made it. **"The last opposite-colour
candle"** is searched backwards from the turn, the turn's own candle included (a rally's final
candle usually *is* the up-close one), and bounded by `LOOKBACK`: with nothing of that colour
within 20 bars there is no level, rather than an arbitrary one.

A level's life, all of it forward-looking: **armed** once price has left it (a close on the far
side — without which the sell-off that created a supply would instantly "test" it, since the
line is that candle's own open), **tested** the first time a later bar's range reaches back to
it, **broken** the first time a candle closes beyond the stop. It dies where the trade would
have, which is the point of putting the stop there.

Drawn: a horizontal line from its origin candle, **dashed until the swing is confirmed** (that
stretch exists in hindsight only, and dashing it is the difference between showing the method
and flattering it), solid after, dimmed once tested, ending at the candle that closed through
the stop. Live levels are named at the right edge — `supply`, `demand · tested`. Params:
`[left, right, sides, fresh only, stop line]`, default `[5, 5, 0, 0, 0]`.

It reads **nothing** — not even daily bars — so the plugin registers it and deliberately does
not `match` it: an unmatched template is left to klinecharts, which is all it wants.

**It does not feed the entries.** `TT:entries` trades the calendar map only. The method's own
setups do reach for these (§7 setup 1 pulls back "into a level"), so wiring them in is a real
option — but it changes which trades appear, so it is a decision rather than a detail.

Not implemented from §3: the close-based support and resistance of **§3.1** (the highest
bullish close / the lowest bearish close), and the intra-trend counter-trend levels of **§3.3**.
The note that "one candle can be both — its open is demand, its close is support" belongs to
§3.1 and arrives with it.

## Where the levels come from

A calendar candle is the sessions it holds, and a session comes from the **instrument's own
schedule** — never a constant (CLAUDE.md, "Candle boundary rules"). `SymbolInfo.timezone` +
`dayGeometry` (which the server resolves from Postgres) date every bar to a session, so the forex
week that opens Sunday 17:00 New York, crypto's UTC midnight and a US equity session are one code
path. An instrument the chart was given no schedule for draws **nothing**, and the legend says so:
a guessed zone would move every boundary without looking wrong.

Daily bars come from the plugin host's one source (`api.ts`), over the chart's window widened back
to the start of the year *before* it — the least that can answer "what did last year's candle do",
and far more than the 21 sessions the EMA needs. Sessions the daily feed has not served yet (the
one forming, any that closed since the page loaded, and on a daily-or-coarser chart simply the
bars themselves) are folded from the chart's own bars.

## No lookahead

A signal is decided at the close of the candle that made it, from levels knowable at the start of
its session; the order fills on a **later** bar; the outcome is read forwards. Where one bar could
have filled and stopped in either order, the **pessimistic** reading is taken — a stop.

`rules.test.ts` pins this as **prefix invariance**: every trade the full run takes must appear,
identically, in a run over the bars up to its own entry. A rule that peeked would differ there.

## Parameters

`[min R:R, bias, hours, order life, smallest level, level map]`, default `[2, 1, 1, 5, 0, 1]`.

| # | parameter | default | values |
|---|---|---|---|
| 1 | minimum reward:risk | 2 | his own floor (§9) |
| 2 | bias | 1 | 0 none, 1 the daily 21 EMA, 2 the daily 21 EMA **and** the yearly open agreeing |
| 3 | hours | 1 | 0 any, 1 03:00–11:00 New York (London through the New York morning), 2 07:00–11:00 |
| 4 | entry order lives for | 5 bars | he states no expiry; this is the one invented number, and it is a parameter |
| 5 | smallest level | 0 daily | 1 weekly, 2 monthly — coarser maps, fewer entries |
| 6 | draw the level map | 1 | 0 draws only the entries |

**An empty pane is a result.** The corner line says how many sweeps each filter refused — "skipped
63 short of the reward, 53 against the bias, 2 outside the hours" — so a chart with no entries on
it is legible rather than looking broken. On EURUSD 1h over 30 days (dev, 2026-09-21) the defaults
take **0** trades and the reward filter is what refuses most of them; on 15m over 12 days they take
5. That is the method working as stated, not a bug: *"the more trades you take, the more
opportunities you have to lose money."*

## What is drawn

Level lines run under the bars they are in force for, coloured by unit (yearly gold, quarterly
purple, monthly blue, weekly teal, daily grey) and labelled down the right edge on chips of the
pane's own background. Each trade is an arrow at the entry bar, the entry line, and the target and
stop zones boxed out to wherever the trade ended, with a dot on the swept level at the signal
candle, a square at the exit, and a label — `L Aug low › week open 2.4R ½`. The legend carries the
entry and stop prices at the crosshair bar.

## What this does NOT model

- **Costs.** A reclaim candle on a fast chart can be smaller than the spread: the EURUSD round
  trip measured in `notes/research/brk01/` is **2.05–2.34 pips**, and several 1h signals here have
  stops under 4 pips. The R multiples drawn are gross.
- **His exits.** He takes two thirds off at the first target and runs the rest from break-even
  (§8). A trade here ends at its first target, whole.
- **Discretion.** *"Wait for price to show it will trade away"* is a judgement; the body-close test
  is the mechanical half of it.
- The **news liquidation break** (§7 setup 3), the **currency-strength pair selection** (§8), the
  **options and hedging layer** (§10) and position sizing in cash (§9).

## Traps, for whoever edits this

- **A figure's values enter the y-axis** (`YAxisImp.createRangeImp`), which is why `entry` and
  `stop` are figures — they are the signal candle's own extremes — and `target` is not: a yearly
  level several percent away would stretch the axis the moment a trade appeared.
- **A period's open is not a line on the bar that opened it.** On a 1h chart the 17:00 candle *is*
  the daily open, so every bullish candle with a lower wick would "sweep and reclaim" it. The
  per-bar mask in `levelsAt` is what excludes it.
- **Daily bars are dated by their session, the chart's may not be.** Daily-and-coarser bars come
  off the wire canonically dated (`services/wiredate.py`); intraday bars are dated by their open.
  `sessionsFromDaily` therefore reads the feed with `sessionDated: true` whatever the chart is.
- **`ChartPane` installs its own `createTooltipDataSource`** on every indicator it creates and only
  asks *this library's* templates for theirs, so an app-registered template cannot supply legends.
  The corner summary is drawn on the canvas for that reason.
- **`paneBackground` reads the DOM once per `draw`**, walking up to eight parents for the first
  painted background. Measured in the running client at **3.5 µs per call** (1,000 walks in 3.5 ms,
  Chrome, 2026-09-21) — 0.02% of a 60 fps frame, so it is not worth caching; it is here so nobody
  "optimises" it on suspicion.
- **The level array is shared by reference** between bars of a session (cached per session and
  mask), which is what lets `draw` group bars into runs. Do not rebuild it per bar.

## Tests

`bun test client/tradetalk` — `heathlevels.test.ts` (the supply/demand definition on both
sides, the origin walk-back, arming/testing/breaking, prefix invariance), `calendar.test.ts` (session dating on all three geometries, period
folding, the labels, the EMA), `rules.test.ts` (the worked stop-run, every refusal, the filters,
prefix invariance, the bar that reaches both), `plugin.test.ts` (the clock, the daily window, the
parameters, the corner summary).

Checked against dev on 2026-09-21: EURUSD 1h/15m and BTCUSD 15m in the browser, and the first
trade of an EURUSD 1h run verified bar by bar against `/getbars` — the 2026-08-26 19:00Z candle
(O 1.16514 H 1.16538 L 1.16502 C 1.16534) sweeping `prev day low` 1.16511 and closing back above
it, entry 1.16538 on the next bar, stop 1.16502, target `prev day mid` 1.16655 at 3.24R, stopped
the bar after that.
