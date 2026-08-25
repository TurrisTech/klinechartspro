// Marker primitives shared by the plugins' `draw` callbacks. klinecharts hands a template a
// raw 2D context; these are the shapes every marker template here used to define for itself.

export function upArrow(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, color: string): void {
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.moveTo(x, y)
  ctx.lineTo(x - size, y + size * 1.4)
  ctx.lineTo(x + size, y + size * 1.4)
  ctx.closePath()
  ctx.fill()
}

export function downArrow(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, color: string): void {
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.moveTo(x, y)
  ctx.lineTo(x - size, y - size * 1.4)
  ctx.lineTo(x + size, y - size * 1.4)
  ctx.closePath()
  ctx.fill()
}

/** Marker size from the bar spacing, clamped. */
export function markerSize(barSpace: number, scale = 0.45, min = 4, max = 9): number {
  return Math.max(min, Math.min(max, barSpace * scale))
}
