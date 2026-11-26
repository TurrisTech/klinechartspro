import { expect, test } from 'bun:test'
import { configOf, describeDelivery, draftOf, hasUnsaved, missing, secretPlaceholder } from './form'
import type { ChannelEntry } from './types'

// The Delivery form's model: what the inputs start as, what blocks a save, what is sent. The
// rule that matters most: a secret is never shown, and leaving it empty keeps the saved one.

const field = (name: string, over: Partial<ChannelEntry['fields'][number]> = {}): ChannelEntry['fields'][number] => ({
  name,
  label: name,
  required: true,
  secret: false,
  help: '',
  placeholder: '',
  choices: [],
  default: '',
  discover: false,
  ...over
})

const PUSHOVER: ChannelEntry = {
  kind: 'pushover',
  title: 'Pushover',
  help: '',
  fields: [
    field('token', { label: 'Application token', secret: true, placeholder: 'azGD…' }),
    field('user', { label: 'User key', secret: true }),
    field('device', { label: 'Device', required: false }),
    field('priority', { label: 'Priority', default: '0', choices: [{ value: '0', label: 'Normal' }] })
  ],
  setting: null,
  lastDelivery: null
}

const SAVED: ChannelEntry = {
  ...PUSHOVER,
  setting: { enabled: false, config: { device: 'phone', priority: '0' }, secrets: ['token', 'user'], updatedAt: 1 }
}

test('a new channel starts on, empty but for its defaults', () => {
  expect(draftOf(PUSHOVER)).toEqual({ enabled: true, values: { token: '', user: '', device: '', priority: '0' } })
})

test('a saved channel starts with its values and its secrets empty', () => {
  expect(draftOf(SAVED)).toEqual({ enabled: false, values: { token: '', user: '', device: 'phone', priority: '0' } })
})

test('a required secret is missing until typed, unless one is saved', () => {
  expect(missing(PUSHOVER, draftOf(PUSHOVER))).toEqual(['Application token', 'User key'])
  const typed = draftOf(PUSHOVER)
  typed.values.token = ' abc '
  expect(missing(PUSHOVER, typed)).toEqual(['User key'])
  expect(missing(SAVED, draftOf(SAVED))).toEqual([])
})

test('what is sent leaves an empty secret out and trims the rest', () => {
  const draft = draftOf(SAVED)
  draft.values.device = ' desk '
  expect(configOf(SAVED, draft)).toEqual({ device: 'desk', priority: '0' })
  draft.values.user = 'new-user'
  expect(configOf(SAVED, draft)).toEqual({ user: 'new-user', device: 'desk', priority: '0' })
})

test('a saved secret says it is saved instead of showing an example', () => {
  expect(secretPlaceholder(PUSHOVER, PUSHOVER.fields[0])).toBe('azGD…')
  expect(secretPlaceholder(SAVED, SAVED.fields[0])).toBe('Saved. Leave empty to keep it.')
})

test('a delivery reads as what happened and how long ago', () => {
  const now = 10_000_000
  expect(describeDelivery(null, now)).toBe('')
  expect(describeDelivery({ at: now - 5_000, ok: true, detail: 'sent (r)', title: 'RSI alert' }, now)).toBe(
    'Last sent just now: RSI alert'
  )
  expect(describeDelivery({ at: now - 3 * 60_000, ok: false, detail: 'Pushover refused (400): user key is invalid', title: 't' }, now)).toBe(
    'Last delivery failed 3 min ago: Pushover refused (400): user key is invalid'
  )
  expect(describeDelivery({ at: now - 5 * 3_600_000, ok: true, detail: '', title: 't' }, now)).toBe('Last sent 5 h ago: t')
})

test('unsaved: anything typed that the saved setting does not hold', () => {
  expect(hasUnsaved(PUSHOVER, draftOf(PUSHOVER))).toBe(true)
  const draft = draftOf(SAVED)
  expect(hasUnsaved(SAVED, draft)).toBe(false)
  draft.values.token = 'new'
  expect(hasUnsaved(SAVED, draft)).toBe(true)
  const changed = draftOf(SAVED)
  changed.values.device = 'desk'
  expect(hasUnsaved(SAVED, changed)).toBe(true)
})
