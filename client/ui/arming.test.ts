import { describe, expect, test } from 'bun:test'
import { Arming } from './arming'

// TWO PRESSES: no DOM, only the key, the window and when the surface is told to redraw. The window
// is real time, kept short; a lapse is waited for with room to spare.

const MS = 20
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function arming(ms = MS): { arming: Arming; redraws: () => number } {
  let count = 0
  return { arming: new Arming(() => count++, ms), redraws: () => count }
}

describe('Arming', () => {
  test('the first press arms and redraws; the second of the same key goes ahead', () => {
    const { arming: a, redraws } = arming()
    expect(a.key).toBeNull()
    expect(a.press('delete:1')).toBe(false)
    expect(a.key).toBe('delete:1')
    expect(redraws()).toBe(1)
    expect(a.press('delete:1')).toBe(true)
    expect(a.key).toBeNull()
    expect(redraws()).toBe(2)
    a.dispose()
  })

  test('another key re-arms on that one: one pending press per surface', () => {
    const { arming: a } = arming()
    a.press('delete:1')
    expect(a.press('delete:2')).toBe(false)
    expect(a.key).toBe('delete:2')
    expect(a.press('delete:1')).toBe(false)
    expect(a.press('delete:1')).toBe(true)
    a.dispose()
  })

  test('`now` goes ahead at once, and drops a press that was waiting', () => {
    const { arming: a, redraws } = arming()
    expect(a.press('place', true)).toBe(true)
    expect(redraws()).toBe(0)
    a.press('close:t1:1')
    expect(a.press('place', true)).toBe(true)
    expect(a.key).toBeNull()
    expect(redraws()).toBe(2)
  })

  test('the window lapses by itself, redrawing the button unarmed', async () => {
    const { arming: a, redraws } = arming()
    a.press('delete:1')
    await sleep(MS * 5)
    expect(a.key).toBeNull()
    expect(redraws()).toBe(2)
    // A press after the lapse is a first press again.
    expect(a.press('delete:1')).toBe(false)
    a.dispose()
  })

  test('re-arming restarts the window rather than keeping the first one', async () => {
    // Checked 450 ms after the first press, whose window ends at 400, and 150 ms into the
    // second's: a slow machine has 250 ms to spare before the check would land past that too.
    const { arming: a } = arming(400)
    a.press('delete:1')
    await sleep(300)
    a.press('delete:2')
    await sleep(150)
    expect(a.key).toBe('delete:2')
    a.dispose()
  })

  test('disarm redraws only when something was armed', () => {
    const { arming: a, redraws } = arming()
    a.disarm()
    expect(redraws()).toBe(0)
    a.press('delete:1')
    a.disarm()
    expect(a.key).toBeNull()
    expect(redraws()).toBe(2)
  })

  test('dispose stops the window without a redraw', async () => {
    const { arming: a, redraws } = arming()
    a.press('delete:1')
    a.dispose()
    await sleep(MS * 5)
    expect(redraws()).toBe(1)
  })
})
