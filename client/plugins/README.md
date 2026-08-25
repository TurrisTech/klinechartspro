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
settings panel, `paneInfo`, `requestReconcile`, `requestPersist`.

A template's `calc` reads its store back: `peekStore<WindowStore<P, V>>(indicator.extendData.seriesKey)`
(`seriesKeys[id]` for a multi-source binding). The host bumps `extendData.rev` on every store
change, so `shouldUpdate` compares it.

## Built-ins

| plugin | templates | sources | notes |
|---|---|---|---|
| `indicators/plugin.ts` | `S:<name>@<version>` per catalogue entry | one: the resolved series | subscribes over the stream; validates params via `/indicators/resolve` |
| `arev/plugin.ts` | `AREV:<generation>` | one per template | no live stream |
| `krev/plugin.ts` | `KREV:krev01:p` | one, folded by side | |
| `mtf/plugin.ts` | `MTF:arev21` | one per enabled source timeframe (`MtfStore`: votes + bar grid) | per-pane settings, own panel; shares arev21 stores with the AREV plugin |

Tests: `bun test client` (`*.test.ts` here, with `testing.ts`'s fake chart).
