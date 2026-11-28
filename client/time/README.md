# client/time — interval codes, candle boundaries, instant formats

PURE: no DOM, no chart, no network. What every feature that reasons about time reads: the chart,
bar replay, the Strategy Lab, the alerts, the trading UI. Moved out of `client/replay/` (and the
client root) on 2026-11-28, when it was the most imported thing in the client.

| module | role |
|---|---|
| `intervals.ts` | Interval CODES (`15m`, `4h`, `1D`): the client's one parser (`parseInterval`, `isInterval`), the one table of nominal lengths (`nominalMs`; `resolutionDurationMs` is the same, Infinity for a non-code), the chart's period conversions (`periodToResolution`, `resolutionToPeriod`), divisibility and the base ladders (`divides`, `gcdInterval`, `defaultBase`, `validateBase`, `finerStored`, `storedLadderFor`). A month is 30.4375 days and a year 365.25 -- for sizing and ordering only. |
| `timeframes.ts` | The boundary math mirroring wmarkettypes' `Interval`, for all three schedules the store carries (`schedule*`), and the **`CandleGrid`** the replay asks every boundary question of: those functions bound to one instrument's zone and day geometry (`gridOf`, `gridFor(symbolInfo)`), plus its trading week (`isTrading`, the port of `MarketHours.is_open`: `tradingFilter`). Parity asserted against `fixtures/boundaries.json` and `fixtures/trading.json`, generated from wmarkettypes. The unparameterised `intervalStart`/… are the FX week, kept for the FX-only callers outside the replay. |
| `daygeometry.ts` | `dayGeometryOf` / `tradingWeekOf`: an instrument's `MarketHours` as the two plain values the chart and the grid read. |
| `marketclosed.ts` | `legalCandleOpens`: which bars of a series may open a candle on the instrument's schedule. |
| `format.ts` | Every instant the client prints, always on a named zone and to the second: the replay's clock WITH the weekday (`formatClock`, `formatSpan`, `zoneName`) and the trading UI's `formatInstant(ms, zone)` -- UTC labelled so when the instrument's zone is not known. |
