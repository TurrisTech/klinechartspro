# client/notifications — the Notification Center

Where anything in the dashboard says *something happened that you were not looking at*. A
bell and a caret at the right-hand end of the top rail (`toolbar-right`, see
`src/types.ts` `ChartProSlot`), a dropdown listing what has arrived, and a model underneath
that no producer has to know about.

Almost everything in it comes from the **server**: a watch fires in
`wdashboard-server` (`wdashboard_server/watch`) whether or not this tab is open, and the row
is stored there before it is sent. This module knows none of that — it knows a row may carry
a `remoteId`, and that acknowledging or clearing such a row has to reach the backend too.
[`client/watch/notifications.ts`](../watch/README.md) is that backend; `client/index.ts` is
where the two meet.

## Pieces

| file | what it is |
|---|---|
| `types.ts` | `Notification`, `NotificationSpec`, **`NotificationSink`** (the one-method interface a producer depends on) and **`NotificationBackend`** (the durable half, when there is one). |
| `center.ts` | `NotificationCenter`: the newest-first capped list, seen/unseen, `subscribe`, and the backend seam. Plus the page singleton `notifications`. |
| `bell.ts` | The view: the bell (blink + badge), the caret (the dropdown), the rows, Clear all. Plain DOM. |
| `index.ts` | `mountNotificationCenter(chartPro)` — puts the bell in the slot for one wall. |

## The two clicks are different acts

- **The bell** acknowledges (`markAllSeen`). That, and only that, stops the blink. It does
  not open the list: knowing that something arrived and reading what it was are separate,
  and a bell that opened a panel would make "stop blinking at me" cost a second click to
  dismiss.
- **The caret** opens the list. Rows carry a title, a body, the producer's tag and a coarse
  relative time (the exact instant is the row's `title` attribute); each has a dismiss, and
  the footer has Clear all.

The blink is a fade, not a hard on/off (`@keyframes wd-notify-blink`), and it is dropped
under `prefers-reduced-motion` — the badge and the colour still say there is something
unseen.

## Two kinds of row

- **Server rows** carry a `remoteId`. They arrive from the backend's `hydrate()` (a catch-up
  read on boot) or its live push, are deduplicated by that id so a push racing a hydrate
  cannot show twice, and are acknowledged and cleared *there* as well as here.
- **Local rows** are raised by the page itself (`notify(spec)`) and live for the page.

Position is decided by `at`, not by arrival — a hydrate replays older rows while a live push
may land in the middle of it, and a catch-up read must not bury the alert that just fired.

The centre holds **no persistence of its own**. It used to mirror the list into
`localStorage`; a server-side store is precisely what replaces that, and keeping both would
be two records of one list.

## Lifetimes

The **centre is a page-level singleton**, like `client/stream.ts`'s client. A workspace switch
tears the whole wall down and builds another (`client/index.ts` `remount`), and a notification
raised on the wall you just left is exactly the one you still need to see. The **bell is per
wall** — it is chrome in that wall's slot — and re-subscribes to the same centre on mount; so
is the backend, which is detached and disposed with it.

## Adding a producer

```ts
import { notifications } from '../notifications'
notifications.notify({ title: '…', body: '…', level: 'alert', source: 'replay' })
```

…except from inside a feature module, which should take a `NotificationSink`-shaped dependency
instead and let `client/index.ts` supply the singleton. `source` is what `clear(source)` works
on, and what the row's tag shows. A producer that needs its rows to **survive the tab being
closed** does not belong here at all: raise them server-side
(`wdashboard_server/notify`) and they arrive through the backend like a watch's.

Tests: `center.test.ts` (`bun test client/notifications`). `bell.ts` has none — bun has no
DOM, which is exactly why the list, the counting, the dedup and the backend seam live in
`center.ts`.
