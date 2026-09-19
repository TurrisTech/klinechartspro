import { describe, expect, test } from 'bun:test'
import { DEFAULT_PREFS, parsePrefs, SIZE_MODES } from './prefs'

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

  test('every size mode survives, an unknown one does not, and each amount falls back alone', () => {
    for (const mode of SIZE_MODES) expect(parsePrefs({ sizeMode: mode }).sizeMode).toBe(mode)
    expect(parsePrefs({ sizeMode: 'percent' }).sizeMode).toBe('units')
    const prefs = parsePrefs({ lots: 0.5, riskAmount: -1, notional: 25_000, marginPercent: 150 })
    expect([prefs.lots, prefs.riskAmount, prefs.notional, prefs.marginPercent]).toEqual([0.5, DEFAULT_PREFS.riskAmount, 25_000, DEFAULT_PREFS.marginPercent])
  })
})
