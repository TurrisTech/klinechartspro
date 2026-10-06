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
