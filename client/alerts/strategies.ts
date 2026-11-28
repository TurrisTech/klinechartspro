// THE STRATEGY LAB, AS THE ALERTS SEE IT. An alert can watch a saved strategy's entries (an
// operand of kind `strategy`), the editor offers the saved strategies, and an alert on one is named
// by it -- but the alerts never import client/lab. The Lab provides a `StrategySource`
// (lab/alertsource.ts) and the page registers it at boot (client/builtins.ts); until then, and on a
// page that registers none, there are no strategies and a strategy operand reads as no entries.
//
// Until 2026-11-28 alerts imported lab/store and lab/alertentries directly, and the Lab imports
// alerts throughout -- the client's one runtime import cycle ran through here.

import type { Point } from './data'
import type { Operand } from './types'

export type StrategyOperand = Extract<Operand, { kind: 'strategy' }>

export interface StrategyEntries {
  points: Point[]
  /** The newest wire date on the operand's timeframe whose answer is final, or null. */
  through: number | null
}

/** Reads a saved strategy's entries on one instrument. */
export interface StrategyEntryReader {
  /** The operand's entries over `[from, to]` (absolute), `to` capped at the reader's now. */
  entries(symbol: string, operand: StrategyOperand, from: number, to: number): Promise<StrategyEntries>
}

export interface StrategySource {
  /** Load the page's saved strategies, once; later calls get the same promise. */
  load(): Promise<void>
  /** The saved strategies as they stand, without waiting: empty until loaded. */
  list(): Array<{ id: string; name: string }>
  /** A saved strategy's name, or null when it is not loaded (or gone). */
  name(id: string): string | null
  /** A reader of entries, capping at `now` (the monitor's clock; the wall clock by default). */
  reader(now?: () => number): StrategyEntryReader
}

const NONE: StrategySource = {
  load: async () => {},
  list: () => [],
  name: () => null,
  reader: () => ({ entries: async () => ({ points: [], through: null }) })
}

let source: StrategySource = NONE

/** Register the page's strategies (the Lab's). */
export function provideStrategies(provided: StrategySource): void {
  source = provided
}

/** The registered strategies, or none. */
export function strategies(): StrategySource {
  return source
}

/** A reader made from whichever source is registered when it is first asked -- so a monitor or a
 * search built before the page registered the Lab still reads the Lab's entries. */
export function strategyEntryReader(now?: () => number): StrategyEntryReader {
  let made: { from: StrategySource; reader: StrategyEntryReader } | null = null
  return {
    entries(symbol, operand, from, to) {
      if (made?.from !== source) made = { from: source, reader: source.reader(now) }
      return made.reader.entries(symbol, operand, from, to)
    }
  }
}
