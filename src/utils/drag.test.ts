import { describe, expect, test } from 'bun:test'
import { dragOffset, resizeBox } from './drag'

const bounds = { left: 0, top: 0, right: 1000, bottom: 800 }
// A 400x300 dialog centred in the bounds.
const centred = { left: 300, top: 250, right: 700, bottom: 550 }

describe('dragOffset', () => {
  test('a move inside the bounds is the pointer delta', () => {
    expect(dragOffset({ x: 0, y: 0 }, { x: -120, y: 40 }, centred, bounds)).toEqual({ x: -120, y: 40 })
  })

  test('the dialog stops at every edge rather than leaving the shell', () => {
    expect(dragOffset({ x: 0, y: 0 }, { x: -900, y: -900 }, centred, bounds)).toEqual({ x: -300, y: -250 })
    expect(dragOffset({ x: 0, y: 0 }, { x: 900, y: 900 }, centred, bounds)).toEqual({ x: 300, y: 250 })
  })

  test('a drag continues from the offset it started with', () => {
    const moved = { left: 100, top: 250, right: 500, bottom: 550 }
    expect(dragOffset({ x: -200, y: 0 }, { x: -500, y: 0 }, moved, bounds)).toEqual({ x: -300, y: 0 })
  })

  test('an axis the dialog overfills does not move, and never jumps', () => {
    const tall = { left: 300, top: -50, right: 700, bottom: 850 }
    expect(dragOffset({ x: 0, y: 0 }, { x: 10, y: 200 }, tall, bounds)).toEqual({ x: 10, y: 0 })
    expect(dragOffset({ x: 0, y: 0 }, { x: 10, y: -200 }, tall, bounds)).toEqual({ x: 10, y: 0 })
  })
})

describe('resizeBox', () => {
  const min = { width: 200, height: 150 }

  test('the bottom-right corner follows the pointer and the top-left stays put', () => {
    const { size, offset } = resizeBox({ x: 0, y: 0 }, { x: 100, y: 60 }, centred, bounds, min)
    expect(size).toEqual({ width: 500, height: 360 })
    // Centred, so the offset moves half the growth: left stays at 300 - 50 + 50.
    expect(offset).toEqual({ x: 50, y: 30 })
  })

  test('shrinking stops at the minimum', () => {
    const { size, offset } = resizeBox({ x: 10, y: 10 }, { x: -900, y: -900 }, centred, bounds, min)
    expect(size).toEqual(min)
    expect(offset).toEqual({ x: 10 - 100, y: 10 - 75 })
  })

  test('growing stops at the bounds', () => {
    const { size } = resizeBox({ x: 0, y: 0 }, { x: 900, y: 900 }, centred, bounds, min)
    expect(size).toEqual({ width: 700, height: 550 })
  })

  test('a dialog already past the bounds is not grown, only allowed to shrink', () => {
    const overhang = { left: 700, top: 600, right: 1100, bottom: 900 }
    const { size } = resizeBox({ x: 0, y: 0 }, { x: 50, y: 50 }, overhang, bounds, min)
    expect(size).toEqual({ width: 300, height: 200 })
  })
})
