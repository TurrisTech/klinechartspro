import { divides, isInterval, parseInterval, type Unit } from '../time/intervals'

// PURE (plus a localStorage pair). What one Step is, typed in words: "15h", "30h", "90m", "2D",
// "3 × 4h" (user, 2026-11-24: "we should be able to configure any amount of step, for example,
// 15h and 30h").
//
// A step is still the session's `{ interval, multiple }` -- N whole candles of one interval,
// walked on the instrument's own candle grid (CandleGrid.advanceTarget) -- so nothing below the
// controls changes. This turns an amount into that pair and back:
//
//   "15h"     -> 15 x 1h    fifteen hourly candles: the next 15 market hours, the weekend skipped
//   "90m"     -> 90 x 1m    on a 1m-or-finer base; 18 x 5m on a 5m base, which is the same span
//   "2D"      -> 2 x 1D
//   "3 × 4h"  -> 3 x 4h     an explicit multiple keeps its interval: three 4h candles, landing on
//                           the 4h grid
//
// An amount is counted in its unit's ONE candles, as finely as the base allows: the base is what
// the walk consumes, so a step that does not end on a base bar's close cannot be walked to.
// "45m" on a 5m base is 9 x 5m; "15h" on a 2h base is refused, because no candle the base tiles
// fits fifteen hours a whole number of times.

export interface StepSetting {
  interval: string
  multiple: number
}

type StepParse = { ok: true; step: StepSetting } | { ok: false; reason: string }

/** The longest step a field accepts, in candles: a typo of an extra digit should not walk a year. */
const MAX_STEP_MULTIPLE = 10_000

/** How many typed steps the picker remembers, most recent first. */
export const MAX_SAVED_STEPS = 8

const SAVED_KEY = 'wd.replay.steps'

/** Spelled units, case-sensitive where the interval codes are: `m` is a minute and `M` a month. */
const UNIT_WORDS: Record<string, Unit> = {
  s: 's',
  S: 's',
  sec: 's',
  secs: 's',
  m: 'm',
  min: 'm',
  mins: 'm',
  h: 'h',
  H: 'h',
  hr: 'h',
  hrs: 'h',
  d: 'D',
  D: 'D',
  day: 'D',
  days: 'D',
  w: 'W',
  W: 'W',
  wk: 'W',
  week: 'W',
  weeks: 'W',
  M: 'M',
  mo: 'M',
  month: 'M',
  months: 'M'
}

/** The candles an intraday amount may be counted in, finest first: one of the unit, then the
 * sizes that tile a day. `15h` tries 1h, 3h, 5h, 15h ... and takes the first the base tiles. */
const COUNT_IN = [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30] as const

/** `text` as a step on a wall walking `base` bars, or why it is not one. `timeframes` are the
 * picker's own intervals: typing one of them ("15m", "4h") picks that timeframe -- a candle of
 * it, landing on its grid -- rather than as many one-unit candles, so a typed step and a listed
 * one never share a name. */
export function parseStep(text: string, base: string, timeframes: readonly string[] = []): StepParse {
  const raw = text.trim()
  if (!raw) return { ok: false, reason: 'Type a step, like 15h or 30h' }
  // "3 × 4h", "3x4h", "3*4h": a multiple of an interval, kept as written.
  const times = /^(\d+)\s*[×xX*]\s*(\d+)\s*([A-Za-z]+)$/.exec(raw)
  if (times) {
    const unit = UNIT_WORDS[times[3]]
    const count = Number(times[2])
    if (!unit || count < 1) return { ok: false, reason: `${raw} is not a step: try 3 × 4h` }
    return checked(`${count}${unit}`, Number(times[1]), base, raw)
  }
  const amount = /^(\d+)\s*([A-Za-z]+)$/.exec(raw)
  if (!amount) return { ok: false, reason: `${raw} is not a step: try 15h, 90m or 2D` }
  const unit = UNIT_WORDS[amount[2]]
  const n = Number(amount[1])
  if (!unit) return { ok: false, reason: `${amount[2]} is not a unit: use s, m, h, D, W or M` }
  if (n < 1) return { ok: false, reason: 'A step moves forward: use 1 or more' }
  if (timeframes.includes(`${n}${unit}`)) return checked(`${n}${unit}`, 1, base, raw)
  // Calendar units are counted in ones: two days is two daily candles, whatever the base.
  if (unit === 'D' || unit === 'W' || unit === 'M') return checked(`1${unit}`, n, base, raw)
  for (const k of COUNT_IN) {
    if (n % k !== 0) continue
    const interval = `${k}${unit}`
    if (isInterval(interval) && tiles(base, interval)) return checked(interval, n / k, base, raw)
  }
  return { ok: false, reason: `${raw} is not a whole number of ${base} base bars` }
}

function tiles(base: string, interval: string): boolean {
  try {
    return divides(base, interval)
  } catch {
    return false
  }
}

function checked(interval: string, multiple: number, base: string, raw: string): StepParse {
  if (!isInterval(interval)) return { ok: false, reason: `${raw} is not a step` }
  if (!Number.isInteger(multiple) || multiple < 1) return { ok: false, reason: 'A step moves forward: use 1 or more' }
  if (multiple > MAX_STEP_MULTIPLE) return { ok: false, reason: `${raw} is too long a step: at most ${MAX_STEP_MULTIPLE} candles` }
  if (!tiles(base, interval)) return { ok: false, reason: `${raw} does not end on a ${base} base bar` }
  return { ok: true, step: { interval, multiple } }
}

/** A step as the picker and the status line say it: "1h" for one candle, "15h" for fifteen of
 * one hour, "3 × 4h" for several of a longer one. `parseStep` reads each of them back. Fifteen
 * 1m candles are "15 × 1m" where "15m" is one of `timeframes`, so the two never read alike. */
export function describeStep(step: StepSetting, timeframes: readonly string[] = []): string {
  if (step.multiple === 1) return step.interval
  const iv = parseInterval(step.interval)
  const short = `${step.multiple}${iv.unit}`
  if (iv.number === 1 && !timeframes.includes(short)) return short
  return `${step.multiple} × ${step.interval}`
}

/** The picker's value for a step: one string per distinct `{ interval, multiple }`. */
export function stepKey(step: StepSetting): string {
  return `${step.multiple}*${step.interval}`
}

export function sameStep(a: StepSetting, b: StepSetting): boolean {
  return a.interval === b.interval && a.multiple === b.multiple
}

/** The steps typed in this browser, most recent first, as typed ("15h"). A habit of the viewer
 * like the play pace, not part of any replay. */
export function readSavedSteps(storage: Pick<Storage, 'getItem'> | null = safeStorage()): string[] {
  try {
    const stored = JSON.parse(storage?.getItem(SAVED_KEY) ?? '[]') as unknown
    if (!Array.isArray(stored)) return []
    return stored.filter((s): s is string => typeof s === 'string' && s.trim() !== '').slice(0, MAX_SAVED_STEPS)
  } catch {
    return []
  }
}

/** `label` at the front of the saved steps (once), the oldest dropped past MAX_SAVED_STEPS. */
export function rememberStep(label: string, storage: Pick<Storage, 'getItem' | 'setItem'> | null = safeStorage()): string[] {
  const next = [label, ...readSavedSteps(storage).filter((s) => s !== label)].slice(0, MAX_SAVED_STEPS)
  writeSaved(next, storage)
  return next
}

export function forgetStep(label: string, storage: Pick<Storage, 'getItem' | 'setItem'> | null = safeStorage()): string[] {
  const next = readSavedSteps(storage).filter((s) => s !== label)
  writeSaved(next, storage)
  return next
}

function writeSaved(steps: string[], storage: Pick<Storage, 'setItem'> | null): void {
  try {
    storage?.setItem(SAVED_KEY, JSON.stringify(steps))
  } catch {
    // private mode, quota: the step still applies, it is just not remembered
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}
