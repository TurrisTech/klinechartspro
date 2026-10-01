import type { Atoms } from './atoms'

// PURE. A range of chart bars' histograms (atoms.ts) -> the profile that is drawn: rows,
// the point of control and the value area.
//
// Rows are cut over the price span the range actually traded -- its lowest and highest atom
// with volume -- and each atom's volume is shared between the rows it overlaps in proportion
// to the overlap. Assigning a whole atom to the row its centre falls in would be cheaper and
// would alias: a row one atom tall next to one two atoms tall draws a comb out of flat volume.

export interface Profile {
  /** Price of the bottom of row 0 and the top of the last row. */
  lo: number
  hi: number
  rowHeight: number
  /** Per row, bottom first. */
  up: Float64Array
  down: Float64Array
  total: number
  /** Of `total`, what was spread from chart bars rather than source bars (atoms.ts). */
  coarse: number
  /** The row with the most volume. */
  poc: number
  /** The value area, rows inclusive. */
  vaLow: number
  vaHigh: number
}

/** The atoms of chart bars `from`..`to` inclusive, summed onto one grid. */
export function sumAtoms(slots: readonly (Atoms | null)[], from: number, to: number): Atoms | null {
  let kmin = Number.POSITIVE_INFINITY
  let kmax = Number.NEGATIVE_INFINITY
  const a = Math.max(0, from)
  const b = Math.min(slots.length - 1, to)
  for (let i = a; i <= b; i++) {
    const s = slots[i]
    if (!s || s.total <= 0) continue
    if (s.first < kmin) kmin = s.first
    if (s.first + s.up.length - 1 > kmax) kmax = s.first + s.up.length - 1
  }
  if (!Number.isFinite(kmin)) return null
  const size = kmax - kmin + 1
  const out: Atoms = { first: kmin, up: new Float64Array(size), down: new Float64Array(size), total: 0, coarse: 0 }
  for (let i = a; i <= b; i++) {
    const s = slots[i]
    if (!s || s.total <= 0) continue
    const offset = s.first - kmin
    for (let k = 0; k < s.up.length; k++) {
      out.up[offset + k] += s.up[k]
      out.down[offset + k] += s.down[k]
    }
    out.total += s.total
    out.coarse += s.coarse
  }
  return out
}

/** Summed atoms -> `rows` rows over the span that carries volume, with the POC and the value
 * area holding `valueArea` (0..1) of the volume. Null when nothing traded. */
export function toProfile(atoms: Atoms | null, q: number, rows: number, valueArea: number): Profile | null {
  if (!atoms || !(atoms.total > 0) || !(q > 0)) return null
  let first = 0
  let last = atoms.up.length - 1
  while (first <= last && atoms.up[first] + atoms.down[first] <= 0) first++
  while (last >= first && atoms.up[last] + atoms.down[last] <= 0) last--
  if (first > last) return null

  const lo = (atoms.first + first) * q
  const hi = (atoms.first + last + 1) * q
  const n = Math.max(1, Math.min(Math.round(rows), last - first + 1))
  const rowHeight = (hi - lo) / n
  const up = new Float64Array(n)
  const down = new Float64Array(n)
  for (let k = first; k <= last; k++) {
    const u = atoms.up[k]
    const d = atoms.down[k]
    if (u + d <= 0) continue
    // The atom's span in row units; its volume goes to each row in proportion to overlap.
    const a = (k - first) * (q / rowHeight)
    const b = a + q / rowHeight
    const r0 = Math.min(n - 1, Math.floor(a))
    const r1 = Math.min(n - 1, Math.max(r0, Math.ceil(b) - 1))
    for (let r = r0; r <= r1; r++) {
      const share = (Math.min(b, r + 1) - Math.max(a, r)) / (b - a)
      if (!(share > 0)) continue
      up[r] += u * share
      down[r] += d * share
    }
  }

  const total = atoms.total
  let poc = 0
  for (let r = 1; r < n; r++) if (up[r] + down[r] > up[poc] + down[poc]) poc = r
  const [vaLow, vaHigh] = valueAreaOf(up, down, poc, valueArea)
  return { lo, hi, rowHeight, up, down, total, coarse: atoms.coarse, poc, vaLow, vaHigh }
}

/** The value area: from the POC outwards, one row at a time, always taking the heavier of the
 * two rows beside it (the upper one on a tie), until it holds `share` of the volume. */
export function valueAreaOf(up: Float64Array, down: Float64Array, poc: number, share: number): [number, number] {
  const n = up.length
  const vol = (r: number) => up[r] + down[r]
  let sum = 0
  for (let r = 0; r < n; r++) sum += vol(r)
  const target = Math.min(1, Math.max(0, share)) * sum
  let low = poc
  let high = poc
  let held = vol(poc)
  while (held < target && (low > 0 || high < n - 1)) {
    const below = low > 0 ? vol(low - 1) : -1
    const above = high < n - 1 ? vol(high + 1) : -1
    if (above >= below) {
      high++
      held += above
    } else {
      low--
      held += below
    }
  }
  return [low, high]
}
