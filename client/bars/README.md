# client/bars — the bar stack

Bars with bid and ask, for bar replay, the alert search and the Strategy Lab. Moved out of
`client/replay/` on 2026-11-28.

| module | role |
|---|---|
| `cache.ts` | `BarCache` per (instrument, timeframe) over an injected `BarSource`: a contiguous run ahead of an anchor; **walked** (`ensure`/`take`) or **seeked** (`seek`: dump and reload), never a partial append onto a stale run; `cover` past the run's end is a seek too. `composeLadder`/`composeSpans` (which stored bars a forming candle is made of), `composeForming`, `nonWeekendGaps`. |
| `source.ts` | `HttpBarSource` (`/getbars columns=all`, paged, 413-split). The only module here that fetches bars. It reads past the page-wide read clock on purpose (`asof: null`), and so does the alert search built on it. `probeStoredIntervals`: which of the stored ladder an instrument holds -- one bar per interval its vendor stores (`storedLadderFor` against `/capabilities` `baseIntervals`), never one the server would only fold. |
| `tiled.ts` | `TiledBarSource`: a `BarSource` over the immutable Parquet tiles, read from the bucket a whole tile at a time, `/getbars` only for what no tile covers. Every source reads through ONE `HeldTiles` per page (`sharedHeldTiles`: decoded bid/ask tiles, least recently used out first, 400k rows), so a tile the replay and the Lab both read is decoded and held once. |
| `yield.ts` | `nextTask`: hand the page a turn between chunks of work. |
