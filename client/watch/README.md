# client/watch — price watches on the chart

Tell me when EURUSD reaches 1.16500. A dashed line on every pane showing that instrument, its
price tagged on the price axis, and a notification when the market gets there — **raised by
the server, whether or not this tab is open**.

That last part is the whole design. The watching happens in `wdashboard-server`
(`wdashboard_server/watch`, `docs/watch.md`). This module is a **view**: chart gestures turned
into `/watch` calls, and lines drawn from what comes back. There is no monitor here, no
crossing rule here, and no persistence here — an earlier version of this feature had all
three, in the browser, and could not fire with the tab closed.

## Pieces

| file | what it is |
|---|---|
| `types.ts` | The watch wire, plus `priceCondition`/`priceLevel`/`priceDirection` — the one shape of watch a chart can draw. |
| `api.ts` | The `/watch` wire. Every mutating call answers with the whole watch. |
| `store.ts` | `WatchStore` — this browser's **cache** of the server's watches, and `subscribe`. |
| `template.ts` | The registered klinecharts overlay `wdPriceWatch`: a line, and a **persistent** tag on the price axis. |
| `overlays.ts` | A line per drawable watch per pane, the drag, and the hit test the menu uses. |
| `menu.ts` | The right-click menu (generic: rows with a label and a detail). |
| `dialog.ts` | Set a price and a direction, then apply. Used by BOTH the create and the move flow. |
| `notifications.ts` | The `NotificationBackend` over `/notifications` + the live `notification` frames. |
| `index.ts` | `mountPriceWatches(chartPro)`. The wiring, and nothing else. |

## A price watch is one shape of watch

The server's model is a **source** (what to watch), a **condition** (when), and a policy
(`trigger`, `repeat`, `cooldownMs`). A price watch is the narrow case this chart can draw:
the `price` source, one leaf, on the `price` field.

```ts
{ source: 'price', target: 'oanda:EURUSD', condition: { field: 'price', op: 'crosses', value: 1.165 } }
```

Everything else the server can hold — a bar's close (`bar` source, `oanda:EURUSD@1h`), a
combinator, a third-party source — is a perfectly good watch that this layer has no line for.
`priceLevel()` returns null and `overlays.ts` skips it, rather than guessing at a price to
draw it at. `GET /watch/sources` publishes every mounted source and its fields, so anything
that wants to build a fuller editor reads the server rather than a second copy of the list.

## Direction is the server's to decide

The dialog offers *reaches (either way)* — the default — plus *rises through* and *falls
through*. The default sends `crosses`, and the **server seeds the crossing baseline from its
own feed at the moment the watch is armed**, so the side is decided by where the market
actually is, not by which button was pressed and not by a chart whose newest bar may be
behind the tick stream. That is why nothing in this module computes a side, and why editing a
level is one `PATCH`: a changed condition re-arms server-side, which re-seeds.

## The gestures

- **Right-click empty chart** → six rows, each showing the price it would use: at cursor,
  current price, and the open/high/low/close of the bar under the pointer. Picking one opens
  the dialog, pre-filled and editable.
- **Right-click a line** (within `HIT_TOLERANCE_PX`) → Edit price…, Re-arm here (once it has
  fired), Delete.
- **Drag a line** → the same dialog, pre-filled with where it was dropped. Cancelling is not
  a revert branch: the store re-emits and every pane redraws from it, the same path that
  draws everything else.

## Two klinecharts traps

- **The default price-axis tag is drawn only while the overlay is selected**
  (`OverlayYAxisView.getDefaultFigures` checks `clickOverlayInfo`), so `needDefaultYAxisFigure`
  is not "tag this line on the axis". A permanent tag needs `createYAxisFigures`, which
  `OverlayCreate` omits — hence a **registered template**. The built-in that has the tag
  (`simpleTag`) marks its line `ignoreEvent` and cannot be dragged, which is why
  `wdPriceWatch` exists.
- **klinecharts removes an overlay on right-click** unless the handler calls
  `preventDefault()` (`OverlayView._figureMouseRightClickEvent`).

## Notifications

`notifications.ts` is a `NotificationBackend` (see
[`client/notifications`](../notifications/README.md)): it hydrates the centre from
`GET /notifications`, pushes live rows from the `notification` stream frame, and routes
acknowledgements and clears back to the server so reading an alert on one device is not
undone by opening another. It lives here, not in the centre, because the two are meant to stay
independent — the centre knows a row may carry a `remoteId` and nothing else about where it
came from.

A live row whose `source` is `watch` also means a watch just changed status server-side, and
`client/index.ts` turns that into a `refresh()` — the one thing that tells this tab to redraw
a fired line grey.

## Gating

`mountPriceWatches` returns null unless the server advertises `watch`. An older server cannot
hold a watch, and a browser-side monitor is not a substitute: it cannot fire with the tab
closed, which is the whole feature.

Debug hook: `window.__wdWatches.list()` / `.sources()`.

Tests: `bun test client/watch` — the price-watch shape (pure) and the cache against a fake
API. The rule for when a watch fires is tested on the server, where it lives
(`tests/watch/test_conditions.py`).
