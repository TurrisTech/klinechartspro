// The Delivery window: where this account's live notifications go beyond the dashboard. Opened
// from the bell's dropdown (client/index.ts hands the bell a "Delivery…" action when the server
// advertises `notification_channels`).
//
// One card per channel the SERVER lists, each built from the fields it publishes -- a password
// box for a secret (empty means "keep the saved one"), a select for choices, a Find button where
// the server can list values -- so nothing here knows what Pushover or Telegram need. Save stores
// and then asks the vendor whether it works (Check, which sends nothing); Send test sends a real
// message; the switch turns a saved channel on or off at once. Only the window is built here: the
// model is ./form.ts, the wire ./api.ts.
//
// Plain DOM in the house style (`kc-*` tokens, `wd-*` classes), like the bell beside it.

import { createDockableWindow, type DockableWindow } from '../../chrome/window'
import { configOf, describeDelivery, type Draft, draftOf, missing, secretIsSet, secretPlaceholder } from './form'
import type { ChannelAnswer, ChannelChoice, ChannelEntry, ChannelField, ChannelsApi } from './types'

const WINDOW_KEY = 'notification-delivery'
/** How long Remove waits for its second press. */
const CONFIRM_MS = 4_000

export interface ChannelSettingsOptions {
  api: ChannelsApi
  /** The element the window floats inside: `#app`. */
  bounds: HTMLElement
  now?: () => number
}

export interface ChannelSettingsWindow {
  open(): void
  close(): void
  readonly visible: boolean
  /** The window's card, once it has been opened. */
  readonly element: HTMLElement | null
  dispose(): void
}

interface Status {
  ok: boolean
  text: string
}

/** Everything one card holds between renders: the form, what the last button said, a Find's
 * answer, and whether a request is in flight. */
interface CardState {
  draft: Draft
  status: Status | null
  options: { field: string; choices: ChannelChoice[] } | null
  busy: boolean
  confirmRemove: boolean
}

export function createChannelSettings(options: ChannelSettingsOptions): ChannelSettingsWindow {
  const { api } = options
  const now = options.now ?? (() => Date.now())
  let entries: ChannelEntry[] | null = null
  let loadError: string | null = null
  const cards = new Map<string, CardState>()
  let confirmTimer: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  let made: DockableWindow | null = null
  function windowFor(): DockableWindow {
    if (made) return made
    made = createDockableWindow({
      key: WINDOW_KEY,
      className: 'wd-delivery-window',
      title: 'Delivery',
      bounds: options.bounds,
      theme: document.querySelector('.klinecharts-pro.dark') ? 'dark' : '',
      defaultMode: 'float',
      floatAnchor: 'center',
      floatSize: { width: 520, height: 620 },
      minSize: { width: 340, height: 240 },
      dockable: false,
      onClose: () => close()
    })
    made.setVisible(false)
    return made
  }

  async function load(): Promise<void> {
    try {
      adopt(await api.list())
      loadError = null
    } catch (err) {
      loadError = message(err)
    }
    render()
  }

  /** Take the server's list, keeping what each card is in the middle of (a typed value, a status
   * line) unless that card's channel was just saved, which `replace` resets. */
  function adopt(list: ChannelEntry[]): void {
    entries = list
    for (const entry of list) {
      if (!cards.has(entry.kind)) {
        cards.set(entry.kind, { draft: draftOf(entry), status: null, options: null, busy: false, confirmRemove: false })
      }
    }
  }

  function replace(entry: ChannelEntry): void {
    entries = (entries ?? []).map((existing) => (existing.kind === entry.kind ? entry : existing))
    const card = cards.get(entry.kind)
    if (card) {
      card.draft = draftOf(entry)
      card.options = null
    }
  }

  function render(): void {
    if (!made?.visible || disposed) return
    const body = made.body
    body.innerHTML = ''
    const root = el('div', 'wd-delivery')
    const intro = el('p', 'wd-delivery-intro')
    intro.textContent =
      'Live notifications (price watches, alerts and paper trade milestones) are also sent to every service switched on here. A bar replay never sends.'
    root.appendChild(intro)
    if (loadError) {
      const error = el('p', 'wd-delivery-status is-error')
      error.textContent = `Could not read the delivery settings: ${loadError}`
      root.appendChild(error)
    } else if (!entries) {
      const loading = el('p', 'wd-delivery-intro')
      loading.textContent = 'Loading…'
      root.appendChild(loading)
    } else {
      for (const entry of entries) root.appendChild(renderCard(entry))
    }
    body.appendChild(root)
  }

  function renderCard(entry: ChannelEntry): HTMLElement {
    const state = cards.get(entry.kind) as CardState
    const card = el('section', 'wd-delivery-card')
    card.dataset.kind = entry.kind

    const head = el('div', 'wd-delivery-head')
    const title = el('h3', 'wd-delivery-title')
    title.textContent = entry.title
    const badge = el('span', 'wd-delivery-badge')
    badge.textContent = !entry.setting ? 'Not set up' : entry.setting.enabled ? 'On' : 'Off'
    const toggle = switchButton(entry.setting ? entry.setting.enabled : state.draft.enabled, `Send to ${entry.title}`, () =>
      void onToggle(entry)
    )
    toggle.disabled = state.busy
    head.append(title, badge, toggle)
    card.appendChild(head)

    if (entry.help) {
      const help = el('p', 'wd-delivery-help')
      help.textContent = entry.help
      card.appendChild(help)
    }

    const save = button('kc-button wd-delivery-save', 'Save', () => void onSave(entry))
    const refresh = (): void => {
      save.disabled = state.busy || missing(entry, state.draft).length > 0
    }
    for (const field of entry.fields) card.appendChild(renderField(entry, field, state, refresh))

    const actions = el('div', 'wd-delivery-actions')
    const check = button('kc-button kc-button-outline', 'Check', () => void onCheck(entry))
    check.title = `Ask ${entry.title} whether these settings work, without sending anything`
    const test = button('kc-button kc-button-outline', 'Send test', () => void onTest(entry))
    test.title = 'Send a test message now'
    for (const b of [check, test]) b.disabled = state.busy || missing(entry, state.draft).length > 0
    actions.append(save, check, test)
    if (entry.setting) {
      const remove = button(
        'kc-button kc-button-outline wd-delivery-remove',
        state.confirmRemove ? 'Press again to remove' : 'Remove',
        () => void onRemove(entry)
      )
      remove.disabled = state.busy
      actions.appendChild(remove)
    }
    refresh()
    card.appendChild(actions)

    if (state.status) {
      const status = el('p', `wd-delivery-status ${state.status.ok ? 'is-ok' : 'is-error'}`)
      status.setAttribute('role', 'status')
      status.textContent = state.status.text
      card.appendChild(status)
    }
    const last = describeDelivery(entry.lastDelivery, now())
    if (last) {
      const line = el('p', `wd-delivery-last ${entry.lastDelivery?.ok ? '' : 'is-error'}`)
      line.textContent = last
      card.appendChild(line)
    }
    return card
  }

  function renderField(entry: ChannelEntry, field: ChannelField, state: CardState, refresh: () => void): HTMLElement {
    const row = el('div', 'wd-delivery-field')
    const id = `wd-delivery-${entry.kind}-${field.name}`
    const label = document.createElement('label')
    label.htmlFor = id
    label.textContent = field.required ? field.label : `${field.label} (optional)`
    row.appendChild(label)

    const line = el('div', 'wd-delivery-input')
    let control: HTMLInputElement | HTMLSelectElement
    if (field.choices.length > 0) {
      const select = document.createElement('select')
      select.className = 'kc-input'
      for (const choice of field.choices) {
        const option = document.createElement('option')
        option.value = choice.value
        option.textContent = choice.label
        select.appendChild(option)
      }
      select.value = state.draft.values[field.name] ?? field.default
      select.addEventListener('change', () => {
        state.draft.values[field.name] = select.value
        refresh()
      })
      control = select
    } else {
      const input = document.createElement('input')
      input.className = 'kc-input'
      input.type = field.secret ? 'password' : 'text'
      input.autocomplete = field.secret ? 'new-password' : 'off'
      input.spellcheck = false
      input.value = state.draft.values[field.name] ?? ''
      input.placeholder = field.secret ? secretPlaceholder(entry, field) : field.placeholder
      input.addEventListener('input', () => {
        state.draft.values[field.name] = input.value
        refresh()
      })
      control = input
    }
    control.id = id
    line.appendChild(control)
    if (field.discover) {
      const find = button('kc-button kc-button-outline wd-delivery-find', 'Find', () => void onDiscover(entry, field))
      find.title = `List the values ${entry.title} knows for ${field.label}`
      find.disabled = state.busy
      line.appendChild(find)
    }
    row.appendChild(line)

    if (field.help) {
      const help = el('small', 'wd-delivery-field-help')
      help.textContent = secretIsSet(entry, field) ? `${field.help} A value is saved.` : field.help
      row.appendChild(help)
    }

    if (state.options?.field === field.name && state.options.choices.length > 0) {
      const list = el('div', 'wd-delivery-options')
      for (const choice of state.options.choices) {
        const pick = button('kc-button kc-button-outline wd-delivery-option', `${choice.label} (${choice.value})`, () => {
          state.draft.values[field.name] = choice.value
          state.options = null
          render()
        })
        list.appendChild(pick)
      }
      row.appendChild(list)
    }
    return row
  }

  // -- the buttons ---------------------------------------------------------------------

  /** Run one request for a card: busy while it is in flight, its answer on the status line. */
  async function run(entry: ChannelEntry, work: (state: CardState) => Promise<Status | null>): Promise<void> {
    const state = cards.get(entry.kind)
    if (!state || state.busy) return
    state.busy = true
    state.status = null
    render()
    try {
      const status = await work(state)
      if (status) state.status = status
    } catch (err) {
      state.status = { ok: false, text: message(err) }
    } finally {
      state.busy = false
      render()
    }
  }

  function onSave(entry: ChannelEntry): Promise<void> {
    return run(entry, async (state) => {
      const saved = await api.save(entry.kind, state.draft.enabled, configOf(entry, state.draft))
      replace(saved)
      // Saved is not the same as working: ask the vendor straight away, sending nothing.
      const answer = await api.check(entry.kind)
      return { ok: answer.ok, text: answer.ok ? `Saved. ${answer.detail}` : `Saved, but ${entry.title} said: ${answer.detail}` }
    })
  }

  function onCheck(entry: ChannelEntry): Promise<void> {
    return run(entry, async (state) => said(await api.check(entry.kind, configOf(entry, state.draft))))
  }

  function onTest(entry: ChannelEntry): Promise<void> {
    return run(entry, async (state) => {
      const answer = await api.test(entry.kind, configOf(entry, state.draft))
      adopt(await api.list())
      return answer.ok ? { ok: true, text: `Test sent: ${answer.detail}` } : said(answer)
    })
  }

  function onDiscover(entry: ChannelEntry, field: ChannelField): Promise<void> {
    return run(entry, async (state) => {
      const answer = await api.discover(entry.kind, field.name, configOf(entry, state.draft))
      if (!answer.ok) return said(answer)
      state.options = { field: field.name, choices: answer.options }
      if (answer.options.length === 0) return { ok: false, text: `${answer.detail || 'Nothing found'}. Send your bot a message, then press Find again.` }
      return { ok: true, text: `Pick your ${field.label.toLowerCase()} below.` }
    })
  }

  function onToggle(entry: ChannelEntry): Promise<void> {
    const state = cards.get(entry.kind)
    if (!state) return Promise.resolve()
    if (!entry.setting) {
      // Nothing saved yet: the switch is part of the form, stored by Save.
      state.draft.enabled = !state.draft.enabled
      render()
      return Promise.resolve()
    }
    const enabled = !entry.setting.enabled
    return run(entry, async () => {
      // An empty edit: the server keeps every stored value and changes only the switch. Typed but
      // unsaved values stay in the form.
      const draft = state.draft
      const saved = await api.save(entry.kind, enabled, {})
      replace(saved)
      state.draft = { ...draft, enabled }
      return { ok: true, text: enabled ? `${entry.title} is on.` : `${entry.title} is off: nothing will be sent to it.` }
    })
  }

  function onRemove(entry: ChannelEntry): Promise<void> {
    const state = cards.get(entry.kind)
    if (!state) return Promise.resolve()
    if (!state.confirmRemove) {
      state.confirmRemove = true
      if (confirmTimer) clearTimeout(confirmTimer)
      confirmTimer = setTimeout(() => {
        state.confirmRemove = false
        render()
      }, CONFIRM_MS)
      render()
      return Promise.resolve()
    }
    state.confirmRemove = false
    if (confirmTimer) clearTimeout(confirmTimer)
    return run(entry, async () => {
      replace(await api.remove(entry.kind))
      return { ok: true, text: `Removed: nothing will be sent to ${entry.title}.` }
    })
  }

  // -- the window ----------------------------------------------------------------------

  function open(): void {
    if (disposed) return
    const win = windowFor()
    win.setVisible(true)
    render()
    void load()
  }

  function close(): void {
    made?.setVisible(false)
  }

  return {
    open,
    close,
    get visible() {
      return made?.visible ?? false
    },
    get element() {
      return made?.element ?? null
    },
    dispose(): void {
      disposed = true
      if (confirmTimer) clearTimeout(confirmTimer)
      made?.element.remove()
      made = null
    }
  }
}

function said(answer: ChannelAnswer): Status {
  return { ok: answer.ok, text: answer.detail }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function el(tag: string, className: string): HTMLElement {
  const node = document.createElement(tag)
  node.className = className
  return node
}

function button(className: string, text: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = className
  b.textContent = text
  b.addEventListener('click', onClick)
  return b
}

/** The library's `.kc-switch`, as client/chartlayers/settings.ts builds it. */
function switchButton(checked: boolean, label: string, onToggle: () => void): HTMLButtonElement {
  const b = document.createElement('button')
  b.type = 'button'
  b.className = 'kc-switch'
  b.setAttribute('role', 'switch')
  b.setAttribute('aria-label', label)
  b.setAttribute('aria-checked', String(checked))
  b.dataset.state = checked ? 'checked' : 'unchecked'
  b.appendChild(Object.assign(document.createElement('span'), { className: 'kc-switch-thumb' }))
  b.addEventListener('click', onToggle)
  return b
}
