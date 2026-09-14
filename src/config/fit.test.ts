import { describe, expect, test } from 'bun:test'

import { fitWall, panePlacement } from './fit'
import { layoutById } from './layouts'

describe('fitWall', () => {
  test('a single pane is always drawn as declared', () => {
    expect(fitWall(layoutById('1'), 320, 200)).toEqual({ mode: 'preset' })
  })

  test('an unmeasured wall draws the preset rather than a fallback', () => {
    expect(fitWall(layoutById('12'), 0, 0)).toEqual({ mode: 'preset' })
  })

  test('a preset whose every cell is usable is kept, spans and all', () => {
    // 8 across a 1080p desktop beside the drawing rail: 234px each is narrow, but usable.
    expect(fitWall(layoutById('8h'), 1872, 1000)).toEqual({ mode: 'preset' })
    // 1920x1030 desktop: twelve 480x343 cells.
    expect(fitWall(layoutById('12'), 1920, 1030)).toEqual({ mode: 'preset' })
    expect(fitWall(layoutById('3-left'), 1280, 700)).toEqual({ mode: 'preset' })
  })

  test('side by side on a portrait phone stacks instead', () => {
    // iPhone portrait: 390 wide, ~740 under the toolbar.
    expect(fitWall(layoutById('2h'), 390, 740)).toEqual({ mode: 'reflow', columns: 1, rows: 2 })
  })

  test('stacked on a landscape phone goes side by side instead', () => {
    expect(fitWall(layoutById('2v'), 844, 300)).toEqual({ mode: 'reflow', columns: 2, rows: 1 })
  })

  test('a reflow prefers a grid with no empty cell over a roomier ragged one', () => {
    // 8 across on 1500x900: 4x2 (no hole) beats 3x3 (one hole), though 3x3 cells are larger.
    expect(fitWall(layoutById('8h'), 1500, 900)).toEqual({ mode: 'reflow', columns: 4, rows: 2 })
  })

  test('among equally complete grids, the one with the most room in its tight dimension', () => {
    // Six panes on a portrait tablet: 2x3 (360x316) over 1x6 (720x158) and 3x2 (240x475).
    expect(fitWall(layoutById('6h'), 720, 950)).toEqual({ mode: 'reflow', columns: 2, rows: 3 })
  })

  test('when no grid of the panes fits, one pane at a time', () => {
    expect(fitWall(layoutById('12'), 390, 740)).toEqual({ mode: 'single' })
    expect(fitWall(layoutById('9'), 844, 300)).toEqual({ mode: 'single' })
  })
})

describe('panePlacement', () => {
  test('preset panes keep their named area', () => {
    expect(panePlacement({ mode: 'preset' }, 0, 3, 'p1')).toBe('grid-area: p1;')
  })

  test('single mode stacks every pane in the one cell', () => {
    expect(panePlacement({ mode: 'single' }, 4, 6, 'p5')).toBe('grid-area: 1 / 1;')
  })

  test('a reflow auto-places, and the last pane spans what its row leaves', () => {
    const fit = { mode: 'reflow', columns: 2, rows: 2 } as const
    expect(panePlacement(fit, 0, 3, 'p1')).toBe('')
    expect(panePlacement(fit, 2, 3, 'p3')).toBe('grid-column: span 2;')
    expect(panePlacement({ mode: 'reflow', columns: 2, rows: 3 }, 5, 6, 'p6')).toBe('')
  })
})
