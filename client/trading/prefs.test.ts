import { describe, expect, test } from 'bun:test'
import { DEFAULT_PREFS, parsePrefs } from './prefs'

describe('parsePrefs', () => {
  test('nothing stored reads as the defaults, with the card state undecided', () => {
    expect(parsePrefs(null)).toEqual(DEFAULT_PREFS)
    expect(parsePrefs(null).cardCollapsed).toBeNull()
  })

  test('a malformed field falls back on its own, keeping the rest', () => {
    const prefs = parsePrefs({ units: -5, sizeMode: 'risk', riskPercent: 250, protectMode: 'percent', rewardRatio: 3, cardCollapsed: 'yes' })
    expect(prefs).toEqual({ ...DEFAULT_PREFS, sizeMode: 'risk', protectMode: 'percent', rewardRatio: 3 })
  })

  test('a chosen card state survives, either way', () => {
    expect(parsePrefs({ cardCollapsed: true }).cardCollapsed).toBe(true)
    expect(parsePrefs({ cardCollapsed: false }).cardCollapsed).toBe(false)
  })
})
