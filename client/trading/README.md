# client/trading — the paper-trading panel

The paper account the user trades on a live wall, against the live market. All the money
logic (the fill engine, the account, the OANDA v20 fill rules) is on the **server**
(`wdashboard-server` `wdashboard_server/sim/`); this module is the view and the actions.

## The `TradingSession` seam (the point of the module)

Everything the UI does goes through the **`TradingSession`** interface (`session.ts`) — never
the server directly:

```ts
interface TradingSession {
  snapshot        // { account, quotes, orders, trades, symbols } (+ mode fields)
  ready
  subscribe(listener) => unsubscribe
  watch(instrument)
  placeOrder(...), cancelOrder(id), modifyOrder(id, ...), modifyTrade(id, ...),
  closeTrade(id, units?), flatten(symbol?)
}
```

Two implementations: **`PaperTradingSession`** (this module), backed by the `/sim` routes and
a poll (fast while something is working, slow when flat, never while the tab is hidden), and
**`ReplayTradingSession`** (`client/replay/session.ts`), a client-side engine over stored
bars. The panel, ticket, tables and overlays consume the interface only, so they serve both
unchanged. The optional members `mode` and `cursor` are additive; the panel branches on
mode only for its title.

## Pieces

- `api.ts` — the `/sim` wire (types + `simApi`). Owner is the signed-in user (dev) or a minted
  `X-Sim-Owner` token kept in `localStorage`, sent on every call.
- `session.ts` — the `TradingSession` interface and `PaperTradingSession` (load, poll, act).
- `panel.ts` — the dock: account strip (balance / equity / unrealized / open + flatten-all),
  the order ticket, and the positions / orders / history tabs. Plain DOM, `kc-*`/`wd-trade-*`.
- `overlays.ts` — a line per pending order and per open trade (entry) on each pane, plus
  draggable stop/target lines that report an amendment back through the session. Per pane, that
  pane's instrument only, clamped to a draw window.
- `instrument.ts` — per-instrument precision + pip size (`forexPipLocation`), cached from
  `GET /instrument`. Forex prices in pips; non-forex falls back to price-only.
- `format.ts` — pure price / pip / P&L helpers.
- `dock.ts` — `mountTradingDock(session, opts)`: the mode-agnostic dock — panel, overlays,
  the dock element below the chart (minimized by default, removed from layout), open/close,
  teardown. A replay's controls are not in it: they float over the chart and toggle this dock
  from their own Account button (`client/replay/window.ts`).
- `index.ts` — `mountPaperTrading(chartPro, container)`: a `PaperTradingSession` on the dock;
  returns `{ toggle, isOpen, sync, teardown }`. The "Paper" button in the drawing rail's
  footer (`client/index.ts` `mountChartExtras`) calls `toggle`; "Replay" beside it is
  `client/replay`.

## Gating

The whole feature is gated on the server's `sim` capability: `mountPaperTrading` returns
`null` when it is absent, so an older server simply has no Paper button.

## Pips (OANDA)

A pip is the instrument's `forexPipLocation` decimal (EURUSD −4 → 0.0001, JPY −2 → 0.01);
display precision is one finer. The ticket takes SL/TP as a **pip distance** by default (a
toggle switches to absolute price), converted from the resting price for a limit/stop else the
fill side; a long's SL is below / TP above, a short's reversed. The spread shows in pips on the
ticket, and P&L in pips beside currency in the tables.
