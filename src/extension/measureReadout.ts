/**
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at

 * http://www.apache.org/licenses/LICENSE-2.0

 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// What the price pane's ruler (./measure.ts) says about a measurement, kept apart from the
// overlay template because importing klinecharts at runtime needs a window, and this is the
// part worth testing.

export interface MeasureInput {
  /** The price pressed on, and the price now under the pointer (or released on). */
  from: number
  to: number
  /** Whole bars between the two points' candles. */
  bars: number
  /** Milliseconds between the two points' candles. */
  spanMs: number
  /** The instrument's display precision. */
  precision: number
  /** One pip in price, or absent for an instrument not priced in pips. */
  pipSize?: number | null
}

export interface MeasureReadout {
  /** The move was up (or flat): the label sits above the box and takes the up colour. */
  up: boolean
  /** "+0.00123 (+0.11%)  +12.3 pips" */
  move: string
  /** "15 bars, 15h" */
  span: string
}

// A typographic minus, as the trading panel's pip figures use (client/trading/format.ts).
function signed(text: string, value: number): string {
  return value > 0 ? `+${text}` : value < 0 ? `−${text}` : text
}

/** A span of time as its two largest units: "45s", "12m 30s", "15h", "3d 4h". */
export function formatSpan(ms: number): string {
  const seconds = Math.round(Math.abs(ms) / 1000)
  const units: Array<[number, string]> = [[86400, 'd'], [3600, 'h'], [60, 'm'], [1, 's']]
  const first = units.findIndex(([size]) => seconds >= size)
  if (first === -1) return '0s'
  const [size, unit] = units[first]
  const whole = Math.floor(seconds / size)
  const rest = seconds - whole * size
  const next = units[first + 1]
  const part = next ? Math.floor(rest / next[0]) : 0
  return part > 0 && next ? `${whole}${unit} ${part}${next[1]}` : `${whole}${unit}`
}

export function measureReadout({ from, to, bars, spanMs, precision, pipSize }: MeasureInput): MeasureReadout {
  const delta = to - from
  // Rounded at the display precision before it is signed, so a move the axis would print as
  // 0.00000 is never labelled "-0.00000".
  const shown = Number(Math.abs(delta).toFixed(precision))
  const sign = shown === 0 ? 0 : delta
  const parts = [signed(shown.toFixed(precision), sign)]
  if (from !== 0) {
    const percent = (delta / Math.abs(from)) * 100
    const percentShown = Math.abs(percent).toFixed(2)
    parts[0] += ` (${signed(percentShown, Number(percentShown) === 0 ? 0 : percent)}%)`
  }
  if (pipSize && pipSize > 0) {
    const pips = delta / pipSize
    const pipsShown = Math.abs(pips).toFixed(1)
    parts.push(`${signed(pipsShown, Number(pipsShown) === 0 ? 0 : pips)} pips`)
  }
  const barCount = Math.abs(Math.round(bars))
  return {
    up: delta >= 0,
    move: parts.join('  '),
    span: `${barCount} ${barCount === 1 ? 'bar' : 'bars'}, ${formatSpan(spanMs)}`
  }
}

// The box and the axis band are the direction's colour at this opacity; the label and the
// axis tags are the colour itself, with white text.
export const FILL_ALPHA = 0.15

/** `color` at `alpha`, for the hex and rgb() spellings a theme or the settings dialog gives. */
export function withAlpha(color: string, alpha: number): string {
  const hex = /^#([0-9a-f]{3,8})$/i.exec(color.trim())?.[1]
  if (hex && (hex.length === 3 || hex.length === 6 || hex.length === 8)) {
    const full = hex.length === 3 ? [...hex].map((c) => c + c).join('') : hex.slice(0, 6)
    const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16))
    return `rgba(${r}, ${g}, ${b}, ${alpha})`
  }
  const rgb = /^rgba?\(([^,]+),([^,]+),([^,)]+)/i.exec(color.trim())
  if (rgb) return `rgba(${rgb[1].trim()}, ${rgb[2].trim()}, ${rgb[3].trim()}, ${alpha})`
  return color
}
