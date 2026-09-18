import { describe, expect, test } from 'bun:test'
import { dragOffset } from './drag'

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
