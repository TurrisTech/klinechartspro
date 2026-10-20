import { mergeRange, missingRanges, truncate } from '../plugins/store'
import type { Phase, Range, SourceStore } from '../plugins/types'
import type { MtfNodeRow, MtfSignalRow } from './api'

// What one multi-timeframe overlay binding holds: the server's markers and graph nodes
// (`GET /mtf/graph`), keyed by the instant each became knowable rather than by a bar -- they come
// from several timeframes at once, and an instant is the one clock they share.
//
// Windows are absolute instants, so the host's read clock needs no conversion: a source that
// declares no `resolution` is forgotten from the replay cursor itself (plugins/horizon.ts), and
// a row exists from its `knownAt` on. Every page REPLACES what was held over its own span rather
// than adding to it: a re-read of the tail after a new bar can take a node OUT of a graph (a
// lagging timeframe's signal arriving late resets one), and a merge would keep it.

/** A marker's identity: its timeframe and its candle's date on that timeframe. */
export function markKey(row: { interval: string; date: number }): string {
  return `${row.interval}|${row.date}`
}

/** A node's identity: the same signal is a node of each root's graph that holds it. */
export function nodeKey(row: MtfNodeRow): string {
  return `${row.root}|${row.interval}|${row.date}`
}

export const NODES_ARRAY = 'nodes'

export class MtfGraphStore implements SourceStore<MtfSignalRow> {
  private readonly marks = new Map<string, MtfSignalRow>()
  private readonly nodeRows = new Map<string, MtfNodeRow>()
  private ranges: Range[] = []
  private sortedMarks: MtfSignalRow[] | null = null
  private sortedNodes: MtfNodeRow[] | null = null
  phase: Phase = 'idle'
  progress: number | null = null
  error: string | null = null
  rev = 0

  constructor(readonly key: string) {}

  get size(): number {
    return this.marks.size
  }

  ingest(points: MtfSignalRow[], window: Range, arrays?: Record<string, { date: number }[]>): void {
    this.dropBetween(window.from, window.to)
    for (const row of points) this.marks.set(markKey(row), row)
    for (const row of (arrays?.[NODES_ARRAY] ?? []) as MtfNodeRow[]) this.nodeRows.set(nodeKey(row), row)
    this.ranges = mergeRange(this.ranges, window)
    this.sortedMarks = this.sortedNodes = null
    this.rev++
  }

  missing(window: Range): Range[] {
    return missingRanges(this.ranges, window)
  }

  /** Drop coverage at or after `from` (absolute) and everything knowable there: a replay step,
   * or a new bar on one of the timeframes, after which the tail is read again. */
  forgetAfter(from: number): void {
    this.ranges = truncate(this.ranges, from)
    this.dropBetween(from, Number.POSITIVE_INFINITY)
    this.sortedMarks = this.sortedNodes = null
    this.rev++
  }

  /** The newest instant anything held became knowable, or null. */
  latest(): number | null {
    let out: number | null = null
    for (const row of this.marks.values()) if (out === null || row.knownAt > out) out = row.knownAt
    return out
  }

  /** Every marker held, by the instant it became knowable. */
  signals(): readonly MtfSignalRow[] {
    this.sortedMarks ??= [...this.marks.values()].sort((a, b) => a.knownAt - b.knownAt)
    return this.sortedMarks
  }

  /** Every graph node held, by the instant it became knowable. */
  nodes(): readonly MtfNodeRow[] {
    this.sortedNodes ??= [...this.nodeRows.values()].sort((a, b) => a.knownAt - b.knownAt)
    return this.sortedNodes
  }

  setPhase(phase: Phase, progress: number | null = null, error: string | null = null): void {
    if (this.phase === phase && this.progress === progress && this.error === error) return
    this.phase = phase
    this.progress = progress
    this.error = error
    this.rev++
  }

  private dropBetween(from: number, to: number): void {
    for (const [k, row] of this.marks) if (row.knownAt >= from && row.knownAt < to) this.marks.delete(k)
    for (const [k, row] of this.nodeRows) if (row.knownAt >= from && row.knownAt < to) this.nodeRows.delete(k)
  }
}

export function createMtfGraphStore(key: string): MtfGraphStore {
  return new MtfGraphStore(key)
}
