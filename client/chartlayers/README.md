# Chart layers

A **ChartLayer** is a server-derived, price-anchored overlay: fetch data for the current
view, turn it into overlays, expose settings. `client/levels/` is the only one today and the
reference implementation. This is deliberately **not** the indicator-plugin model
(`client/plugins/`) — a plugin binds sources to a pane's indicator template on the bar grid,
a layer draws objects anchored to *price*, with lifespans that predate the loaded bars.

| file | what it is |
|---|---|
| `types.ts` | `ChartLayer`, `LayerWindow`, `LayerContext` — the contract |
| `controller.ts` | the per-pane lifecycle: toolbar button, settings panel, wiring, debounced redraw |
| `window.ts` | **pure**: what a pane has covered and what it still needs |
| `paint.ts` | **pure**: whether a redraw would change the picture |
| `store.ts` | per-layer settings persistence (`/preferences`, or localStorage where auth is off) |
| `settings.ts` | the declarative field schema and its plain-DOM renderer |
| `encoding.ts`, `color.ts` | metrics → line width/opacity/colour |

## Not fetching, and not repainting

Both halves of the same problem: a layer is asked to redraw far more often than anything it
draws has changed, because **every live tick raises `onVisibleRangeChange`** (klinecharts
re-adjusts the visible range when the last bar is merely updated) and nudges the autoscaled
price axis for the axis watcher to notice on top of that. Three separate gates stand between
that and work:

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

The layer's own fetch deduplicates identical in-flight requests (`levels/api.ts`) — a wall of
panes on one symbol shares a time axis, so one pan lands several byte-identical `/levels`
reads on a browser with six connections per origin to spend. The server side of the same
concern is `wdashboard-server` `docs/plugins.md`: the book is read once per closed 1W/1M bar
and `/levels` answers a conditional GET.

## Tests

`bun test client` — `window.test.ts` (the rectangles tile exactly; a long pan stays bounded),
`paint.test.ts` (the signature is blind to nothing visible and to everything invisible),
`../levels/freshness.test.ts` (the horizon in all three states, both DST directions, and that
a dead feed is still bounded), `../levels/levels.test.ts` (what identifies a request, what is
drawn, the tick case end to end, and that the horizon is read per instrument). The controller's
DOM half has no coverage; the decisions it makes were moved out of it so they could have some.
