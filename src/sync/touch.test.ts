import { describe, expect, test } from 'bun:test'
import {
  createGestureTail,
  createTapRecognizer,
  DOUBLE_TAP_MS,
  DOUBLE_TAP_SLOP_PX,
  FLING_GAP_MS,
  FLING_MAX_MS,
  TAP_MAX_MS,
  TAP_SLOP_PX
} from './touch'

const at = (x: number, y: number, t: number) => ({ x, y, t })

function tap(r: ReturnType<typeof createTapRecognizer>, x: number, y: number, t: number, holdMs = 60) {
  r.start(at(x, y, t), 1)
  return r.end(at(x, y, t + holdMs), 0)
}

describe('createTapRecognizer', () => {
  test('a quick lift where the finger landed is a tap', () => {
    const r = createTapRecognizer()
    expect(tap(r, 100, 100, 0)).toBe('tap')
  })

  test('two taps close in time and place are a double tap', () => {
    const r = createTapRecognizer()
    expect(tap(r, 100, 100, 0)).toBe('tap')
    expect(tap(r, 100 + DOUBLE_TAP_SLOP_PX - 2, 100, 200)).toBe('double-tap')
  })

  test('a third tap starts a new pair', () => {
    const r = createTapRecognizer()
    tap(r, 100, 100, 0)
    expect(tap(r, 100, 100, 150)).toBe('double-tap')
    expect(tap(r, 100, 100, 300)).toBe('tap')
    expect(tap(r, 100, 100, 450)).toBe('double-tap')
  })

  test('a second tap too late or too far is a fresh tap', () => {
    const r = createTapRecognizer()
    tap(r, 100, 100, 0)
    expect(tap(r, 100, 100, 60 + DOUBLE_TAP_MS + 1)).toBe('tap')
    expect(tap(r, 100 + DOUBLE_TAP_SLOP_PX + 5, 100, 600)).toBe('tap')
  })

  test('a drag is not a tap, and breaks a pair', () => {
    const r = createTapRecognizer()
    tap(r, 100, 100, 0)
    r.start(at(100, 100, 100), 1)
    expect(r.end(at(100 + TAP_SLOP_PX + 1, 100, 150), 0)).toBeNull()
    expect(tap(r, 100, 100, 200)).toBe('tap')
  })

  test('a press held past the tap time is not a tap', () => {
    const r = createTapRecognizer()
    r.start(at(100, 100, 0), 1)
    expect(r.end(at(100, 100, TAP_MAX_MS + 1), 0)).toBeNull()
  })

  test('a pinch is never a tap, before or after its second finger', () => {
    const r = createTapRecognizer()
    r.start(at(100, 100, 0), 1)
    r.start(at(200, 200, 20), 2)
    expect(r.end(at(200, 200, 60), 1)).toBeNull()
    expect(r.end(at(100, 100, 80), 0)).toBeNull()
    // and the gesture after it is judged afresh
    expect(tap(r, 100, 100, 200)).toBe('tap')
  })

  test('reset forgets a half-made pair', () => {
    const r = createTapRecognizer()
    tap(r, 100, 100, 0)
    r.reset()
    expect(tap(r, 100, 100, 150)).toBe('tap')
  })
})

describe('createGestureTail', () => {
  test('lasts while changes keep coming, and ends a gap after the last', () => {
    const tail = createGestureTail()
    tail.begin(0)
    let now = 0
    for (let frame = 0; frame < 60; frame++) {
      now += 16
      expect(tail.touch(now)).toBe(true)
    }
    expect(tail.active(now + FLING_GAP_MS - 1)).toBe(true)
    expect(tail.touch(now + FLING_GAP_MS + 1)).toBe(false)
  })

  test('a change after the gap is not the gesture', () => {
    const tail = createGestureTail()
    tail.begin(0)
    expect(tail.touch(FLING_GAP_MS + 1)).toBe(false)
  })

  test('never outlasts its cap', () => {
    const tail = createGestureTail()
    tail.begin(0)
    let now = 0
    while (now < FLING_MAX_MS - 16) {
      now += 16
      tail.touch(now)
    }
    expect(tail.touch(FLING_MAX_MS)).toBe(false)
  })

  test('clear ends it at once', () => {
    const tail = createGestureTail()
    tail.begin(0)
    tail.clear()
    expect(tail.active(1)).toBe(false)
  })
})
