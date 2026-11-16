import { afterAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

// THE DELIVERY WINDOW in a real DOM (happy-dom), driven by clicks and typed values over a fake
// server: set Telegram up with Find, save (which checks), send a test, switch it off, remove it.
// The fake answers like the server does -- secrets never come back, an empty secret keeps the
// stored one.

GlobalRegistrator.register({ url: 'http://test/' })
afterAll(() => GlobalRegistrator.unregister())

const { createChannelSettings } = await import('./dialog')
import type { ChannelAnswer, ChannelEntry, ChannelsApi, DiscoverAnswer } from './types'

const FIELDS: Record<string, ChannelEntry['fields']> = {
  pushover: [
    { name: 'token', label: 'Application token', required: true, secret: true, help: 'From pushover.net.', placeholder: '', choices: [], default: '', discover: false },
    { name: 'user', label: 'User key', required: true, secret: true, help: '', placeholder: '', choices: [], default: '', discover: false },
    {
      name: 'priority',
      label: 'Priority',
      required: true,
      secret: false,
      help: '',
      placeholder: '',
      choices: [
        { value: '0', label: 'Normal' },
        { value: '1', label: 'High' }
      ],
      default: '0',
      discover: false
    }
  ],
  telegram: [
    { name: 'bot_token', label: 'Bot token', required: true, secret: true, help: '', placeholder: '', choices: [], default: '', discover: false },
    { name: 'chat_id', label: 'Chat id', required: true, secret: false, help: '', placeholder: '', choices: [], default: '', discover: true }
  ]
}

/** A server in memory, as `/notifications/channels` behaves, recording every call. */
function fakeServer() {
  const stored: Record<string, { enabled: boolean; config: Record<string, string> }> = {}
  const calls: Array<[string, ...unknown[]]> = []
  const entry = (kind: string): ChannelEntry => {
    const s = stored[kind]
    const secrets = FIELDS[kind].filter((f) => f.secret && s?.config[f.name]).map((f) => f.name)
    const shown = Object.fromEntries(Object.entries(s?.config ?? {}).filter(([k]) => !FIELDS[kind].find((f) => f.name === k)?.secret))
    return {
      kind,
      title: kind === 'pushover' ? 'Pushover' : 'Telegram',
      help: `Set up ${kind}.`,
      fields: FIELDS[kind],
      setting: s ? { enabled: s.enabled, config: shown, secrets, updatedAt: 1 } : null,
      lastDelivery: calls.some(([name, kind_]) => name === 'test' && kind_ === kind)
        ? { at: Date.now(), ok: true, detail: 'sent (message 3)', title: 'Test from the dashboard' }
        : null
    }
  }
  const api: ChannelsApi = {
    list: async () => {
      calls.push(['list'])
      return ['pushover', 'telegram'].map(entry)
    },
    save: async (kind, enabled, config) => {
      calls.push(['save', kind, enabled, config])
      const merged = { ...(stored[kind]?.config ?? {}) }
      for (const [k, v] of Object.entries(config)) if (v !== '' || !FIELDS[kind].find((f) => f.name === k)?.secret) merged[k] = v
      stored[kind] = { enabled, config: merged }
      return entry(kind)
    },
    remove: async (kind) => {
      calls.push(['remove', kind])
      delete stored[kind]
      return entry(kind)
    },
    check: async (kind, config): Promise<ChannelAnswer> => {
      calls.push(['check', kind, config])
      return { ok: true, detail: '@alerts_bot can write to Ann' }
    },
    test: async (kind, config): Promise<ChannelAnswer> => {
      calls.push(['test', kind, config])
      return { ok: true, detail: 'sent (message 3)' }
    },
    discover: async (kind, field, config): Promise<DiscoverAnswer> => {
      calls.push(['discover', kind, field, config])
      return { ok: true, detail: '', options: [{ value: '424242', label: 'Ann' }] }
    }
  }
  return { api, stored, calls }
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

async function mount() {
  const server = fakeServer()
  const bounds = document.createElement('div')
  document.body.appendChild(bounds)
  const dialog = createChannelSettings({ api: server.api, bounds })
  dialog.open()
  await settle()
  const root = dialog.element as HTMLElement
  const card = (kind: string) => root.querySelector(`[data-kind="${kind}"]`) as HTMLElement
  const press = async (kind: string, label: string) => {
    const b = [...card(kind).querySelectorAll('button')].find((x) => x.textContent === label) as HTMLButtonElement
    expect(b).toBeDefined()
    b.click()
    await settle()
    await settle()
  }
  const type = (kind: string, field: string, value: string) => {
    const input = root.querySelector(`#wd-delivery-${kind}-${field}`) as HTMLInputElement
    input.value = value
    input.dispatchEvent(new Event('input'))
  }
  return { dialog, server, root, card, press, type }
}

test('every channel the server lists is a card built from its fields', async () => {
  const { root, card } = await mount()
  expect([...root.querySelectorAll('.wd-delivery-card')].map((c) => (c as HTMLElement).dataset.kind)).toEqual(['pushover', 'telegram'])
  expect((root.querySelector('#wd-delivery-pushover-token') as HTMLInputElement).type).toBe('password')
  expect((root.querySelector('#wd-delivery-pushover-priority') as HTMLSelectElement).value).toBe('0')
  expect(card('telegram').querySelector('.wd-delivery-badge')?.textContent).toBe('Not set up')
  expect(root.textContent).toContain('A bar replay never sends.')
  const buttons = () => [...card('telegram').querySelectorAll('button')].filter((b) => ['Save', 'Check', 'Send test'].includes(b.textContent ?? ''))
  expect(buttons().map((b) => b.disabled)).toEqual([true, true, true])
  // Typing re-enables all three, without a re-render (which would take the focus away).
  const token = root.querySelector('#wd-delivery-telegram-bot_token') as HTMLInputElement
  token.value = '123:SECRET'
  token.dispatchEvent(new Event('input'))
  const chat = root.querySelector('#wd-delivery-telegram-chat_id') as HTMLInputElement
  chat.value = '1'
  chat.dispatchEvent(new Event('input'))
  expect(buttons().map((b) => b.disabled)).toEqual([false, false, false])
  expect(document.activeElement === chat || root.contains(chat)).toBe(true)
})

test('Telegram: Find picks the chat, Save stores and checks, and the token is never shown', async () => {
  const { root, server, card, press, type } = await mount()
  type('telegram', 'bot_token', '123:SECRET')
  await press('telegram', 'Find')
  expect(server.calls.find((c) => c[0] === 'discover')).toEqual(['discover', 'telegram', 'chat_id', { bot_token: '123:SECRET', chat_id: '' }])
  await press('telegram', 'Ann (424242)')
  expect((root.querySelector('#wd-delivery-telegram-chat_id') as HTMLInputElement).value).toBe('424242')
  await press('telegram', 'Save')
  expect(server.stored.telegram).toEqual({ enabled: true, config: { bot_token: '123:SECRET', chat_id: '424242' } })
  expect(server.calls.filter((c) => c[0] === 'check')).toEqual([['check', 'telegram', undefined]])
  expect(card('telegram').querySelector('.wd-delivery-status')?.textContent).toBe('Saved. @alerts_bot can write to Ann')
  expect(card('telegram').querySelector('.wd-delivery-badge')?.textContent).toBe('On')
  const token = root.querySelector('#wd-delivery-telegram-bot_token') as HTMLInputElement
  expect(token.value).toBe('')
  expect(token.placeholder).toBe('Saved. Leave empty to keep it.')
  expect(root.innerHTML).not.toContain('SECRET')
})

test('an edit that leaves a saved secret empty keeps it', async () => {
  const { root, server, press, type } = await mount()
  type('pushover', 'token', 'app-token')
  type('pushover', 'user', 'user-key')
  await press('pushover', 'Save')
  const select = root.querySelector('#wd-delivery-pushover-priority') as HTMLSelectElement
  select.value = '1'
  select.dispatchEvent(new Event('change'))
  await press('pushover', 'Save')
  expect(server.calls.filter((c) => c[0] === 'save').at(-1)).toEqual(['save', 'pushover', true, { priority: '1' }])
  expect(server.stored.pushover.config).toEqual({ token: 'app-token', user: 'user-key', priority: '1' })
})

test('Send test sends and the last delivery appears', async () => {
  const { card, press, type } = await mount()
  type('telegram', 'bot_token', '123:SECRET')
  type('telegram', 'chat_id', '424242')
  await press('telegram', 'Save')
  await press('telegram', 'Send test')
  expect(card('telegram').querySelector('.wd-delivery-status')?.textContent).toBe('Test sent: sent (message 3)')
  expect(card('telegram').querySelector('.wd-delivery-last')?.textContent).toBe('Last sent just now: Test from the dashboard')
})

test('the switch turns a saved channel off at once, keeping its credentials', async () => {
  const { server, card, type, press } = await mount()
  type('telegram', 'bot_token', '123:SECRET')
  type('telegram', 'chat_id', '424242')
  await press('telegram', 'Save')
  ;(card('telegram').querySelector('.kc-switch') as HTMLButtonElement).click()
  await settle()
  await settle()
  expect(server.calls.filter((c) => c[0] === 'save').at(-1)).toEqual(['save', 'telegram', false, {}])
  expect(server.stored.telegram).toEqual({ enabled: false, config: { bot_token: '123:SECRET', chat_id: '424242' } })
  expect(card('telegram').querySelector('.wd-delivery-badge')?.textContent).toBe('Off')
})

test('Remove needs a second press', async () => {
  const { server, card, type, press } = await mount()
  type('telegram', 'bot_token', '123:SECRET')
  type('telegram', 'chat_id', '424242')
  await press('telegram', 'Save')
  await press('telegram', 'Remove')
  expect(server.stored.telegram).toBeDefined()
  await press('telegram', 'Press again to remove')
  expect(server.stored.telegram).toBeUndefined()
  expect(card('telegram').querySelector('.wd-delivery-badge')?.textContent).toBe('Not set up')
})

test('a server error is shown on the card', async () => {
  const { server, card, type, press } = await mount()
  server.api.save = async () => {
    throw new Error('Chat id is required')
  }
  type('telegram', 'bot_token', '123:SECRET')
  type('telegram', 'chat_id', '1')
  await press('telegram', 'Save')
  const status = card('telegram').querySelector('.wd-delivery-status') as HTMLElement
  expect(status.textContent).toBe('Chat id is required')
  expect(status.className).toContain('is-error')
})

test('reopening the window starts from the server, not from the last visit', async () => {
  const { dialog, card, press, type } = await mount()
  type('telegram', 'bot_token', '123:SECRET')
  type('telegram', 'chat_id', '424242')
  await press('telegram', 'Check')
  expect(card('telegram').querySelector('.wd-delivery-status')).not.toBeNull()
  dialog.close()
  dialog.open()
  await settle()
  expect(card('telegram').querySelector('.wd-delivery-status')).toBeNull()
  expect((card('telegram').querySelector('#wd-delivery-telegram-chat_id') as HTMLInputElement).value).toBe('')
})
