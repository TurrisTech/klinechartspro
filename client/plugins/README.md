# Indicator plugins (client)

An indicator on the chart that reads data the server holds — a registry series (`S:…`), an
AREV generation, krev's votes, the AREV21 multi-timeframe overlay — is an **`IndicatorPlugin`**
(`types.ts`). The plugin declares its klinecharts templates and how one instance on one pane
maps to **sources** (a series to fetch, keyed so panes showing the same one share it). The
**host** (`host.ts`) owns everything that used to be copied per plugin: watching each pane's
indicator list, fetching exactly the windows a store is missing (paged), keeping a store per
source alive for as long as some pane reads it, subscribing live updates, and handing the
chart the values by bumping the indicator's `extendData` — which the plugin's `calc` reads back
with `peekStore` (`store.ts`).

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
      // optional: window(chartRange), createStore(key), subscribe(store, notify)
    }],
    label: (state) => `MINE · ${state.sources[0]?.store.phase}`,
    // optional: extendData(state), overrides, yAxisGap
  }),
  // optional: signature(ctx), handleSettings, validateParams, paneState, dispose
}
```

Then add it to `registry.ts`. `PluginFacilities` is the whole of what a plugin may depend on:
the API, the stream, `hasFeature`, the unified `points` fetch, the period/symbol helpers, the
settings panel, `paneInfo`, `requestReconcile`, `requestPersist`, and `signals` (below).

A template's `calc` reads its store back: `peekStore<WindowStore<P, V>>(indicator.extendData.seriesKey)`
(`seriesKeys[id]` for a multi-source binding). The host bumps `extendData.rev` on every store
change, so `shouldUpdate` compares it.

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
a replay's "next signal" jumps to. A plugin (or a script) consumes another's signals through
the facilities:

```ts
const labels = await facilities.signals.catalogue()          // SignalCatalogueEntry[]
const page = await facilities.signals.points<ArevPoint>({
  ref: 'arev:arev21:long',                                   // '' id = every label
  vendorSymbol: 'oanda:EURUSD', resolution: '4h', from, to, limit: 5000
})
for (const p of page.points) place(p.effective /* not p.date */, p.signal)
```

Both are gated on the `plugins.signals` feature (empty / `no_data` on an older server, whose
points carry the old boolean — `arevSignal` / `krevSignal` in the plugins' `api.ts`
normalise it with the server's own rule). Tests: `signals.test.ts`.

## Built-ins

| plugin | templates | sources | notes |
|---|---|---|---|
| `indicators/plugin.ts` | `S:<name>@<version>` per catalogue entry | one: the resolved series | subscribes over the stream; validates params via `/indicators/resolve` |
| `arev/plugin.ts` | `AREV:<generation>` | one per template | no live stream |
| `krev/plugin.ts` | `KREV:krev01:p` | one, folded by side | |
| `mtf/plugin.ts` | `MTF:arev21` | one per enabled source timeframe (`MtfStore`: votes + bar grid) | per-pane settings, own panel; shares arev21 stores with the AREV plugin |

Tests: `bun test client` (`*.test.ts` here, with `testing.ts`'s fake chart).
