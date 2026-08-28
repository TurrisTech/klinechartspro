# client/chrome — the app's own window furniture

Chrome the *app* owns, as opposed to the chart the library owns. One module today.

## `window.ts` — dockable windows

A window is a card that is either **docked**, in a column below the chart, or **floating**
over it. The two are the same object: same title bar, same drag, same persistence, so
learning one teaches the other.

```
+----------------------------------------------------+
| ::  TITLE   <title slot>      <actions>    ^  ⇲  x |
+----------------------------------------------------+
|  body                                              |
+----------------------------------------------------+
```

| control | what it does |
|---|---|
| the bar itself | drags the window. Docked, dragging it **out** floats it under the pointer; floating, dropping it on the bottom strip of the chart (lit while you are over it) docks it |
| `^` | rolls the window up to its title bar, and back |
| `⇱` / `⇲` | docks / floats it outright |
| `×` | hides it (only when the caller passes `onClose`) |
| corner | resizes a floating window; the top edge resizes a docked one, which is the column's height |

`titleSlot` and `actions` are for the caller: the replay puts its cursor and Step button
there, the account window a live equity readout — which is what each still shows rolled up.

Two windows today, from `defaultMode` and `order`: the trading panel (docked, order 20) and
the replay's controls (floating, order 10 — above the account when both are docked).

## Three things worth knowing before changing it

**Floating windows are clamped into `#app`'s rect, not the viewport.** `#app` shrinks by
exactly the dock column's height (`body.wd-has-dock` makes the page a flex column), so
clamping to it is what keeps a floating window off the docked ones — and gives the space back
when the column empties.

**The layout change is broadcast, not observed.** A `ResizeObserver` on `#app` would catch a
window docking in a tab that is painting, and only there: an occluded or background tab
delivers no observer callbacks at all, and every floating window would then sit over the dock
column until something else moved it. `layoutChanged()` is called where the change happens
(dock, undock, hide, dock-height drag, viewport resize) and every live window re-clamps. The
observer is kept as well, for a window's own content growing.

**Drags run on `window` listeners, not `setPointerCapture`.** Dragging a docked window out
re-parents the card into `document.body`, and re-parenting silently drops the capture — after
which `releasePointerCapture` throws, the drag never ends, and the window stays stuck to the
cursor. That was a real bug, caught in the browser; window-level listeners gated on the grab
do not care where the element lives.

## Persistence

`localStorage`, one key per window (`wd.window.<key>`): mode, floating position and size,
docked height, collapsed. A window the user has never dragged stores **no position** and stays
anchored to its default spot — bottom-centre above the time axis for a small window, centred
for a large one, which is what keeps two windows from opening on top of each other. It then
grows upward as panels open, instead of drifting into the axis. One drag hands the position
over for good.

Visibility is deliberately **not** persisted: opening the account is the rail button's job (or
the replay's Account toggle), and a page that opened it by itself on every load would be
taking the wall back uninvited.

## Tests

`bun test client/chrome` — the geometry only (`clampPosition`, `defaultPosition`, `clampSize`,
`clampDockHeight`, `inDropZone`), which is pure. The rest is DOM and is verified in a browser.
