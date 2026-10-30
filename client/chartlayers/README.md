# Chart layers

A **ChartLayer** is a server-derived, price-anchored overlay: fetch data for the current
view, turn it into overlays, expose settings. `client/levels/` (Levels) is the reference
implementation and `client/levels2/` (Zones) the second. Its data path is deliberately **not**
the indicator-plugin model (`client/plugins/`) — a plugin binds sources to a pane's indicator
template on the bar grid, a layer draws objects anchored to *price*, with lifespans that
predate the loaded bars, and fetches by price band as well as time.

**On the chart, though, a layer is an indicator** (since 2026-10-03; until then each was one
toolbar button and one config for the whole wall), and since 2026-10-11 an ordinary plugin
binding. `plugin.ts` registers a template per layer (`LEVELS:levels`, `LEVELS:levels2` — saved
walls name them, so never rename one) under one "Levels" picker group on the price pane; the
template draws nothing itself. The plugin host binds it like any other plugin indicator, and the
binding `attach`es a view (`controller.ts`) that draws the pane's overlays while the indicator is
shown -- so the picker, the legend's eye and ×, and the indicator manager turn it on and off per
pane like anything else, and a settings edit, a symbol change or the pane moving on the wall is a
rebind. Settings are per pane and kept by the host (`client/plugins/paneconfig.ts`): the legend's
gear opens the panel, the indicator manager edits the same fields inline, and the wall document
keeps each pane's differences from the defaults under `ly.<layer id>` (`persist.ts` is the codec,
and validates them on the way back in). A pane never configured starts from what the user last
chose under the old toolbar button (`store.ts`, read only, awaited before the plugin registers).
The legend names the timeframes drawn, or why nothing is (`none for <ticker>`, `not served here`
for Zones while no server advertises `levels2`).

Until 2026-10-11 each layer had a controller that followed the wall's panes itself -- its own
pane table, its own range subscriptions, its own copy of the settings -- and sampled **every**
pane five times a second for the template, whether or not any pane carried it. A view now
samples only its own pane, and only while its binding lives.

| file | what it is |
|---|---|
| `types.ts` | `ChartLayer`, `LayerWindow`, `LayerContext` — the contract |
| `controller.ts` | a layer's view of one pane, attached by a binding: drawn while the indicator is shown, debounced redraw, what the pane holds kept across the bindings that follow one another |
| `plugin.ts` | the layers as one indicator plugin: templates, picker group, legend, the settings each layer declares (`paneConfigs`), the binding's `attach` |
| `persist.ts` | a layer config's stored form (diff from defaults, flat by path) and its validation against the fields |
| `window.ts` | **pure**: what a pane has covered and what it still needs |
| `paint.ts` | **pure**: whether a redraw would change the picture |
| `store.ts` | the toolbar-era wall-wide settings, read once as the starting point of an unconfigured pane |
| `settings.ts` | the declarative field schema and its plain-DOM renderer |
| `encoding.ts`, `color.ts` | metrics → line width/opacity/colour |
| `alerts/` | price alerts on a layer's lines -- see below |

## Price alerts on a layer's lines (`alerts/`)

A layer that declares `alerts` (types.ts `LayerAlerts`) makes its lines alertable: **click** a
line to enable an alert when price enters a zone around it -- the line's price plus or minus a
buffer in the instrument's pips (ticks where it has none) -- and set the buffer in the small
editor that opens beside its **bell** at the pane's right edge. **Hovering** a line or a bell
draws the zone across the pane with its width; on a line not yet enabled, the zone a click would
give it, fainter. Levels is the one layer that offers it so far: a live level, by its price and
timeframe, with the pane's default buffer under the gear's "Alerts".

The layer only says what is alertable (`target(datum)` -> price + label, or null) and the
default buffer (`zonePips(config)`); everything else is here, and the controller applies it to
every layer that opts in. It finds a datum through the layer's own overlays, by their
`extendData` -- so a layer that offers alerts puts its datum there, and nothing else.

| file | what it is |
|---|---|
| `zone.ts` | **pure**: the alert's shape -- `any(price crosses_above low, price crosses_below high)`, entering the zone from either side -- its pips, its name |
| `hub.ts` | `PriceAlerts`: one wall's view of a watch backend, narrowed to the alerts; enable / new buffer / remove |
| `view.ts` | a layer's pane: the click and hover handlers, the bells, the zone band, opening the editor |
| `figures.ts` | the registered overlays: the bell (`wdPriceAlert`) and the band (`wdPriceAlertZone`) |
| `editor.ts` | the card beside a bell |

**An alert is a price watch** (`client/watch`), on the same backend as the chart's price-watch
lines, handed to the hub by `client/index.ts`: the server's `/watch` on a live wall, so it fires
with the tab closed and lands in the Notification Center, and the replay's own registry on a
replay wall. Nothing here evaluates anything: the condition is the server's language, and the
crossing baseline is the server's to seed when it arms. It keeps watching once it has fired
(`repeat: 'always'` -- the line is *enabled*, not set once), five minutes apart at the closest
(`PRICE_ALERT_COOLDOWN_MS`); entering needs leaving first, so price wandering inside the zone
raises nothing more. Armed with price already inside the zone, it waits for the next arrival.

**The shape is the identity.** Nothing stores which line an alert belongs to: the zone's middle
is the line's price, matched to half a tick. So two lines at one price share one alert, and an
alert outlives its line -- a bell is drawn for every alert in the price band whether or not its
line still is (a level spent since, a timeframe switched off), which is how it stays reachable.
Its watch has two leaves, so `client/watch/overlays.ts` (one `price` leaf only) never draws it a
second time. The bells are a layer's: two layers offering alerts on one pane would each draw them.

The handlers are left out of the paint signature (paint.ts), so a paint that changes nothing
visible leaves the previous paint's handlers on the chart; they read the pane's context from the
view at the moment of the event, never from what they captured. The zone band is the one thing
drawn outside the layer's group (`<layer id>-alert-zone`), because it follows the pointer; the
controller clears it, and closes an open editor, whenever it clears the layer.

**Every overlay a layer paints keeps itself on a right-click.** klinecharts removes an overlay on
right-click unless its handler prevents it, locked or not
(`OverlayView._figureMouseRightClickEvent`), and a layer whose signature still said the line was
drawn never put it back. The controller gives every overlay a preventing `onRightClick` unless
the layer brings its own.

## Not fetching, and not repainting

Both halves of the same problem: a layer is asked to redraw far more often than anything it
draws has changed, because **every live tick raises `onVisibleRangeChange`** (klinecharts
re-adjusts the visible range when the last bar is merely updated) and nudges the autoscaled
price axis for the axis watcher to notice on top of that. Since 2026-10-11 the first of those
no longer reaches a view at all: it subscribes through `client/chartview.ts`'s `onViewMoved`,
which drops a dispatch whose visible bars and held bars are unchanged -- a tick that only moved
the forming bar. The price band drift is still sampled. Three separate gates stand between
what is left and work:

1. **Is the window already held?** `controller.ts` keeps, per pane, the rectangle of the
   price/time plane it has fetched. If the view is inside it, there is no request — this is
   the common case for panning and for rescaling the price axis. When the view does leave,
   `targetWindow` extends the held rectangle **only on the sides that moved** and
   `missingWindows` tiles the difference, so a pan to the right is one request for one strip,
   not four for a re-padded box.
2. **Has the data had a chance to change, and has the producer written it yet?**
   `ChartLayer.staleAt(fetchedAt, ctx)` says when what is held can first differ from what the
   server would answer. Levels are computed on 1W and 1M, so a book can only change at a 17:00
   market-day close — but **that is when the candle closes, not when its levels exist**, and a
   horizon built out of the calendar alone lands in the gap and then waits a whole day. So
   `client/levels/freshness.ts` reads the server's own watermark
   (`X-Levels-Computed-Through`) and returns a short, backing-off horizon while the feed is
   behind — **bounded**, because "late" and "never coming" are indistinguishable from one
   observation. A layer that declares nothing falls back to a flat five-minute timer, which
   for levels meant a full refetch per pane twelve times an hour to be handed the same book.
   `client/levels2/` is on that fallback today; its producer is manual, so it wants a
   validator rather than a calendar horizon. The general pattern, and what each plugin would
   need, is `notes/architecture/freshness-horizons.md` in the workspace.
3. **Would the picture differ?** `paint.ts`'s `overlaySignature` is taken over the overlays
   just built and compared with what is on the chart; equal means the chart is left alone
   instead of tearing down and rebuilding several hundred overlays. This is safe because of
   what `toOverlays` actually reads: the age metrics key off `ctx.to`, the last **visible
   bar's** timestamp, which moves when a candle opens and not while one forms, so between two
   candles only the price band drifts — and that only matters when a level crosses its edge.

The redraw debounce is trailing with a **ceiling** (`MAX_DEBOUNCE_MS`): a live chart produces
events faster than the debounce window indefinitely, and a purely trailing debounce would then
never fire at all, leaving a pane showing the levels it had before the user panned until the
market went quiet.

**One `/levels` read per instrument, not per pane** (`levels/api.ts`, since 2026-10-29). Whatever
makes one pane of a wall re-read makes all of them re-read together -- a replay step across a day
boundary invalidates every view at once, and a workspace opening or a new candle at 17:00 lands
on every pane in the same moment -- and each asks for its own band and date window. Those asks
are gathered per instrument and per everything else that decides the answer (interval set,
spent levels, read clock) into ONE read of the union of their windows, and each pane is handed
exactly what the server would have sent for its own window, picked out by the server's own
filter (`levelsIn`). The controller is untouched: every view still holds and extends its own
window, so it draws precisely what it drew when it read alone -- under a replay clock with spent
levels shown, less a lookahead the server's own per-window answer had (`levelsIn` says which
levels, and why none of them was ever on screen). An ask inside a read already in
flight waits on it, and one inside a window read recently re-reads that window's URL, so the
browser revalidates the answer it already holds and the server's ETag answers 304. Measured on
prod with six-pane EURUSD and EURGBP walls at four 2023 replay clocks: a day boundary went from
6 concurrent reads and 1.4-2.3 s to 1 read and 0.44-0.79 s, with every pane's overlays
identical; live, a wall opening went from 6 reads to 1, and six panes re-reading 300 ms apart
after a new candle from 6 full reads to five 304s and one read. The server
side of the same concern is `wdashboard-server` `docs/plugins.md`: the book is read once per
closed 1W/1M bar and `/levels` answers a conditional GET.

## Tests

`bun test client` — `alerts/alerts.test.ts` (the shape, when it fires through the real
condition language and firing policy, the hub over a real local registry, and panes driven
through the real controller in happy-dom: click, bell, hover, editor, remove, refusal, teardown,
and across panes -- a bell on every pane of the instrument, one editor at a time, an edit or a
removal on one pane reaching the others),
`indicator.test.ts` (drawn only on panes carrying the template, off when
hidden or removed, settings per pane, the wall document's shape, the legend), `persist.test.ts`
(what is stored and what is let back in), `window.test.ts` (the rectangles tile exactly; a long pan stays bounded),
`paint.test.ts` (the signature is blind to nothing visible and to everything invisible),
`../levels/freshness.test.ts` (the horizon in all three states, both DST directions, and that
a dead feed is still bounded), `../levels/levels.test.ts` (what identifies a request, what is
drawn, the tick case end to end, that the horizon is read per instrument, and that a wall reads
once per instrument while every pane draws what it drew reading alone).
