import { describe, expect, test } from 'bun:test'
import { installWindow } from '../plugins/testing'

installWindow()
const { RuleError } = await import('./rules')
const { ClientAlertStore, normaliseSymbol } = await import('./store')
import type { AlertPersistence } from './store'
import type { AlertDefinition, Operand } from './types'

const rsi: Operand = { kind: 'indicator', interval: '1h', name: 'RSI', params: [14], output: 'rsi1' }

function memory(initial?: unknown): AlertPersistence & { saved: unknown[] } {
  const saved: unknown[] = []
  return {
    saved,
    load: async () => initial,
    save: (document) => {
      saved.push(structuredClone(document))
    }
  }
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
  })

  test('round-trips through its persistence, dropping a row that no longer reads', async () => {
    const first = memory()
    const store = new ClientAlertStore(first)
    await store.create(definition())
    const document = first.saved.at(-1) as { alerts: unknown[] }
    const broken = { ...(document.alerts[0] as object), id: 'broken', rule: { all: [] } }
    const reloaded = new ClientAlertStore(memory({ ...document, alerts: [...document.alerts, broken] }))
    await reloaded.load()
    expect(reloaded.list().map((a) => a.name)).toEqual(['Oversold'])
    expect(reloaded.list()[0].rule).toEqual(definition().rule)
  })

  test('a store that could not be read refuses to write, so it cannot overwrite what is stored', async () => {
    const saved: unknown[] = []
    const store = new ClientAlertStore({
      load: async () => {
        throw new Error('503')
      },
      save: (document) => saved.push(document)
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
