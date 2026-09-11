import type { MarkShape, MarkSpec } from './api'

// The mark vocabulary, drawn from a registry row. Every per-bar symbol the chart puts on an
// indicator -- AREV's signal arrows, krev01's vote triangles and its leaning dots, a
// crossover's up/down markers -- is one of these, chosen by a predicate and styled by the
// row. Before the registry each of those was a `draw` callback of its own, and the three
// that drew a triangle drew three different triangles.

export type Fill = 'solid' | 'hollow' | 'pending'

/** A filled shape is the event; a hollow one is the same event that then failed; a
 * half-transparent one is still in play. One rule, so two panes cannot mean different
 * things by a hollow triangle. */
function paint(ctx: CanvasRenderingContext2D, color: string, fill: Fill, alpha: number): void {
  ctx.lineWidth = 1.5
  ctx.strokeStyle = color
  if (fill !== 'hollow') {
    ctx.globalAlpha = alpha * (fill === 'pending' ? 0.45 : 1)
    ctx.fillStyle = color
    ctx.fill()
    ctx.globalAlpha = alpha
  }
  ctx.stroke()
}

function path(ctx: CanvasRenderingContext2D, shape: MarkShape, x: number, y: number, size: number): void {
  ctx.beginPath()
  switch (shape) {
    // An arrow points AT the thing and sits clear of it: the tip is the anchor and the body
    // hangs away, which is why `arrow-up` extends downward from y.
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
    // A triangle is centred ON the anchor: it marks a value, it does not point at a candle.
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
    // circle, and anything a newer registry row names that this build does not know: a
    // mark that is drawn as a dot is better than a mark that silently is not drawn at all.
    default:
      ctx.arc(x, y, size, 0, Math.PI * 2)
      break
  }
}

export function drawMark(
  ctx: CanvasRenderingContext2D,
  mark: MarkSpec,
  x: number,
  y: number,
  size: number,
  fill: Fill,
  color: string
): void {
  ctx.save()
  const alpha = mark.size != null && mark.size < 0.35 ? 0.5 : 1
  ctx.globalAlpha = alpha
  path(ctx, mark.shape, x, y, size)
  paint(ctx, color, fill, alpha)
  ctx.restore()
}

/** Beside the mark, not above it: the pane's y-axis already measures what the label says, so
 * a label above a mark near the top of the pane lands in the legend row. */
export function drawLabel(ctx: CanvasRenderingContext2D, x: number, y: number, text: string, color: string): void {
  ctx.save()
  ctx.font = '10px sans-serif'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = color
  ctx.fillText(text, x, y)
  ctx.restore()
}
