import type { Chart } from 'klinecharts'
import type { BindingSpec, BindingState, BoundSource } from './types'

// Handing a binding's values to the chart, for the host (host.ts): what one re-apply sends --
// the indicator's extendData, replaced rather than merged, and its legend text -- and when, at
// most once per binding per animation frame.
//
// A re-apply is an `overrideIndicator`, and so a full `calc` of the template and a layout: a
// fetch arrives in pages, an MTF overlay reads five sources, and a live point lands on several
// stores at once, so applying each as it came recalculated the same indicator several times a
// frame -- going live once cost five back-to-back ~150 ms frames on a prod wall (2026-10-07).
// Hence the coalescer. A binding just made is still applied at once (the host's `reconcile`),
// so its legend appears with it.

/** The longest a re-apply waits for an animation frame: none comes in a hidden tab. */
const APPLY_FALLBACK_MS = 100

/** What a re-apply needs of a binding (host.ts `Binding`). */
export interface AppliedBinding {
  readonly plugin: { readonly id: string }
  /** The chart its indicator is on. */
  readonly chart: Chart
  readonly indicatorId: string
  readonly name: string
  readonly chartPaneId: string
  /** Monotonic per host; folded into `rev` so a rebind always reaches the template. */
  readonly seq: number
  readonly spec: Pick<BindingSpec, 'label' | 'extendData'>
  readonly sources: readonly BoundSource[]
  readonly state: BindingState
  readonly disposed: boolean
  lastAppliedRev: number
  lastShortName: string
}

/** The revision a binding's template compares in `shouldUpdate`: its stores' revisions, and its
 * own sequence, so a rebind that keeps its stores still reaches the template. */
export function aggregateRev(b: Pick<AppliedBinding, 'seq' | 'sources'>): number {
  let rev = b.seq * 1_000_003
  for (const s of b.sources) rev += s.store.rev
  return rev
}

/** What the legend's warning says for a binding: a source that failed to load, else one that
 * loaded only partly (`SourceStore.problem`), else null. */
export function problemOf(b: Pick<AppliedBinding, 'sources'>): string | null {
  for (const s of b.sources) if (s.store.phase === 'error') return `Could not be loaded: ${s.store.error ?? 'unknown error'}`
  for (const s of b.sources) if (s.store.problem) return s.store.problem
  return null
}

/** Hand the chart what `b` reads now, unless it already has exactly that. */
export function applyBinding(b: AppliedBinding): void {
  if (b.disposed) return
  const rev = aggregateRev(b)
  let shortName: string
  try {
    shortName = b.spec.label(b.state)
  } catch (err) {
    console.warn(`[plugins] ${b.plugin.id} label failed`, err)
    shortName = b.name
  }
  if (rev === b.lastAppliedRev && shortName === b.lastShortName) return
  b.lastAppliedRev = rev
  b.lastShortName = shortName
  const seriesKeys: Record<string, string> = {}
  for (const s of b.sources) seriesKeys[s.id] = s.key
  const extendData = {
    seriesKey: b.sources[0]?.key ?? '',
    seriesKeys,
    rev,
    ...(b.spec.extendData?.(b.state) ?? {}),
    // The legend's warning icon and its card (src/ChartPane.svelte): set by the host for every
    // plugin indicator, after the plugin's own keys so none can hide it.
    problem: problemOf(b)
  }
  try {
    // klinecharts MERGES an override's extendData into the indicator's own, deeply: an array
    // is merged index by index and a key is never removed, so a plugin could never say "these
    // and no others" -- an MTF overlay's graph roots going from ['1D', '8h'] to [] read
    // ['8h', '8h'], and the graph stayed drawn. Clearing the indicator's own first makes the
    // merge a copy of exactly what is sent.
    for (const live of b.chart.getIndicators({ id: b.indicatorId })) live.extendData = undefined
    b.chart.overrideIndicator({ id: b.indicatorId, name: b.name, paneId: b.chartPaneId, extendData, shortName } as never)
  } catch (err) {
    console.warn(`[plugins] ${b.plugin.id} override failed`, err)
  }
}

/** Re-applies asked for, run together once per animation frame. */
export interface ApplyCoalescer<K> {
  /** `key` is to be re-applied at the next frame; asking again before then costs nothing. */
  request(key: K): void
  /** Run every re-apply asked for, now rather than at the next frame. */
  flush(): void
  /** How many re-applies are waiting. */
  readonly pending: number
}

export function createApplyCoalescer<K>(run: (key: K) => void): ApplyCoalescer<K> {
  const dirty = new Set<K>()
  let flushPending = false
  const flush = (): void => {
    flushPending = false
    const batch = [...dirty]
    dirty.clear()
    for (const key of batch) run(key)
  }
  return {
    request(key: K): void {
      dirty.add(key)
      if (flushPending) return
      flushPending = true
      if (typeof requestAnimationFrame !== 'function') {
        queueMicrotask(flush)
        return
      }
      let done = false
      const once = (): void => {
        if (done) return
        done = true
        if (flushPending) flush()
      }
      requestAnimationFrame(once)
      setTimeout(once, APPLY_FALLBACK_MS)
    },
    flush,
    get pending(): number {
      return dirty.size
    }
  }
}
