// Minimal, dependency-free color math for the visual-encoding layer (encoding.ts). Canvas
// `strokeStyle` accepts CSS color strings directly, so every helper here returns one rather
// than a stylesheet construct like `color-mix()` — klinecharts' canvas renderer never touches
// CSS, so a value it can't hand straight to the 2D context is not usable here.

export interface Rgb {
  r: number
  g: number
  b: number
}

// Accepts '#rgb', '#rrggbb', 'rgb(r, g, b)' and 'rgba(r, g, b, a)'. Anything else (a named
// CSS color, an unparseable string) falls back to opaque black rather than throwing — a
// server-supplied or hand-typed color the client can't parse should degrade visibly, not
// crash the draw.
export function parseColor(color: string): Rgb {
  const hex = color.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)
  if (hex) {
    const value = hex[1]
    const expand = (c: string): string => c + c
    const [r, g, b] =
      value.length === 3
        ? [expand(value[0]), expand(value[1]), expand(value[2])].map((c) => parseInt(c, 16))
        : [value.slice(0, 2), value.slice(2, 4), value.slice(4, 6)].map((c) => parseInt(c, 16))
    return { r, g, b }
  }
  const rgb = color.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*[\d.]+\s*)?\)$/i)
  if (rgb) return { r: Number(rgb[1]), g: Number(rgb[2]), b: Number(rgb[3]) }
  return { r: 0, g: 0, b: 0 }
}

export function toCssRgba({ r, g, b }: Rgb, alpha: number): string {
  const a = Math.min(1, Math.max(0, alpha))
  return `rgba(${r}, ${g}, ${b}, ${a})`
}

// Blends `color` toward transparent by `alpha` (1 = unchanged, 0 = invisible). This is what
// "dimmer with age" means on a canvas — there is no separate opacity field on
// `SmoothLineStyle` (klinecharts/dist/index.d.ts), so alpha has to live in the color string.
export function withAlpha(color: string, alpha: number): string {
  return toCssRgba(parseColor(color), alpha)
}

// Shifts perceived lightness by `factor` (positive = brighter, negative = dimmer), holding
// hue and saturation fixed — a 'brighter' reading that isn't also 'more see-through', for a
// future colorMode that wants that distinction. The default Levels encoding drives
// brightness through withAlpha instead, since these are thin lines on a dark canvas where
// dimmer and more-transparent read the same.
export function withLightness(color: string, factor: number): string {
  const { r, g, b } = parseColor(color)
  const [h, s, l] = rgbToHsl(r, g, b)
  const nextL = Math.min(1, Math.max(0, l + factor))
  const [nr, ng, nb] = hslToRgb(h, s, nextL)
  return toCssRgba({ r: nr, g: ng, b: nb }, 1)
}

// Lowers perceived lightness by `amount`, stopping at `floor` rather than at black. This is
// the shape a per-step gradient needs and `withLightness` is not: capping the SHIFT instead
// of the RESULT bottoms out differently for every color it is given — the Levels 1W green
// sits at lightness 0.32, so the same -0.3 that merely deepens a yellow erases it entirely.
export function darkenToward(color: string, amount: number, floor: number): string {
  const { r, g, b } = parseColor(color)
  const [h, s, l] = rgbToHsl(r, g, b)
  const nextL = Math.max(Math.min(l, floor), l - amount)
  const [nr, ng, nb] = hslToRgb(h, s, nextL)
  return toCssRgba({ r: nr, g: ng, b: nb }, 1)
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  let h: number
  switch (max) {
    case rn:
      h = (gn - bn) / d + (gn < bn ? 6 : 0)
      break
    case gn:
      h = (bn - rn) / d + 2
      break
    default:
      h = (rn - gn) / d + 4
  }
  return [h / 6, s, l]
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) {
    const v = Math.round(l * 255)
    return [v, v, v]
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const hue = (t: number): number => {
    let tt = t
    if (tt < 0) tt += 1
    if (tt > 1) tt -= 1
    if (tt < 1 / 6) return p + (q - p) * 6 * tt
    if (tt < 1 / 2) return q
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6
    return p
  }
  return [
    Math.round(hue(h + 1 / 3) * 255),
    Math.round(hue(h) * 255),
    Math.round(hue(h - 1 / 3) * 255)
  ]
}
