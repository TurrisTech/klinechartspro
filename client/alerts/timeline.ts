// WHEN, ACROSS TIMEFRAMES. A rule may read a 1h RSI and a 4h EMA; this turns their values into
// one sequence of instants the condition language can be asked about, and walks the firing
// policy along it.
//
// The clock is the EFFECTIVE instant: a bar's value exists from its close, never from its
// label (CLAUDE.md "Effective timestamps"). So the instants are every bar close of every
// timeframe the rule reads, and at each one every operand reads its value on the latest bar
// of its own timeframe that has closed by then. A 4h EMA read at a 13:00 1h close is the EMA of
// the 4h bar that closed at 12:00 -- not the one still forming, which no one could have known.
//
// A missing value reads as MISSING, never as an older one: an indicator still warming up, or
// a server series not yet written for the newest bar, makes the leaf unknowable (`null`),
// which neither fires nor resets an edge (./conditions.ts, ./policy.ts). Carrying the last
// known value forward would compare today's close against yesterday's line.
//
// Bars of two timeframes that close at the same instant land in the same observation, so a
// 12:00 1h close and a 12:00 4h close are evaluated once, together.
//
// PURE: arrays in, instants and firings out.

import { type Condition, evaluate, type Observation, type Sample } from './conditions'
import { armedState, decide, type PolicySettings, type PolicyState } from './policy'
import type { FieldSpec } from './rules'

export type Value = number | string | undefined

/** One timeframe's values: each bar's close, and each operand's value on that bar. */
export interface Track {
  interval: string
  /** Bar closes (effective instants), ascending. */
  at: readonly number[]
  /** Each bar's wire date -- what a plugin's points are filed under. */
  dates?: readonly number[]
  /** Operand key -> its value on each bar, aligned with `at`. */
  values: ReadonlyMap<string, readonly Value[]>
}

export interface Instant {
  at: number
  observation: Observation
}

/** Merge tracks into instants, ascending. Only instants in `(from, to]` are returned, but the
 * value an operand reads at each is the latest of its own timeframe at or before it, however
 * far back that bar closed. */
export function instants(
  tracks: readonly Track[],
  fields: ReadonlyMap<string, FieldSpec>,
  from = Number.NEGATIVE_INFINITY,
  to = Number.POSITIVE_INFINITY
): Instant[] {
  const times = new Set<number>()
  for (const track of tracks) for (const t of track.at) if (t > from && t <= to) times.add(t)
  const ordered = [...times].sort((a, b) => a - b)
  // One pointer per track: the index of its latest bar closed by the instant being built.
  const pointers = tracks.map(() => -1)
  const out: Instant[] = []
  for (const t of ordered) {
    const reading = new Map<string, Value>()
    tracks.forEach((track, i) => {
      let p = pointers[i]
      while (p + 1 < track.at.length && track.at[p + 1] <= t) p++
      pointers[i] = p
      for (const [key, values] of track.values) reading.set(key, p >= 0 ? values[p] : undefined)
    })
    out.push({ at: t, observation: observe(fields, reading) })
  }
  return out
}

/** The fields of one observation, from the operands' values. A value that is not a finite
 * number or a string is absent -- the condition language's "unknowable". */
export function observe(fields: ReadonlyMap<string, FieldSpec>, reading: ReadonlyMap<string, Value>): Observation {
  const out: Observation = {}
  for (const [name, spec] of fields) {
    if (spec.kind === 'operand') {
      const value = usable(reading.get(spec.key))
      if (value !== undefined) out[name] = { value } satisfies Sample
    } else {
      const a = usable(reading.get(spec.a))
      const b = usable(reading.get(spec.b))
      if (typeof a === 'number' && typeof b === 'number') out[name] = { value: a - b }
    }
  }
  return out
}

function usable(value: Value): number | string | undefined {
  if (typeof value === 'string') return value
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** What a run of evaluations carries from one instant to the next. */
export interface RunState {
  /** The last observation: what a crossing compares against. */
  previous: Observation | null
  policy: PolicyState
}

export function freshRun(): RunState {
  return { previous: null, policy: armedState() }
}

/** Evaluate one instant and move the policy. True when the alert fires there. */
export function stepInstant(condition: Condition, settings: PolicySettings, state: RunState, instant: Instant): boolean {
  const result = evaluate(condition, instant.observation, state.previous)
  // Recorded whatever the answer: the next crossing compares against THIS reading.
  state.previous = instant.observation
  if (state.policy.status !== 'armed') return false
  return decide(state.policy, settings, result, instant.at)
}

/** What a replay's "Next alert" asks: the first instant in `(after, until]` at which the rule
 * TRIGGERS. Instants at or before `after` are evaluated too -- they are what an edge and a
 * crossing compare against -- but cannot fire. `state` carries over between calls, so a scan
 * can be fed one chunk of instants at a time.
 *
 * Only the trigger counts here: a replay asks where the rule next triggers, so `once` and a
 * cooldown -- which are about not repeating a NOTIFICATION -- do not apply. */
export function scan(
  condition: Condition,
  trigger: PolicySettings['trigger'],
  timeline: readonly Instant[],
  after: number,
  until: number,
  state: RunState = freshRun()
): Instant | null {
  const settings: PolicySettings = { trigger, repeat: 'always', cooldownMs: 0 }
  for (const instant of timeline) {
    if (instant.at > until) return null
    const fired = stepInstant(condition, settings, state, instant)
    if (fired && instant.at > after) return instant
  }
  return null
}
