import { afterEach, expect, test } from 'bun:test'
import { provideStrategies, type StrategyOperand, type StrategySource, strategies, strategyEntryReader } from './strategies'

// The alerts read the Strategy Lab only through what the page registers, so the Lab is never
// imported here. A reader made before registration reads what is registered by the time it is used.

const operand = { kind: 'strategy', strategy: 's1', interval: '5m' } as StrategyOperand

function fake(name: string, made: string[]): StrategySource {
  return {
    load: async () => {},
    list: () => [{ id: 's1', name }],
    name: (id) => (id === 's1' ? name : null),
    reader: () => {
      made.push(name)
      return { entries: async () => ({ points: [{ date: 1, signal: 1 } as never], through: 1 }) }
    }
  }
}

const none = strategies()
afterEach(() => provideStrategies(none))

test('with nothing registered there are no strategies, and a strategy operand has no entries', async () => {
  expect(strategies().list()).toEqual([])
  expect(strategies().name('s1')).toBeNull()
  expect(await strategyEntryReader().entries('oanda:EURUSD', operand, 0, 10)).toEqual({ points: [], through: null })
})

test('a reader made before the Lab is registered reads the Lab once it is, making its reader once', async () => {
  const made: string[] = []
  const reader = strategyEntryReader()
  provideStrategies(fake('Rank 85', made))
  expect((await reader.entries('oanda:EURUSD', operand, 0, 10)).through).toBe(1)
  await reader.entries('oanda:EURUSD', operand, 0, 10)
  expect(made).toEqual(['Rank 85'])
  expect(strategies().name('s1')).toBe('Rank 85')
})
