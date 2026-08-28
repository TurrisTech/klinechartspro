# client/notifications — the Notification Center

Where anything in the dashboard says *something happened that you were not looking at*. A
bell and a caret at the right-hand end of the top rail (`toolbar-right`, see
`src/types.ts` `ChartProSlot`), a dropdown listing what has arrived, and a model underneath
that no producer has to know about.

Today's only producer is [`client/alerts`](../alerts/README.md). It does not import this
module — it takes an `AlertNotifier` (`notify(spec)` and nothing else) and
`client/index.ts` hands it the centre. Any future producer should do the same.

## Pieces

| file | what it is |
|---|---|
| `types.ts` | `Notification`, `NotificationSpec`, and **`NotificationSink`** — the one-method interface a producer depends on. |
| `center.ts` | `NotificationCenter`: the newest-first, capped, age-bounded list, seen/unseen, `subscribe`. Plus the page singleton `notifications`. |
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

## Lifetimes

The **centre is a page-level singleton**, like `client/stream.ts`'s client. A workspace
switch tears the whole wall down and builds another (`client/index.ts` `remount`), and a
notification raised on the wall you just left is exactly the one you still need to see. The
**bell is per wall** — it is chrome in that wall's slot — and re-subscribes to the same
centre on mount.

The list is mirrored to `localStorage` (`wd.notifications`), capped at
`MAX_NOTIFICATIONS` and dropped after three days, so a reload does not lose the session's
alerts. It is deliberately **not** in `/preferences`: a notification is an event this device
observed, not a preference to sync. `seen` survives the reload too — an alert nobody has
looked at is exactly the one the bell should still be blinking about.

## Adding a producer

```ts
import { notifications } from '../notifications'
notifications.notify({ title: 'EURUSD reached 1.16500', body: '…', level: 'alert', source: 'alerts' })
```

…except from inside a feature module, which should take a `NotificationSink`-shaped
dependency instead and let `client/index.ts` supply the singleton. `source` is what
`clear(source)` works on, and what the row's tag shows.

Tests: `center.test.ts` (`bun test client/notifications`). `bell.ts` has none — bun has no
DOM, which is exactly why the list, the counting and the cap live in `center.ts`.
