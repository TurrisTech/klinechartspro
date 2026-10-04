// The alert model. An ALERT is a rule over values on one instrument -- a bar's close, an
// indicator's line, a stored server series, a published signal -- each read at a timeframe of
// its own, and a policy for what happens when the rule holds.
//
// Two kinds, one manager:
//
//   client  evaluated in this browser (./monitor.ts on a live wall, ./timeline.ts `scan` for a
//           bar replay's "Next alert"). Fires only while a dashboard tab is open.
//   server  evaluated by wdashboard-server, so it fires with every tab closed. NOT BUILT: the
//           manager shows the section and the seam (`AlertSource`) is what a server backend
//           implements. The server's price watches (client/watch) are the nearest thing today.
//
// A rule is a tree (`Rule`) the editor edits directly; it compiles to the condition language
// (./conditions.ts) to be evaluated, so a client alert and a watch fire by exactly the same
// rules (./rules.ts).

import type { Repeat, Trigger } from './policy'

export type AlertKind = 'client' | 'server'

/** A bar's own fields. */
export type BarField = 'open' | 'high' | 'low' | 'close' | 'volume'

/** Something a rule reads, on the alert's instrument, at `interval`. Every operand is a
 * value per bar of its interval, known at that bar's CLOSE (its effective instant) and never
 * before -- the no-lookahead rule every multi-timeframe calculation here keys off. */
export type Operand =
  | { kind: 'bar'; interval: string; field: BarField }
  /** A klinecharts built-in (RSI, MA, MACD...), computed in the browser from the bars with the
   * same template the chart draws. `output` is the figure key (`rsi1`, `ma2`, `dif`). */
  | { kind: 'indicator'; interval: string; name: string; params: number[]; output: string }
  /** A stored server indicator from the timeseries registry (`GET /indicators/registry`):
   * `indicator` is the row's name, `key` one of its series (dotted for a folded source). */
  | { kind: 'series'; interval: string; indicator: string; key: string }
  /** A plugin's published signal labels (`GET /plugins/signals`): the label on a bar
   * (`long`, `top`), or '' on a bar that carries none. */
  | { kind: 'signal'; interval: string; plugin: string; variant: string }

/** What a comparison compares against. Absent for `changed`. */
export type RuleRight =
  | { value: number }
  | { operand: Operand }
  | { band: [number, number] }
  | { label: string }

/** One comparison: `left op right`. `op` is a condition-language operator
 * (./conditions.ts `OPS`). */
export interface RuleLeaf {
  left: Operand
  op: string
  right?: RuleRight
}

export type Rule = RuleLeaf | { all: Rule[] } | { any: Rule[] } | { not: Rule }

/** What a user writes. */
export interface AlertDefinition {
  name: string
  note: string
  enabled: boolean
  /** `vendor:TICKER` -- every operand reads this instrument. */
  symbol: string
  rule: Rule
  /** `level` (the default): fires at every bar close where the rule holds. `edge`: only at
   * the close where it starts holding. */
  trigger: Trigger
  /** `always` (the default) keeps watching; `once` fires and then waits to be re-armed. */
  repeat: Repeat
  cooldownMs: number
}

export type AlertStatus = 'armed' | 'fired' | 'disabled'

export interface Alert extends AlertDefinition {
  id: string
  kind: AlertKind
  createdAt: number
  updatedAt: number
  armedAt: number
  /** `fired` is a `once` alert that has fired; `disabled` is any alert switched off. */
  status: AlertStatus
  /** The bar close the last firing was about (its event instant), not when it was raised. */
  lastFiredAt: number | null
  fireCount: number
}

/** A list of alerts the manager can show and switch: one per kind. The client store
 * implements it; a server backend is what "server alerts" will be. */
export interface AlertSource {
  readonly kind: AlertKind
  /** False while the kind cannot hold alerts at all; `unavailable` says why. */
  readonly available: boolean
  readonly unavailable: string
  list(): Alert[]
  setEnabled(id: string, enabled: boolean): Promise<void>
  rearm(id: string): Promise<void>
  remove(id: string): Promise<void>
  subscribe(listener: () => void): () => void
}

export const DEFAULT_TRIGGER: Trigger = 'level'
export const DEFAULT_REPEAT: Repeat = 'always'
