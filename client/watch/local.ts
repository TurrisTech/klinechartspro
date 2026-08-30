import type { SourceCatalogue } from './api'
import type { WatchApi } from './store'
import {
  type Observation,
  conditionFields,
  ConditionError,
  describe,
  evaluate,
  needsPrevious,
  OPS,
  parse
} from './evaluate'
import type { Condition, SourceField, Watch, WatchDraft, WatchSource } from './types'

// A WATCH REGISTRY THAT RUNS HERE, for the one case the server's cannot serve: a BAR REPLAY.
//
// A replay's market is a walk over stored bars at the base interval and its clock is the
// cursor. No source in the server process can see either, so a watch placed on a replay wall
// is evaluated in this tab, against those same base bars (client/replay/watches.ts). A live
// wall never builds one of these: there the server watches, which is what lets an alert fire
// with the tab closed.
//
// This is a PORT of `wdashboard_server/watch/registry.py`'s policy -- arming and its seed,
// the edge trigger's memory, repeat, the cooldown -- and only that policy. Subscriptions,
// owners and durable storage are the server's problems; a replay has one instrument, pushes
// its own observations, and persists into the replay's own state blob.
//
// It implements `WatchApi`, so `WatchStore` (and therefore every gesture, dialog, line and
// axis tag in this module) drives it with no idea it is not the server. That is the whole
// modularity claim: ONE view, two backends.
//
// Parity with the server is DATA, not review -- see `evaluate.ts` and `local.test.ts`.

/** Ceiling per replay, mirroring the server's per-owner limit. */
export const MAX_WATCHES = 200
export const DEFAULT_COOLDOWN_MS = 60_000

/** What a local source is: something that can be watched during a replay. The shape mirrors
 * `wdashboard_server/watch/api.py`'s `WatchSource`, minus subscribe/unsubscribe -- a replay
 * pushes every observation it has, so there is nothing to reference-count. */
export interface LocalWatchSource {
  readonly id: string
  readonly title: string
  readonly description: string
  readonly targetHint: string
  available(): boolean
  fields(): SourceField[]
  /** Canonical spelling of a target, or throw. */
  normaliseTarget(target: string): string
  /** The latest reading, for seeding a crossing at arm time. May fetch: unlike the server's
   * (which is fed by a live stream) a replay's reading is a bar it may have to go and get. */
  current(target: string): Promise<Observation | null>
}

/** What the registry hands out when a watch fires. It knows nothing about notifications --
 * the caller turns this into one, exactly as the server reaches its centre through a single
 * callable. */
export interface WatchFiring {
  watch: Watch
  /** The source's own event clock. In a replay that is the base bar's close, NOT the wall
   * clock: the cooldown measures one firing against another on one clock. */
  at: number
  observation: Observation
  title: string
  body: string
}

export interface LocalWatchOptions {
  sources: LocalWatchSource[]
  onFire?: (firing: WatchFiring) => void
  /** Anything that changed a watch without a call through `WatchApi` -- i.e. a firing. The
   * store's own mutations already emit; this is what tells it to re-read after an event. */
  onChange?: () => void
  /** Wall clock, injected for tests. Stamps createdAt/updatedAt/armedAt only; never the
   * cooldown, which is on the source's clock. */
  now?: () => number
}

/** A watch plus the three fields that are policy state rather than wire fields. */
interface Record_ {
  wire: Omit<Watch, 'status'>
  status: 'armed' | 'fired'
  previous: Observation | null
  wasTrue: boolean
  /** When it last fired SINCE THE CURRENT ARM, on the source's clock. Separate from
   * `lastFiredAt` (history a client shows, never reset) because it is what the cooldown
   * reads: a re-arm is a deliberate "watch this again, from now". */
  firedSinceArm: number | null
}

/** The persisted shape: a watch, its status, and the policy state. Goes into the replay's
 * state blob (client/replay/persist.ts), so a reload finds a crossing still comparing
 * against the reading it was armed with -- the same decision the server's `restore()` makes
 * about its stored baseline. */
export interface LocalWatchState {
  wire: Omit<Watch, 'status'>
  status: 'armed' | 'fired'
  previous: Observation | null
  wasTrue: boolean
  firedSinceArm: number | null
}

export class LocalWatchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LocalWatchError'
  }
}

let counter = 0
function newId(): string {
  counter += 1
  return `lw${Date.now().toString(36)}${counter.toString(36)}`
}

export class LocalWatchRegistry implements WatchApi {
  private readonly records = new Map<string, Record_>()
  private readonly mounted = new Map<string, LocalWatchSource>()
  private readonly now: () => number

  constructor(private readonly opts: LocalWatchOptions) {
    for (const source of opts.sources) this.mounted.set(source.id, source)
    this.now = opts.now ?? (() => Date.now())
  }

  // -- WatchApi ---------------------------------------------------------------------------

  async sources(): Promise<SourceCatalogue> {
    return this.catalogue()
  }

  /** The catalogue, in the shape `GET /watch/sources` answers with. Only what a replay can
   * actually deliver is listed, so a form built from it cannot offer a watch that would
   * silently never fire. */
  catalogue(): SourceCatalogue {
    const sources: WatchSource[] = [...this.mounted.values()].map((source) => ({
      id: source.id,
      title: source.title || source.id,
      description: source.description,
      targetHint: source.targetHint,
      available: source.available(),
      fields: source.fields()
    }))
    return { sources, ops: [...OPS], maxWatches: MAX_WATCHES }
  }

  async list(): Promise<Watch[]> {
    return this.snapshot()
  }

  /** Newest first, as the server orders them. */
  snapshot(): Watch[] {
    return [...this.records.values()]
      .map((record) => toWire(record))
      .sort((a, b) => b.createdAt - a.createdAt)
  }

  async create(draft: WatchDraft): Promise<Watch> {
    if (this.records.size >= MAX_WATCHES) {
      throw new LocalWatchError(`at the limit of ${MAX_WATCHES} watches`)
    }
    const at = this.now()
    const record: Record_ = {
      wire: {
        id: newId(),
        source: draft.source,
        target: draft.target,
        condition: draft.condition,
        name: draft.name ?? '',
        note: draft.note ?? '',
        enabled: draft.enabled ?? true,
        trigger: draft.trigger ?? 'edge',
        repeat: draft.repeat ?? 'once',
        cooldownMs: draft.cooldownMs ?? DEFAULT_COOLDOWN_MS,
        createdAt: at,
        updatedAt: at,
        armedAt: at,
        lastFiredAt: null,
        fireCount: 0
      },
      status: 'armed',
      previous: null,
      wasTrue: false,
      firedSinceArm: null
    }
    this.apply(record, draft)
    record.wire.name = draft.name || describe(record.wire.condition)
    this.records.set(record.wire.id, record)
    await this.arm_(record)
    return toWire(record)
  }

  async update(id: string, patch: Partial<WatchDraft>): Promise<Watch> {
    const record = this.require(id)
    // Anything that changes WHAT it watches re-arms: a new level compared against a baseline
    // taken for a different question is not the question that was asked. Compared through
    // `parse`, so a condition that differs only in key order is the same question -- the
    // server compares two dicts, which does not care about order either.
    const rearm = (['source', 'target', 'condition', 'trigger', 'repeat'] as const).some(
      (key) => patch[key] !== undefined && canonical(patch[key]) !== canonical(record.wire[key])
    )
    this.apply(record, patch)
    if (patch.name !== undefined) record.wire.name = patch.name || describe(record.wire.condition)
    if (patch.note !== undefined) record.wire.note = patch.note ?? ''
    if (patch.enabled !== undefined) record.wire.enabled = patch.enabled
    record.wire.updatedAt = this.now()
    if (rearm || patch.enabled === true) await this.arm_(record)
    return toWire(record)
  }

  async arm(id: string): Promise<Watch> {
    const record = this.require(id)
    record.wire.enabled = true
    await this.arm_(record)
    record.wire.updatedAt = this.now()
    return toWire(record)
  }

  async remove(id: string): Promise<unknown> {
    this.records.delete(id)
    return { deleted: id }
  }

  // -- the event path ---------------------------------------------------------------------

  /** One observation of one target, evaluated against every armed watch on it.
   *
   * `at` is the SOURCE's clock -- for a replay, the base bar's close. Nothing here reads the
   * wall clock, so a session replaying 2024 has a cooldown measured in 2024. */
  onEvent(sourceId: string, target: string, at: number, observation: Observation): WatchFiring[] {
    const fired: WatchFiring[] = []
    for (const record of [...this.records.values()]) {
      if (record.wire.source !== sourceId || record.wire.target !== target) continue
      if (!record.wire.enabled || record.status !== 'armed') continue
      const firing = this.evaluate(record, at, observation)
      if (firing) fired.push(firing)
    }
    if (fired.length > 0) {
      for (const firing of fired) this.opts.onFire?.(firing)
      this.opts.onChange?.()
    }
    return fired
  }

  private evaluate(record: Record_, at: number, observation: Observation): WatchFiring | null {
    const result = evaluate(record.wire.condition, observation, record.previous)
    // Recorded whatever the answer: the next crossing compares against THIS reading, and an
    // unknowable answer is still an observation.
    record.previous = observation
    if (result === null) return null
    if (!result) {
      record.wasTrue = false
      return null
    }
    const already = record.wasTrue
    record.wasTrue = true
    if (record.wire.trigger === 'edge' && already) return null
    if (cooling(record, at)) return null
    return this.fire(record, at, observation)
  }

  private fire(record: Record_, at: number, observation: Observation): WatchFiring {
    record.wire.lastFiredAt = at
    record.firedSinceArm = at
    record.wire.fireCount += 1
    if (record.wire.repeat === 'once') record.status = 'fired'
    const watch = toWire(record)
    return {
      watch,
      at,
      observation,
      title: watch.name || describe(watch.condition),
      body: body(watch, observation)
    }
  }

  // -- state ------------------------------------------------------------------------------

  get(id: string): Watch | null {
    const record = this.records.get(id)
    return record ? toWire(record) : null
  }

  /** Every armed watch's `(source, target)`. What a replay asks to decide whether it must
   * walk base bars at all. */
  armedTargets(): Array<{ source: string; target: string }> {
    const out: Array<{ source: string; target: string }> = []
    for (const record of this.records.values()) {
      if (!record.wire.enabled || record.status !== 'armed') continue
      out.push({ source: record.wire.source, target: record.wire.target })
    }
    return out
  }

  toState(): LocalWatchState[] {
    return [...this.records.values()].map((record) => ({
      wire: { ...record.wire },
      status: record.status,
      previous: record.previous,
      wasTrue: record.wasTrue,
      firedSinceArm: record.firedSinceArm
    }))
  }

  /** Adopt a persisted list. A row whose condition no longer parses is dropped rather than
   * kept as a watch that cannot be evaluated. */
  restore(rows: readonly LocalWatchState[]): void {
    this.records.clear()
    for (const row of rows) {
      let condition: Condition
      try {
        condition = parse(row.wire.condition)
      } catch {
        console.warn('[watch] dropping a stored watch with an unreadable condition', row.wire.id)
        continue
      }
      this.records.set(row.wire.id, {
        wire: { ...row.wire, condition },
        status: row.status === 'fired' ? 'fired' : 'armed',
        // The STORED baseline, not a fresh reading: a move made while this tab was gone is
        // then recognised by the first event after it comes back.
        previous: row.previous ?? null,
        wasTrue: row.wasTrue === true,
        firedSinceArm: typeof row.firedSinceArm === 'number' ? row.firedSinceArm : null
      })
    }
  }

  // -- internals --------------------------------------------------------------------------

  private require(id: string): Record_ {
    const record = this.records.get(id)
    if (!record) throw new LocalWatchError(`unknown watch ${id}`)
    return record
  }

  private source(id: string): LocalWatchSource {
    const source = this.mounted.get(id)
    if (!source) {
      const known = [...this.mounted.keys()].sort().join(', ')
      throw new LocalWatchError(`unknown source '${id}' (a replay watches: ${known || 'nothing'})`)
    }
    return source
  }

  /** Validate and set the fields that define what a watch watches. Every refusal here
   * happens at the moment it is written -- a condition naming a field its source never emits
   * would otherwise be a watch that silently never fires. */
  private apply(record: Record_, changes: Partial<WatchDraft>): void {
    const sourceId = changes.source ?? record.wire.source
    const source = this.source(sourceId)
    let target: string
    try {
      target = source.normaliseTarget(String(changes.target ?? record.wire.target))
    } catch (err) {
      throw new LocalWatchError(err instanceof Error ? err.message : String(err))
    }
    let condition: Condition
    try {
      condition = parse(changes.condition ?? record.wire.condition)
    } catch (err) {
      throw new LocalWatchError(err instanceof ConditionError ? err.message : String(err))
    }
    const known = new Set(source.fields().map((field) => field.name))
    const unknown = [...conditionFields(condition)].filter((name) => !known.has(name)).sort()
    if (unknown.length > 0) {
      throw new LocalWatchError(
        `source '${sourceId}' has no field(s) ${unknown.join(', ')} (it emits ${[...known].sort().join(', ')})`
      )
    }
    const trigger = changes.trigger ?? record.wire.trigger
    if (trigger !== 'edge' && trigger !== 'level') throw new LocalWatchError(`unknown trigger '${trigger}'`)
    const repeat = changes.repeat ?? record.wire.repeat
    if (repeat !== 'once' && repeat !== 'always') throw new LocalWatchError(`unknown repeat '${repeat}'`)
    const cooldown = changes.cooldownMs ?? record.wire.cooldownMs
    if (!Number.isFinite(cooldown) || cooldown < 0) throw new LocalWatchError('cooldownMs must not be negative')
    record.wire.source = sourceId
    record.wire.target = target
    record.wire.condition = condition
    record.wire.trigger = trigger
    record.wire.repeat = repeat
    record.wire.cooldownMs = cooldown
  }

  /** (Re-)arm: seed the crossing baseline, clear the edge and the cooldown.
   *
   * Seeding from the source's CURRENT reading is what makes "alert me at 1.16500" mean
   * *reach it from where the market is now*. Without it a crossing armed above the market
   * fires on its first event, on a move nobody asked about. */
  private async arm_(record: Record_): Promise<void> {
    record.status = 'armed'
    record.wasTrue = false
    record.firedSinceArm = null
    record.wire.armedAt = this.now()
    // Only a crossing has anything to cross FROM; for a plain comparison a stored baseline
    // would be nothing but a misleading field.
    if (needsPrevious(record.wire.condition)) {
      try {
        record.previous = (await this.source(record.wire.source).current(record.wire.target)) ?? null
      } catch (err) {
        console.warn('[watch] could not seed the crossing baseline', err)
        record.previous = null
      }
    } else {
      record.previous = null
    }
  }
}

/** A value as it compares for "did this change": a condition through `parse` (so key order
 * is not a difference), anything else as itself. An unparseable one falls back to its literal
 * shape -- `apply` is about to refuse it anyway. */
function canonical(value: unknown): string {
  if (typeof value === 'object' && value !== null) {
    try {
      return JSON.stringify(parse(value))
    } catch {
      return JSON.stringify(value)
    }
  }
  return JSON.stringify(value)
}

function toWire(record: Record_): Watch {
  return {
    ...record.wire,
    condition: record.wire.condition,
    // One word for what a client shows: a disabled watch is not "armed but off".
    status: !record.wire.enabled ? 'disabled' : record.status
  }
}

/** Whether a firing is too soon after the last one. Only for a REPEATING watch (a one-shot
 * fires once, so a cooldown could only ever suppress the one firing it exists for) and only
 * for a firing since the current arm. */
function cooling(record: Record_, at: number): boolean {
  if (record.wire.repeat !== 'always' || record.wire.cooldownMs <= 0) return false
  if (record.firedSinceArm === null) return false
  return at - record.firedSinceArm < record.wire.cooldownMs
}

/** `target · readings · note`, as the server builds it. A rendering, not a rule: the number
 * format follows `%g`'s six significant digits rather than JavaScript's default, so a float
 * that landed on 1.1650000000000003 reads as 1.165. */
function body(watch: Watch, observation: Observation): string {
  const readings = Object.entries(observation)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([name, sample]) =>
      typeof sample.value === 'number'
        ? `${name} ${Number(sample.value.toPrecision(6))}`
        : `${name} ${sample.value}`
    )
    .join(', ')
  return [watch.target, readings, watch.note].filter((part) => !!part).join(' · ')
}
