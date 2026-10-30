# Indicator plugins (client)

An indicator on the chart that reads data the server holds — a registry series (`S:…`), an
AREV generation, krev's votes, the AREV21 multi-timeframe overlay — is an **`IndicatorPlugin`**
(`types.ts`). The plugin declares its klinecharts templates and how one instance on one pane
maps to **sources** (a series to fetch, keyed so panes showing the same one share it). The
**host** (`host.ts`) owns everything that used to be copied per plugin: watching each pane's
indicator list, fetching exactly the windows a store is missing (paged), keeping a store per
source alive for as long as some pane reads it, subscribing live updates, handing the chart
the values by replacing the indicator's `extendData` — which the plugin's `calc` reads back
with `peekStore` (`store.ts`) — and, since 2026-10-11, every pane's **settings** for the
plugins that have any (`paneconfig.ts`).

The "super indicators" are plugins on the same host, not a second system: the MTF overlays
(sources on other timeframes), the AREV lab, the divergence and the volume profile (settings
per pane), and Levels and Zones (price-anchored overlays drawn by a binding's own `attach`).

The server has the same shape (`wdashboard-server/docs/plugins.md`); the two meet on
`GET /plugins/{id}/values` (`api.ts`), with each plugin's legacy path as the fallback on a
server without the `plugins` feature.

## What a plugin implements

```ts
const plugin: IndicatorPlugin = {
  id: 'mine',
  feature: 'mine',                      // gate: registered only when the server advertises it
  register: (facilities) => registerMyTemplates(),   // klinecharts templates -> picker groups
  matches: (name) => name.startsWith('MINE:'),
  bind: (ctx) => ({
    sources: [{
      id: 'v',
      key: `mine|${ctx.vendor}:${ctx.ticker}|${ctx.interval}`,   // shared across panes
      resolution: ctx.interval,                                  // what its points are dated on
      fetch: (range, limit) => facilities.points({ pluginId: 'mine', legacyPath: '/mine/values', ... }),
      // optional: window(chartRange), createStore(key), subscribe(store, notify), warm
    }],
    label: (state) => phaseLabel('MINE', [state.sources[0]?.store]) ?? 'MINE',   // legend.ts
    // optional: extendData(state), overrides, yAxisGap, attach()
  }),
  // optional: paneConfigs (settings per pane, below), validateParams,
  //           follows(indicator, indicators) -- what else on the chart a binding is made from
}
```

**`follows`** is for a binding that depends on another indicator on the same chart: TradeTalk
entries trades the zones of the Heath levels indicator beside it. The host asks it on every
reconcile and adds the answer to the binding's identity, beside its own `calcParams`. So an edit
of the followed indicator rebinds this one, exactly as an edit of its own parameters would, and
`bind` receives the answer as `ctx.follows`. Return something small and JSON-serialisable (the
settings the binding uses, not the other indicator's whole state), or an edit that changes
nothing this binding reads rebinds it anyway.

Then add it to `registry.ts`. `PluginFacilities` is the whole of what a plugin may depend on:
the API (`api.get`), the stream, `hasFeature`, the unified `points` fetch, the period/symbol
helpers and the server's values cap. Everything a plugin used to reach for to keep its
settings -- the panel, `paneInfo`, `requestReconcile`, `requestPersist` -- is the host's now.

A template's `calc` reads its store back: `peekStore<WindowStore<P, V>>(indicator.extendData.seriesKey)`
(`seriesKeys[id]` for a multi-source binding). The host replaces `extendData` on every store
change, carrying a new `rev`, so `shouldUpdate` compares it. **Replaces, not merges**:
klinecharts deep-merges an override's `extendData` into the indicator's own -- an array index
by index, and a key never removed -- so until 2026-10-11 an MTF overlay's graph roots going from
`['1D', '4h']` to `[]` read `['1D', '4h']` and the graph stayed drawn. The host clears the
indicator's own before every override.

**Wrap `calc` in `timestampCalc`** (`calc.ts`) when its result depends on the bars'
timestamps, its stores and its params but never on a bar's prices -- every template here that
reads a store does. klinecharts recalculates every indicator on a pane, over every bar it holds,
on every live tick; the wrapper hands back the last result while nothing it is computed from
moved. The divergence, the volume profile and TradeTalk read prices and must not use it.

**Bars a plugin reads for itself** (TradeTalk's daily candles, the AREV lab's prior, the MTF
grid, the volume profile's finer bars) go through `bars.ts` (`fetchClosedBars`,
`closedBarPage`): closed bars only, so under a bar replay the window ends at the bar forming at
the cursor.

**Every tile read is one join** (`client/tiles/join.ts`, `readTiled`): the tiles for what they
hold of a window, the API from where they stop, the first n of a forward page or the last n of
a chart window. The bars (`history.ts` `fetchBars`), the books and a tiered indicator
(`indicatortiles/source.ts`) all call it. Under a bar replay it stops the tiles at the bar
forming at the clock (`readHorizon`, the host's own horizon) and lets the server, which clamps
to the cursor, answer the rest. Nothing on the server clamps a tile, so a source with tiles must
read through it. **It asks the server nothing that cannot be answered** (`horizon.ts`
`answerableTo`): past the bar forming at the clock nothing exists, and when the clock sits on
that bar's open -- where a Step leaves every pane whose interval divides the Step's -- not even that bar,
so the remainder is not sent at all. Tested on the store clock, not the wire: a forex day dated
Wednesday 00:00 forms from Tuesday 17:00 and is answerable from then on.

## Settings per pane

A plugin with settings declares them, and the host does the rest:

```ts
export const MINE_PANE_CONFIG = paneConfig<MineConfig>({
  templates: ['MINE:a', 'MINE:b'],   // several templates may share one config
  doc: 'mn',                         // the pane's field in the wall document -- never rename
  title: 'Mine',                     // the panel's title; ticker and timeframe are appended
  fields: MINE_FIELDS,               // what the gear's panel and the indicator manager draw
  defaults: MINE_DEFAULTS,
  normalise, toStored, fromStored    // layerConfigCodec(defaults, fields) builds all three
  // optional: fallback() -- what a pane never configured draws with
})
const plugin: IndicatorPlugin = { ..., paneConfigs: [MINE_PANE_CONFIG], bind: (ctx) => use(ctx.config as MineConfig) }
```

The host keeps a config per pane INDEX (`PaneConfigStore`), opens the panel from the legend's
gear, hands the indicator manager the same fields, rebinds the pane on an edit (the config's
revision is in every binding's signature, so a binding reads `ctx.config` once and never watches
it), asks the app to save, writes the document's fields (`PluginHost.paneDocs`, which
`client/layout.ts` merges into each pane's entry without reading them) and moves every pane's
settings with it when panes change places. A config whose plugin this server does not mount is
carried through verbatim, so a save there does not cost a pane its settings.

A binding that draws a control of its own can write a setting too: `ctx.editConfig(key, value)`
(a dotted key into its config) goes through the same write as the panel and the manager -- kept
for the pane, the wall saved, the pane rebound -- so the binding is replaced by one made with the
new config. The level alerts' "Make default" is the first user (`client/chartlayers/alerts/`).

`doc` is a field of its own (`'mtf'`, `'al'`, `'dv'`, `'vp'`) or a key inside a shared one
(`['mx', 'mtf_<name>']`, `['ly', 'levels']`). Until 2026-10-11 each of the five plugins with
settings carried its own copy of all this -- six optional `IndicatorPlugin` members -- and
`client/layout.ts` and `client/index.ts` named every one of their fields.
`fixtures/panedocs-golden.json` is what `main` wrote for all six fields before the move, and
`layout.test.ts` holds the host to it.

## A binding that draws itself

A binding may `attach()` -- called once it is filed and BEFORE the binding it replaces is
released, its return called on release. Levels and Zones use it: their overlays are anchored to
price and fetched by price band, which a source cannot express, so each binding attaches a view
(`chartlayers/controller.ts`) that follows the pane's view and draws while the indicator is
shown. What a pane holds is kept per chart, so the binding that follows another (a settings
edit, a symbol change) starts from it.

## Two bindings on one key

Sources with the same `key` share one store — that is the point (a 15m, a 3m and a 1h pane
all overlaying 4h arev21 pay for one fetch, not three). But `storeFor(key, create)` runs
`create` only when the key is **absent**, so the binding that arrives first decides the class
and the second silently gets it. Two rules follow, and both are load-bearing:

- **Name the same factory.** Not an equivalent closure — the same module-level function, so
  there is one place to look. `arev/store.ts`'s `arevStore` is the pattern.
- **Write the same row.** Anything a source needs that is *not* that row is an auxiliary
  array on the same window (`Page.arrays`), never a second kind of value. mtf01 ships its
  trades that way, and the MTF overlays their graph nodes (in a store of their own class).

Break either and the failure is silent and order-dependent: the overlay's rows overwrote the
sub-pane's votes with rows carrying no `p`, so the sub-pane drew gaps, and the overlay then
read back a store with no `grid()` and drew nothing at all. Measured before the fix, one 1h
pane carrying both: 0 of 266 votes drawn and 0 markers. Tests: `arev/store.test.ts`, which
asserts the two specs agree on key, resolution and factory by reference.

## Under a replay's read clock

Declare `resolution` on every source. A replay clamps every read to its cursor
(`services/asof.py`): **a point exists once its bar has closed**, so an answer fetched at the
cursor is missing the bar that source still had forming — and the host must not record that
bar's window as covered. `resolution` is what lets it work out how far the answer was final
(`horizon.ts` `knownThrough`), per source rather than per wall, and forget exactly that much
when the cursor moves (`invalidateFrom`).

Getting this wrong is invisible until you look for it. Forgetting from the **cursor** is
right only for a source dated on the cursor's own grid: at a stop of 11:15 a 15m source is
whole, a 1h source is one bar short, and a 1D source is short the whole session. The bar that
is not refetched stays filed as fetched-and-empty for the rest of the session, which draws as
a permanent blank column — one per stop, widest on the coarsest pane. The measurement, on a
3m+15m+1h+4h+8h+1D wall jumping between armed arev21 signals: eight jumps left 5 holes on the
1h pane, 3 on the 4h and 1 on the 8h, with 15m and 3m clean, because every stop landed on a
15m boundary. Tests: `horizon.test.ts`, and the invalidation cases in `host.test.ts`.

A source dated on a **wire clock** (daily-and-coarser bars are `open + 7h`,
`services/wiredate.py`) needs nothing extra — `knownThrough` answers on the same clock the
store's keys and windows use.

A **custom store** must implement `forgetAfter` (the interface makes it optional, and a store
without one simply keeps whatever it fetched — `Mtf01Store` did, and never revisited a window).
`plugins/store.ts` exports `missingRanges`/`mergeRange`/`truncate` so a custom store shares the
coverage arithmetic instead of copying it. If it dedups rows, **prune the dedup keys with the
rows it drops** — otherwise the refetch is deduplicated away and the row never comes back,
which is worse than the hole.

## Warming a replay's next landing

A source whose first read of a region is expensive on the server, and cached there, may offer
`warm` (`SourceWarm`): `window(chartRange, at)` -- the window it will read once the read clock
stands at `at`, for the bars the pane will hold then -- and `read(window, at)`, which asks the
server for it and throws the answer away. A bar replay calls `PluginHost.warmAhead(at,
landingRange)` for where its next Next alert press will land (`client/replay/landing.ts`); the
host sends one read per store over the union of the windows of the panes reading it, and nothing
for a store already warmed for that instant over as much. Nothing is filed: the answer lies past
the chart's clock, and a store holding it would draw it before the replay got there. Only the MTF
overlays offer it (`mtf/plugin.ts`: `/mtf/graph` with `asof` the landing and `limit` 1); a cold
`/mtf/graph` region took 0.2-4.9 s on prod data, a warm one ~50 ms.

## Signals

A plugin whose points carry discrete events **labels** them on the server
(`wdashboard-server/docs/plugins.md` "Signals"): `signals()` declares the labels, `signal_of`
names a point's, and the host publishes the result — every served point's `signal` field is
the label id or `null` (`ArevPoint.signal` is `'long' | 'short' | null`, `KrevPoint.signal`
`'top' | 'bottom' | null`), `GET /plugins/signals` catalogues every label under a stable
`ref` (`arev:arev21:long`), and `GET /plugins/{id}/signals` serves only the labelled points,
each with `effective` — the **absolute** instant its bar closed, which is when the signal
became knowable and what any multi-timeframe consumer keys off.

The client draws the label and never re-derives one: the AREV pane's arrows are the `long`
(green, up) and `short` (red, down) labels, the same events the AREV21 MTF overlay places and
an alert can read (`client/alerts`, a `signal` operand -- which is how a replay's Next alert
jumps to one). The alerts read the catalogue through `loadSignalCatalogue` (`api.ts`). The
plugin-facing `facilities.signals` that once let one plugin read another's labelled points was
never used by any plugin and was removed on 2026-10-11, along with `client/krev/api.ts`.

The catalogue is gated on the `plugins.signals` feature (empty on an older server, whose points
carry the old boolean -- `arevSignal` in `client/arev/api.ts` normalises it with the server's own
rule). Tests: `signals.test.ts`.

## Built-ins

| plugin | templates | sources | notes |
|---|---|---|---|
| `tsregistry/plugin.ts` (`registry`) | one per enabled row of `GET /indicators/registry`: `S:…`, `AREV:…`, `KREV:krev01:p`, `TS:…` | one per binding, on the wire its row names | every server indicator; see "The registry plugin" below |
| `mtf/plugin.ts` | `MTF:arev21`, `MTF:arev21_outlier_rank_90`, `MTF:arev21_outlier_rank_85` (one plugin per `mtf/overlays.ts` entry) | one per binding: the server's answer (`GET /mtf/graph`) for the timeframes drawn, the roots and the largest step -- every signal at the instant it became knowable, and the graph's nodes and entry stars as an auxiliary array -- in an `MtfGraphStore` keyed by those settings, its windows absolute instants | settings per pane (`mtf`, or `mx.<id>`), the graph on the rank-85 overlay; the server builds and caches signals and graphs (wdashboard-server 0.56.0), the template only places them on the chart's bars; in a bar replay the read at the next landing is warmed on the server before the press (`warm`) |
| `mtf01/plugin.ts` | `MTF01:mtf01` | one: the cascade's events with its trades as an auxiliary array | |
| `arevlab/plugin.ts` | `LAB:arev` | one per shown AREV generation (the registry's own `storedSource`, reaching back exactly the rule's window), plus a bar source while any generation uses the prior | several generations' `p` in one sub-pane, each with the fixed level or a client-side rank/median/prior over a window of DAYS; every bar with a usable `p` is compared unless `samplesOnly`; per-pane settings, own panel; the quantile, the band and the entry rule are locked to the server's by `arevlab/fixtures/rules_parity.json` |
| `arev21div/plugin.ts` | `DIV:arev21` (sub-pane), `DIV:arev21:price` (price pane) | one: the registry's own arev21 `storedSource`, unmodified -- the AREV21 pane's store, key and all, so beside one it costs no request | where price and arev21's `p` disagree at a swing (a lower low with a higher `p` is `bull`, a higher high with a lower `p` `bear`; the hidden pair on param `hidden`), computed entirely in the browser from the pane's own bars in `calc`; swings strict on `left` (10, arev21's lookback, so every swing is a sample bar) and confirmed by `right` (5), each compared with the swing immediately before it; the arrow is on the CONFIRMING bar and a line joins the two swings in each pane (thick dotted by default); rule, line style, width and colours are one per-pane config (`paneConfigs`), shared by both templates and persisted as `PersistedPane.dv`, so an edit recomputes or redraws without refetching; calcParams stay empty; no server change |
| `books/plugin.ts` | `BOOK:depth:*`, `BOOK:view:*`, `BOOK:sentiment:*`, `BOOK:flow` | one per binding; depth + view share one profile store per kind | the OANDA 20-minute books: depth draws every snapshot on the price pane at its own instant, view follows the crosshair, sentiment/flow are sub-pane series |
| `bidask/plugin.ts` | `QUOTE:bidask` | one per binding: `/getbars?columns=all`, paged forwards by nominal span (no `limit`, which keeps the wrong end), a 413 split in halves | the bid and ask close of every bar on the price pane with the spread shaded between; a bar is quoted when all eight quote columns are numbers and the sides differ (coinbase and schwab fill them with one price, so they draw nothing and the legend says so); `/getbars` serves closed bars only and the stream is mid-only, so the forming bar has no quote until it closes; a closed frame re-reads everything after the newest quote held |
| `tradetalk/plugin.ts` | `TT:entries` | one: `1D` bars over the chart window widened back to the start of the previous calendar year | where the TradeTalk (Heath) method would enter — the calendar level map off the instrument's own schedule (`SymbolInfo.timezone` + `dayGeometry`), a sweep-and-reclaim entry with its stop and target boxed out, and a corner line counting the sweeps each filter refused; computed entirely in the browser, no server change (`client/tradetalk/README.md`) |
| `chartlayers/plugin.ts` (`levels`) | `LEVELS:levels`, `LEVELS:levels2` (price pane, the "Levels" group: Levels and Zones) | none: the template draws nothing; each binding `attach`es a view (`chartlayers/controller.ts`) that fetches `/levels` / `/levels2` by price band and draws overlays while the indicator is shown | the toolbar's Levels and Zones buttons until 2026-10-03; settings per pane (`ly.<layer>`), starting from the toolbar era's wall-wide ones; the legend names the timeframes drawn or why nothing is; built by `client/levels/indicator.ts` and handed to `builtinPlugins`, because the replay invalidates the Levels views directly on a day boundary (`chartlayers/README.md`) |
| `volprofile/plugin.ts` | `VP:volume` (price pane) | at most one: bars of a stored interval finer than the chart (`vp-bars\|vendor:ticker\|<interval>`, a custom `BarStore` -- ascending, with a change log so a live tick rebuilds one chart bar), tiles first, `/getbars` for the forming period, the stream for the forming bar | volume at price over the visible range or one profile per session; the source is chosen for the PROFILE, not the chart (`source.ts`: a source bar should span no more than a display row, so `source <= chart * 150 / rows^2`, or the finest intraday base for sessions), which makes the same span give the same profile on every timeframe; each source bar's volume is spread evenly over its range onto a fixed price grid per chart bar (`atoms.ts`), and whatever of a chart bar's volume its source bars do not account for (out of reach, past the 250k-bar budget, not arrived yet) is spread from the chart bar itself so no volume is lost -- the legend names the source and the date it runs from; replay-clamped in the source, because tiles are read from the bucket and nothing on the server clamps them; settings per pane, persisted as `PersistedPane.vp`; no server change |

Tests: `bun test client` (`*.test.ts` here, with `testing.ts`'s fake chart).

## The registry plugin (2026-09-11, `feat/ts-registry`)

`client/tsregistry/` is one plugin for **every** server indicator. It fetches
`GET /indicators/registry` — the server's timeseries indicator registry — registers one
klinecharts template per row, and binds each to the wire its row names. The chart knows no
server indicator by name.

It replaced three plugins and their template modules: `arev/`, `krev/` and `indicators/`,
which were structural copies differing mostly in their colours and in constants the server
also held. What is left beside it is what the registry deliberately does not cover: `mtf/`
and `mtf01/`, whose sources read timeframes that are not the chart's; `books/`, which is
not a scalar-per-bar series at all; and `arevlab/`, which reads several registry rows into one
pane and computes its own signal rules over them.

**Template names come from the row.** A saved wall document names its indicators by template,
so `S:rsi@v0.0.2`, `AREV:arev21` and `KREV:krev01:p` are unchanged and every stored layout
keeps working. Anything new is `TS:<name>`.

**Two source builders**, chosen by `wire.plugin`:

* `indicators` — the computable library: `calcParams` resolve to a node document, points come
  from `/indicators/values`, and the series is **subscribed** at bind time so a live point
  arriving during the history read is not lost. Store key
  `S|vendor:ticker|interval|<series doc>`, unchanged.
* anything else — the unified `GET /plugins/{id}/values?variant=`. Store key
  `<name>|vendor:ticker|interval`, unchanged. Subscribed where the server relays that
  plugin's points (`plugins.live`, `subscribeLive`); elsewhere new values arrive on a reload
  or a range change.

**What the generic template can say**, which is exactly what the four it replaced needed:
several lines with their own colours and dash styles; flat reference lines from a constant;
`render: 'hold'`, which carries the last value forward over bars that have none; a `gate`
that drops an uncalibrated number; a `fold_by` source whose two rows on one bar are filed
under their own side, so a series key is two-part (`top.p`); and per-bar `marks` chosen by a
predicate, each with a shape, an anchor (`series:<key>` or `bar:low|high|close`), an optional
label field and an optional fill (solid / hollow / pending).

Three klinecharts facts the row is turned into, each of which cost a bug before:

* **`draw`'s return value is `isCover`**, and declared figures render only `if (!isCover)`.
  A row with figures AND marks returns `false`; a marker-only row declares no figures and
  returns `true`. The row decides, not the template's author.
* **`minValue`/`maxValue` widen the y-axis, never narrow it**, so `valueRange` means "never
  zoom inside this".
* **A non-figure key does not enter the y-axis range**, which is where marker values and the
  raw bar live.

**The shared store.** `tsregistry/store.ts` holds the one class every registry-driven source
uses. It still carries an auxiliary bar grid (the MTF overlay's, until it moved to
`GET /mtf/graph`), and `storeFactory(foldBy)` is **memoised** -- so two sources that share a key
pass the identical factory reference, and `storeFor`'s first-binding-wins cannot make the class
depend on mount order. See `store.test.ts`, which is the test that invariant came with.
