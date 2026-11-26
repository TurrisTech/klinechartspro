// Delivery channels on the client: the Delivery window that sets up where this account's live
// notifications go beyond the dashboard (Pushover, Telegram). The sending itself is the
// server's (wdashboard-server `notify/channels`); this module only edits the settings, built from
// the fields the server publishes. See ./README.md.

export { HttpChannelsApi } from './api'
export { createChannelSettings } from './dialog'
