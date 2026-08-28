# client/alerts — price alerts

Tell me when EURUSD reaches 1.16500. A dashed line on every pane showing that instrument,
its price tagged on the price axis, and a notification when the market gets there.

Built so the pieces are separable: the rule for when an alert fires is a pure function, the
watching is a class over `client/stream.ts` that has never heard of a chart, the drawing is
a class over the panes that has never heard of the stream, and the only thing that knows
they exist together is `index.ts`. It depends on the rest of the app through exactly two
things — a `KLineChartPro`, and an **`AlertNotifier`** (`types.ts`), which is one method.
[`client/notifications`](../notifications/README.md) satisfies that interface; this module
does not import it.

## Pieces

| file | what it is |
|---|---|
| `types.ts` | `PriceAlert`, `AlertDraft`, `AlertSide`, and `AlertNotifier` — the one method this module needs from the outside world. |
| `cross.ts` | **When an alert fires.** Pure, no imports. `sideOf`, `reach`, `triggers`, `observationFor`. |
| `store.ts` | `AlertStore` — the alerts, their persistence, and `subscribe`. The feature's single source of truth. `loadAlerts()` is the page's. |
| `monitor.ts` | `AlertMonitor` — one `client/stream.ts` subscription per instrument with an armed alert, reconciled from the store. Reports each crossing once. |
| `template.ts` | The registered klinecharts overlay `wdPriceAlert`: a line across the pane and a **persistent** tag on the price axis. |
| `overlays.ts` | `AlertOverlays` — a line per alert per pane, the drag, and the hit test the menu uses. |
| `menu.ts` | The right-click menu (generic: rows with a label and a detail). |
| `dialog.ts` | `openAlertDialog` — edit a price, then apply. Used by BOTH the create and the move flow. |
| `index.ts` | `mountPriceAlerts(chartPro, { notifier, live })`. The wiring, and nothing else. |

## The rule, and why it is one-sided

An alert records **which side of the level the market was on when it was armed** (`from`),
taken from the market price at that instant. Firing is then a one-sided comparison against
the newest reading:

```
armed from below  ->  fires once the market trades AT or ABOVE the level
armed from above  ->  fires once the market trades AT or BELOW the level
```

That is what makes the test **stateless** — no per-alert memory of a previous price, and no
way for a reading from before the alert existed to fire it. Two consequences worth knowing:

- **The reference price comes from the monitor, not the chart** (`index.ts` `marketPrice`).
  The side an alert waits on and the reading that will fire it must come from one clock. A
  chart whose newest bar is behind the stream — a file-store dev stack, a pane that has not
  caught up — would otherwise arm an alert on the wrong side of a market that has already
  moved, and the very next frame would fire it. The chart answers only for an instrument
  nothing is watching yet, which is every first alert on a symbol.
- **A bar's high/low count only if the bar opened at or after the alert was armed**
  (`observationFor`). The extremes are how a move between two frames is seen at all, and on
  a fast market that is where the crossing is; but a bar that was already forming when the
  alert was armed carries extremes from before it existed.

**What is missed, by construction:** a crossing that happened while no tab was open. This is
a client-side monitor with no server-side counterpart. A move through the level and back
while the dashboard was closed leaves nothing to find — the backfill on reconnect covers a
dropped socket, not a closed browser. That is a property of where the feature lives.

## The feed

`client/stream.ts` **directly**, one subscription per instrument with an armed alert, at the
finest interval the server serves (`1m`). Deliberately not a pane's feed and not a pane's
interval:

- an alert is about an instrument, so it keeps firing when the pane is retargeted, hidden by
  a layout preset, or was never on screen;
- the interval decides how much of a fast move is visible — with `stream.forming` a 1m bar
  updates on every tick and its high/low carry what happened between two frames. A wall on
  1D would otherwise learn about a crossing a day late.

Subscriptions are reconciled from the store on every change, so deleting the last alert on a
symbol really does stop watching it. Idempotence is `store.markTriggered`, which returns null
for an alert already triggered — a repeated frame cannot notify twice.

## The chart figure

`wdPriceAlert` has to be a **registered template** rather than a built-in with per-instance
overrides. klinecharts' `OverlayCreate` omits `createYAxisFigures`, and the default axis
figure (`needDefaultYAxisFigure`) is drawn only while the overlay is the *selected* one
(`OverlayYAxisView.getDefaultFigures` checks `clickOverlayInfo`) — a tag that appears only
when you click the line is not "the price tagged on the price axis". The closest built-in,
`simpleTag`, has the tag but marks its line `ignoreEvent`, so it cannot be dragged.

Dragging is the line figure carrying events: pressing it routes to klinecharts'
`eventPressedOtherMove`, which applies the pointer's delta to the point's value.
`onPressedMoveEnd` on the instance is what opens the dialog.

**`onRightClick` must call `preventDefault()`.** klinecharts REMOVES an overlay on
right-click otherwise (`OverlayView._figureMouseRightClickEvent`). The menu itself is opened
from the pane's own `contextmenu` listener — one code path for "create here" and "this
alert", which is also what makes a triggered line behave like a live one.

## The gestures

- **Right-click empty chart** → six rows, each showing the price it would use: at cursor,
  current price, and the open/high/low/close of the bar under the pointer. Picking one opens
  the dialog, pre-filled and editable.
- **Right-click a line** (within `HIT_TOLERANCE_PX`) → Edit price…, Re-arm here (triggered
  only), Delete.
- **Drag a line** → the same dialog, pre-filled with where it was dropped. Cancelling is not
  a revert branch: the store re-emits and every pane redraws from it, which is the same path
  that draws everything else.

## Storage

One `/preferences` key, `priceAlerts`, holding the whole list, mirrored to `localStorage`
(`wd.priceAlerts`) — which is both the fallback (prod has no appstate database) and what
answers a reload when `/preferences` is unreachable. Unlike `client/workspaces`, this is one
key rather than a key per row: alerts are small and edited one at a time, and the multi-device
merge a key-per-document buys is not worth a key space. Two devices editing alerts at the
same moment is therefore last-write-wins across the whole list.

## Gating and modes

Nothing to gate on: the stream and `localStorage` are always there, and `/preferences` is
optional. On a **replay** wall `client/index.ts` passes `live: false` — the chart is under a
read clock (`services/asof.py`) and the monitor's feed is the live market, the same reason
the plugins get `inertStream` there. The lines stay drawn, draggable and editable; only the
watching stops.

Debug hook: `window.__wdAlerts.list()` / `.watching()`.

Tests: `bun test client/alerts` — `cross.test.ts` (the rule, pure), `store.test.ts` (sides,
idempotent triggering, re-arming, the cap, the mirror), `monitor.test.ts` (subscription
reconcile, fire-once, the armed-at guarantee, backfill) against a fake stream.
