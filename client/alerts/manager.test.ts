import { afterAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

// THE MANAGER AND THE EDITOR, in a real DOM (happy-dom), driven by clicks and typed values,
// over a store with an in-memory persistence. What a user does: write a simple alert, make it
// compound, switch it off, delete it.

GlobalRegistrator.register({ url: 'http://test/' })
afterAll(() => GlobalRegistrator.unregister())

const { createAlertManager } = await import('./manager')
const { ClientAlertStore } = await import('./store')
const { toEditable, fromEditable } = await import('./editable')
import type { Rule } from './types'

const NO_SERVER = async () => ({
  stored: [],
  signals: [{ plugin: 'arev', variant: 'arev21', title: 'AREV arev21', labels: [{ id: 'long', label: 'Long', side: 'long' }, { id: 'short', label: 'Short', side: 'short' }] }]
})

function mount() {
  const saved: unknown[] = []
  const store = new ClientAlertStore({ load: async () => undefined, save: (d) => saved.push(d) })
  const bounds = document.createElement('div')
  document.body.appendChild(bounds)
  const manager = createAlertManager({
    store,
    bounds,
    context: () => ({ symbol: 'oanda:EURUSD', interval: '1h', symbols: ['oanda:EURUSD'] }),
    catalogue: NO_SERVER
  })
  const root = manager.element
  const buttons = (): HTMLButtonElement[] => [...root.querySelectorAll('button')] as HTMLButtonElement[]
  const button = (text: string): HTMLButtonElement => {
    const found = buttons().find((b) => (b.textContent ?? '').trim() === text)
    if (!found) throw new Error(`no button '${text}' in: ${buttons().map((b) => b.textContent).join(' | ')}`)
    return found
  }
  const change = (el: HTMLSelectElement | HTMLInputElement, value: string): void => {
    el.value = value
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }
  return { store, manager, root, button, buttons, change, saved }
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

describe('the alert manager', () => {
  test('says what an alert is when there are none, and that server alerts are not built', async () => {
    const m = mount()
    m.manager.open()
    expect(m.root.textContent).toContain('No alerts yet')
    m.button('Server').click()
    expect(m.root.textContent).toContain('not built yet')
    expect(m.root.textContent).toContain('price watch')
  })

  test('a simple alert: the default condition, a value typed, saved as one condition', async () => {
    const m = mount()
    m.manager.create()
    await settle()
    const sentence = (): string => m.root.querySelector('.wd-alert-sentence')?.textContent ?? ''
    expect(sentence()).toBe('RSI(14) 1h crosses below 30')
    const value = m.root.querySelector('.wd-alert-number') as HTMLInputElement
    value.value = '25'
    value.dispatchEvent(new Event('input', { bubbles: true }))
    // The sentence follows the typing without a re-render taking the focus away.
    expect(m.root.querySelector('.wd-alert-number')).toBe(value)
    expect(sentence()).toBe('RSI(14) 1h crosses below 25')
    m.button('Create alert').click()
    await settle()
    const [alert] = m.store.list()
    expect(alert.symbol).toBe('oanda:EURUSD')
    expect(alert.name).toBe('RSI(14) 1h crosses below 25')
    // Simple: stored as the one condition, not a group of one.
    expect(alert.rule).toEqual({ left: { kind: 'indicator', interval: '1h', name: 'RSI', params: [14], output: 'rsi1' }, op: 'crosses_below', right: { value: 25 } })
    // Back on the list.
    expect(m.root.querySelector('.wd-alert-row')).not.toBeNull()
  })

  test('a compound alert: a second condition comparing two series, and a group of signals', async () => {
    const m = mount()
    m.manager.create()
    await settle()
    m.button('+ Condition').click()
    const leaves = (): HTMLElement[] => [...m.root.querySelectorAll('.wd-alert-leaf')] as HTMLElement[]
    expect(leaves().length).toBe(2)
    // Second row: Close crosses above the series (defaults to its MA(20)).
    const second = leaves()[1]
    m.change(second.querySelector('.wd-alert-source') as HTMLSelectElement, 'bar:close')
    m.change(leaves()[1].querySelector('.wd-alert-op') as HTMLSelectElement, 'crosses_above')
    m.change(leaves()[1].querySelector('[aria-label="Compare with"]') as HTMLSelectElement, 'series')
    // A group of one signal condition under "any".
    m.button('+ Group').click()
    const nested = m.root.querySelector('.wd-alert-group.is-nested') as HTMLElement
    m.change(nested.querySelector('.wd-alert-source') as HTMLSelectElement, 'sig:arev/arev21')
    expect(m.root.querySelector('.wd-alert-sentence')?.textContent).toBe(
      'RSI(14) 1h crosses below 30 and Close 1h crosses above MA(20) 1h and AREV arev21 signal 1h is long'
    )
    m.button('Create alert').click()
    await settle()
    const rule = m.store.list()[0].rule as { all: Rule[] }
    expect(rule.all.length).toBe(3)
    expect(rule.all[1]).toMatchObject({ op: 'crosses_above', right: { operand: { name: 'MA', params: [20] } } })
    expect(rule.all[2]).toMatchObject({ left: { kind: 'signal', plugin: 'arev' }, op: '==', right: { label: 'long' } })
  })

  test('what cannot be evaluated cannot be saved, and says why', async () => {
    const m = mount()
    m.manager.create()
    await settle()
    const symbol = m.root.querySelector('[aria-label="Instrument"]') as HTMLInputElement
    m.change(symbol, 'EURUSD')
    const problem = m.root.querySelector('.wd-alert-problem') as HTMLElement
    expect(problem.hidden).toBe(false)
    expect(problem.textContent).toContain('vendor:TICKER')
    expect(m.button('Create alert').disabled).toBe(true)
  })

  test('switch off, re-arm a fired one, and delete in two presses', async () => {
    const m = mount()
    const alert = await m.store.create({
      name: 'once',
      note: '',
      enabled: true,
      symbol: 'oanda:EURUSD',
      rule: { left: { kind: 'bar', interval: '1h', field: 'close' }, op: '>', right: { value: 1 } },
      trigger: 'level',
      repeat: 'once',
      cooldownMs: 0
    })
    m.manager.open()
    const toggle = m.root.querySelector('.wd-alert-switch') as HTMLInputElement
    toggle.checked = false
    toggle.dispatchEvent(new Event('change'))
    await settle()
    expect(m.store.get(alert.id)?.status).toBe('disabled')
    expect(m.root.querySelector('.wd-alert-row')?.classList.contains('is-disabled')).toBe(true)

    await m.store.setEnabled(alert.id, true)
    m.store.recordFiring(alert.id, 5)
    m.button('Re-arm').click()
    await settle()
    expect(m.store.get(alert.id)?.status).toBe('armed')

    m.button('Delete').click()
    expect(m.store.list().length).toBe(1)
    m.button('Confirm delete').click()
    await settle()
    expect(m.store.list()).toEqual([])
  })
})

describe('the editable tree', () => {
  test('round-trips every shape a rule can take', () => {
    const leaf: Rule = { left: { kind: 'bar', interval: '1h', field: 'close' }, op: '>', right: { value: 1 } }
    const shapes: Rule[] = [
      leaf,
      { all: [leaf, leaf] },
      { any: [leaf, { all: [leaf, leaf] }] },
      { not: { any: [leaf, leaf] } },
      { not: leaf }
    ]
    for (const rule of shapes) expect(fromEditable(toEditable(rule))).toEqual(rule)
    // A `not` over an `all` is a "none" group holding that group.
    const notAll: Rule = { not: { all: [leaf, leaf] } }
    expect(toEditable(notAll).mode).toBe('none')
    expect(fromEditable(toEditable(notAll))).toEqual(notAll)
  })
})
