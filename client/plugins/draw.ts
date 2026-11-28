// Drawing constants and the canvas marks shared by the plugins' templates.
//
// The marks the templates put on the chart -- a registry row's arrows, triangles and dots
// (AREV's signals, krev01's votes, a crossover's markers), the MTF overlays' arrows and graph
// nodes, the Strategy Lab's stars, mtf01's rungs, the divergence's links -- are drawn with
// these. Each template used to carry its own copy: the same star twice, the same arrow three
// times, triangles in three proportions. A mark that means the same thing on two panes is now
// the same function, and a template that wants another proportion says so in its arguments.

/** klinecharts pads an indicator pane's y-axis by 20% above and 10% below its data range,
 * which is sized for a candle pane (room for the legend, and for a price line to sit off the
 * top). A pane whose range is already bounded either side by flat threshold lines spends
 * most of that on empty pane; this gives it half -- enough that the top line clears the
 * legend row. Registry rows carry their own `axisGap`; this is the default the panes that
 * are not registry-driven use. */
export const AXIS_GAP = { top: 0.1, bottom: 0.05 }

/** The shapes a mark can take. A registry row names one (`MarkSpec.shape`); anything a newer
 * row names that this build does not know is drawn as a circle (`shapePath`). */
export type MarkShape =
  | 'arrow-up'
  | 'arrow-down'
  | 'triangle-up'
  | 'triangle-down'
  | 'circle'
  | 'square'
  | 'diamond'
  | 'cross'

/** A filled shape is the event; a hollow one is the same event that then failed; a
 * half-transparent one is still in play. One rule, so two panes cannot mean different
 * things by a hollow triangle. */
export type Fill = 'solid' | 'hollow' | 'pending'

/** How far an arrow's base sits from its tip, per unit of its half-width. */
export const ARROW_LENGTH = 1.4

/** Paints the current path by the `Fill` rule: outlined in `color` at `lineWidth`, and filled
 * unless hollow -- at `alpha`, or under half of it while pending. Leaves `globalAlpha` at
 * `alpha`. */
export function paintShape(ctx: CanvasRenderingContext2D, color: string, fill: Fill, alpha: number, lineWidth = 1.5): void {
  ctx.lineWidth = lineWidth
  ctx.strokeStyle = color
  if (fill !== 'hollow') {
    ctx.globalAlpha = alpha * (fill === 'pending' ? 0.45 : 1)
    ctx.fillStyle = color
    ctx.fill()
    ctx.globalAlpha = alpha
  }
  ctx.stroke()
}

/** A new path: an arrow whose TIP is at (x, tipY), its base `length` away on the side it comes
 * from and `halfWidth` either side -- so an up arrow's body hangs below its tip. An arrow points
 * AT the thing and sits clear of it. */
export function arrowPath(ctx: CanvasRenderingContext2D, x: number, tipY: number, halfWidth: number, length: number, up: boolean): void {
  const base = up ? tipY + length : tipY - length
  ctx.beginPath()
  ctx.moveTo(x, tipY)
  ctx.lineTo(x - halfWidth, base)
  ctx.lineTo(x + halfWidth, base)
  ctx.closePath()
}

/** A new path: a triangle CENTRED on (x, y) -- it marks a value rather than pointing at a
 * candle -- its point `size` away, its base `base * size` the other side. */
export function trianglePath(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, up: boolean, base = 0.8): void {
  ctx.beginPath()
  if (up) {
    ctx.moveTo(x, y - size)
    ctx.lineTo(x - size, y + size * base)
    ctx.lineTo(x + size, y + size * base)
  } else {
    ctx.moveTo(x, y + size)
    ctx.lineTo(x - size, y - size * base)
    ctx.lineTo(x + size, y - size * base)
  }
  ctx.closePath()
}

/** A new path: `shape` at (x, y), `size` its half-width. */
export function shapePath(ctx: CanvasRenderingContext2D, shape: MarkShape, x: number, y: number, size: number): void {
  switch (shape) {
    case 'arrow-up':
      arrowPath(ctx, x, y, size, size * ARROW_LENGTH, true)
      return
    case 'arrow-down':
      arrowPath(ctx, x, y, size, size * ARROW_LENGTH, false)
      return
    case 'triangle-up':
      trianglePath(ctx, x, y, size, true)
      return
    case 'triangle-down':
      trianglePath(ctx, x, y, size, false)
      return
  }
  ctx.beginPath()
  switch (shape) {
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
    // circle, and anything a newer registry row names that this build does not know: a
    // mark that is drawn as a dot is better than a mark that silently is not drawn at all.
    default:
      ctx.arc(x, y, size, 0, Math.PI * 2)
      break
  }
}

/** `shape` at (x, y), painted by the `Fill` rule at `alpha`. Leaves the context as it found it. */
export function drawShape(
  ctx: CanvasRenderingContext2D,
  shape: MarkShape,
  x: number,
  y: number,
  size: number,
  color: string,
  paint: { fill?: Fill; alpha?: number; lineWidth?: number } = {}
): void {
  const alpha = paint.alpha ?? 1
  ctx.save()
  ctx.globalAlpha = alpha
  shapePath(ctx, shape, x, y, size)
  paintShape(ctx, color, paint.fill ?? 'solid', alpha, paint.lineWidth)
  ctx.restore()
}

/** A filled arrow with no outline, tip at (x, tipY) and `ARROW_LENGTH` deep: the MTF overlays'
 * and the AREV lab's signal arrow. Leaves the context as it found it. */
export function fillArrow(ctx: CanvasRenderingContext2D, x: number, tipY: number, size: number, color: string, up: boolean): void {
  ctx.save()
  arrowPath(ctx, x, tipY, size, size * ARROW_LENGTH, up)
  ctx.fillStyle = color
  ctx.fill()
  ctx.restore()
}

/** Adds a five-pointed star centred on (`cx`, `cy`), point up, to the current path. */
export function starPath(ctx: CanvasRenderingContext2D, cx: number, cy: number, outer: number): void {
  const inner = outer * 0.45
  for (let k = 0; k < 10; k++) {
    const r = k % 2 === 0 ? outer : inner
    const a = -Math.PI / 2 + (k * Math.PI) / 5
    if (k === 0) ctx.moveTo(cx + r * Math.cos(a), cy + r * Math.sin(a))
    else ctx.lineTo(cx + r * Math.cos(a), cy + r * Math.sin(a))
  }
  ctx.closePath()
}

/** A filled dot of radius `r`, in a new path. */
export function fillDot(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string): void {
  ctx.beginPath()
  ctx.arc(x, y, r, 0, Math.PI * 2)
  ctx.fillStyle = color
  ctx.fill()
}

/** One node of a signal graph, as the MTF overlays and the Strategy Lab both draw it, sized
 * from the graph's line width: an entry a star, a graph's root a ring, a step a dot. A star is
 * filled with `starFill` and outlined in `starOutline` with mitred joins, so the points stay
 * points and a dark fill still reads on a dark chart; a null `starFill` draws it hollow, in
 * `color`. The line width the ring and the outlines are stroked at is the caller's. */
export function drawGraphNode(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  width: number,
  node: { entry: boolean; root: boolean },
  color: string,
  starFill: string | null,
  starOutline: string
): void {
  if (node.entry) {
    ctx.beginPath()
    starPath(ctx, cx, cy, 4 * width + 8)
    if (starFill === null) {
      ctx.strokeStyle = color
      ctx.stroke()
      return
    }
    ctx.fillStyle = starFill
    ctx.fill()
    ctx.save()
    ctx.lineJoin = 'miter'
    ctx.strokeStyle = starOutline
    ctx.stroke()
    ctx.restore()
  } else if (node.root) {
    // A ring, so where a graph starts reads apart from the steps it takes.
    ctx.beginPath()
    ctx.arc(cx, cy, width + 3, 0, Math.PI * 2)
    ctx.strokeStyle = color
    ctx.stroke()
  } else {
    fillDot(ctx, cx, cy, width + 1.5, color)
  }
}

/** Text at (x, y), by default 10 px, left-aligned and vertically centred: beside a mark rather
 * than above it, since the pane's y-axis already measures what the label says and a label above
 * a mark near the top of the pane lands in the legend row. Leaves the context as it found it. */
export function drawText(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  text: string,
  color: string,
  layout: { size?: number; align?: CanvasTextAlign; baseline?: CanvasTextBaseline } = {}
): void {
  ctx.save()
  ctx.font = `${layout.size ?? 10}px sans-serif`
  ctx.textAlign = layout.align ?? 'left'
  ctx.textBaseline = layout.baseline ?? 'middle'
  ctx.fillStyle = color
  ctx.fillText(text, x, y)
  ctx.restore()
}

/** How a link is stroked. `dotted` is round dots as wide as the line, so a thick dotted line
 * reads as a row of beads rather than a dash pattern. */
interface LinkStyle {
  style: 'solid' | 'dashed' | 'dotted'
  width: number
  /** 0..1; a fainter line for a weaker reading. */
  alpha?: number
}

/** A straight line between two points -- a divergence's two swings -- drawn under the mark that
 * goes with it, so the mark stays legible. Leaves the context as it found it. */
export function drawLink(
  ctx: CanvasRenderingContext2D,
  from: { x: number; y: number },
  to: { x: number; y: number },
  color: string,
  style: LinkStyle
): void {
  ctx.save()
  ctx.globalAlpha = style.alpha ?? 1
  ctx.lineWidth = style.width
  ctx.strokeStyle = color
  // A zero-length dash with round caps is a dot of the line's width, and the gap is measured
  // between dot centres; both patterns scale with the width, so a thick line keeps its shape.
  ctx.lineCap = style.style === 'dotted' ? 'round' : 'butt'
  ctx.setLineDash(
    style.style === 'dotted' ? [0, style.width * 2.5] : style.style === 'dashed' ? [style.width * 3, style.width * 2] : []
  )
  ctx.beginPath()
  ctx.moveTo(from.x, from.y)
  ctx.lineTo(to.x, to.y)
  ctx.stroke()
  ctx.restore()
}
