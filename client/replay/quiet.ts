import { fromWall, toWall } from './timeframes'

// QUIET HOURS: a stretch of every day -- 22:00 to 06:00, say -- in which a replay's alerts are
// SILENCED (user, 2026-11-24: "build a feature that would allow me to silence alerts in bar replay
// between certain times, for example 10pm - 6am").
//
// What silenced means, everywhere it applies, is that the alert is not listening then:
//
//   - an alert on the Alerts list that triggers in quiet hours is passed over by Next alert, which
//     runs on to the next one outside them (alerts.ts);
//   - a price watch -- a level alert, a line placed from the chart -- does not fire in quiet hours:
//     it neither stops the advance nor rings, and one set to fire ONCE is still armed when they end
//     (watches.ts). It keeps reading the bars meanwhile, so a crossing that happened at 3am does
//     not fire at 6:00 as if it had just happened.
//
// What it does not silence: the account. An order filling, a stop loss, a take profit, a trail or
// breakeven stop and a trade's "Notify at" happen at night as they would on a real account, and
// still end a run there. Nor the Go to panel's stop price, which is where the user asked the run to
// go, not an alert.
//
// The hours are on ONE clock for every alert, whatever instrument it watches: the replay's (the
// title bar's), or the browser's own zone. A habit of the viewer, like the play pace, so it is kept
// per browser rather than in the replay.

export type QuietZone = 'replay' | 'local'

export interface QuietSetting {
  on: boolean
  /** Minutes after midnight, on the chosen clock: from (inclusive) to (exclusive). A `from` after
   * `to` runs over midnight, which is the usual case. Equal is no window at all. */
  from: number
  to: number
  zone: QuietZone
}

export const DEFAULT_QUIET: QuietSetting = { on: false, from: 22 * 60, to: 6 * 60, zone: 'replay' }

const KEY = 'wd.replay.quiet'
const MINUTE = 60_000
const QUARTER = 15 * MINUTE
const DAY_MINUTES = 1440

/** Whether a minute of the day is inside `[from, to)`, over midnight when `from > to`. */
export function inWindow(minute: number, from: number, to: number): boolean {
  if (from === to) return false
  return from < to ? minute >= from && minute < to : minute >= from || minute < to
}

/** "22:00–06:00". */
export function describeQuiet(setting: Pick<QuietSetting, 'from' | 'to'>): string {
  return `${hhmm(setting.from)}–${hhmm(setting.to)}`
}

export function hhmm(minute: number): string {
  const m = ((Math.round(minute) % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

/** "22:00" or "6:30" as minutes after midnight, or null. */
export function parseHhmm(text: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim())
  if (!m) return null
  const h = Number(m[1])
  const mi = Number(m[2])
  if (h > 23 || mi > 59) return null
  return h * 60 + mi
}

/** This browser's own zone. */
export function localZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/** Answers "is `at` in quiet hours" on one zone, cheaply enough to be asked for every base bar a
 * walk consumes (a week of 5s bars is 120k questions): it remembers the stretch of time the last
 * answer holds for -- up to the next from or to on the wall clock -- and only works out the wall
 * clock again outside it. */
export class QuietWindow {
  private lo = Number.POSITIVE_INFINITY
  private hi = Number.NEGATIVE_INFINITY
  private quiet = false

  constructor(
    readonly from: number,
    readonly to: number,
    readonly zone: string
  ) {}

  has(at: number): boolean {
    if (this.from === this.to) return false
    if (at >= this.lo && at < this.hi) return this.quiet
    const wall = toWall(at, this.zone)
    const wallMinute = Math.floor(wall / MINUTE)
    const minute = ((wallMinute % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES
    this.quiet = inWindow(minute, this.from, this.to)
    // The stretch runs from the start of this wall minute to the next edge: `to` while quiet,
    // `from` while not. Both ends are wall readings turned back into instants, which is what keeps
    // a DST change inside the stretch honest.
    const edge = this.quiet ? this.to : this.from
    const ahead = (((edge - minute) % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES || DAY_MINUTES
    this.lo = at - (wall - wallMinute * MINUTE)
    let hi = Math.max(at + 1, fromWall((wallMinute + ahead) * MINUTE, this.zone))
    // ...unless the clocks change inside it. Falling back, the wall clock runs an hour again, and
    // 01:00-02:00 can enter a window it had already left: the stretch then ends at the next
    // quarter hour of UTC (every zone changes its clocks on one) and is worked out again there.
    // A stretch is at most a day, so the same offset at both ends means no change between.
    if (toWall(hi - 1, this.zone) - (hi - 1) !== wall - at) hi = Math.min(hi, Math.floor(at / QUARTER) * QUARTER + QUARTER)
    this.hi = hi
    return this.quiet
  }
}

/** The quiet hours a replay wall uses: the viewer's setting, and the question every silenced
 * thing asks of it. `replayZone` is read at each question, so a replay that follows the chart to
 * an instrument on another clock is asked on the new one. */
export class ReplayQuiet {
  private setting: QuietSetting
  private window: QuietWindow | null = null
  private readonly listeners = new Set<() => void>()

  constructor(
    private readonly replayZone: () => string,
    private readonly storage: Pick<Storage, 'getItem' | 'setItem'> | null = safeStorage()
  ) {
    this.setting = readQuiet(storage)
  }

  get value(): QuietSetting {
    return { ...this.setting }
  }

  /** The zone the hours are read on, as an IANA name. */
  get zone(): string {
    return this.setting.zone === 'local' ? localZone() : this.replayZone()
  }

  set(next: QuietSetting): void {
    this.setting = normalise(next)
    this.window = null
    writeQuiet(this.setting, this.storage)
    for (const listener of this.listeners) listener()
  }

  /** Whether an alert triggering at `at` is silenced. */
  isQuiet(at: number): boolean {
    if (!this.setting.on) return false
    const zone = this.zone
    if (!this.window || this.window.zone !== zone) this.window = new QuietWindow(this.setting.from, this.setting.to, zone)
    return this.window.has(at)
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

function normalise(value: Partial<QuietSetting> | null | undefined): QuietSetting {
  const minute = (m: unknown, fallback: number): number =>
    typeof m === 'number' && Number.isInteger(m) && m >= 0 && m < DAY_MINUTES ? m : fallback
  return {
    on: value?.on === true,
    from: minute(value?.from, DEFAULT_QUIET.from),
    to: minute(value?.to, DEFAULT_QUIET.to),
    zone: value?.zone === 'local' ? 'local' : 'replay'
  }
}

export function readQuiet(storage: Pick<Storage, 'getItem'> | null = safeStorage()): QuietSetting {
  try {
    return normalise(JSON.parse(storage?.getItem(KEY) ?? 'null') as Partial<QuietSetting> | null)
  } catch {
    return { ...DEFAULT_QUIET }
  }
}

function writeQuiet(setting: QuietSetting, storage: Pick<Storage, 'setItem'> | null): void {
  try {
    storage?.setItem(KEY, JSON.stringify(setting))
  } catch {
    // private mode, quota: the hours still apply to this page
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}
