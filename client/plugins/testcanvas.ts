// A 2D canvas context that records what is drawn on it, for tests of the templates' drawing.
// Not shipped: nothing outside `*.test.ts` imports this.
//
// Two records. `calls` is every method call and every style assignment, in order -- the strict
// one, for a drawing whose sequence must be exactly what it was. `painted` is one entry per
// fill, stroke or text, carrying the path it painted and every style in force at that moment:
// what reaches the pixels. Two drawings that set the same styles in a different order between
// two paints record the same `painted` and different `calls`.

type PathCommand = [string, ...unknown[]]

interface PaintStyle {
  fillStyle: unknown
  strokeStyle: unknown
  lineWidth: number
  globalAlpha: number
  lineDash: number[]
  lineJoin: string
  lineCap: string
  font: string
  textAlign: string
  textBaseline: string
}

export interface Painted {
  op: string
  /** The path a `fill` or `stroke` painted, from its `beginPath`. */
  path?: PathCommand[]
  /** A text or rectangle op's own arguments. */
  args?: unknown[]
  style: PaintStyle
}

export interface RecordingContext {
  ctx: CanvasRenderingContext2D
  calls: unknown[][]
  painted: Painted[]
}

const DEFAULT_STYLE: PaintStyle = {
  fillStyle: '#000000',
  strokeStyle: '#000000',
  lineWidth: 1,
  globalAlpha: 1,
  lineDash: [],
  lineJoin: 'miter',
  lineCap: 'butt',
  font: '10px sans-serif',
  textAlign: 'start',
  textBaseline: 'alphabetic'
}

const PATH_OPS = new Set(['moveTo', 'lineTo', 'arc', 'arcTo', 'rect', 'closePath', 'quadraticCurveTo', 'bezierCurveTo', 'ellipse'])
const SHAPE_OPS = new Set(['fillText', 'strokeText', 'fillRect', 'strokeRect', 'clearRect'])

export function recordingContext(): RecordingContext {
  const calls: unknown[][] = []
  const painted: Painted[] = []
  let style: PaintStyle = { ...DEFAULT_STYLE, lineDash: [] }
  const stack: PaintStyle[] = []
  let path: PathCommand[] = []
  const snapshot = (): PaintStyle => ({ ...style, lineDash: [...style.lineDash] })

  const methods: Record<string, (...args: unknown[]) => unknown> = {
    save: () => {
      stack.push(snapshot())
    },
    restore: () => {
      style = stack.pop() ?? style
    },
    beginPath: () => {
      path = []
    },
    setLineDash: (dash) => {
      style.lineDash = [...(dash as number[])]
    },
    getLineDash: () => [...style.lineDash],
    measureText: (text) => ({ width: String(text).length * 6 }),
    fill: () => {
      painted.push({ op: 'fill', path: path.map((c) => [...c] as PathCommand), style: snapshot() })
    },
    stroke: () => {
      painted.push({ op: 'stroke', path: path.map((c) => [...c] as PathCommand), style: snapshot() })
    }
  }

  const ctx = new Proxy({} as Record<string, unknown>, {
    get(_, name: string) {
      if (name in style) return (style as unknown as Record<string, unknown>)[name]
      return (...args: unknown[]) => {
        calls.push([name, ...args])
        if (PATH_OPS.has(name)) path.push([name, ...args])
        else if (SHAPE_OPS.has(name)) painted.push({ op: name, args, style: snapshot() })
        return methods[name]?.(...args)
      }
    },
    set(_, name: string, value: unknown) {
      calls.push(['set', name, value])
      ;(style as unknown as Record<string, unknown>)[name] = value
      return true
    }
  })
  return { ctx: ctx as unknown as CanvasRenderingContext2D, calls, painted }
}
