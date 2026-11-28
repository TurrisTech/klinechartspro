# client/bars — the bar stack

Bars with bid and ask, for bar replay, the alert search and the Strategy Lab. Moved out of
`client/replay/` on 2026-11-28. Beside them, the closed mid bars a feature reads for itself
(`closed.ts`, out of `client/plugins/` the same day).

| module | role |
|---|---|
| `cache.ts` | `BarCache` per (instrument, timeframe) over an injected `BarSource`: a contiguous run ahead of an anchor; **walked** (`ensure`/`take`) or **seeked** (`seek`: dump and reload), never a partial append onto a stale run; `cover` past the run's end is a seek too. `composeLadder`/`composeSpans` (which stored bars a forming candle is made of), `composeForming`, `nonWeekendGaps`. |
| `source.ts` | `HttpBarSource` (`/getbars columns=all`, paged, 413-split). The only module here that fetches bars with bid and ask. It reads past the page-wide read clock on purpose (`asof: null`), and so does the alert search built on it. `probeStoredIntervals`: which of the stored ladder an instrument holds -- one bar per interval its vendor stores (`storedLadderFor` against `/capabilities` `baseIntervals`), never one the server would only fold. |
| `tiled.ts` | `TiledBarSource`: a `BarSource` over the immutable Parquet tiles, read from the bucket a whole tile at a time, `/getbars` only for what no tile covers. Every source reads through ONE `HeldTiles` per page (`sharedHeldTiles`: decoded bid/ask tiles, least recently used out first, 400k rows), so a tile the replay and the Lab both read is decoded and held once. |
| `yield.ts` | `nextTask`: hand the page a turn between chunks of work. |
| `closed.ts` | The bars a feature reads for ITSELF rather than a pane drawing them -- TradeTalk's daily candles, the AREV lab's prior, the volume profile's finer bars, the trading dock: `fetchClosedBars` (closed bars only, so under a bar replay the window ends at the bar forming at the clock) and `closedBarPage` (one page of a plugin's bar source, bigger where the tiles hold it). Mid bars through `history.ts` `fetchBars`, which joins the tiles and `/getbars`. |
