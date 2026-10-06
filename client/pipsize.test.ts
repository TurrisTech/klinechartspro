import { describe, expect, test } from 'bun:test'

import { pipSizeOf } from './pipsize'
import type { InstrumentConfig } from './symbols'

const config = (assetClass: string, forexPipLocation: number | null) =>
  ({ assetClass, forexPipLocation }) as InstrumentConfig

describe('pipSizeOf', () => {
  test('forex and metals are priced in pips at their pip location', () => {
    expect(pipSizeOf(config('forex', -4))).toBe(0.0001)
    expect(pipSizeOf(config('forex', -2))).toBe(0.01)
    expect(pipSizeOf(config('metal', -2))).toBe(0.01)
  })

  test('every other asset class, a missing location and a missing config have none', () => {
    expect(pipSizeOf(config('crypto', -2))).toBeNull()
    expect(pipSizeOf(config('equity', null))).toBeNull()
    expect(pipSizeOf(config('forex', null))).toBeNull()
    expect(pipSizeOf(null)).toBeNull()
  })
})
