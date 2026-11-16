// The wire of `/notifications/channels` (wdashboard-server `notify/channels/api.py`, its doc
// `docs/notification-channels.md`): where an owner's live notifications are delivered beyond the
// dashboard -- Pushover, Telegram. Everything a form needs is published by the server, so a new
// channel there needs no change here.

export interface ChannelChoice {
  value: string
  label: string
}

/** One setting a channel needs. A `secret` is write-only: the server never returns it, only that
 * it is set, and an edit that leaves one empty keeps the stored value. `discover` means the
 * server can list candidate values for it (Telegram's chat id). */
export interface ChannelField {
  name: string
  label: string
  required: boolean
  secret: boolean
  help: string
  placeholder: string
  choices: ChannelChoice[]
  default: string
  discover: boolean
}

/** This owner's setting: the non-secret values, and the NAMES of the secrets that are set. */
export interface ChannelSetting {
  enabled: boolean
  config: Record<string, string>
  secrets: string[]
  updatedAt: number
}

/** The last send since the server started, test sends included. */
export interface ChannelDelivery {
  at: number
  ok: boolean
  detail: string
  title: string
}

export interface ChannelEntry {
  kind: string
  title: string
  /** How to set it up: where the user gets each value. */
  help: string
  fields: ChannelField[]
  setting: ChannelSetting | null
  lastDelivery: ChannelDelivery | null
}

/** A vendor's answer. A refusal is `ok: false` with what the vendor said, not an error. */
export interface ChannelAnswer {
  ok: boolean
  detail: string
}

export interface DiscoverAnswer extends ChannelAnswer {
  options: ChannelChoice[]
}

/** What the dialog needs of the server; `./api.ts` is the HTTP one, a test supplies a fake. The
 * `config` of check, test and discover is laid over the stored one by the server, so a form can
 * try what it holds before saving it. */
export interface ChannelsApi {
  list(): Promise<ChannelEntry[]>
  save(kind: string, enabled: boolean, config: Record<string, string>): Promise<ChannelEntry>
  remove(kind: string): Promise<ChannelEntry>
  check(kind: string, config?: Record<string, string>): Promise<ChannelAnswer>
  test(kind: string, config?: Record<string, string>): Promise<ChannelAnswer>
  discover(kind: string, field: string, config?: Record<string, string>): Promise<DiscoverAnswer>
}
