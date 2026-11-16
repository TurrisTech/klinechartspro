# client/notifications/channels — the Delivery window

Where this account's **live** notifications go beyond the dashboard: **Pushover** and
**Telegram**. The sending is the server's (`wdashboard-server` `notify/channels`, its doc
`docs/notification-channels.md`), and so is the list of channels and the fields each needs. This
module only edits each account's settings, through `/notifications/channels`.

Opened from the bell's dropdown (**Delivery…**), which `client/index.ts` adds when the server
advertises `notification_channels`. The bell knows only a label and a click (`BellAction`).

## What goes out

Every notification the server raises for the account, to each channel switched on:

- a price watch or level alert firing (`watch`), with or without a tab open;
- a paper trade reaching a "Notify at" milestone (`trade`);
- a client alert firing on the live market (`alert`), posted to the server by
  `../durable.ts`.

A **bar replay never sends**. Its notifications are about a past market. It raises them into
the centre directly, `durableSink` refuses to post a `replay` row, and the server refuses one too.

## Pieces

| file | what it is |
|---|---|
| `types.ts` | the wire, and `ChannelsApi` (what the window needs of the server) |
| `api.ts` | `HttpChannelsApi`, owner-scoped like every `/notifications` call |
| `form.ts` | the form's model, with no DOM: the initial values, what is missing, what a save sends, how a delivery reads |
| `dialog.ts` | `createChannelSettings`: the window, one card per channel, built from the server's field descriptors |

## The rules a card follows

- **A secret is never shown.** The server returns only which secrets are set. The password box
  starts empty with "Saved. Leave empty to keep it.", and an empty secret is left out of what is
  sent, so the server keeps the stored one.
- **Save stores, then checks.** After a save the card asks the vendor whether the settings work
  (`check`, which sends nothing) and says what it answered.
- **Check, Send test and Find use what the form holds**, saved or not. The server lays it over
  the stored setting, so Find can list Telegram chats before anything is saved.
- **The switch acts at once on a saved channel** (an empty edit: only `enabled` changes). On a
  channel not yet saved it is part of the form.
- **Remove takes a second press.**
- A vendor's refusal is the card's status line, in red. The last delivery since the server
  started (`lastDelivery`) is shown under it, so a failing token is visible here rather than only
  in a pod log.

Tests: `form.test.ts` (bun), `dialog.test.ts` (happy-dom, against a fake server that answers as
the real one does).
