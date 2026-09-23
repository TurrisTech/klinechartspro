import { describe, expect, test } from 'bun:test'
import builtin from '../config/indicators'
import type { IndicatorSettingField } from '../types'
import {
  coverage,
  holds,
  lineApplies,
  resolveParams,
  settingLines,
  settleSetting,
  sharedParam,
  sharedSetting,
  usedIndicators,
  valueAt,
  withParam
} from './indicatorMatrix'

const pane = (main: string[], sub: string[]) => ({ mainIndicators: main, subIndicatorNames: sub })

describe('usedIndicators', () => {
  test('the union over panes, price-pane rows before sub-pane rows, first appearance first', () => {
    const rows = usedIndicators([pane(['MA'], ['VOL', 'RSI']), pane(['BOLL', 'MA'], ['MACD', 'VOL'])])
    expect(rows).toEqual([
      { name: 'MA', main: true },
      { name: 'BOLL', main: true },
      { name: 'VOL', main: false },
      { name: 'RSI', main: false },
      { name: 'MACD', main: false }
    ])
  })

  test('one template on the price pane and in a sub-pane is two rows', () => {
    const rows = usedIndicators([pane(['EMA'], []), pane([], ['EMA'])])
    expect(rows).toEqual([
      { name: 'EMA', main: true },
      { name: 'EMA', main: false }
    ])
  })

  test('a retained row survives once no pane holds it, in its place', () => {
    const shown = usedIndicators([pane(['MA'], ['VOL', 'RSI'])])
    const rows = usedIndicators([pane(['MA'], ['RSI'])], shown)
    expect(rows).toEqual(shown)
  })

  test('an empty wall has no rows', () => {
    expect(usedIndicators([pane([], []), pane([], [])])).toEqual([])
  })
})

describe('coverage', () => {
  const panes = [pane(['MA'], ['VOL']), pane(['MA'], [])]
  test('all, some and none', () => {
    expect(coverage(panes, { name: 'MA', main: true })).toBe('all')
    expect(coverage(panes, { name: 'VOL', main: false })).toBe('some')
    expect(coverage(panes, { name: 'VOL', main: true })).toBe('none')
  })

  test('placement is part of the question', () => {
    expect(holds(panes[0], { name: 'VOL', main: false })).toBe(true)
    expect(holds(panes[0], { name: 'VOL', main: true })).toBe(false)
  })
})

describe('withParam', () => {
  test('replaces one slot of the live params', () => {
    expect(withParam([5, 10, 30, 60], 1, 20)).toEqual([5, 20, 30, 60])
  })

  test('a slot past the end is padded as empty up to it', () => {
    expect(withParam([5, 10], 3, 60)).toEqual([5, 10, '', 60])
  })

  test('a cleared cell is empty, and a non-number held value reads as empty', () => {
    expect(withParam([12, 26, 9], 2, '')).toEqual([12, 26, ''])
    expect(withParam([12, null, 9], 0, 14)).toEqual([14, '', 9])
  })
})

describe('resolveParams', () => {
  test('numbers within bounds pass through', () => {
    expect(resolveParams([20, 2.5], builtin.BOLL)).toEqual({ params: [20, 2.5] })
  })

  test('an empty cell takes the setting default, as the settings dialog does', () => {
    expect(resolveParams(['', 3], builtin.BOLL)).toEqual({ params: [20, 3] })
  })

  test('an empty optional line is left out and the later ones close up', () => {
    // MA1..MA5 have no default: clearing MA2 removes that line rather than sending a hole.
    expect(resolveParams([5, '', 30, 60], builtin.MA)).toEqual({ params: [5, 30, 60] })
    // MA5 filled in on a four-line MA adds a fifth line.
    expect(resolveParams([5, 10, 30, 60, 120], builtin.MA)).toEqual({ params: [5, 10, 30, 60, 120] })
  })

  test('refuses a value below the minimum or above the maximum, naming the slot', () => {
    expect(resolveParams([0, 2], builtin.BOLL)).toEqual({ problem: { kind: 'below', index: 0, bound: 1 } })
    expect(resolveParams([8, 2, 1], builtin.SESSIONS)).toEqual({ problem: { kind: 'above', index: 1, bound: 1 } })
  })

  test('refuses a fraction where the setting is a whole number', () => {
    expect(resolveParams([20.5, 2], builtin.BOLL)).toEqual({ problem: { kind: 'fraction', index: 0 } })
  })

  test('refuses clearing every optional line', () => {
    expect(resolveParams(['', '', '', '', ''], builtin.MA)).toEqual({ problem: { kind: 'empty' } })
  })

  test('a slot the settings do not describe passes through unchecked', () => {
    expect(resolveParams([10, 10, 0, 7], builtin.SWING)).toEqual({ params: [10, 10, 0, 7] })
  })
})

describe('sharedParam', () => {
  test('the value every holding pane agrees on; panes not holding the row do not count', () => {
    expect(sharedParam([[5, 10], null, [5, 20]], 0)).toBe(5)
  })

  test('mixed where holding panes differ', () => {
    expect(sharedParam([[5, 10], [5, 20]], 1)).toBe('mixed')
  })

  test('empty where no holding pane sets the slot, or no pane holds the row', () => {
    expect(sharedParam([[5, 10, 30, 60], [5, 10, 30, 60]], 4)).toBe('')
    expect(sharedParam([null, null], 0)).toBe('')
  })

  test('a slot set on one pane and unset on another is mixed', () => {
    expect(sharedParam([[5, 10, 30, 60, 120], [5, 10, 30, 60]], 4)).toBe('mixed')
  })
})

// The shape of the AREV21 divergence's and the MTF overlay's settings (client/arev21div,
// client/mtf): groups of fields over a nested per-pane config.
const FIELDS: IndicatorSettingField[] = [
  {
    kind: 'group',
    label: 'Swings',
    fields: [
      { kind: 'number', key: 'rule.left', label: 'Left', min: 2, max: 100, step: 1, integer: true },
      { kind: 'switch', key: 'rule.hidden', label: 'Hidden too' }
    ]
  },
  {
    kind: 'group',
    label: 'Lines',
    fields: [
      { kind: 'select', key: 'line.style', label: 'Style', options: [{ value: 'dotted', label: 'Dotted' }] },
      { kind: 'color', key: 'line.bullColor', label: 'Bullish', when: { key: 'rule.hidden', is: [true] } },
      { kind: 'group', label: 'More', fields: [{ kind: 'number', key: 'line.width', label: 'Width', min: 1, max: 10, step: 0.5 }] }
    ]
  }
]

describe('settingLines', () => {
  test('groups become headings before their fields, with index-path ids and their enclosing groups', () => {
    const lines = settingLines(FIELDS)
    expect(lines.map((line) => (line.kind === 'group' ? `# ${line.id} ${line.label}` : `${line.field.key} in [${line.groups}]`))).toEqual([
      '# 0 Swings',
      'rule.left in [0]',
      'rule.hidden in [0]',
      '# 1 Lines',
      'line.style in [1]',
      'line.bullColor in [1]',
      '# 1.2 More',
      'line.width in [1,1.2]'
    ])
    expect(lines.map((line) => line.depth)).toEqual([0, 1, 1, 0, 1, 1, 1, 2])
  })

  test("a field carries its own condition and every enclosing group's", () => {
    const nested = settingLines([
      { kind: 'group', label: 'G', when: { key: 'a', is: [1] }, fields: [{ kind: 'switch', key: 'b', label: 'B', when: { key: 'c', is: [2] } }] }
    ])
    expect(nested[1].when).toEqual([
      { key: 'a', is: [1] },
      { key: 'c', is: [2] }
    ])
  })
})

describe('lineApplies', () => {
  const [, , , , , bull] = settingLines(FIELDS)
  test('holds where every condition does, and never for a pane without a config', () => {
    expect(lineApplies(bull, { rule: { hidden: true } })).toBe(true)
    expect(lineApplies(bull, { rule: { hidden: false } })).toBe(false)
    expect(lineApplies(bull, null)).toBe(false)
    expect(lineApplies({ when: [] }, {})).toBe(true)
  })
})

describe('valueAt', () => {
  test('walks a dotted path, indexing arrays by a numeric segment', () => {
    expect(valueAt({ a: { b: [5, 7] } }, 'a.b.1')).toBe(7)
    expect(valueAt({ a: 1 }, 'a.b')).toBeUndefined()
    expect(valueAt(null, 'a')).toBeUndefined()
  })
})

describe('settleSetting', () => {
  test('clamps to the bounds and rounds a whole-number field', () => {
    expect(settleSetting({ min: 2, max: 100, integer: true }, 250)).toBe(100)
    expect(settleSetting({ min: 2, max: 100, integer: true }, 7.6)).toBe(8)
    expect(settleSetting({ min: 1, max: 10 }, 2.25)).toBe(2.25)
    expect(settleSetting({ min: 1, max: 10 }, 0)).toBe(1)
  })
})

describe('sharedSetting', () => {
  test('the value every holding pane agrees on, mixed where they differ, null where none holds', () => {
    expect(sharedSetting([{ line: { width: 3 } }, null, { line: { width: 3 } }], 'line.width')).toEqual({ value: 3 })
    expect(sharedSetting([{ line: { width: 3 } }, { line: { width: 2 } }], 'line.width')).toBe('mixed')
    expect(sharedSetting([null, null], 'line.width')).toBeNull()
  })
})
