import type { IndicatorGroup } from '../../src'
import { loadServerCatalogue } from '../alerts/catalogue'
import { phaseLabel } from '../plugins/legend'
import { paneConfig } from '../plugins/paneconfig'
import type { BindContext, BindingSpec, IndicatorPlugin, Phase, Range, SourceSpec, SourceStore } from '../plugins/types'
import { gridFor } from '../replay/timeframes'
import { HttpLabData, type LabData } from './data'
import { DEFAULT_SHOW, LAB_TEMPLATE, publishRun, registerLabTemplate, type ShowOptions } from './overlay'
import { type LabRun, runStrategy } from './runner'
import { sharedStrategyStore, type StrategyStore } from './store'

// A SAVED STRATEGY ON A DASHBOARD PANE -- where a strategy developed in the Strategy Lab goes
// once it is good. One template, `LAB:strategy` (./overlay.ts, the same drawing the lab's chart
// uses), offered in the picker; the gear chooses which saved strategy the pane draws and what of
// it. The run is the strategy's own (./runner.ts) on the PANE's instrument, over the span the pane
// has loaded: its graphs and entries, and -- switched on -- its simulated trades.
//
// What a pane reads is the SAVED strategy: an experiment in the lab changes nothing here until it
// is saved, and a save in another tab of this browser redraws every pane showing that strategy at
// once (./store.ts announces it). It re-runs every minute as well, so a new entry appears without a
// reload; the data layer re-reads only the tail of what it holds.
//
// One store per strategy and instrument, shared by every pane showing them whatever its
// timeframe -- a run does not depend on the chart's interval; only where its nodes are drawn does.

export interface LabPaneConfig extends ShowOptions {
  /** The saved strategy's id; '' for the most recently saved. */
  strategy: string
}

const DEFAULTS: LabPaneConfig = { strategy: '', ...DEFAULT_SHOW, trades: false }

/** How often a pane's run is made again, for a new bar's entries. */
const REFRESH_MS = 60_000

/** One run, as a store holds it: the run and the absolute span it covers. */
interface RunPoint {
  date: number
  run: LabRun
}

/** A source store holding one run over the union of every span asked of it. */
export class RunStore implements SourceStore<RunPoint> {
  rev = 0
  phase: Phase = 'idle'
  progress: number | null = null
  error: string | null = null
  run: LabRun | null = null
  /** The absolute span the run covers. */
  span: Range | null = null
  /** Set to make the next cover run again over the whole span. */
  stale = false

  constructor(readonly key: string) {}

  get size(): number {
    return this.run ? this.run.entries.length + 1 : 0
  }

  ingest(points: RunPoint[], window: Range): void {
    const point = points.at(-1)
    if (point) {
      this.run = point.run
      publishRun(this.key, point.run)
    }
    this.span = window
    this.stale = false
    this.rev++
  }

  /** The whole union of the span held and the one asked, when anything of it is not held: a run is
   * made over a span at once, never pieced together (a graph reaches back across any seam). */
  missing(window: Range): Range[] {
    const held = this.span
    if (held && !this.stale && held.from <= window.from && held.to >= window.to) return []
    return [held ? { from: Math.min(held.from, window.from), to: Math.max(held.to, window.to) } : window]
  }

  setPhase(phase: Phase, progress: number | null = null, error: string | null = null): void {
    this.phase = phase
    this.progress = progress
    this.error = error
    this.rev++
  }
}

export interface LabPluginOptions {
  /** The saved strategies; the page's shared store by default. */
  store?: () => Promise<StrategyStore>
  data?: LabData
  now?: () => number
}

export function createLabPlugin(options: LabPluginOptions = {}): IndicatorPlugin {
  let strategies: StrategyStore | null = null
  const data = options.data ?? new HttpLabData()
  const now = options.now ?? (() => Date.now())
  /** Who to tell when a strategy is saved elsewhere, by strategy id. */
  const watchers = new Map<string, Set<() => void>>()

  const resolve = (id: string) => {
    if (!strategies) return null
    if (id) return strategies.get(id)
    return [...strategies.list()].sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null
  }

  const config = paneConfig<LabPaneConfig>({
    templates: [LAB_TEMPLATE],
    doc: ['mx', 'lab'],
    title: 'Strategy',
    // A getter: the choices are the strategies saved when the gear is opened.
    get fields() {
      return [
        {
          kind: 'select' as const,
          key: 'strategy',
          label: 'Strategy',
          options: [{ value: '', label: 'the latest saved' }, ...(strategies?.list() ?? []).map((s) => ({ value: s.id, label: s.name || s.id }))]
        },
        { kind: 'switch' as const, key: 'graphs', label: 'Graphs' },
        { kind: 'switch' as const, key: 'entries', label: 'Entries' },
        { kind: 'switch' as const, key: 'signals', label: 'Every signal of the pool' },
        { kind: 'switch' as const, key: 'trades', label: 'Simulated trades' }
      ]
    },
    defaults: DEFAULTS,
    normalise: (c) => ({ ...DEFAULTS, ...c }),
    toStored: (c) => {
      const out: Partial<LabPaneConfig> = {}
      for (const key of Object.keys(DEFAULTS) as Array<keyof LabPaneConfig>) if (c[key] !== DEFAULTS[key]) (out as Record<string, unknown>)[key] = c[key]
      return Object.keys(out).length > 0 ? out : undefined
    },
    fromStored: (stored) => {
      if (typeof stored !== 'object' || stored === null) return undefined
      const s = stored as Record<string, unknown>
      const out: LabPaneConfig = { ...DEFAULTS }
      if (typeof s.strategy === 'string') out.strategy = s.strategy
      for (const key of ['graphs', 'entries', 'signals', 'trades'] as const) if (typeof s[key] === 'boolean') out[key] = s[key]
      return out
    }
  })

  return {
    id: 'lab',
    feature: null,
    paneConfigs: [config],
    async register(): Promise<IndicatorGroup[]> {
      registerLabTemplate()
      strategies = await (options.store ?? sharedStrategyStore)()
      strategies.onRemoteChange(async (message) => {
        await strategies?.load(true)
        for (const notify of watchers.get(message.id) ?? []) notify()
      })
      return [
        {
          label: 'Strategy Lab · price pane',
          main: true,
          items: [
            {
              name: LAB_TEMPLATE,
              label: 'Saved strategy',
              description: 'A strategy saved in the Strategy Lab, run on this pane’s instrument: its graphs, entries and (switched on) simulated trades. Which strategy is on the gear.'
            }
          ]
        }
      ]
    },
    matches: (name) => name === LAB_TEMPLATE,
    bind(ctx: BindContext): BindingSpec | null {
      const pane = ctx.config as LabPaneConfig
      const strategy = resolve(pane.strategy)
      const grid = gridFor(ctx.symbol)
      const show: ShowOptions = { graphs: pane.graphs, entries: pane.entries, signals: pane.signals, trades: pane.trades }
      if (!strategy || !grid) {
        const why = !grid ? 'no market hours for this instrument' : pane.strategy ? 'that strategy is no longer saved' : 'none saved yet: open the Strategy Lab'
        return { sources: [], label: () => `Strategy · ${why}`, extendData: () => ({ runKey: null, chartInterval: ctx.interval, show }) }
      }
      const id = strategy.id
      const symbol = `${ctx.vendor}:${ctx.ticker}`
      const key = `lab|${id}|${symbol}|${pane.trades ? 'sim' : 'nosim'}`
      const durationMs = (code: string): number => {
        const m = /^(\d+)([smhDWMY])$/.exec(code)
        const unit: Record<string, number> = { s: 1000, m: 60_000, h: 3_600_000, D: 86_400_000, W: 604_800_000, M: 2_592_000_000, Y: 31_536_000_000 }
        return m ? Number(m[1]) * unit[m[2]] : 60_000
      }
      const source: SourceSpec<RunPoint> = {
        id: 'run',
        key,
        createStore: (k) => new RunStore(k),
        // The pane's loaded bars, as absolute instants: a run is the same whichever timeframe asks.
        window: (chartRange) => ({
          from: grid.fromWire(ctx.interval, chartRange.from),
          to: Math.min(now(), grid.fromWire(ctx.interval, chartRange.to) + durationMs(ctx.interval))
        }),
        fetch: async (range) => {
          // The SAVED strategy as it is now: a save elsewhere re-runs it (`watchers`).
          const saved = strategies?.get(id)
          if (!saved) throw new Error('the strategy is no longer saved')
          const catalogue = await loadServerCatalogue().catch(() => null)
          const run = await runStrategy(saved, data, { symbol, from: range.from, to: range.to, catalogue, simulate: pane.trades, now: now() })
          return { points: [{ date: range.from, run }], nextFrom: null }
        },
        subscribe: (store, notify) => {
          const again = (): void => {
            ;(store as RunStore).stale = true
            notify.refetch()
          }
          const timer = setInterval(again, REFRESH_MS)
          let set = watchers.get(id)
          if (!set) {
            set = new Set()
            watchers.set(id, set)
          }
          set.add(again)
          return () => {
            clearInterval(timer)
            set.delete(again)
          }
        }
      }
      return {
        sources: [source],
        label: (state) => {
          const name = strategies?.get(id)?.name || 'Strategy'
          const pending = phaseLabel(`Strategy · ${name}`, state.sources.map((s) => s.store))
          if (pending) return pending
          const run = (state.sources[0]?.store as RunStore | undefined)?.run
          return run ? `Strategy · ${name} · ${run.entries.length} entries` : `Strategy · ${name}`
        },
        extendData: () => ({ runKey: key, chartInterval: ctx.interval, show })
      }
    }
  }
}
