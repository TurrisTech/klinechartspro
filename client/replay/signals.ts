import type { SignalCatalogueEntry } from '../plugins/types'
import type { SignalOccurrence } from './clock'
import { nominalMs } from './timeframes'

// The signal book: the published catalogue, the STARRED set (the user's shortlist) and the
// ARMED set (pause points), and `nextSignalAt` over an injected `SignalSource`. No DOM, no
// network of its own: the source is the only thing that fetches, and it is handed in.
//
// A signal is armed ON A RESOLUTION (the pane interval it is computed on): `arev:arev21:long`
// on 1h and on 4h are different pause points. Occurrences are keyed off their `effective`
// instant -- the bar's close, as the server states it -- never off the bar's label.

export interface ArmedSignal {
  ref: string
  resolution: string
}

/** One labelled point as the server serves it: the bar (wire date) and when it became
 * knowable. */
export interface SignalHit {
  date: number
  effective: number
}

export interface SignalSource {
  /** The labelled points of one signal with bar dates in `[from, to)`, ascending, UNCLAMPED
   * (the book applies the cursor itself). */
  points(ref: string, symbol: string, resolution: string, from: number, to: number): Promise<SignalHit[]>
}

function key(a: ArmedSignal): string {
  return `${a.ref}@${a.resolution}`
}

interface Coverage {
  hits: SignalHit[]
  from: number
  to: number
}

/** How far ahead of a query the book fetches, in bars of the signal's resolution. */
const LOOKAHEAD_BARS = 500

export class SignalBook {
  starred = new Set<string>()
  private armedSet = new Map<string, ArmedSignal>()
  private coverage = new Map<string, Coverage>()

  constructor(
    readonly catalogue: readonly SignalCatalogueEntry[],
    private readonly source: SignalSource
  ) {}

  // -- the sets --------------------------------------------------------------------------

  entry(ref: string): SignalCatalogueEntry | undefined {
    return this.catalogue.find((e) => e.ref === ref)
  }

  star(ref: string, on = true): void {
    if (on) this.starred.add(ref)
    else {
      this.starred.delete(ref)
      for (const [k, a] of this.armedSet) if (a.ref === ref) this.armedSet.delete(k)
    }
  }

  isStarred(ref: string): boolean {
    return this.starred.has(ref)
  }

  /** Arm a starred signal as a pause point on a resolution. Arming an unstarred ref stars it. */
  arm(ref: string, resolution: string, on = true): void {
    const a = { ref, resolution }
    if (on) {
      this.starred.add(ref)
      this.armedSet.set(key(a), a)
    } else this.armedSet.delete(key(a))
  }

  isArmed(ref: string, resolution?: string): boolean {
    if (resolution !== undefined) return this.armedSet.has(key({ ref, resolution }))
    for (const a of this.armedSet.values()) if (a.ref === ref) return true
    return false
  }

  get armed(): ArmedSignal[] {
    return [...this.armedSet.values()]
  }

  setArmed(list: readonly ArmedSignal[]): void {
    this.armedSet.clear()
    for (const a of list) this.arm(a.ref, a.resolution)
  }

  /** Forget fetched occurrences (a symbol change). */
  reset(): void {
    this.coverage.clear()
  }

  // -- occurrences -----------------------------------------------------------------------

  /** The next occurrence of each armed signal effective in `(after, until]`, for the
   * planner. Fetches only what is not yet covered, with a look-ahead. */
  async nextSignalsAt(symbol: string, after: number, until: number): Promise<SignalOccurrence[]> {
    const out: SignalOccurrence[] = []
    for (const a of this.armedSet.values()) {
      const hit = await this.nextOccurrence(a, symbol, after, until)
      if (hit) out.push({ ref: a.ref, resolution: a.resolution, effective: hit.effective, date: hit.date })
    }
    return out.sort((x, y) => x.effective - y.effective)
  }

  /** The earliest armed occurrence in `(after, until]`, or null. */
  async nextSignalAt(symbol: string, after: number, until: number): Promise<SignalOccurrence | null> {
    const all = await this.nextSignalsAt(symbol, after, until)
    return all[0] ?? null
  }

  private async nextOccurrence(a: ArmedSignal, symbol: string, after: number, until: number): Promise<SignalHit | null> {
    const k = `${symbol}|${key(a)}`
    const len = nominalMs(a.resolution)
    // A bar whose close is in (after, until] has a label in [after - 2 bars, until]: query
    // by label, filter by effective.
    const from = after - 2 * len
    let cov = this.coverage.get(k)
    if (!cov || cov.from > from) {
      cov = { hits: [], from, to: from }
      this.coverage.set(k, cov)
    }
    if (cov.to < until) {
      const to = Math.max(until, cov.to + LOOKAHEAD_BARS * len)
      const fetched = await this.source.points(a.ref, symbol, a.resolution, cov.to, to)
      const seen = new Set(cov.hits.map((h) => h.effective))
      for (const h of fetched) if (!seen.has(h.effective)) cov.hits.push(h)
      cov.hits.sort((x, y) => x.effective - y.effective)
      cov.to = to
    }
    for (const h of cov.hits) {
      if (h.effective > after && h.effective <= until) return h
    }
    return null
  }
}
