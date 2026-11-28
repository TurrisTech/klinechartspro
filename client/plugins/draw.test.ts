import { describe, expect, test } from 'bun:test'
import {
  arrowPath,
  drawGraphNode,
  drawLink,
  drawShape,
  drawText,
  fillArrow,
  fillDot,
  type Fill,
  type MarkShape,
  paintShape,
  shapePath,
  starPath,
  trianglePath
} from './draw'
import { recordingContext } from './testcanvas'

type Ctx = CanvasRenderingContext2D

/** What `draw` records: every call in order, and what reached the pixels. */
function record(draw: (ctx: Ctx) => void): ReturnType<typeof recordingContext> {
  const rec = recordingContext()
  draw(rec.ctx)
  return rec
}

const XS = [0, 13.7, 101.35]
const YS = [-3.3, 0, 250.123]
const SIZES = [3, 4.75, 9]
const FILLS: Fill[] = ['solid', 'hollow', 'pending']
const SHAPES: MarkShape[] = ['arrow-up', 'arrow-down', 'triangle-up', 'triangle-down', 'circle', 'square', 'diamond', 'cross']

function* grid(): Generator<{ x: number; y: number; size: number; up: boolean }> {
  for (const x of XS) for (const y of YS) for (const size of SIZES) for (const up of [true, false]) yield { x, y, size, up }
}

describe('the marks', () => {
  test('an arrow hangs from its tip, ARROW_LENGTH deep, filled with no outline', () => {
    const rec = record((ctx) => fillArrow(ctx, 10, 20, 5, '#123456', true))
    expect(rec.painted).toHaveLength(1)
    expect(rec.painted[0].op).toBe('fill')
    expect(rec.painted[0].path).toEqual([['moveTo', 10, 20], ['lineTo', 5, 27], ['lineTo', 15, 27], ['closePath']])
    expect(rec.painted[0].style.fillStyle).toBe('#123456')
    expect(record((ctx) => fillArrow(ctx, 10, 20, 5, '#123456', false)).painted[0].path).toEqual([
      ['moveTo', 10, 20],
      ['lineTo', 5, 13],
      ['lineTo', 15, 13],
      ['closePath']
    ])
  })

  test('a triangle is centred on its point, its base 0.8 of its size the other side unless told', () => {
    expect(record((ctx) => trianglePath(ctx, 10, 20, 5, true)).calls).toEqual([
      ['beginPath'],
      ['moveTo', 10, 15],
      ['lineTo', 5, 24],
      ['lineTo', 15, 24],
      ['closePath']
    ])
    expect(record((ctx) => trianglePath(ctx, 10, 20, 5, false, 0.4)).calls).toEqual([
      ['beginPath'],
      ['moveTo', 10, 25],
      ['lineTo', 5, 18],
      ['lineTo', 15, 18],
      ['closePath']
    ])
  })

  test('the Fill rule: outlined always, filled unless hollow, under half strength while pending', () => {
    const paints = (fill: Fill) =>
      record((ctx) => drawShape(ctx, 'circle', 0, 0, 4, '#ABCDEF', { fill, alpha: 0.8 })).painted.map((p) => [
        p.op,
        p.style.globalAlpha,
        p.style.lineWidth
      ])
    expect(paints('solid')).toEqual([
      ['fill', 0.8, 1.5],
      ['stroke', 0.8, 1.5]
    ])
    expect(paints('hollow')).toEqual([['stroke', 0.8, 1.5]])
    expect(paints('pending')).toEqual([
      ['fill', 0.8 * 0.45, 1.5],
      ['stroke', 0.8, 1.5]
    ])
  })

  test('a shape the build does not know is drawn as a circle, not dropped', () => {
    const unknown = record((ctx) => shapePath(ctx, 'hexagon' as MarkShape, 3, 4, 5)).calls
    expect(unknown).toEqual(record((ctx) => shapePath(ctx, 'circle', 3, 4, 5)).calls)
    expect(unknown).toEqual([['beginPath'], ['arc', 3, 4, 5, 0, Math.PI * 2]])
  })

  test('every mark leaves the context as it found it', () => {
    const rec = recordingContext()
    for (const shape of SHAPES) drawShape(rec.ctx, shape, 1, 2, 3, '#FF0000', { fill: 'pending', alpha: 0.3, lineWidth: 4 })
    fillArrow(rec.ctx, 1, 2, 3, '#00FF00', true)
    drawText(rec.ctx, 1, 2, 'x', '#0000FF', { size: 14, align: 'center', baseline: 'top' })
    drawLink(rec.ctx, { x: 0, y: 0 }, { x: 1, y: 1 }, '#FFFFFF', { style: 'dotted', width: 3, alpha: 0.5 })
    expect(rec.ctx.globalAlpha).toBe(1)
    expect(rec.ctx.fillStyle).toBe('#000000')
    expect(rec.ctx.lineWidth).toBe(1)
    expect(rec.ctx.font).toBe('10px sans-serif')
    expect(rec.ctx.getLineDash()).toEqual([])
  })

  test('a link is dotted in beads as wide as the line, dashed in proportion to it, or solid', () => {
    const stroked = (style: 'solid' | 'dashed' | 'dotted') =>
      record((ctx) => drawLink(ctx, { x: 1, y: 2 }, { x: 30, y: 40 }, '#26A69A', { style, width: 2, alpha: 0.5 })).painted
    for (const [style, dash, cap] of [
      ['dotted', [0, 5], 'round'],
      ['dashed', [6, 4], 'butt'],
      ['solid', [], 'butt']
    ] as const) {
      const [line] = stroked(style)
      expect(line.path).toEqual([['moveTo', 1, 2], ['lineTo', 30, 40]])
      expect([line.style.lineDash, line.style.lineCap, line.style.lineWidth, line.style.globalAlpha]).toEqual([[...dash], cap, 2, 0.5])
    }
  })

  test('a graph node: a star for an entry, a ring for a root, a dot for a step', () => {
    const ops = (node: { entry: boolean; root: boolean }, fill: string | null) =>
      record((ctx) => drawGraphNode(ctx, 0, 0, 1.5, node, '#111111', fill, '#FFFFFF')).painted.map((p) => [
        p.op,
        p.op === 'fill' ? p.style.fillStyle : p.style.strokeStyle,
        p.style.lineJoin
      ])
    expect(ops({ entry: true, root: true }, '#222222')).toEqual([
      ['fill', '#222222', 'miter'],
      ['stroke', '#FFFFFF', 'miter']
    ])
    expect(ops({ entry: true, root: false }, null)).toEqual([['stroke', '#111111', 'miter']])
    expect(ops({ entry: false, root: true }, '#222222')).toEqual([['stroke', '#111111', 'miter']])
    expect(ops({ entry: false, root: false }, '#222222')).toEqual([['fill', '#111111', 'miter']])
    const star = record((ctx) => drawGraphNode(ctx, 0, 0, 1.5, { entry: true, root: false }, '#111111', '#222222', '#FFFFFF'))
    // Ten points and a close, the outer ones 4 * width + 8 out.
    expect(star.painted[0].path).toHaveLength(11)
    expect(star.painted[0].path?.[0]).toEqual(['moveTo', 14 * Math.cos(-Math.PI / 2), 14 * Math.sin(-Math.PI / 2)])
  })
})

// -- as they were -------------------------------------------------------------------------------
//
// Each template used to draw its marks with a copy of its own. These are those copies as they
// stood at f0b1a1d (client/mtf/templates.ts, arevlab/templates.ts, mtf01/templates.ts,
// lab/overlay.ts, tsregistry/marks.ts, tradetalk/templates.ts), kept so each site's drawing is
// held to what it drew before: the same paths, painted in the same order with the same styles.
// Where the call sequence itself is unchanged it is compared too.

const before = {
  arrow(ctx: Ctx, x: number, tipY: number, size: number, color: string, pointingUp: boolean): void {
    const dir = pointingUp ? 1 : -1
    ctx.save()
    ctx.beginPath()
    ctx.moveTo(x, tipY)
    ctx.lineTo(x - size, tipY + dir * size * 1.4)
    ctx.lineTo(x + size, tipY + dir * size * 1.4)
    ctx.closePath()
    ctx.fillStyle = color
    ctx.fill()
    ctx.restore()
  },
  mtfLabel(ctx: Ctx, x: number, y: number, text: string, color: string, size: number, above: boolean): void {
    ctx.save()
    ctx.font = `${size}px sans-serif`
    ctx.textAlign = 'center'
    ctx.textBaseline = above ? 'bottom' : 'top'
    ctx.fillStyle = color
    ctx.fillText(text, x, y)
    ctx.restore()
  },
  star(ctx: Ctx, cx: number, cy: number, outer: number): void {
    const inner = outer * 0.45
    for (let k = 0; k < 10; k++) {
      const r = k % 2 === 0 ? outer : inner
      const a = -Math.PI / 2 + (k * Math.PI) / 5
      if (k === 0) ctx.moveTo(cx + r * Math.cos(a), cy + r * Math.sin(a))
      else ctx.lineTo(cx + r * Math.cos(a), cy + r * Math.sin(a))
    }
    ctx.closePath()
  },
  mtfDot(ctx: Ctx, cx: number, cy: number, width: number, dot: { entry: boolean; root: boolean }, color: string, starFill: string, outline: string): void {
    ctx.beginPath()
    if (dot.entry) {
      before.star(ctx, cx, cy, 4 * width + 8)
      ctx.fillStyle = starFill
      ctx.fill()
      ctx.save()
      ctx.lineJoin = 'miter'
      ctx.strokeStyle = outline
      ctx.stroke()
      ctx.restore()
    } else if (dot.root) {
      ctx.arc(cx, cy, width + 3, 0, Math.PI * 2)
      ctx.strokeStyle = color
      ctx.stroke()
    } else {
      ctx.arc(cx, cy, width + 1.5, 0, Math.PI * 2)
      ctx.fillStyle = color
      ctx.fill()
    }
  },
  labDot(ctx: Ctx, cx: number, cy: number, dot: { entry: boolean; root: boolean; filtered: boolean }, color: string, outline: string): void {
    const WIDTH = 1.5
    ctx.beginPath()
    ctx.lineWidth = WIDTH
    if (dot.entry) {
      before.star(ctx, cx, cy, 4 * WIDTH + 8)
      if (dot.filtered) {
        ctx.strokeStyle = color
        ctx.stroke()
      } else {
        ctx.fillStyle = color
        ctx.fill()
        ctx.save()
        ctx.lineJoin = 'miter'
        ctx.strokeStyle = outline
        ctx.stroke()
        ctx.restore()
      }
    } else if (dot.root) {
      ctx.arc(cx, cy, WIDTH + 3, 0, Math.PI * 2)
      ctx.strokeStyle = color
      ctx.stroke()
    } else {
      ctx.arc(cx, cy, WIDTH + 1.5, 0, Math.PI * 2)
      ctx.fillStyle = color
      ctx.fill()
    }
  },
  labPoolSignal(ctx: Ctx, cx: number, tip: number, above: boolean, color: string): void {
    const dir = above ? -1 : 1
    ctx.beginPath()
    ctx.moveTo(cx, tip)
    ctx.lineTo(cx - 3.5, tip + dir * 6)
    ctx.lineTo(cx + 3.5, tip + dir * 6)
    ctx.closePath()
    ctx.fillStyle = color
    ctx.globalAlpha = 0.7
    ctx.fill()
    ctx.globalAlpha = 1
  },
  labCloseCross(ctx: Ctx, cx: number, cy: number, color: string): void {
    ctx.strokeStyle = color
    ctx.beginPath()
    ctx.moveTo(cx - 4, cy - 4)
    ctx.lineTo(cx + 4, cy + 4)
    ctx.moveTo(cx + 4, cy - 4)
    ctx.lineTo(cx - 4, cy + 4)
    ctx.stroke()
  },
  paint(ctx: Ctx, color: string, fill: Fill, alpha: number): void {
    ctx.lineWidth = 1.5
    ctx.strokeStyle = color
    if (fill !== 'hollow') {
      ctx.globalAlpha = alpha * (fill === 'pending' ? 0.45 : 1)
      ctx.fillStyle = color
      ctx.fill()
      ctx.globalAlpha = alpha
    }
    ctx.stroke()
  },
  mtf01TriangleDown(ctx: Ctx, x: number, y: number, size: number, color: string, fill: Fill, alpha: number): void {
    ctx.save()
    ctx.globalAlpha = alpha
    ctx.beginPath()
    ctx.moveTo(x, y + size)
    ctx.lineTo(x - size, y - size * 0.4)
    ctx.lineTo(x + size, y - size * 0.4)
    ctx.closePath()
    before.paint(ctx, color, fill, alpha)
    ctx.restore()
  },
  mtf01Dot(ctx: Ctx, x: number, y: number, r: number, color: string, alpha: number): void {
    ctx.save()
    ctx.globalAlpha = alpha
    ctx.beginPath()
    ctx.arc(x, y, r, 0, Math.PI * 2)
    ctx.strokeStyle = color
    ctx.lineWidth = 1
    ctx.stroke()
    ctx.restore()
  },
  label(ctx: Ctx, x: number, y: number, text: string, color: string): void {
    ctx.save()
    ctx.font = '10px sans-serif'
    ctx.textAlign = 'left'
    ctx.textBaseline = 'middle'
    ctx.fillStyle = color
    ctx.fillText(text, x, y)
    ctx.restore()
  },
  path(ctx: Ctx, shape: MarkShape, x: number, y: number, size: number): void {
    ctx.beginPath()
    switch (shape) {
      case 'arrow-up':
        ctx.moveTo(x, y)
        ctx.lineTo(x - size, y + size * 1.4)
        ctx.lineTo(x + size, y + size * 1.4)
        ctx.closePath()
        break
      case 'arrow-down':
        ctx.moveTo(x, y)
        ctx.lineTo(x - size, y - size * 1.4)
        ctx.lineTo(x + size, y - size * 1.4)
        ctx.closePath()
        break
      case 'triangle-up':
        ctx.moveTo(x, y - size)
        ctx.lineTo(x - size, y + size * 0.8)
        ctx.lineTo(x + size, y + size * 0.8)
        ctx.closePath()
        break
      case 'triangle-down':
        ctx.moveTo(x, y + size)
        ctx.lineTo(x - size, y - size * 0.8)
        ctx.lineTo(x + size, y - size * 0.8)
        ctx.closePath()
        break
      case 'square':
        ctx.rect(x - size, y - size, size * 2, size * 2)
        break
      case 'diamond':
        ctx.moveTo(x, y - size)
        ctx.lineTo(x + size, y)
        ctx.lineTo(x, y + size)
        ctx.lineTo(x - size, y)
        ctx.closePath()
        break
      case 'cross':
        ctx.moveTo(x - size, y - size)
        ctx.lineTo(x + size, y + size)
        ctx.moveTo(x + size, y - size)
        ctx.lineTo(x - size, y + size)
        break
      default:
        ctx.arc(x, y, size, 0, Math.PI * 2)
        break
    }
  },
  drawMark(ctx: Ctx, mark: { shape: MarkShape; size?: number }, x: number, y: number, size: number, fill: Fill, color: string): void {
    ctx.save()
    const alpha = mark.size != null && mark.size < 0.35 ? 0.5 : 1
    ctx.globalAlpha = alpha
    before.path(ctx, mark.shape, x, y, size)
    before.paint(ctx, color, fill, alpha)
    ctx.restore()
  },
  tradeTalkArrow(ctx: Ctx, x: number, y: number, size: number, up: boolean, color: string): void {
    const base = up ? y + size : y - size
    ctx.beginPath()
    ctx.moveTo(x, y)
    ctx.lineTo(x - size * 0.7, base)
    ctx.lineTo(x + size * 0.7, base)
    ctx.closePath()
    ctx.fillStyle = color
    ctx.fill()
  },
  tradeTalkSweep(ctx: Ctx, x: number, y: number, color: string): void {
    ctx.fillStyle = color
    ctx.beginPath()
    ctx.arc(x, y, 2.5, 0, Math.PI * 2)
    ctx.fill()
  }
}

/** Two drawings paint the same thing; with `strict`, by the very same calls. */
function same(old: (ctx: Ctx) => void, now: (ctx: Ctx) => void, strict: boolean): void {
  const a = record(old)
  const b = record(now)
  expect(b.painted).toEqual(a.painted)
  if (strict) expect(b.calls).toEqual(a.calls)
}

describe('every site draws what it drew before', () => {
  test('mtf/templates and arevlab/templates: the signal arrow', () => {
    for (const { x, y, size, up } of grid()) same((ctx) => before.arrow(ctx, x, y, size, '#26A69A', up), (ctx) => fillArrow(ctx, x, y, size, '#26A69A', up), true)
  })

  test('mtf/templates: the arrow label', () => {
    for (const { x, y, size, up } of grid()) {
      same(
        (ctx) => before.mtfLabel(ctx, x, y, '4h 0.41', '#FFA726', size, up),
        (ctx) => drawText(ctx, x, y, '4h 0.41', '#FFA726', { size, align: 'center', baseline: up ? 'bottom' : 'top' }),
        true
      )
    }
  })

  test('mtf/templates: the graph nodes', () => {
    for (const { x, y, size } of grid()) {
      for (const node of [{ entry: true, root: false }, { entry: true, root: true }, { entry: false, root: true }, { entry: false, root: false }]) {
        same(
          (ctx) => before.mtfDot(ctx, x, y, size / 2, node, '#3F51B5', '#FFD600', '#FFFFFF'),
          (ctx) => drawGraphNode(ctx, x, y, size / 2, node, '#3F51B5', '#FFD600', '#FFFFFF'),
          true
        )
      }
    }
  })

  test('lab/overlay: the graph nodes, a filtered entry hollow', () => {
    for (const { x, y } of grid()) {
      for (const node of [
        { entry: true, root: false, filtered: false },
        { entry: true, root: false, filtered: true },
        { entry: false, root: true, filtered: false },
        { entry: false, root: false, filtered: false }
      ]) {
        same(
          (ctx) => before.labDot(ctx, x, y, node, '#3F51B5', '#FFFFFF'),
          (ctx) => {
            ctx.lineWidth = 1.5
            drawGraphNode(ctx, x, y, 1.5, node, '#3F51B5', node.filtered ? null : '#3F51B5', '#FFFFFF')
          },
          // The line width is now set before the path is begun rather than after.
          false
        )
      }
    }
  })

  test('lab/overlay: a pool signal and a closed trade', () => {
    for (const { x, y, up } of grid()) {
      same(
        (ctx) => before.labPoolSignal(ctx, x, y, up, '#FFA726'),
        (ctx) => {
          arrowPath(ctx, x, y, 3.5, 6, !up)
          ctx.fillStyle = '#FFA726'
          ctx.globalAlpha = 0.7
          ctx.fill()
          ctx.globalAlpha = 1
        },
        true
      )
      same(
        (ctx) => before.labCloseCross(ctx, x, y, '#EF5350'),
        (ctx) => {
          ctx.strokeStyle = '#EF5350'
          shapePath(ctx, 'cross', x, y, 4)
          ctx.stroke()
        },
        true
      )
    }
  })

  test('mtf/templates and lab/overlay: the star', () => {
    for (const { x, y, size } of grid()) same((ctx) => before.star(ctx, x, y, size * 2), (ctx) => starPath(ctx, x, y, size * 2), true)
  })

  test('mtf01/templates: the rung arrow, the rejected ring and the P&L label', () => {
    for (const { x, y, size } of grid()) {
      for (const fill of FILLS) {
        same(
          (ctx) => before.mtf01TriangleDown(ctx, x, y, size, '#E53935', fill, 1),
          (ctx) => {
            ctx.save()
            ctx.globalAlpha = 1
            trianglePath(ctx, x, y, size, false, 0.4)
            paintShape(ctx, '#E53935', fill, 1)
            ctx.restore()
          },
          true
        )
      }
      same(
        (ctx) => before.mtf01Dot(ctx, x, y, size * 0.45, '#8E24AA', 0.5),
        (ctx) => drawShape(ctx, 'circle', x, y, size * 0.45, '#8E24AA', { fill: 'hollow', alpha: 0.5, lineWidth: 1 }),
        // `paintShape` sets the line width before the colour.
        false
      )
      same((ctx) => before.label(ctx, x, y, '+12.3', '#26A69A'), (ctx) => drawText(ctx, x, y, '+12.3', '#26A69A'), true)
    }
  })

  test('tsregistry/templates and arev21div/templates: every registry shape, fill and size', () => {
    for (const { x, y, size } of grid()) {
      for (const shape of [...SHAPES, 'unknown' as MarkShape]) {
        for (const fill of FILLS) {
          for (const markSize of [undefined, 0.28, 0.35, 0.7, 1.6]) {
            const alpha = markSize != null && markSize < 0.35 ? 0.5 : 1
            same(
              (ctx) => before.drawMark(ctx, { shape, size: markSize }, x, y, size, fill, '#787B86'),
              (ctx) => drawShape(ctx, shape, x, y, size, '#787B86', { fill, alpha }),
              true
            )
          }
        }
      }
      // arev21div's arrows: a solid arrow sized 1 or 0.7, so always at full strength.
      for (const shape of ['arrow-up', 'arrow-down'] as const) {
        for (const scale of [1, 0.7]) {
          same(
            (ctx) => before.drawMark(ctx, { shape, size: scale }, x, y, size * scale, 'solid', '#26A69A'),
            (ctx) => drawShape(ctx, shape, x, y, size * scale, '#26A69A'),
            true
          )
        }
      }
      same((ctx) => before.label(ctx, x + size + 3, y, '0.42', '#426EFF'), (ctx) => drawText(ctx, x + size + 3, y, '0.42', '#426EFF'), true)
    }
  })

  test('tradetalk/templates: the entry arrow and the sweep dot', () => {
    for (const { x, y, size, up } of grid()) {
      same(
        (ctx) => before.tradeTalkArrow(ctx, x, y, size, up, '#26A69A'),
        (ctx) => {
          arrowPath(ctx, x, y, size * 0.7, size, up)
          ctx.fillStyle = '#26A69A'
          ctx.fill()
        },
        true
      )
      // The colour is now set after the path rather than before it.
      same((ctx) => before.tradeTalkSweep(ctx, x, y, '#AB47BC'), (ctx) => fillDot(ctx, x, y, 2.5, '#AB47BC'), false)
    }
  })
})
