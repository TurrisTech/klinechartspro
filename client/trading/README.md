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
- `panel.ts` — the contents: account strip (balance / equity / unrealized / open +
  flatten-all), the order ticket, and the positions / orders / history tabs. Plain DOM,
  `kc-*`/`wd-trade-*`. It owns no chrome — the title bar, close and drag are the window's —
  but it does own its shape: below 620px (a window floated small) the three grid areas stop
  sharing rows and stack into one column (`is-narrow`, from its OWN width, not the page's).
- `overlays.ts` — `TradingOverlays`, everything the session puts on the candle panes (below).
- `lines.ts` — the two registered klinecharts templates (`wdTradeLine`, `wdTradeBracket`) and the
  pure "which lines does this snapshot draw" (`linesFor`, `workingFor`).
- `onchart.ts` — the HTML layer per pane: a label on every line, dragging, and the actions.
- `ordercard.ts` — the collapsible order card in that layer.
- `ticket.ts` — the order ticket (below), built once and updated in place.
- `prefs.ts` — the choices kept per browser (ticket size/stop modes, risk %, R, whether the order
  card is rolled up), and the channel that keeps every pane, the ticket and other tabs in step.
- `metrics.ts` — PURE forex figures, risk sizing, the engine's refusal rules, label placement.
- `amend.ts` — PURE: a waiting stop/target/price change in words, and why the engine would refuse
  it; shared by the chart and the tables.
- `instrument.ts` — per-instrument precision + pip size (`forexPipLocation`), cached from
  `GET /instrument`. Forex prices in pips; non-forex falls back to price-only.
- `format.ts` — pure price / pip / P&L helpers.
- `dock.ts` — `mountTradingDock(session, opts)`: the mode-agnostic dock — panel, overlays, the
  window it lives in, open/close, teardown. The window is a `DockableWindow`
  (`client/chrome/window.ts`): **docked below the chart by default** (the account strip, the
  ticket and the tables want the width), floated over it on request, resizable in both, and
  hidden until asked for, so it costs the wall nothing until then. Equity and open P&L are
  rendered into its TITLE BAR, which is what the window still shows rolled up. A replay's
  controls are a second window of the same kind, and drive this one from their Account
  toggle.
- `index.ts` — `mountPaperTrading(chartPro, container)`: a `PaperTradingSession` on the dock;
  returns `{ toggle, isOpen, sync, teardown }`. The "Paper" button in the drawing rail's
  footer (`client/index.ts` `mountChartExtras`) calls `toggle`; "Replay" beside it is
  `client/replay`.

## On the price pane

Whatever is working on a pane's instrument is drawn on that pane, **whether or not the account
window is open** — an order placed from the ticket appears on the chart at once.

- **Lines** (`wdTradeLine`): entries and pending prices **solid**, stops and targets **long dashes**
  (10 on, 6 off; user, 2026-09-15). Colour does the rest — red stop, green target, the side's colour
  for an entry; a pending order is heavier — with the label: a pending order's price, an open trade's entry, every stop and
  target, each with its price on the axis. The entry is locked; the rest are draggable.
- **Bracket** (`wdTradeBracket`): what connects an entry to its stop and target — a loss band
  and a profit band from the bar the position opened on to the right edge, a connector,
  and a dot at the fill. Strong for the selected entry, faint for the rest. No figure takes
  events, so it never steals a pan.
- **Labels**, against the right edge beside each line's axis tag: `Long 10K −1.8p −1.80 ×`,
  `SL −20.0p −20.00 ×`, `Buy limit 10K 14.5p away ×`. Close lines are placed by `layoutLabels`
  so none overlap, with a leader back to the line; a line off the pane pins its label to that
  edge (▲/▼). Hover or selection shows `SL`/`TP` buttons where one is missing.
- **The order card**, lower left: one row per trade and order, the selected (or only) one
  expanded with stop and target (price, pips, amount, % of balance, R:R), size in units and lots,
  pip value, margin and time; actions Breakeven, Close ½, Close, Cancel order, add/remove
  stop/target, and Flatten for the instrument. **Risk N%** puts the stop where it loses that share
  of the balance at the position's size, and **NR** puts the target at N times the stop's distance
  -- N being the ticket's risk % and last-used R. Rolled up, the header still shows the counts and
  the open P&L. **Rolled up on one pane is rolled up on every pane**, and in other tabs (`prefs.ts`,
  via the `storage` event); until chosen, a phone-sized pane starts rolled up.

**The draft — the order being written, on the chart.** While the account window is open, the
ticket's order is drawn on its instrument's panes and listed first on the card, and it is edited
from either place: dragging its entry, stop or target writes the new price into the ticket's
fields as it moves (stated however the ticket states them — pips follow their entry, a risk-sized
order re-sizes), dragging a market draft's entry makes it a limit or a stop by which side of the
market it is dropped on, the card's `+ Add` / `Risk N%` / `NR` apply to it, and **Place** (two
presses) sends it. The ticket stays the one place the order lives (`OrderTicket implements
DraftController`, `lines.ts`), so the chart and the fields cannot disagree.

Because it sits among orders that are real, it is kept unmistakably apart:

- it is drawn only **once it has a level of its own** (a limit/stop price, a stop or a target) —
  a bare market draft would be a line on top of the price, beside every open entry, so until
  then it is a row on the card and nothing on the chart;
- **outlined** labels that say "Draft", in **their own column** left of
  the working orders' labels (a draft stop next to a real stop reads side by side, never
  interleaved);
- while it is being composed, **what is already working recedes**: dimmed lines, labels dimmed
  until hovered, no selected band, card rows faded and shut;
- **×** on its entry label (or Discard on the card) clears it, and the pane is as it was; closing
  the account window hides it; a placed order returns the ticket to a clean market order;
- Escape mid-drag puts the level back where the drag began.

**Dragging** a stop, a target or a pending order's price — by the label or by the line — shows
what that price would realise while it moves and marks a price the engine would refuse (dashed
label border, the reason as its title). Canvas rebuilds are held for the gesture, so a poll
landing mid-drag cannot pull the line out from under the pointer.

**Every interactive change to a working stop, target or pending price is confirmed before it is
sent** (user, 2026-09-15). Dropping a drag, or pressing `+ Add`, `Risk N%`, `NR`, Breakeven or ×
on a stop/target, only PROPOSES the change (`Amendment`, held by `TradingOverlays` so every pane
shows the same one): the chart draws it as if confirmed (`applyAmendment`), that line's label pulses
and turns into **Confirm / ×** (a removal reads "remove?"), and the card opens with the same
question in words — "Move the long 10K's stop loss 1.15228 → 1.15300? If hit: −7.8p · −7.80 USD".
Confirm sends it; × or Escape puts it back. A new proposal replaces the old one; one whose position
has since closed is dropped; a button that would change nothing says so. Drafts are exempt — a
draft only edits the ticket, and placing it already takes two presses.

**The account window's tables ask too.** Leaving an edited stop, target or pending-price cell
proposes the same kind of change through the same waiting state (`TradingOverlays`), so the chart
label and card show it when the instrument is on a pane, and a bar above the table asks it in any
case — a table row's instrument need not be on screen. The cell is marked (a cleared cell reads
"remove?"), a value that is not a price is refused with a note, and Confirm/Cancel answer it. The
wording and the refusal rules are one pure module (`amend.ts`) for the chart and the tables alike.

**A table is never rebuilt under the cursor.** The panel re-renders on every session notification;
while a table cell has focus the table waits (the confirm bar still updates), and it catches up
when the focus leaves — so a two-second poll no longer takes an edit away mid-typing.

**Currencies.** P&L is the engine's: in the instrument's quote currency. The card labels it so,
and adds the account-currency figure only where one exact conversion exists (the account is the
quote, or the base at the mid) — a cross gets none rather than an invented rate.

**Close and flatten take two presses** (the button relabels for three seconds, and stays where the
first press found it). Selecting is a click on a row, a label or a line; a newly placed order or a
fresh fill is selected automatically, and a fill, a stop or target hit and a close are announced
in the card's header for a few seconds.

**Traps.** The layer lives inside klinecharts' price-area container, so it stops `mousedown`,
`touchstart`, `pointerdown`, `click`, `wheel` and `contextmenu` from reaching the chart (a pan, a
wall seek, the watch menu) but lets `mouseup` and a button-down `mousemove` through (a pan ending
over the card). And `src/app.css`'s `.klinecharts-pro * { border-color }` loads after
`client/style.css` at equal specificity: a rule here that colours a border is scoped `.wd-oc …`.

## Gating

The whole feature is gated on the server's `sim` capability: `mountPaperTrading` returns
`null` when it is absent, so an older server simply has no Paper button.

## The order ticket

- **Size by** Units, or **Risk %**: the units that lose that share of the balance if the stop is
  hit (`unitsForRisk`), floored to the instrument's unit precision so the loss never exceeds it.
- **SL / TP as** Pips, Price, or **% bal** — the balance lost at the stop or made at the target at
  the planned size (`levelForBalancePercent`, rounded toward the entry). % bal is disabled while
  sizing by risk, which already fixes the loss. Switching how a level is stated converts what was
  typed.
- **Target at 1R / 2R / 3R** once there is a stop.
- A **summary** of the order as it would be sent: units, lots, margin (flagged when it is more
  than the equity — the paper engine does not enforce margin, a live account would), risk and
  reward with their share of the balance, R:R — or the reason it cannot be sent yet.

Everything percent-of-balance needs a conversion to the account currency: 1:1 when the account is
the quote, the mid when it is the base, or a pair the session holds a quote for (GBPUSD for EURGBP).
Without one the ticket says so rather than guessing.

The ticket is built once. It used to be rebuilt on every session notification — every two seconds
while anything is working — which took focus and a half-typed price away from whoever was typing.

## Pips (OANDA)

A pip is the instrument's `forexPipLocation` decimal (EURUSD −4 → 0.0001, JPY −2 → 0.01);
display precision is one finer. The ticket takes SL/TP as a **pip distance** by default (a
toggle switches to absolute price), converted from the resting price for a limit/stop else the
fill side; a long's SL is below / TP above, a short's reversed. The spread shows in pips on the
ticket, and P&L in pips beside currency in the tables.
