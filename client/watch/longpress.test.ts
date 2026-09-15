import { describe, expect, test } from 'bun:test'

import { attachLongPress, type LongPressPoint } from './longpress'

const DELAY = 30
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function touch(type: string, points: Array<[number, number]>): Event {
  const event = new Event(type, { cancelable: true })
  Object.assign(event, { touches: points.map(([clientX, clientY]) => ({ clientX, clientY })) })
  return event
}

function setup() {
  const element = new EventTarget()
  const clickTarget = new EventTarget()
  const presses: LongPressPoint[] = []
  const longPress = attachLongPress(element, {
    delayMs: DELAY,
    clickTarget,
    onLongPress: (point) => presses.push(point)
  })
  return { element, clickTarget, presses, longPress }
}

describe('attachLongPress', () => {
  test('a finger held still fires once, at where it landed', async () => {
    const { element, presses } = setup()
    element.dispatchEvent(touch('touchstart', [[100, 200]]))
    element.dispatchEvent(touch('touchmove', [[104, 203]]))
    await wait(DELAY * 2)
    expect(presses).toEqual([{ clientX: 100, clientY: 200 }])
  })

  test('lifting before the delay is a tap, not a hold', async () => {
    const { element, presses } = setup()
    element.dispatchEvent(touch('touchstart', [[100, 200]]))
    element.dispatchEvent(touch('touchend', []))
    await wait(DELAY * 2)
    expect(presses).toEqual([])
  })

  test('a drag past the slop is a pan, not a hold', async () => {
    const { element, presses } = setup()
    element.dispatchEvent(touch('touchstart', [[100, 200]]))
    element.dispatchEvent(touch('touchmove', [[130, 200]]))
    await wait(DELAY * 2)
    expect(presses).toEqual([])
  })

  test('a second finger is a pinch, not a hold', async () => {
    const { element, presses } = setup()
    element.dispatchEvent(touch('touchstart', [[100, 200]]))
    element.dispatchEvent(touch('touchmove', [[100, 200], [220, 300]]))
    element.dispatchEvent(touch('touchstart', [[100, 200], [220, 300]]))
    await wait(DELAY * 2)
    expect(presses).toEqual([])
  })

  test('cancel() abandons a hold in progress (a native contextmenu came first)', async () => {
    const { element, presses, longPress } = setup()
    element.dispatchEvent(touch('touchstart', [[100, 200]]))
    longPress.cancel()
    await wait(DELAY * 2)
    expect(presses).toEqual([])
    expect(longPress.firedRecently()).toBe(false)
  })

  test('a fired hold is recent, so the native contextmenu for the same hold is ignored', async () => {
    const { element, longPress } = setup()
    element.dispatchEvent(touch('touchstart', [[100, 200]]))
    await wait(DELAY * 2)
    expect(longPress.firedRecently()).toBe(true)
  })

  test('the click released by a fired hold is swallowed; a tap is not', async () => {
    const { element, clickTarget } = setup()

    element.dispatchEvent(touch('touchstart', [[100, 200]]))
    await wait(DELAY * 2)
    element.dispatchEvent(touch('touchend', []))
    const release = new Event('click', { cancelable: true })
    clickTarget.dispatchEvent(release)
    expect(release.defaultPrevented).toBe(true)

    element.dispatchEvent(touch('touchstart', [[100, 200]]))
    element.dispatchEvent(touch('touchend', []))
    const tap = new Event('click', { cancelable: true })
    clickTarget.dispatchEvent(tap)
    expect(tap.defaultPrevented).toBe(false)
  })

  test('dispose() stops listening', async () => {
    const { element, presses, longPress } = setup()
    longPress.dispose()
    element.dispatchEvent(touch('touchstart', [[100, 200]]))
    await wait(DELAY * 2)
    expect(presses).toEqual([])
  })
})
