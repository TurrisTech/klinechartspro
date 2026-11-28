import type { ServerCatalogue } from '../alerts/catalogue'
import type { LabData } from './data'
import { readStrategyFile } from './export'
import { type Problem, rank85Strategy, ruleStrategy, type Strategy, strategyCopy, strategyProblems, utcDayStart, withHoldoutKind, withWindowKind } from './model'
import { type LabRun, RunCancelled, RunError, runStrategy, runWindow } from './runner'
import { type RunRecord, RunHistory } from './runs'
import type { StrategyStore } from './store'

// THE STRATEGY LAB'S STATE AND ACTIONS, without a DOM: which strategy is open, every draft of the
// visit and which of them the user has touched, what is unsaved, Save / Revert / Delete / New /
// a file read back, the header's instrument, window and holdout, this session's runs and the one
// shown -- and running the open draft, a newer run (or Stop, or another strategy) abandoning the
// one before. page.ts is the DOM around it: it calls an action, then draws what the session holds.
//
// The open draft is edited IN PLACE: the editor holds it, and its fields hold its parts, so an
// edit here -- one field set, or model.ts's pure edit written back -- never puts a new object in
// its place. Opening another strategy, a revert, a restore and a save do; the page hands the
// editor `current` again after the first three.
//
// What it needs comes in (`LabSessionDeps`): the saved strategies, the data layers, the server
// catalogue and the clock -- so session.test.ts drives it on the fake data at a fixed instant.

/** What the session reads and writes of the saved strategies (store.ts). */
export type SavedStrategies = Pick<StrategyStore, 'list' | 'get' | 'save' | 'remove' | 'loadError'>

export interface LabSessionDeps {
  store: SavedStrategies
  /** The page's data layer: every run of the open strategy reads through it, so a re-run that
   * changed no read fetches nothing. */
  data: LabData
  /** A data layer of its own for a basket's other instruments, dropped with its run, so a basket
   * of 28 never holds 28 instruments' bars at once. */
  newData(): LabData
  /** For rules that read a stored series or a signal; null when it could not be read. */
  catalogue: ServerCatalogue | null
  /** Now, in ms: what a new strategy, a save and a run's record are stamped with, and the day a
   * window or a holdout of another kind counts from. A run's own window and reads take the time
   * themselves (runner.ts), as they always have. */
  clock(): number
}

/** Where a visit starts: the strategy the address names, else the one open last on this device,
 * else the first saved, else a fresh rank 85 draft. */
export interface LabOpening {
  requested: string | null
  remembered: string | null
}

/** What "⋯ ▸ New" makes: the rank 85 rules, the rule-event pair, or a copy of the open one. */
export type NewKind = 'rank85' | 'rule' | 'copy'

/** What came of a run. `ticket` says which: `settle` it once its outcome is shown. */
export type RunOutcome =
  | { kind: 'done'; ticket: number; run: LabRun }
  /** The draft cannot run (runner.ts `RunError`): the problems, and what to say. */
  | { kind: 'problems'; ticket: number; problems: Problem[]; message: string }
  | { kind: 'failed'; ticket: number; error: unknown }
  /** Stopped, or overtaken by a newer run: nothing to show. */
  | { kind: 'cancelled'; ticket: number }

/** One strategy as the picker lists it. */
export interface StrategyListing {
  id: string
  name: string
  saved: boolean
  unsaved: boolean
}

const DAY_MS = 86_400_000

/** A strategy as compared for "unsaved": everything but when it was saved. */
function signature(strategy: Strategy | null): string {
  if (!strategy) return ''
  const { updatedAt: _u, ...rest } = strategy
  return JSON.stringify(rest)
}

export class LabSession {
  /** Every strategy of the visit as it is being edited, by id: the saved ones and new drafts. */
  private readonly drafts = new Map<string, Strategy>()
  /** Drafts the user has edited or created. Only these can hold work worth a "leave the page?"
   * prompt: the default strategy a first visit opens on is unsaved but holds nothing of theirs. */
  private readonly touched = new Set<string>()
  private openId = ''
  private readonly history = new RunHistory()
  private finished: LabRun | null = null
  /** The run shown, as the history keeps it. */
  private shown: RunRecord | null = null
  /** Every run takes the next ticket; one whose ticket is no longer the latest is abandoned. */
  private token = 0
  private busy = false

  constructor(
    private readonly deps: LabSessionDeps,
    opening: LabOpening
  ) {
    const { store } = deps
    for (const saved of store.list()) this.drafts.set(saved.id, structuredClone(saved))
    const { requested, remembered } = opening
    let id = (requested && this.drafts.has(requested) ? requested : null) ?? remembered ?? ''
    if (!this.drafts.has(id)) {
      const first = store.list()[0]
      if (first) id = first.id
      else {
        const fresh = rank85Strategy(deps.clock())
        this.drafts.set(fresh.id, fresh)
        id = fresh.id
      }
    }
    this.openId = id
  }

  // -- what is open -------------------------------------------------------------------------------

  /** The open strategy's draft: what the editor edits and a run runs. */
  get current(): Strategy {
    return this.drafts.get(this.openId) as Strategy
  }

  get currentId(): string {
    return this.openId
  }

  /** Whether a draft differs from what is saved of it; one never saved always does. */
  unsaved(id: string): boolean {
    return signature(this.drafts.get(id) ?? null) !== signature(this.deps.store.get(id))
  }

  /** Whether a strategy (the open one by default) is saved. */
  isSaved(id = this.openId): boolean {
    return !!this.deps.store.get(id)
  }

  /** Whether the open strategy has anything for Delete to take: it is saved, or a draft the user
   * made or edited. A fresh default nobody has touched holds nothing to discard. */
  get removable(): boolean {
    return this.isSaved() || this.touched.has(this.openId)
  }

  /** What the picker lists: the saved strategies in their order, then the drafts never saved. */
  strategies(): StrategyListing[] {
    const { store } = this.deps
    const ids = [...new Set([...store.list().map((s) => s.id), ...this.drafts.keys()])]
    return ids.flatMap((id) => {
      const s = this.drafts.get(id) ?? store.get(id)
      return s ? [{ id, name: s.name, saved: !!store.get(id), unsaved: this.unsaved(id) }] : []
    })
  }

  /** Whether a draft the user made or edited is unsaved: what asks before the page closes. */
  hasUnsavedWork(): boolean {
    return [...this.touched].some((id) => this.drafts.has(id) && this.unsaved(id))
  }

  /** What stops the open draft running (model.ts `strategyProblems`); empty when it can. */
  problems(): Problem[] {
    return strategyProblems(this.current)
  }

  // -- switching, saving, deleting ----------------------------------------------------------------

  /** Open strategy `id` -- a draft of the visit, or a saved one -- abandoning any run in progress.
   * False, and nothing changes, for an id that is neither. */
  open(id: string): boolean {
    if (!this.drafts.has(id)) {
      const saved = this.deps.store.get(id)
      if (!saved) return false
      this.drafts.set(id, structuredClone(saved))
    }
    this.stop()
    this.openId = id
    this.finished = null
    this.shown = null
    return true
  }

  /** A new draft on the open strategy's instrument, opened. Its id. */
  create(kind: NewKind): string {
    const now = this.deps.clock()
    const fresh: Strategy = kind === 'copy' ? strategyCopy(this.current, now) : kind === 'rule' ? ruleStrategy(now) : rank85Strategy(now)
    fresh.instrument = this.current.instrument
    return this.adopt(fresh)
  }

  /** A strategy file read back as a new draft (export.ts `readStrategyFile`), opened. Its id;
   * throws `ImportError` for a file that is not one. */
  importFile(text: string): string {
    return this.adopt(readStrategyFile(text, this.deps.clock()))
  }

  private adopt(fresh: Strategy): string {
    this.drafts.set(fresh.id, fresh)
    this.touched.add(fresh.id)
    this.open(fresh.id)
    return fresh.id
  }

  /** Keep the open draft (store.ts `save`; it throws with the reason it cannot). The draft is then
   * what was saved -- written INTO the draft, not swapped for a copy: the editor holds the draft
   * object, and a copy left it editing something nothing read (every edit after a visit's first
   * Save was lost, until 2026-11-28). */
  save(): void {
    const saved = this.deps.store.save(this.current, this.deps.clock())
    Object.assign(this.current, structuredClone(saved))
  }

  /** Put the saved version back in the draft. False for a draft never saved. */
  revert(): boolean {
    const saved = this.deps.store.get(this.openId)
    if (!saved) return false
    this.drafts.set(this.openId, structuredClone(saved))
    return true
  }

  /** Delete the open strategy -- a saved one from the store, a draft never saved from the visit --
   * and open the first draft left, or a fresh rank 85 one. Its id. A store that cannot delete
   * throws, and nothing changes. */
  remove(): string {
    const { store } = this.deps
    if (store.get(this.openId)) store.remove(this.openId)
    this.drafts.delete(this.openId)
    let next = [...this.drafts.keys()][0]
    if (!next) {
      const fresh = rank85Strategy(this.deps.clock())
      this.drafts.set(fresh.id, fresh)
      next = fresh.id
    }
    this.open(next)
    return next
  }

  /** Put a run's version of the strategy in the draft, under the open strategy's id. */
  restore(record: RunRecord): void {
    this.drafts.set(this.openId, { ...structuredClone(record.strategy), id: this.openId })
  }

  /** The open draft was edited (by the editor, or here). */
  touch(): void {
    this.touched.add(this.openId)
  }

  // -- the header ---------------------------------------------------------------------------------

  rename(name: string): void {
    this.current.name = name
  }

  /** Run on `symbol` (`vendor:TICKER`; model.ts `normalInstrument` makes one of what is typed). */
  setInstrument(symbol: string): void {
    this.current.instrument = symbol
  }

  /** The window as the last N days (`days`) or as dates (`range`), over the same span. */
  setWindowKind(kind: string): void {
    Object.assign(this.current, withWindowKind(this.current, kind, this.deps.clock()))
  }

  /** The last `days` days, rounded; false (and nothing changes) for fewer than one. */
  setDays(days: number): boolean {
    const n = Math.round(days)
    if (!(n >= 1)) return false
    this.current.window = { kind: 'days', days: n }
    return true
  }

  /** From the first UTC day through the last (`yyyy-mm-dd`, the last one included); false for a
   * day that does not read. */
  setRange(firstDay: string, lastDay: string): boolean {
    const from = utcDayStart(firstDay)
    const to = utcDayStart(lastDay)
    if (from === null || to === null) return false
    this.current.window = { kind: 'range', from, to: to + DAY_MS }
    return true
  }

  /** No holdout (`''`), the last 30% (`percent`) or from the day 30% back from the end (`from`). */
  setHoldoutKind(kind: string): void {
    Object.assign(this.current, withHoldoutKind(this.current, kind, runWindow(this.current, { now: this.deps.clock() })))
  }

  /** Hold out the last `percent`%; false for one not strictly between 0 and 100. */
  setHoldoutPercent(percent: number): boolean {
    if (!(percent > 0 && percent < 100)) return false
    this.current.holdout = { kind: 'percent', percent }
    return true
  }

  /** Hold out from a UTC day (`yyyy-mm-dd`); false for one that does not read. */
  setHoldoutFrom(day: string): boolean {
    const at = utcDayStart(day)
    if (at === null) return false
    this.current.holdout = { kind: 'from', at }
    return true
  }

  // -- running ------------------------------------------------------------------------------------

  /** Whether a run of the open draft is in progress (from `run` until it is settled or stopped). */
  get running(): boolean {
    return this.busy
  }

  /** The last run of the open strategy that finished; null before one, and after a switch. */
  get lastRun(): LabRun | null {
    return this.finished
  }

  /** Run a copy of the open draft, so editing on while it runs changes nothing in it. `onProgress`
   * hears the stages while the run is the latest. A finished run is kept in the history and is
   * `lastRun`; an abandoned one is dropped. */
  async run(onProgress: (text: string) => void): Promise<RunOutcome> {
    const ticket = ++this.token
    const strategy = structuredClone(this.current)
    this.busy = true
    try {
      const run = await runStrategy(strategy, this.deps.data, {
        catalogue: this.deps.catalogue,
        onProgress: (text) => {
          if (ticket === this.token) onProgress(text)
        },
        isCancelled: () => ticket !== this.token
      })
      if (ticket !== this.token) return { kind: 'cancelled', ticket }
      this.finished = run
      this.shown = this.history.add(run, this.deps.clock())
      return { kind: 'done', ticket, run }
    } catch (err) {
      if (err instanceof RunCancelled || ticket !== this.token) return { kind: 'cancelled', ticket }
      if (err instanceof RunError) return { kind: 'problems', ticket, problems: err.problems, message: err.message }
      return { kind: 'failed', ticket, error: err }
    }
  }

  /** Whether the run with `ticket` is still the latest: nothing stopped or overtook it. */
  isLatest(ticket: number): boolean {
    return ticket === this.token
  }

  /** A run's outcome has been shown: when it is still the latest, nothing runs now. Whether so. */
  settle(ticket: number): boolean {
    if (!this.isLatest(ticket)) return false
    this.stop()
    return true
  }

  /** Abandon the run in progress; the last one that finished stays `lastRun`. */
  stop(): void {
    this.token++
    this.busy = false
  }

  /** A sweep's run of a copy of the draft: a whole run, with no account per rule. */
  sweepRun(strategy: Strategy, isCancelled: () => boolean): Promise<LabRun> {
    return runStrategy(strategy, this.deps.data, { catalogue: this.deps.catalogue, isCancelled, perRule: false })
  }

  /** A basket's run of the draft on `symbol`: the open strategy's own instrument through the
   * page's data, any other through a data layer of its own. */
  basketRun(strategy: Strategy, symbol: string, isCancelled: () => boolean): Promise<LabRun> {
    const data = symbol === this.current.instrument ? this.deps.data : this.deps.newData()
    return runStrategy(strategy, data, { symbol, catalogue: this.deps.catalogue, isCancelled, perRule: false })
  }

  // -- this session's runs ------------------------------------------------------------------------

  /** The open strategy's runs, oldest first. */
  runs(): readonly RunRecord[] {
    return this.history.list(this.openId)
  }

  /** The open strategy's pinned run; null for none. */
  baseline(): RunRecord | null {
    return this.history.baseline(this.openId)
  }

  /** Pin a run as the open strategy's baseline; null unpins. */
  pin(record: RunRecord | null): void {
    this.history.pin(this.openId, record?.id ?? null)
  }

  /** The run shown, when it is the open strategy's: its id in the history. */
  shownRunId(): number | null {
    return this.shown?.strategy.id === this.openId ? this.shown.id : null
  }

  /** The baseline the Summary sets the run shown beside: none when the baseline IS that run. */
  comparedBaseline(): RunRecord | null {
    const baseline = this.baseline()
    return baseline && baseline.id !== this.shown?.id ? baseline : null
  }

  /** A run's place among its strategy's runs, from 1. */
  runNumber(record: RunRecord): number {
    return this.history.list(record.strategy.id).indexOf(record) + 1
  }

  /** Signals the last run read, by `source|interval`, while it is the open strategy's run. */
  signalCounts(): Map<string, number> | null {
    const run = this.finished
    return run && run.strategy.id === this.openId ? new Map(run.counts.map((c) => [`${c.source}|${c.interval}`, c.signals])) : null
  }
}
