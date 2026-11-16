// The settings form's model, apart from the DOM so bun can test it: what a channel's inputs start
// as, what is missing, what a save sends, and how a delivery reads.

import type { ChannelDelivery, ChannelEntry, ChannelField } from './types'

/** What the form holds for one channel: the switch and every field's typed value. A secret starts
 * empty -- the form never has the stored one -- and empty means "keep it". */
export interface Draft {
  enabled: boolean
  values: Record<string, string>
}

export function draftOf(entry: ChannelEntry): Draft {
  const values: Record<string, string> = {}
  for (const field of entry.fields) {
    values[field.name] = field.secret ? '' : (entry.setting?.config[field.name] ?? field.default)
  }
  return { enabled: entry.setting?.enabled ?? true, values }
}

export function secretIsSet(entry: ChannelEntry, field: ChannelField): boolean {
  return field.secret && (entry.setting?.secrets.includes(field.name) ?? false)
}

/** The labels of required fields that have no value: typed, or (a secret) already stored. */
export function missing(entry: ChannelEntry, draft: Draft): string[] {
  return entry.fields
    .filter((field) => field.required && !draft.values[field.name]?.trim() && !secretIsSet(entry, field))
    .map((field) => field.label)
}

/** What a save, check, test or discover sends: every value, trimmed. A secret left empty is left
 * out, and the server keeps the stored one. */
export function configOf(entry: ChannelEntry, draft: Draft): Record<string, string> {
  const config: Record<string, string> = {}
  for (const field of entry.fields) {
    const value = (draft.values[field.name] ?? '').trim()
    if (field.secret && !value) continue
    config[field.name] = value
  }
  return config
}

/** What the password box shows when the form has nothing typed. */
export function secretPlaceholder(entry: ChannelEntry, field: ChannelField): string {
  return secretIsSet(entry, field) ? 'Saved. Leave empty to keep it.' : field.placeholder
}

/** "Last sent 3 min ago: sent (r-1)" / "Last delivery failed 2 h ago: invalid token". */
export function describeDelivery(delivery: ChannelDelivery | null, now = Date.now()): string {
  if (!delivery) return ''
  const when = ago(delivery.at, now)
  return delivery.ok ? `Last sent ${when}: ${delivery.title}` : `Last delivery failed ${when}: ${delivery.detail}`
}

function ago(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `${hours} h ago`
  return `${Math.round(hours / 24)} days ago`
}
