# NNFX shortlist indicators

Eight indicators that the No Nonsense Forex discovery ranked well. They are computed in the browser from the
bars the pane holds, like WMA, Tops and Bottoms and SSL. The study, its rankings and its caveats
are in the workspace repo (`TurrisTech/project-trading-marketdata`), at
`notes/research/NoNonSenseForex/results/README.md`. Every number below comes from there: 28 OANDA
pairs on prod data, full NNFX trade rules, **in-sample and best-of-grid by design**. The user asked
for a discretionary search, not a validated one.

| Template | Picker label | Pane | NNFX slot it ranked in | Default | Source's own default |
|---|---|---|---|---|---|
| `DODA_STOCH` | Doda Stochastic | sub | C1, two-lines cross, 1D: 18/28 pairs | slw 12, pds 20, signal 14 | 8, 13, 9 |
| `BANDPASS` | Band Pass Filter | sub | C1, zero cross, 1D: 18/28 | period 50, delta 0.1, median | same |
| `CORR_TREND` | Correlation Trend | sub | C1, long line's zero cross, 8h: 16/28 | short 40, long 80, HA median | 20, 40 |
| `HA_SMOOTHED` | Heiken Ashi Smoothed | price | C1, 8h: 15/28, but see below | SMMA 6, then LWMA 2 | same |
| `OSCAR` | OSCAR Oscillator | sub | C1, the trigger rule, 8h: 16/28 | length 20, RMA | 8 |
| `TTF` | TTF (Trend Trigger Factor) | sub | C1, zero cross, 8h: 14/28 | period 45, MQL5 version | 15 |
| `CHANDELIER` | Chandelier Exit | price | Baseline, 8h: 14/28 | range 6, ATR 7 × 2.5 | range 7, ATR 9 |
| `TREND_AKKAM` | Trend Akkam | price | Baseline, 8h: 11/28 | ATR 150 × 6 | ATR 100 × 6 |

**The defaults are the settings that put each indicator on the shortlist**, on the timeframe where
it ranked. The study's headline is that **1D is the only timeframe where NNFX holds up**: spread is
2.8% of ATR there, against 16% on 1h. So treat an 8h ranking as weaker evidence, and re-check any
setting on 1D before trusting it. Where an indicator does better on 1D at another setting, that
template's doc comment says so (TTF: Bilak's T3 version at 12/4).

Two rankings are not quite what the chart draws:

- **Heiken Ashi Smoothed.** Its 8h rank came from an artefact form: the smoothed open against the
  smoothed low, which is "long" 94% of the time. The candle **colour** the chart draws ranked 14/28
  on 1D (at SMMA 9 / LWMA 3) and only 6/28 on 8h.
- **Trend Akkam.** As a baseline it was ranked on the close against the stop. The arrows mark the
  indicator's own flips, where the **open** crosses the stop, which usually comes one bar later.

Each template's doc comment covers:

- the formula;
- what the colours and marks mean;
- where the template departs from its MQL / Pine source, and why.

Two departures matter for reading a chart:

- **A signal at a bar is final only at that bar's close.** On the live edge, the forming bar can
  flip and flip back.
- **The IIR ones depend slightly on where the loaded history starts.** These are the EMAs and
  SMMAs (Doda, Heiken Ashi Smoothed, OSCAR's RMA), the band-pass filter and Bilak's T3.

## The library indicators the systems use

Five more templates are the standard indicators the NNFX systems are built from, not shortlist
entries of their own (`library.test.ts` locks each to the library the study ran, through
`fixtures/library_parity.json`):

| Template | Picker label | Pane | Used by (the NNFX Systems Manual) | Default | Locked to |
|---|---|---|---|---|---|
| `KELTNER` | Keltner Channel | price | System B's C1: the mid-line rising or falling | window 20, original version | `ta.volatility.KeltnerChannel` |
| `RSX` | RSX | sub | System A's C2: above or below 50 | 21 | `pandas_ta.rsx` |
| `SMI` | SMI | sub | System C's C1: SMI against its 3-bar average | 39, 6, 75, 27, average 3 | `talib.SMI` |
| `LINREG` | Linear Regression Intercept | price | System C's C2: close above or below it | 28 | `talib.LINEARREG_INTERCEPT` |
| `ATR` | ATR | sub | Every system: distance rule, stop, target, trail | 14, simple average (MT4) | the NNFX simulator's MT4 ATR, and `talib.ATR` for Wilder |

How each departs from its library:

- **Keltner.** `ta`'s original bands average a partial window over the first `window − 1` bars;
  the template draws nothing there. The modern version (EMA ± ATR) is offered too.
- **SMI.** TA-Lib withholds SMI until its signal line exists. The template draws it from its own
  first value, with the same numbers wherever TA-Lib has one.
- **Linear-regression intercept.** It is the fitted line's value at the **oldest** bar of the
  window, as TA-Lib defines it, so it lags price by design.

## The windicators scan's top systems

Fifteen more templates, and `SSL`, are the indicators of the best 1D systems from the **windicators
NNFX scan**: all of the `windicators` library, scanned over the last six years on 28 OANDA pairs
(workspace repo, `notes/research/NoNonSenseForex/results/windicators-6y/`, finding 8). Same caveat
as above: in-sample and best-of-grid, by the user's instruction. A "real" baseline is one the close
is above 30–70% of the time. The ranking below is the scan's rerun of 2026-10-14, after three fixes
that changed it: its moving-average forms are exact, it holds only two-sided baselines, and the
pivot indicators no longer count their blocks from each pair's first bar.

| # | Baseline | C1 | C2 | %/yr per pair | Pairs + |
|---|---|---|---|---|---|
| 1 | `HWMA` 0.3 / 0.067 / 0.15 | `HWC_PCT` 0.67 / 0.3 / 0.15 / 0.225 / 0.165, MA 8, inverted | `TCF` 15 / 10 / 1.0815, inverted | +2.62 | 26/28 |
| 2 | `KALMAN` 0.00015 / 0.00067 / 2 | `KST` 10/15/40/15, 11/5/6/30, signal 4, MA 3 | `BANDPASS_J` 30 / 0.1206 | +2.26 | 24/28 |
| 3 | `KALMAN`, as 2 | `SSL` 7, HMA, read inverted | `BANDPASS_J` 30 / 0.1608 | +2.20 | 23/28 |
| 4 | `KALMAN`, as 2 | `MACDEXT` 24 / 26 / 4, MA 3, inverted | `TURTLE` 10 / 5, inverted | +2.16 | 24/28 |
| 5 | `KALMAN`, as 2 | `MACDEXT`, as 4 | `PTL` 10 / 2, inverted | +2.16 | 24/28 |
| 6 | `HWMA`, as 1 | `HWC_PCT`, as 1 | `VOSS` 36 / 2 / 0.1675, inverted | +2.14 | 22/28 |

**Every template's default is the setting a system ran,** so adding it to a chart draws what was
tested. Two exceptions: system 3's `BANDPASS_J` bandwidth (0.1608; the template opens at system 2's
0.1206) and its `SSL`, which opens at the NNFX discovery's SSL(15) and has no `inverted` setting
(set length 7 and MA 5, HMA, and read its short as the long). The seventh system, `HWMA` + `HWC_PCT`
+ the Schaff trend cycle on EVWMA (+2.13), has no template.

The scan finds every `HWMA` system twice: `HWC`'s middle line is the HWMA at the same na, nb and nc,
and the two take the same trades. At its defaults `HWC` draws that line with bands around it.

**The best system overall has no baseline:** `HWC_PCT` + `VOSS`, as above, plus the `VP_POC` exit
at 3 / 0.63 / 0.055, inverted: +3.56, 27/28 pairs. Without the exit it makes +3.28. The best with no
exit is `MACDEXT` + `BANDPASS_J` 30 / 0.1206, +3.41.

`VWMACD`, `BANDPASS_J_RAW` and `IS_CALC` were in the scan's first top five and are no longer in a top
system; they are kept, because removing a template breaks the layouts that saved it.

| Template | Picker label | Pane | Draws |
|---|---|---|---|
| `HWMA` | HWMA (Holt-Winters Moving Average) | price | the line, in the up colour while the close is above it |
| `HWC` | Holt-Winters Channel | price | middle line coloured by the close's side; bands in the neutral colour |
| `KALMAN` | Kalman Filter Forecast | price | the `horizon`-bar forecast, coloured by the close's side |
| `TURTLE` | Turtle Trading Channel | price | the channel line, coloured by the side it gives; the stop neutral |
| `PTL` | Perfect Trend Line | price | the slow line, coloured by the side it gives; the fast line neutral |
| `VP_POC` | Volume Profile POC and Value Area | price | the value area shaded, the POC, and a dot on each bar where the exit closes a trade |
| `HWC_PCT` | HWC % | sub | the close's position in the channel (0 lower band, 1 upper) and its MA; shaded by side |
| `MACDEXT` | MACDEXT (MACD on simple averages) | sub | MACD, signal, the signal's MA, histogram; shaded by side between signal and MA |
| `KST` | KST (Know Sure Thing) | sub | KST, signal, the signal's MA; shaded by side between signal and MA |
| `TCF` | TCF (Trend Continuation Factor) | sub | TCF+ coloured by side, TCF- neutral |
| `VWMACD` | VW-MACD (Volume-Weighted MACD) | sub | line, signal coloured by side, histogram |
| `BANDPASS_J` | Band-Pass Filter, jesse | sub | normalised band-pass and trigger, shaded by the signal |
| `BANDPASS_J_RAW` | Band-Pass Filter, jesse, raw line | sub | the raw band-pass line, coloured by its side of zero |
| `IS_CALC` | IS Calculation (EMA slope) | sub | the slope, coloured by its side of zero; the trigger neutral |
| `VOSS` | Voss Predictive Filter | sub | the band-pass `filt`, coloured by its side of zero; the predictor neutral |

**"Inverted" is how the scan tested them.** Which of two lines counts as "first" is arbitrary, so
the scan tried every reading both ways round. Ten of these won inverted: `HWC_PCT`, `MACDEXT`,
`TCF`, `VWMACD`, `BANDPASS_J_RAW`, `IS_CALC`, `TURTLE`, `PTL`, `VOSS` and `VP_POC`. Their `inverted`
setting defaults to 1, and the shading and colours follow it; 0 gives the conventional reading. Two
of them fade moves outright: `MACDEXT` inverted agreed with the last 10 bars' direction on only 42%
of bars, and `TURTLE` inverted is the channel's own trend reversed (the close is above its line
exactly while the channel is long), a fade of 10-bar breakouts. `BANDPASS_J` keeps jesse's own
sign: +1, long, while the normalised line is below its trigger.

Where these depart from the scan or the source:

- **`IS_CALC`'s trigger starts blank.** The source fills the slope buffer with MT4's EMPTY_VALUE
  (2,147,483,647) before writing it, and iMAOnArray seeds the trigger's EMA with that, so MT4 draws
  it in the billions for its first bars. The template leaves it blank until what is left of that
  seed is below 1e-12 (about 120 bars at the defaults), and matches windicators from there. The
  slope, the system's reading, is drawn from its first bar.
- **`HWC_PCT` starts on bar 4.** The channel has zero width on its first three bars, where
  pandas-ta's percent divides by epsilon and reaches ~1e13; the template leaves them blank, and its
  average waits for `ma` values after them. Its `scalar` (0.67, the scan's) does not change the
  reading: percent is 0.5 + (close − middle) / (2 · scalar · sd), so the line minus its average is
  one fixed multiple of the same quantity at any scalar. Not one state differs at 0.67, 1.5 or 3 on
  the 28 pairs' 1D bars.
- **`TCF` restarts as the MQL source does,** over its last `count` bars at every bar, so each bar
  has the value it had live. When that restart cannot change a value (the T3's weight on the
  dropped bars is below 1e-20, ~1e-66 at the systems' setting), one pass over the history replaces
  it; `wscan.test.ts` checks the two agree to 1e-12. On the first `count` bars of the chart's
  history the source reads the close before the oldest bar as 0, so the first bar is a spike.
- **`MACDEXT` offers simple averages only.** The scan's setting is fast MA type 0 and signal MA
  type 11, both SMA in TA-Lib; the other MA types were not used.
- **`KALMAN`'s noises are in price units squared,** and the scan used the same numbers on every
  pair. So the filter follows a JPY cross (~150) far more tightly than EURUSD (~1.1), as tested.
- **`TURTLE` draws nothing before its first breakout,** and nothing on its first two bars, where the
  source's first pass starts. A close equal to the channel's high or low is not a breakout. The
  source's `strict` setting (a high or low through the channel also counts) is left off, as the
  scan ran it; so are `PTL`'s pip displacements, at 0.
- **`BANDPASS_J` and `BANDPASS_J_RAW` start blank.** jesse seeds its high-pass with the close, so
  the line starts at the price level and rings down over the high-pass's period (4 × period /
  bandwidth: ~1,000 bars at 30 / 0.1206, ~600 at 36 / 0.2412). The scan computed it from 2005; a
  chart computes it from its oldest loaded bar, where the raw line swung to ±0.03 on EURUSD 1D
  against ±0.005 once settled. Both templates leave the first bars blank until the seed is below
  1e-4 of where it started: **1,459 bars** for `BANDPASS_J` and **876** for `BANDPASS_J_RAW` at their
  defaults. Measured on the 28 prod pairs at 1D, 8h, 4h and 1h, from 252–868 start points each:
  past that point the line is within 0.6% of its median size of the line computed from 2005, and
  the reading agrees on 99.98% of bars; at bar 500 `BANDPASS_J`'s signal disagreed on 18% of 1D
  bars. A dashed line marks the first bar drawn; with less history loaded, a note says how much is
  missing (a 1D chart loads 500 bars at a time, so scroll back). The `warm-up` setting, 0, draws
  from the first bar.
- **`VOSS` starts blank too.** Its band-pass starts from zero rather than from the state a longer
  history would have left it in. Measured on the 28 prod pairs' 1D bars from 1,316 start points
  (2026-10-14), its sign disagreed with the from-2005 one on 45% of bars at its first bar, 7% a
  hundred bars later and 0.5% after 250. The template leaves both lines blank until that start-up
  error is below 1e-4 of where it began, the filter's pole radius to that power: **668 bars** at the
  defaults, past which the sign disagreed on 3 of 1.5 million bars. The same warm-up mark and
  `warm-up` setting as the band-pass.
- **`VP_POC` is an exit, and it closes shorts only.** It reads the profile's low against the value
  area's low, inverted. The value area never reaches below the profile, so the reading is 0 while
  the area spans the lowest bin and +1 while it does not, and an exit closes a trade only when its
  reading is against it. In plain terms it closes a short when one of the last three closes sits
  alone in a bin below the others: when price has just risen through a multiple of 0.055. That
  grid is in price, not pips: 5.5 pips on a JPY cross, 550 on EURUSD. So it fires on ~40% of JPY
  bars and 2–9% elsewhere. The bins are the close rounded up to the grid, so on EURUSD they sit up to
  550 pips from price; the template keeps them out of the price axis and builds its own legend. Its
  volume is the bars' (OANDA's tick volume), as the scan's was.

`fixtures/wscan_parity.json` is generated by
`notes/research/NoNonSenseForex/tests/gen_nnfx_wscan_parity.py` from the windicators snapshot the
scan ran (`9f7b6c8`), on the same 250 prod EURUSD 1D bars:

- 68 cases;
- each system's setting, each source's defaults, and settings that reach the branches those miss:
  - TCF's per-bar restart (`count` below 250);
  - ties, from the bars rounded to 3 decimals: TCF's up/down branch, and the Turtle's and the
    PTL's strict comparisons;
  - the slow-shorter-than-fast swap in MACDEXT and VW-MACD;
  - the volume profile's empty bins (zero volume), a missing volume, and equal bins (every bar
    weighing 1), where the POC and the value area each break a tie.

`wscan.test.ts` checks every output to 1e-9 relative (IS Calculation's trigger from where the
template draws it), and the reading each system trades on. Of 23 bugs planted in the first eleven
templates, 21 were caught; the other two changed only the trigger bars IS Calculation leaves blank.
Of 20 planted in `TURTLE`, `PTL`, `VOSS` and `VP_POC`, all 20 were caught.

## How each one reads

- **Doda Stochastic.** The area between the main and signal lines is shaded up-colour while main
  is above signal. The colour change is the C1 cross.
- **Band Pass Filter.** Histogram around zero. The colour is the side of zero; a solid bar's
  slope agrees with its side (moving away from zero), a hollow one's does not.
- **Correlation Trend.** The long line takes the up colour above zero and the down colour below.
  The short line is context.
- **Heiken Ashi Smoothed.** Smoothed candles over the price candles. The body colour is the
  signal. A wick need not contain its body, and its colour can differ from the body's for a bar
  or two after a turn, both as in MT4.
- **OSCAR.** Arrows mark the NNFX list's triggers:
  - long when the rough line crosses up through the oscar line below 35, with the two more than
    0.5 apart;
  - short when it crosses down above 65, likewise.
  - The bare line cross is not the signal.
- **TTF.** One line, coloured by the side of zero, with guides at the version's own levels (±100,
  or Bilak's ±75). The `t3` setting switches to Nick Bilak's MT4 version (disjoint windows plus a
  T3 smoothing).
- **Chandelier Exit / Trend Akkam.** The active stop only:
  - the long stop sits below price in the up colour;
  - the short stop sits above price in the down colour;
  - each is its own line, so it breaks at a flip;
  - an arrow marks the flip bar (setting `arrows`).

## Parity with the research ports

`fixtures/parity.json` is generated by
`notes/research/NoNonSenseForex/tests/gen_nnfx_chart_parity.py` in the workspace repo. That script
runs the Python/numba ports the discovery used (`nnfx/ports/`) on 250 prod EURUSD 1D bars:

- 33 cases;
- the defaults above, the sources' defaults, and every MA kind, price code and TTF version the
  templates take.

`nnfx.test.ts` checks every output of every case to 1e-9 relative. It also checks that:

- every template is causal (a run on a prefix of the bars equals the prefix of the full run);
- the settings dialog's defaults are the templates' `calcParams`.

Regenerate the fixture when a port changes; never edit it by hand.

## Checked against the published code

`sources.test.ts` transliterates each published source literally and runs it against the
templates on the fixture bars. It keeps MQL's timeseries indexing (0 is the newest bar), its loop
order and its globals. MT4's built-ins (`iMA`, `iMAOnArray`, `iATR`) are written out from
MetaQuotes' own `Moving Averages.mq4` and `ATR.mq4`. The check is independent of the Python ports.
Seventeen deliberately planted bugs were each caught by this test or by the port parity test.

| Template | Published source | Agreement | Deliberate departures |
|---|---|---|---|
| `DODA_STOCH` | `Doda-Stochastic-modified.mq4` (Niels, 2023) | every bar | none |
| `BANDPASS` | `band pass filter.mq4` (mladen, after Ehlers) | every bar, once the seed is made equal | **Seed.** The source seeds its two oldest values with the price, which rings for ~1,000 bars at period 50: invisible on MT4's history, most of a chart's window. They are seeded at zero, as Ehlers' original. The test proves the seed is the only difference: the gap between the two obeys the filter's bare recursion. |
| `CORR_TREND` | `Correlation_trend_indicator.mq5` (mladen, 2020), plus his price list from the MT4 build | every bar with a full window | **Early bars.** The source also prints the first `long − 1` bars, dividing partial sums by the full period. Here those bars are blank. |
| `HA_SMOOTHED` | `Heiken Ashi Smoothed.mq4` (Forex-TSD 2006, mod by Raff) | every bar after the warm-up (80 bars here) | **Warm-up.** The source's first HA open reads an uninitialised buffer, and its loop starts one bar later. The error halves every bar. |
| `OSCAR` | `oscar.pine` (GenZai, NNFX) | every bar, lines and C1 triggers | The triggers are the script's own commented-out C1 rule. The **EMA** option's seeding is TradingView's built-in and cannot be checked from the script; it affects the warm-up only. |
| `TTF` (t3 = 0) | `TTF.mq5` (MetaQuotes, 2018) | every bar | none; levels ±100 |
| `TTF` (t3 ≥ 1) | `ttf.mq4` (Nick Bilak, 2005) | every bar | **Live re-application.** MT4 re-applies the T3 step on every tick of the forming bar (its stages are globals); here it is one step per bar. Levels ±75. |
| `CHANDELIER` | `ChandelierExit.mq4` (MQLService, mod2008fxtsd) | from the first turn after the warm-up | **Partial windows.** The source's `Highest`/`Lowest` accept windows the history cannot fill yet. The template waits for a full window, and the difference lasts until the next turn. |
| `TREND_AKKAM` | `TREND AKKAM.mq4` | from the first turn after the warm-up | **Zero-ATR warm-up.** The source runs its stop through ATR.mq4's zeroed warm-up bars; the template starts at the first ATR value. **Display.** The source draws one orange line; the side colours, breaks and flip arrows are additions. |

Display rules taken from the sources:

- **Band Pass.** A solid bar is the source's "strong" histogram (slope agrees with the side of
  zero); a hollow bar is its "weak" one.
- **Heiken Ashi Smoothed.** The wick and body colours are decided separately, as MT4 colours each
  histogram pair by its larger buffer.
- **Price lists.** Band Pass and Correlation Trend take mladen's whole 0–32 price list
  (`prices.ts`).

`mt4.ts` holds MT4's own averages and ATR: an EMA seeded with the first value, a
Wilder SMMA seeded with an SMA, and an SMA that restarts after a gap. These are not the Pine
versions SSL uses. The MQL indicators here call MT4's, and the ports reproduce them.
