import { describe, expect, test } from 'bun:test'
import { type Measurement, SyncBus, type SyncPane } from './bus'

// The ruler's channel on the bus: one measurement for the whole wall, handed to every pane
// (the one dragging it included) so each decides for itself whether it is on the instrument.

function fakePane(id: string): SyncPane & { shown: Array<Measurement | null> } {
  const shown: Array<Measurement | null> = []
  return {
    id,
    shown,
    getChart: () => null,
    getPeriodMs: () => 3_600_000,
    seekTo: () => {},
    showMeasurement: (measurement) => { shown.push(measurement) }
  }
}

const EURUSD = { ticker: 'EURUSD', exchange: 'oanda' }

function measurement(sourceId: string, to = 1.1): Measurement {
  return {
    sourceId,
    symbol: EURUSD,
    points: [{ timestamp: 1_000, value: 1.0 }, { timestamp: 2_000, value: to }]
  }
}

describe('SyncBus measurement', () => {
  test('reaches every pane, the source included', () => {
    const bus = new SyncBus()
    const a = fakePane('a')
    const b = fakePane('b')
    bus.register(a)
    bus.register(b)
    const m = measurement('a')
    bus.setMeasurement(m)
    expect(a.shown).toEqual([m])
    expect(b.shown).toEqual([m])
    expect(bus.getMeasurement()).toBe(m)
  })

  test('each move of the drag is passed on', () => {
    const bus = new SyncBus()
    const b = fakePane('b')
    bus.register(b)
    bus.setMeasurement(measurement('a', 1.1))
    bus.setMeasurement(measurement('a', 1.2))
    expect(b.shown.map((m) => m?.points[1].value)).toEqual([1.1, 1.2])
  })

  test('clearing tells every pane once, and clearing nothing tells no one', () => {
    const bus = new SyncBus()
    const a = fakePane('a')
    bus.register(a)
    bus.setMeasurement(null)
    expect(a.shown).toEqual([])
    bus.setMeasurement(measurement('a'))
    bus.setMeasurement(null)
    bus.setMeasurement(null)
    expect(a.shown.at(-1)).toBeNull()
    expect(a.shown.length).toBe(2)
    expect(bus.getMeasurement()).toBeNull()
  })

  test('a pane added to the wall while a measurement is up shows it', () => {
    const bus = new SyncBus()
    const m = measurement('a')
    bus.register(fakePane('a'))
    bus.setMeasurement(m)
    const late = fakePane('late')
    bus.register(late)
    expect(late.shown).toEqual([m])
    const empty = new SyncBus()
    const quiet = fakePane('quiet')
    empty.register(quiet)
    expect(quiet.shown).toEqual([])
  })

  test('the source leaving the wall takes its measurement with it; another pane leaving does not', () => {
    const bus = new SyncBus()
    const a = fakePane('a')
    const b = fakePane('b')
    const c = fakePane('c')
    for (const pane of [a, b, c]) bus.register(pane)
    bus.setMeasurement(measurement('a'))
    bus.unregister('b')
    expect(bus.getMeasurement()).not.toBeNull()
    bus.unregister('a')
    expect(bus.getMeasurement()).toBeNull()
    expect(c.shown.at(-1)).toBeNull()
    // The pane already gone is not drawn on.
    expect(b.shown.length).toBe(1)
  })
})
