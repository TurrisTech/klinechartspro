import { describe, expect, test } from 'bun:test'
import { installWindow } from '../plugins/testing'

installWindow()
const { RuleError } = await import('./rules')
const { ClientAlertStore, normaliseSymbol } = await import('./store')
import type { AlertPersistence } from './store'
import type { AlertDefinition, Operand } from './types'

const rsi: Operand = { kind: 'indicator', interval: '1h', name: 'RSI', params: [14], output: 'rsi1' }

/** One stored document, as the server or a browser's storage holds it, that any number of tabs
 * (`tab()`) read and write. Every write applies its edit to the document as it is then. */
function shared(initial?: unknown) {
  let document: unknown = structuredClone(initial)
  const saved: unknown[] = []
  return {
    saved,
    get document() {
      return document
    },
    tab(): AlertPersistence {
      return {
        load: async () => structuredClone(document),
        update: (apply, written) => {
          document = apply(structuredClone(document))
          saved.push(structuredClone(document))
          written(structuredClone(document))
        }
      }
    }
  }
}

function memory(initial?: unknown): AlertPersistence & { saved: unknown[] } {
  const store = shared(initial)
  return { ...store.tab(), saved: store.saved }
}

function definition(overrides: Partial<AlertDefinition> = {}): AlertDefinition {
  return {
    name: 'Oversold',
    note: '',
    enabled: true,
    symbol: 'OANDA:eurusd',
    rule: { left: rsi, op: 'crosses_below', right: { value: 30 } },
    trigger: 'level',
    repeat: 'always',
    cooldownMs: 0,
    ...overrides
  }
}

describe('ClientAlertStore', () => {
  test('creates, normalising the instrument, and saves at once', async () => {
    const persistence = memory()
    let clock = 1000
    const store = new ClientAlertStore(persistence, { now: () => clock })
    const alert = await store.create(definition())
    expect(alert.symbol).toBe('oanda:EURUSD')
    expect(alert.status).toBe('armed')
    expect(alert.armedAt).toBe(1000)
    expect(persistence.saved.length).toBe(1)
    clock = 2000
    await store.create(definition({ name: '' }))
    // Newest first, and an empty name becomes the rule read aloud.
    expect(store.list().map((a) => a.name)).toEqual(['RSI(14) rsi1 1h crosses below 30', 'Oversold'])
  })

  test('refuses a rule that could never be evaluated, and keeps nothing', async () => {
    const persistence = memory()
    const store = new ClientAlertStore(persistence)
    await expect(store.create(definition({ rule: { all: [] } }))).rejects.toThrow(RuleError)
    await expect(store.create(definition({ symbol: 'EURUSD' }))).rejects.toThrow(RuleError)
    expect(store.list()).toEqual([])
    expect(persistence.saved.length).toBe(0)
  })

  test('a once alert stays fired until re-armed; a change to its rule re-arms it', async () => {
    let clock = 0
    const store = new ClientAlertStore(memory(), { now: () => clock })
    const { id } = await store.create(definition({ repeat: 'once' }))
    store.recordFiring(id, 5_000)
    expect(store.get(id)).toMatchObject({ status: 'fired', fireCount: 1, lastFiredAt: 5_000 })
    clock = 9
    await store.update(id, definition({ repeat: 'once', name: 'renamed' }))
    // A rename is not a new question.
    expect(store.get(id)?.status).toBe('fired')
    await store.update(id, definition({ repeat: 'once', rule: { left: rsi, op: 'crosses_below', right: { value: 25 } } }))
    expect(store.get(id)).toMatchObject({ status: 'armed', armedAt: 9, fireCount: 1 })
  })

  test('disabled reads as disabled; enabling re-arms', async () => {
    const store = new ClientAlertStore(memory())
    const { id } = await store.create(definition({ repeat: 'once' }))
    store.recordFiring(id, 1)
    await store.setEnabled(id, false)
    expect(store.get(id)?.status).toBe('disabled')
    expect(store.enabledOn('oanda:EURUSD')).toEqual([])
    await store.setEnabled(id, true)
    expect(store.get(id)?.status).toBe('armed')
    expect(store.enabledOn('oanda:EURUSD').length).toBe(1)
    // Every enabled one, on any instrument: what a replay's Next alert stops at.
    await store.create({ ...definition({ repeat: 'once' }), symbol: 'oanda:EURGBP' })
    expect(store.enabled().map((a) => a.symbol).sort()).toEqual(['oanda:EURGBP', 'oanda:EURUSD'])
    await store.setEnabled(id, false)
    expect(store.enabled().map((a) => a.symbol)).toEqual(['oanda:EURGBP'])
  })

  test('round-trips through its persistence, dropping a row that no longer reads', async () => {
    const first = memory()
    const store = new ClientAlertStore(first)
    await store.create(definition())
    const document = first.saved.at(-1) as { alerts: unknown[] }
    const broken = { ...(document.alerts[0] as object), id: 'broken', rule: { all: [] } }
    const again = memory({ ...document, alerts: [...document.alerts, broken] })
    const reloaded = new ClientAlertStore(again)
    await reloaded.load()
    expect(reloaded.list().map((a) => a.name)).toEqual(['Oversold'])
    expect(reloaded.list()[0].rule).toEqual(definition().rule)
    // Not shown, but not deleted either: a newer client's alert survives this one's writes.
    await reloaded.create(definition({ name: 'Second' }))
    expect((again.saved.at(-1) as { alerts: Array<{ id: string }> }).alerts.map((a) => a.id)).toContain('broken')
  })

  test('a store that could not be read refuses to write, so it cannot overwrite what is stored', async () => {
    const saved: unknown[] = []
    const store = new ClientAlertStore({
      load: async () => {
        throw new Error('503')
      },
      update: (apply) => void saved.push(apply(undefined))
    })
    await store.load()
    expect(store.loadError).toContain('could not be read')
    await expect(store.create(definition())).rejects.toThrow(RuleError)
    expect(saved).toEqual([])
  })

  test('remove, and listeners hear every change', async () => {
    const store = new ClientAlertStore(memory())
    let heard = 0
    store.subscribe(() => heard++)
    const { id } = await store.create(definition())
    await store.remove(id)
    expect(store.list()).toEqual([])
    expect(heard).toBe(2)
  })
})

test('normaliseSymbol', () => {
  expect(normaliseSymbol(' Coinbase:btcusd ')).toBe('coinbase:BTCUSD')
  expect(() => normaliseSymbol('BTCUSD')).toThrow(RuleError)
  expect(() => normaliseSymbol('oanda:')).toThrow(RuleError)
})

// Every tab and device writes the one stored list: each write is an edit by id on the list as
// it is stored then, never this tab's copy of the whole list.
describe('several tabs on one stored list', () => {
  async function twoTabs() {
    const store = shared()
    const a = new ClientAlertStore(store.tab(), { now: () => 1000 })
    await a.load()
    const first = await a.create(definition({ name: 'First' }))
    const b = new ClientAlertStore(store.tab(), { now: () => 2000 })
    await b.load()
    return { store, a, b, first }
  }
  const storedRows = (store: { document: unknown }) => (store.document as { alerts: Array<{ id: string; name: string; enabled: boolean; fireCount: number }> }).alerts

  test("a firing in a tab that has not seen another tab's new alert keeps it", async () => {
    const { store, a, b, first } = await twoTabs()
    await b.create(definition({ name: 'Made in B' }))
    a.recordFiring(first.id, 5000)
    expect(storedRows(store).map((r) => r.name).sort()).toEqual(['First', 'Made in B'])
    // And the stale tab has caught up: it shows what the other made.
    expect(a.list().map((x) => x.name).sort()).toEqual(['First', 'Made in B'])
  })

  test('a firing in a stale tab does not switch back on an alert switched off elsewhere', async () => {
    const { store, a, b, first } = await twoTabs()
    await b.setEnabled(first.id, false)
    a.recordFiring(first.id, 5000)
    expect(storedRows(store)[0]).toMatchObject({ enabled: false, fireCount: 0 })
    expect(a.get(first.id)?.status).toBe('disabled')
  })

  test('one bar close seen by two tabs is one firing', async () => {
    const { store, a, b, first } = await twoTabs()
    a.recordFiring(first.id, 5000)
    b.recordFiring(first.id, 5000)
    expect(storedRows(store)[0].fireCount).toBe(1)
    b.recordFiring(first.id, 6000)
    expect(storedRows(store)[0].fireCount).toBe(2)
  })

  test('an alert deleted elsewhere is not brought back by a firing or an edit', async () => {
    const { store, a, b, first } = await twoTabs()
    await b.remove(first.id)
    a.recordFiring(first.id, 5000)
    expect(storedRows(store)).toEqual([])
    expect(a.list()).toEqual([])
  })

  test("an edit changes its own alert and leaves the others' as they are stored", async () => {
    const { store, a, b, first } = await twoTabs()
    const other = await b.create(definition({ name: 'Made in B' }))
    await b.setEnabled(other.id, false)
    await a.update(first.id, definition({ name: 'Renamed in A' }))
    const rows = storedRows(store)
    expect(rows.find((r) => r.id === first.id)?.name).toBe('Renamed in A')
    expect(rows.find((r) => r.id === other.id)).toMatchObject({ name: 'Made in B', enabled: false })
  })
})
