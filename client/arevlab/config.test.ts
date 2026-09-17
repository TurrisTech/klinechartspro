import { describe, expect, test } from 'bun:test'
import { installWindow } from '../plugins/testing'
import type { LabConfig } from './config'

// config.ts takes the generation list from arev/api.ts, which reads the page's API base at import.
installWindow()
const { LAB_DEFAULTS, LAB_FIELDS, LEVERS, enabledGenerations, fromStoredLabConfig, normaliseLabConfig, toStoredLabConfig } =
  await import('./config')

const edit = (mutate: (c: LabConfig) => void): LabConfig => {
  const c = structuredClone(LAB_DEFAULTS)
  mutate(c)
  return c
}

describe('defaults', () => {
  test('arev21 alone, on the published level, comparing every bar', () => {
    expect(enabledGenerations(LAB_DEFAULTS)).toEqual(['arev21'])
    expect(LAB_DEFAULTS.generations.arev21.signals).toBe('fixed')
    expect(LAB_DEFAULTS.generations.arev21.fixed.confidence).toBe(0.075)
    expect(LAB_DEFAULTS.generations.arev21.samplesOnly).toBe(false)
  })

  test("rank counts bars; median and prior span days", () => {
    const g = LAB_DEFAULTS.generations.arev21
    expect(g.rank.bars).toBe(200)
    expect([g.median.days, g.prior.days]).toEqual([90, 365])
  })

  test("the band is the published rule's own half-width, around a moving centre", () => {
    // Measured 2026-09-17 on prod: only 18-25% of bars sit within 0.025 of their rolling
    // median, so the old band flagged the majority rather than the tail (README §7).
    const g = LAB_DEFAULTS.generations.arev21
    expect(g.median.width).toBe(g.fixed.confidence)
    expect(g.prior.width).toBe(g.fixed.confidence)
  })

  test('every generation has its own colour', () => {
    const colours = Object.values(LAB_DEFAULTS.generations).map((g) => g.color)
    expect(new Set(colours).size).toBe(colours.length)
  })
})

describe('normaliseLabConfig', () => {
  test('clamps numbers, rounds integers, and refuses the wrong type', () => {
    const c = normaliseLabConfig(
      edit((c) => {
        c.generations.arev19.rank.bars = 0
        c.generations.arev19.rank.q = 7
        c.generations.arev19.median.days = 12.6
        c.generations.arev19.color = 'red; drop'
        c.generations.arev19.signals = 'oracle' as never
        c.generations.arev19.lines = 'yes' as never
      })
    )
    const g = c.generations.arev19
    expect(g.rank.bars).toBe(20)
    expect(g.rank.q).toBe(1)
    expect(g.median.days).toBe(13)
    expect(g.color).toBe(LAB_DEFAULTS.generations.arev19.color)
    expect(g.signals).toBe('fixed')
    expect(g.lines).toBe(false)
  })

  test('a missing config is the defaults', () => {
    expect(normaliseLabConfig(undefined as never)).toEqual(LAB_DEFAULTS)
  })
})

describe('the stored diff', () => {
  test('defaults store nothing', () => {
    expect(toStoredLabConfig(LAB_DEFAULTS)).toBeUndefined()
  })

  test('round-trips every lever it stores, and only what differs', () => {
    const c = edit((c) => {
      c.generations.arev19.enabled = true
      c.generations.arev19.signals = 'prior'
      c.generations.arev19.prior.days = 2500
      c.generations.arev21.enabled = false
      c.generations.arev23.color = '#123456'
    })
    const stored = toStoredLabConfig(c)
    expect(stored).toEqual({
      arev19: { enabled: true, signals: 'prior', 'prior.days': 2500 },
      arev21: { enabled: false },
      arev23: { color: '#123456' }
    })
    expect(fromStoredLabConfig(JSON.parse(JSON.stringify(stored)))).toEqual(c)
  })

  test('a malformed document reads as never configured, and junk inside one is ignored', () => {
    expect(fromStoredLabConfig(null)).toBeUndefined()
    expect(fromStoredLabConfig([1, 2])).toBeUndefined()
    expect(fromStoredLabConfig({ arev99: { enabled: true } })).toBeUndefined()
    const c = fromStoredLabConfig({ arev20: { enabled: true, 'rank.bars': 'many', lineWidth: 99 } })
    expect(c?.generations.arev20.enabled).toBe(true)
    expect(c?.generations.arev20.rank.bars).toBe(LAB_DEFAULTS.generations.arev20.rank.bars)
    expect(c?.generations.arev20.lineWidth).toBe(4)
  })
})

describe('the settings panel', () => {
  test('one group per generation, levers shown only for the rules they belong to', () => {
    expect(LAB_FIELDS.map((f) => f.label)).toEqual(['arev19', 'arev20', 'arev21', 'arev22', 'arev23'])
    const group = LAB_FIELDS[2]
    if (group.kind !== 'group') throw new Error('expected a group')
    const inner = group.fields[1]
    if (inner.kind !== 'group') throw new Error('expected a nested group')
    expect(inner.when).toEqual({ key: 'generations.arev21.enabled', is: [true] })
    const q = inner.fields.find((f) => f.kind === 'number' && f.key === 'generations.arev21.rank.bars')
    expect(q?.when).toEqual({ key: 'generations.arev21.signals', is: ['rank'] })
    expect(inner.fields).toHaveLength(LEVERS.length)
  })
})
