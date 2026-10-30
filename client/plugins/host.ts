import type { Chart, Indicator } from 'klinecharts'
import type { ChartProPane, IndicatorGroup, IndicatorParamsCheck, IndicatorSettingsModel } from '../../src'
import { openSettingsPanel as openPanel, setByPath, type SettingsPanelHandle } from '../chartlayers/settings'
import { onViewMoved } from '../chartview'
import { gridFor } from '../replay/timeframes'
import { knownThrough } from './horizon'
import { type PaneConfig, PaneConfigStore, type PaneDoc } from './paneconfig'
import { dropStore, liveStores, missingRanges, storeFor, WindowStore } from './store'
import type {
  BindContext,
  BindingSpec,
  BindingState,
  BoundSource,
  IndicatorPlugin,
  PluginFacilities,
  Range,
  SettingsRequest,
  SourceSpec,
  SourceStore,
  SourceWarm,
  ValidateRequest
} from './types'

// The plugin host: one controller for every indicator plugin on every live pane.
//
// Per pane it watches the chart's own indicator list (klinecharts is the source of truth for
// "what is on this pane": the library's picker/settings dialogs create, remove and
// re-parameterise indicators without telling anyone), and for each indicator a plugin claims
// it asks that plugin for a binding: which sources to read. It then keeps every source
// covered for exactly the bar range the chart holds and nothing it already has (paged),
// subscribed where the source offers it, and hands the chart the values by bumping the
// indicator's extendData (which the plugin's `calc` reads back from the stores). A change
// of symbol, period, params or plugin signature under a pane rebinds; the old sources are
// released, and a store is dropped when no binding on the wall reads it any more.
//
// Built per MOUNT, not once per page: it holds per-pane state keyed by pane id, and
// `sync([])` at teardown is the only signal it gets.
//
// One thing it does that is not coverage: on a bar replay's word, it has the server compute
// ahead what the sources will read at the replay's next landing (`warmAhead`) -- only for the
// sources that offer it, and never filing what comes back.

const POLL_MS = 500
const RANGE_DEBOUNCE_MS = 250
const MAX_PAGES_PER_GAP = 20
/** How often `settled` looks again while some binding is still fetching. */
const SETTLE_POLL_MS = 50
/** The longest a re-apply waits for an animation frame: none comes in a hidden tab. */
const APPLY_FALLBACK_MS = 100
/** Rough height of one klinecharts legend row: a settings panel hangs just below the legend
 * the gear sits in. */
const LEGEND_ROW_HEIGHT = 24

interface Binding {
  plugin: IndicatorPlugin
  indicatorId: string
  name: string
  chartPaneId: string
  signature: string
  /** Monotonic per host; folded into `rev` so a rebind always reaches the template. */
  seq: number
  spec: BindingSpec
  sources: Array<BoundSource & { spec: SourceSpec; unsubscribe: (() => void) | null }>
  state: BindingState
  inFlight: Set<string>
  retryTimer: ReturnType<typeof setTimeout> | null
  /** `BindingSpec.attach`'s release. */
  detach: (() => void) | null
  disposed: boolean
  lastAppliedRev: number
  lastShortName: string
}

interface WiredPane {
  pane: ChartProPane
  paneIndex: number
  chart: Chart
  bindings: Map<string, Binding>
  poll: ReturnType<typeof setInterval>
  rangeTimer: ReturnType<typeof setTimeout> | null
  /** The release of its view-moved subscription. */
  unwatchView: () => void
}

export interface PluginHost {
  /** The picker groups every registered plugin contributed, in registry order. */
  readonly groups: IndicatorGroup[]
  /** The plugins that registered (their feature was advertised). */
  readonly plugins: IndicatorPlugin[]
  sync(panes: ChartProPane[]): void
  /** ChartProOptions.indicatorSettingsHandler. */
  handleSettings(request: SettingsRequest): boolean
  /** ChartProOptions.indicatorSettingsOwned. */
  ownsSettings(templateName: string): boolean
  /** ChartProOptions.indicatorSettingsModel: the plugin's settings, addressed by wall pane. */
  settingsModel(templateName: string): IndicatorSettingsModel | null
  /** ChartProOptions.indicatorParamsValidator, or null when no plugin validates. */
  readonly validateParams: ((request: ValidateRequest) => Promise<IndicatorParamsCheck>) | null
  /** Every pane's plugin settings as the wall document stores them, by pane index
   * (paneconfig.ts) -- what `client/layout.ts` writes into each pane's entry. */
  paneDocs(): Record<number, PaneDoc>
  /** Panes changed places on the wall (ChartProOptions.onPaneOrderChange: `order[newIndex] =
   * oldIndex`): every pane's settings move with it. Called BEFORE the next `sync`, which then
   * finds each moved pane at its new index and rebinds it there. */
  reorderPanes(order: readonly number[]): void
  /** The read clock moved forward off `clock` (a replay step): forget the coverage that
   * `clock` made incomplete and re-cover every binding. */
  invalidateFrom(clock: number): void
  /** Have the server work out ahead of time what every source that offers it (`SourceSpec.warm`)
   * will read once the read clock stands at `at` -- a bar replay's next landing -- for the bars
   * `landingRange` says each pane will hold then. One read per store, over the union of the
   * windows of the panes reading it; a store already warmed for `at` over as much is skipped, so
   * asking again for the same landing sends nothing. Sends at once (when is the caller's call)
   * and resolves, with how many reads it sent, once they are all answered. Nothing is filed. */
  warmAhead(at: number, landingRange: (pane: ChartProPane) => Range | null): Promise<number>
  /** Resolves once no binding has a fetch in flight, or when `timeoutMs` is up -- for a caller
   * that must wait for what the panes draw AFTER a step, rather than what they drew before it
   * (the replay's Play). A timeout is not an error here: the caller reads whatever
   * the panes have, and the read itself says how far they have got. */
  settled(timeoutMs?: number): Promise<void>
  teardown(): void
}

export interface CreateHostOptions {
  plugins: IndicatorPlugin[]
  facilities: PluginFacilities
  /** Each pane's plugin settings as the wall document stored them, by pane index. */
  paneDocs?: Record<number, PaneDoc | undefined>
  /** Ask the app to save the wall: a pane's settings were edited. */
  requestPersist?: () => void
  /** The settings panel; a test passes a recorder. */
  openSettingsPanel?: typeof openPanel
}

export async function createPluginHost(options: CreateHostOptions): Promise<PluginHost> {
  const wired = new Map<string, WiredPane>()
  const facilities = options.facilities
  let seq = 0

  const plugins: IndicatorPlugin[] = []
  const groups: IndicatorGroup[] = []
  for (const plugin of options.plugins) {
    if (plugin.feature !== null && !facilities.hasFeature(plugin.feature)) continue
    try {
      groups.push(...(await plugin.register(facilities)))
      plugins.push(plugin)
    } catch (err) {
      // A plugin that cannot register (its catalogue failed to load, say) contributes
      // nothing; the others must not go down with it.
      console.error(`[plugins] ${plugin.id} failed to register`, err)
    }
  }

  const pluginFor = (name: string): IndicatorPlugin | undefined => plugins.find((p) => p.matches(name))

  // Per-pane settings: owned for the plugins that registered, carried verbatim for the rest so
  // a server that cannot draw an overlay does not cost a pane its settings at the next save.
  const configByTemplate = new Map<string, PaneConfig>()
  for (const plugin of plugins) for (const config of plugin.paneConfigs ?? []) for (const name of config.templates) configByTemplate.set(name, config)
  const paneConfigs = new PaneConfigStore(
    [...new Set(configByTemplate.values())],
    options.plugins.flatMap((plugin) => (plugin.paneConfigs ?? []).map((config) => config.doc))
  )
  paneConfigs.hydrate(options.paneDocs ?? {})
  const openSettingsPanel = options.openSettingsPanel ?? openPanel
  let panel: SettingsPanelHandle | null = null

  /** A pane's settings edited, from its panel or from the indicator manager: kept, the wall
   * saved, and only that pane rebound -- the settings belong to it, so another pane showing the
   * same instrument keeps whatever it was set to. */
  const writeConfig = (config: PaneConfig, paneIndex: number, paneId: string, next: object): void => {
    paneConfigs.write(config, paneIndex, next)
    options.requestPersist?.()
    const entry = wired.get(paneId)
    if (entry) reconcile(entry)
  }

  /** One field of a pane's settings, by its dotted key: the indicator manager's edit, and a
   * binding's own (`BindContext.editConfig`). The pane is looked up at the moment of the edit,
   * so one that has since moved on the wall is written at its new index. */
  const editField = (config: PaneConfig, paneId: string, key: string, value: unknown): void => {
    const entry = wired.get(paneId)
    if (!entry) return
    const next = structuredClone(paneConfigs.read(config, entry.paneIndex))
    setByPath(next, key, value)
    writeConfig(config, entry.paneIndex, paneId, next)
  }

  const openConfigPanel = (config: PaneConfig, paneId: string): boolean => {
    const entry = wired.get(paneId)
    if (!entry) return false
    // The gear is drawn on the chart's CANVAS, not in the DOM, so there is no element to point
    // at. The chart container is what the panel must live inside (it carries the theme class
    // the panel's tokens resolve against), but it is the full height of the pane, so its own
    // rect is the wrong place to hang the panel from -- under its bottom edge is below the
    // fold. Hence an explicit rect: just under the legend row at the chart's top left, which is
    // where the gear that opened it is drawn.
    let anchor: HTMLElement | null = null
    try {
      anchor = entry.chart.getDom() as HTMLElement | null
    } catch {
      anchor = null
    }
    if (!anchor) return false
    const rect = anchor.getBoundingClientRect()
    const paneIndex = entry.paneIndex
    panel?.close()
    panel = openSettingsPanel<object>({
      anchor,
      anchorRect: { top: rect.top, bottom: rect.top + LEGEND_ROW_HEIGHT, left: rect.left + 8 },
      // Names the pane, because the settings are that pane's alone and a wall can have twelve
      // of them open on different instruments.
      title: `${config.title} · ${entry.pane.getSymbol().ticker} ${facilities.periodToResolution(entry.pane.getPeriod())}`,
      fields: config.fields,
      config: paneConfigs.read(config, paneIndex),
      defaults: config.defaults,
      onChange: (next) => writeConfig(config, paneIndex, paneId, next),
      onClose: () => {
        panel = null
      }
    })
    return true
  }

  const chartRange = (chart: Chart): Range | null => {
    const data = chart.getDataList()
    if (data.length === 0) return null
    return { from: data[0].timestamp, to: data[data.length - 1].timestamp + 1 }
  }

  const aggregateRev = (b: Binding): number => {
    let rev = b.seq * 1_000_003
    for (const s of b.sources) rev += s.store.rev
    return rev
  }

  const apply = (entry: WiredPane, b: Binding): void => {
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
      ...(b.spec.extendData?.(b.state) ?? {})
    }
    try {
      // klinecharts MERGES an override's extendData into the indicator's own, deeply: an array
      // is merged index by index and a key is never removed, so a plugin could never say "these
      // and no others" -- an MTF overlay's graph roots going from ['1D', '8h'] to [] read
      // ['8h', '8h'], and the graph stayed drawn. Clearing the indicator's own first makes the
      // merge a copy of exactly what is sent.
      for (const live of entry.chart.getIndicators({ id: b.indicatorId })) live.extendData = undefined
      entry.chart.overrideIndicator({ id: b.indicatorId, name: b.name, paneId: b.chartPaneId, extendData, shortName } as never)
    } catch (err) {
      console.warn(`[plugins] ${b.plugin.id} override failed`, err)
    }
  }

  // Re-applies are coalesced to one per binding per animation frame. Each is an
  // `overrideIndicator`, and so a full `calc` of the template and a layout: a fetch arrives in
  // pages, an MTF overlay reads five sources, and a live point lands on several stores at once,
  // so applying each as it came recalculated the same indicator several times a frame -- going
  // live once cost five back-to-back ~150 ms frames on a prod wall (2026-10-07). A binding just
  // made is still applied at once (`reconcile`), so its legend appears with it.
  const dirty = new Map<Binding, WiredPane>()
  let flushPending = false
  const flushApplies = (): void => {
    flushPending = false
    const batch = [...dirty]
    dirty.clear()
    for (const [b, entry] of batch) apply(entry, b)
  }
  const requestApply = (entry: WiredPane, b: Binding): void => {
    dirty.set(b, entry)
    if (flushPending) return
    flushPending = true
    if (typeof requestAnimationFrame !== 'function') {
      queueMicrotask(flushApplies)
      return
    }
    let done = false
    const run = (): void => {
      if (done) return
      done = true
      if (flushPending) flushApplies()
    }
    requestAnimationFrame(run)
    setTimeout(run, APPLY_FALLBACK_MS)
  }

  /** Every binding on the wall that reads the store under `key` -- what a fetch into that
   * store changed, whichever binding asked for it. */
  const applyReaders = (key: string): void => {
    for (const e of wired.values()) {
      for (const other of e.bindings.values()) {
        if (!other.disposed && other.sources.some((s) => s.key === key)) requestApply(e, other)
      }
    }
  }

  // Every fetch in flight, by store: what it covers, the turn it was sent in, and when it ends. A
  // binding whose window overlaps a fetch another binding already has in flight waits for it
  // rather than asking for the same bars again -- two panes on one instrument (an MTF overlay's
  // 4h source under a 1h and a 15m pane) used to fetch the part they share twice.
  const storeFetches = new Map<string, Set<{ range: Range; turn: number; done: Promise<void> }>>()

  // Waiting is wrong for a `refetch`, though: that is a live cue saying the producer has written
  // something, and a fetch sent before the cue arrived was answered without it -- yet its answer
  // is filed as covering the range, so a cue that only waited for it was lost until the next one.
  // On prod the timeframes of one close arrive ~100 ms apart and a re-read takes 100-300 ms, so
  // an MTF overlay's second timeframe routinely landed inside its first one's read (2026-10-27).
  // So a refetch records, per store, the turn it came in and where the store is short; a fetch
  // that lands with one recorded after the turn it was sent in reads that part again, once.
  //
  // A turn is one task: everything one stream message sets off -- every pane's listener for it,
  // and the fetch the first of them sends -- shares one, so two panes on one store still read
  // once per cue. Any call schedules the move to the next, so it moves before anything later runs.
  const invalidations = new Map<string, Array<{ turn: number; from: number }>>()
  let turn = 0
  let turnEnding = false
  const currentTurn = (): number => {
    if (!turnEnding) {
      turnEnding = true
      queueMicrotask(() => {
        turnEnding = false
        turn++
      })
    }
    return turn
  }

  /** What a refetch of `b` was told: from where each source it reads is short, at this turn. Only
   * a store with a fetch in flight records it -- no other fetch can have been asked too early. */
  const noteInvalidation = (entry: WiredPane, b: Binding): void => {
    const range = chartRange(entry.chart)
    if (!range) return
    for (const source of b.sources) {
      if (!storeFetches.has(source.key)) continue
      const window = source.spec.window ? source.spec.window(range) : range
      const gap = window ? source.store.missing(window)[0] : undefined
      if (!gap) continue
      const marks = invalidations.get(source.key) ?? []
      marks.push({ turn: currentTurn(), from: gap.from })
      invalidations.set(source.key, marks)
    }
  }

  /** The part of a landed fetch's range a refetch invalidated after it was sent, or null. */
  const staleSpan = (key: string, fetch: { range: Range; turn: number }): Range | null => {
    let from = Number.POSITIVE_INFINITY
    for (const mark of invalidations.get(key) ?? []) if (mark.turn > fetch.turn) from = Math.min(from, mark.from)
    const span = { from: Math.max(from, fetch.range.from), to: fetch.range.to }
    return span.from < span.to ? span : null
  }

  // What each store was last warmed for (`warmAhead`): the read clock and the window. Every
  // advance that stops short of the next landing asks for it again, and none of those asks may
  // reach the server: each would be a read of what the first one built, one per store per Step.
  // One entry per store, so the next landing replaces the last.
  const warmed = new Map<string, { at: number; window: Range }>()

  const scheduleRetry = (entry: WiredPane, b: Binding, afterMs: number): void => {
    if (b.retryTimer) clearTimeout(b.retryTimer)
    b.retryTimer = setTimeout(() => {
      b.retryTimer = null
      void ensureCoverage(entry, b)
    }, Math.max(500, afterMs))
  }

  const fetchGap = async (entry: WiredPane, b: Binding, source: Binding['sources'][number], gap: Range): Promise<void> => {
    const tag = `${source.id}|${gap.from}-${gap.to}`
    if (b.inFlight.has(tag)) return
    b.inFlight.add(tag)
    const store = source.store
    let finish = (): void => {}
    let filed = false
    const fetch = { range: gap, turn: currentTurn(), done: new Promise<void>((resolve) => (finish = resolve)) }
    let running = storeFetches.get(source.key)
    if (!running) {
      running = new Set()
      storeFetches.set(source.key, running)
    }
    running.add(fetch)
    try {
      let from = gap.from
      let pages = 0
      while (from < gap.to && !b.disposed && pages < MAX_PAGES_PER_GAP) {
        pages++
        const page = await source.spec.fetch({ from, to: gap.to }, facilities.maxValuesPerRequest)
        if (b.disposed) return
        if (page.status) {
          store.setPhase(page.status.phase, page.status.progress)
          applyReaders(source.key)
          scheduleRetry(entry, b, page.status.retryAfterMs)
          return
        }
        const to = page.nextFrom ?? gap.to
        store.ingest(page.points, { from, to }, page.arrays)
        filed = true
        store.setPhase('ready')
        applyReaders(source.key)
        if (page.nextFrom === null) return
        from = page.nextFrom
      }
    } catch (err) {
      store.setPhase('error', null, err instanceof Error ? err.message : String(err))
      applyReaders(source.key)
      console.error(`[plugins] ${b.plugin.id} fetch failed for ${source.id}`, err)
    } finally {
      b.inFlight.delete(tag)
      running.delete(fetch)
      const again = filed && !b.disposed ? staleSpan(source.key, fetch) : null
      if (running.size === 0) {
        storeFetches.delete(source.key)
        invalidations.delete(source.key)
      }
      finish()
      // Sent before its waiters resume, so they wait for it rather than send their own.
      if (again) void fetchGap(entry, b, source, again)
    }
  }

  const ensureCoverage = async (entry: WiredPane, b: Binding): Promise<void> => {
    if (b.disposed) return
    const range = chartRange(entry.chart)
    if (!range) return
    for (const source of b.sources) {
      const window = source.spec.window ? source.spec.window(range) : range
      if (!window) continue
      // Twice at most: a fetch waited on can end short of its range -- its binding was released,
      // or the server is still building the series -- and what it left is then this one's.
      for (let pass = 0; pass < 2 && !b.disposed; pass++) {
        const waits = new Set<Promise<void>>()
        for (const gap of source.store.missing(window)) {
          const running = [...(storeFetches.get(source.key) ?? [])].filter((f) => f.range.from < gap.to && f.range.to > gap.from)
          for (const f of running) waits.add(f.done)
          for (const free of missingRanges(running.map((f) => f.range), gap)) await fetchGap(entry, b, source, free)
        }
        if (waits.size === 0) break
        // Counted as this binding's own fetch while it waits, so `settled` waits for it too.
        const tag = `${source.id}|waiting`
        b.inFlight.add(tag)
        await Promise.all(waits)
        b.inFlight.delete(tag)
      }
    }
    requestApply(entry, b)
  }

  const storeInUse = (key: string, except: Binding): boolean => {
    for (const e of wired.values()) {
      for (const other of e.bindings.values()) {
        if (other === except || other.disposed) continue
        if (other.sources.some((s) => s.key === key)) return true
      }
    }
    return false
  }

  const dispose = (b: Binding): void => {
    b.disposed = true
    if (b.retryTimer) clearTimeout(b.retryTimer)
    try {
      b.detach?.()
    } catch (err) {
      console.error(`[plugins] ${b.plugin.id} detach failed for ${b.name}`, err)
    }
    b.detach = null
    for (const s of b.sources) {
      s.unsubscribe?.()
      s.unsubscribe = null
      if (!storeInUse(s.key, b)) dropStore(s.key)
    }
  }

  // Everything a binding is made from: the indicator, the instrument, the pane's position (what
  // its settings are kept under), the revision of those settings, and whatever else on the chart
  // the plugin says it follows.
  const signatureOf = (
    ind: Indicator,
    ctx: Omit<BindContext, 'indicator' | 'siblings' | 'config' | 'follows'>,
    follows: unknown
  ): string => {
    const config = configByTemplate.get(ind.name)
    const rev = config ? paneConfigs.rev(config, ctx.paneIndex) : null
    return JSON.stringify([ind.name, ind.paneId, ind.calcParams, ctx.vendor, ctx.ticker, ctx.interval, ctx.paneIndex, rev, follows ?? null])
  }

  const bind = (entry: WiredPane, plugin: IndicatorPlugin, ind: Indicator, ctx: BindContext, sig: string): Binding | null => {
    let spec: BindingSpec | null
    try {
      spec = plugin.bind(ctx)
    } catch (err) {
      console.error(`[plugins] ${plugin.id} bind failed for ${ind.name}`, err)
      return null
    }
    if (!spec) return null
    const b: Binding = {
      plugin,
      indicatorId: ind.id,
      name: ind.name,
      chartPaneId: ind.paneId,
      signature: sig,
      seq: ++seq,
      spec,
      sources: [],
      state: { sources: [], chartInterval: ctx.interval },
      inFlight: new Set(),
      retryTimer: null,
      detach: null,
      disposed: false,
      lastAppliedRev: -1,
      lastShortName: ''
    }
    for (const sourceSpec of spec.sources as SourceSpec[]) {
      const store: SourceStore = storeFor(sourceSpec.key, sourceSpec.createStore ?? ((key) => new WindowStore(key)))
      const bound = { id: sourceSpec.id, key: sourceSpec.key, store, spec: sourceSpec, unsubscribe: null as (() => void) | null }
      b.sources.push(bound)
      b.state.sources.push({ id: bound.id, key: bound.key, store })
    }
    const patch: Record<string, unknown> = { ...(spec.overrides ?? {}) }
    if (Object.keys(patch).length > 0) {
      try {
        entry.chart.overrideIndicator({ id: ind.id, name: ind.name, paneId: ind.paneId, ...patch } as never)
      } catch {
        // ignore
      }
    }
    if (spec.yAxisGap) {
      try {
        entry.chart.overrideYAxis({ paneId: ind.paneId, gap: spec.yAxisGap })
      } catch (err) {
        console.warn(`[plugins] ${plugin.id} y-axis override failed`, err)
      }
    }
    // Subscribed after the store exists and before the first fetch, so a live point that
    // lands during the history read is not lost; the store's key, not the server's, is
    // what the subscription is keyed by.
    for (const s of b.sources) {
      if (!s.spec.subscribe) continue
      try {
        s.unsubscribe = s.spec.subscribe(s.store, {
          changed: () => requestApply(entry, b),
          refetch: () => {
            noteInvalidation(entry, b)
            void ensureCoverage(entry, b)
          }
        })
      } catch (err) {
        console.error(`[plugins] ${plugin.id} subscribe failed for ${s.id}`, err)
      }
    }
    if (spec.attach) {
      try {
        b.detach = spec.attach()
      } catch (err) {
        console.error(`[plugins] ${plugin.id} attach failed for ${ind.name}`, err)
      }
    }
    return b
  }

  const reconcile = (entry: WiredPane): void => {
    let indicators: Indicator[]
    try {
      indicators = entry.chart.getIndicators()
    } catch {
      return
    }
    const symbol = entry.pane.getSymbol()
    const interval = facilities.periodToResolution(entry.pane.getPeriod())
    const vendor = facilities.symbolVendor(symbol)
    const base = { chart: entry.chart, pane: entry.pane, paneIndex: entry.paneIndex, symbol, vendor, ticker: symbol.ticker, interval }
    const seen = new Set<string>()
    const fresh: Binding[] = []
    for (const ind of indicators) {
      const plugin = pluginFor(ind.name)
      if (!plugin) continue
      seen.add(ind.id)
      let follows: unknown
      try {
        follows = plugin.follows?.(ind, indicators)
      } catch (err) {
        console.warn(`[plugins] ${plugin.id} follows failed for ${ind.name}`, err)
      }
      const sig = signatureOf(ind, base, follows)
      const existing = entry.bindings.get(ind.id)
      if (existing && existing.signature === sig) continue
      const siblings = [...entry.bindings.values()]
        .filter((o) => o.plugin === plugin && o.indicatorId !== ind.id && !o.disposed)
        .map((o) => ({ indicatorId: o.indicatorId, name: o.name }))
      // The new binding is made AND filed before the old one is disposed, so a store both
      // read (a rebind that keeps a source) survives the hand-over instead of being dropped
      // and refetched. Filing it first is the half that matters: `dispose` asks
      // `storeInUse`, which only sees filed bindings, and a store dropped while the new
      // binding still holds it is unreachable by key -- the template's `peekStore` finds
      // nothing and the pane stays blank however much the orphan is filled.
      const config = configByTemplate.get(ind.name)
      const paneId = entry.pane.id
      const b = bind(
        entry,
        plugin,
        ind,
        {
          ...base,
          indicator: ind,
          siblings,
          config: config && paneConfigs.read(config, entry.paneIndex),
          editConfig: config ? (key: string, value: unknown) => editField(config, paneId, key, value) : undefined,
          follows
        },
        sig
      )
      if (b) entry.bindings.set(ind.id, b)
      else entry.bindings.delete(ind.id)
      if (existing) dispose(existing)
      if (!b) continue
      fresh.push(b)
    }
    for (const [id, b] of entry.bindings) {
      if (!seen.has(id)) {
        dispose(b)
        entry.bindings.delete(id)
      }
    }
    for (const b of fresh) {
      apply(entry, b)
      void ensureCoverage(entry, b)
    }
  }

  /** The first and last bar a chart holds, or null when it holds none. */
  const dataEnds = (chart: Chart): { first: number; last: number } | null => {
    const data = chart.getDataList()
    return data.length > 0 ? { first: data[0].timestamp, last: data[data.length - 1].timestamp } : null
  }

  const coverAll = (entry: WiredPane): void => {
    for (const b of entry.bindings.values()) void ensureCoverage(entry, b)
  }

  const wire = (pane: ChartProPane, paneIndex: number): void => {
    const chart = pane.getChart()
    const entry: WiredPane = {
      pane,
      paneIndex,
      chart,
      bindings: new Map(),
      poll: setInterval(() => reconcile(entry), POLL_MS),
      rangeTimer: null,
      unwatchView: () => {}
    }
    // A pan, a zoom or a page of history may expose bars a source has not covered. A tick that
    // only moves the forming bar cannot, and on a fast feed it would otherwise keep resetting
    // the debounce so that nothing newly exposed was fetched until the market went quiet.
    //
    // Bars replaced whole -- both ends moved, or the first load: a reload, as a replay's long jump
    // makes -- are one event, not a pan's stream of them, and are covered at once. Debounced, a
    // Next alert landing on prod waited 250 ms between its 5m pane's reload and the overlays'
    // reads of it.
    let ends = dataEnds(chart)
    entry.unwatchView = onViewMoved(chart, () => {
      const now = dataEnds(chart)
      const replaced = now !== null && (ends === null || (now.first !== ends.first && now.last !== ends.last))
      ends = now
      if (entry.rangeTimer) clearTimeout(entry.rangeTimer)
      entry.rangeTimer = null
      if (replaced) {
        coverAll(entry)
        return
      }
      entry.rangeTimer = setTimeout(() => {
        entry.rangeTimer = null
        coverAll(entry)
      }, RANGE_DEBOUNCE_MS)
    })
    wired.set(pane.id, entry)
    reconcile(entry)
  }

  const unwire = (id: string): void => {
    const entry = wired.get(id)
    if (!entry) return
    clearInterval(entry.poll)
    if (entry.rangeTimer) clearTimeout(entry.rangeTimer)
    entry.unwatchView()
    for (const b of entry.bindings.values()) dispose(b)
    entry.bindings.clear()
    wired.delete(id)
  }

  const validators = plugins.filter((p) => p.validateParams)
  const validateParams =
    validators.length === 0
      ? null
      : async (request: ValidateRequest): Promise<IndicatorParamsCheck> => {
          const plugin = validators.find((p) => p.matches(request.indicatorName))
          return plugin?.validateParams ? plugin.validateParams(request) : { ok: true }
        }

  // Debug hook: what each pane's plugin indicators currently hold -- read-only by
  // convention, never used by the app itself. Replaces the per-plugin __wdIndicators /
  // __wdArev / __wdMtf hooks.
  if (typeof window !== 'undefined') {
    window.__wdPlugins = {
      debug: () =>
        [...wired.values()].flatMap((entry) =>
          [...entry.bindings.values()].map((b) => ({
            pane: entry.pane.id,
            paneIndex: entry.paneIndex,
            plugin: b.plugin.id,
            name: b.name,
            sources: b.sources.map((s) => ({ id: s.id, key: s.key, size: s.store.size, phase: s.store.phase, error: s.store.error }))
          }))
        ),
      paneDocs: () => host.paneDocs()
    }
  }

  const host: PluginHost = {
    groups,
    plugins,
    validateParams,
    sync(panes: ChartProPane[]): void {
      const live = new Map(panes.map((p, i) => [p.id, { p, i }]))
      for (const id of [...wired.keys()]) if (!live.has(id)) unwire(id)
      for (const [id, { p, i }] of live) {
        const existing = wired.get(id)
        if (existing && existing.chart === p.getChart()) {
          // A layout change can renumber panes without remounting their charts; the
          // index is part of every binding's signature, so the next reconcile rebinds.
          if (existing.paneIndex !== i) {
            existing.paneIndex = i
            reconcile(existing)
          }
          continue
        }
        if (existing) unwire(id)
        wire(p, i)
      }
    },
    handleSettings(request: SettingsRequest): boolean {
      const config = configByTemplate.get(request.indicatorName)
      return config ? openConfigPanel(config, request.paneId) : false
    },
    ownsSettings(templateName: string): boolean {
      return configByTemplate.has(templateName)
    },
    settingsModel(templateName: string): IndicatorSettingsModel | null {
      const config = configByTemplate.get(templateName)
      if (!config) return null
      // Settings are kept by pane INDEX (what the wall document stores them under); the library
      // addresses panes by id. Only a wired pane has an index, and only a wired pane can be
      // holding the indicator.
      return {
        fields: config.fields,
        read: (paneId) => {
          const entry = wired.get(paneId)
          return entry ? paneConfigs.read(config, entry.paneIndex) : null
        },
        write: (paneId, key, value) => editField(config, paneId, key, value)
      }
    },
    paneDocs(): Record<number, PaneDoc> {
      return paneConfigs.snapshot()
    },
    reorderPanes(order: readonly number[]): void {
      paneConfigs.reorder(order)
    },
    async settled(timeoutMs = 3000): Promise<void> {
      const deadline = Date.now() + timeoutMs
      for (;;) {
        let busy = false
        for (const entry of wired.values()) for (const b of entry.bindings.values()) if (b.inFlight.size > 0) busy = true
        if (!busy || Date.now() >= deadline) {
          // What was fetched reaches the panes now rather than on the next frame: the caller
          // reads what they draw.
          if (dirty.size > 0) flushApplies()
          return
        }
        await new Promise((resolve) => setTimeout(resolve, SETTLE_POLL_MS))
      }
    },
    invalidateFrom(clock: number): void {
      // The read clock moved (a replay step): everything the OLD clock made unknowable may
      // be knowable now. Each source forgets from its OWN horizon under that clock -- the
      // bar it had forming at it -- and not from the cursor, because a source is dated on
      // its own interval: at a cursor of 06:15 a 15m source's last answer was final through
      // 06:15, a 1h source's only through 06:00, and a 1D source's only through the
      // session's date. Forgetting from the cursor leaves each coarser source's forming bar
      // filed as fetched-and-empty for good, which draws as a permanent hole in the series
      // -- one per stop (`horizon.ts`, and notes/architecture/freshness-horizons.md).
      const seen = new Set<string>()
      for (const entry of wired.values()) {
        // On the schedule of the instrument THIS pane shows: its forming bar is where it is.
        const grid = gridFor(entry.pane.getSymbol())
        for (const b of entry.bindings.values()) {
          if (b.disposed) continue
          for (const s of b.sources) {
            seen.add(s.key)
            s.store.forgetAfter?.(knownThrough(s.spec.resolution, clock, grid))
          }
        }
      }
      // Any store the registry still holds that no live binding reads (a rebind in flight)
      // gets the weakest true statement: nothing past the cursor was knowable.
      for (const [key, store] of liveStores()) if (!seen.has(key)) store.forgetAfter?.(clock)
      for (const entry of wired.values()) coverAll(entry)
    },
    async warmAhead(at: number, landingRange: (pane: ChartProPane) => Range | null): Promise<number> {
      // One read per store: two panes on one key read one series, so the server is asked once,
      // for everything either will ask -- the union of their windows.
      const wanted = new Map<string, { window: Range; read: SourceWarm['read'] }>()
      for (const entry of wired.values()) {
        let range: Range | null | undefined
        for (const b of entry.bindings.values()) {
          if (b.disposed) continue
          for (const s of b.sources) {
            const warm = s.spec.warm
            if (!warm) continue
            if (range === undefined) range = landingRange(entry.pane)
            if (range === null) break
            const window = warm.window(range, at)
            if (!window || window.to <= window.from) continue
            const held = wanted.get(s.key)
            if (held) held.window = { from: Math.min(held.window.from, window.from), to: Math.max(held.window.to, window.to) }
            else wanted.set(s.key, { window, read: warm.read })
          }
        }
      }
      const reads: Promise<void>[] = []
      for (const [key, { window, read }] of wanted) {
        const done = warmed.get(key)
        if (done && done.at === at && done.window.from <= window.from && done.window.to >= window.to) continue
        const mark = { at, window }
        warmed.set(key, mark)
        reads.push(
          read(window, at).catch((err) => {
            // A warm-up that failed costs the press nothing it would not have paid anyway; it is
            // forgotten, so the next ask for this landing tries again.
            if (warmed.get(key) === mark) warmed.delete(key)
            console.debug(`[plugins] warm-up of ${key} failed`, err)
          })
        )
      }
      await Promise.all(reads)
      return reads.length
    },
    teardown(): void {
      host.sync([])
      panel?.close()
      panel = null
    }
  }
  return host
}

declare global {
  interface Window {
    __wdPlugins?: { debug: () => unknown[]; paneDocs: () => unknown }
  }
}
