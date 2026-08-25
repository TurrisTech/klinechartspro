import type { ChartProPane, Datafeed, KLineChartPro } from '../../src'
import { capabilities, hasFeature } from '../capabilities'
import type { LayerController } from '../chartlayers/controller'
import { apiGet, OhlcvApiError, setReadClock } from '../config'
import { isNoData, type OHLCVBar } from '../ohlcv'
import { loadSignalCatalogue } from '../plugins/api'
import type { PluginHost } from '../plugins/host'
import { periodToResolution } from '../periods'
import { symbolVendor } from '../symbols'
import { simApi } from '../trading/api'
import { mountTradingDock, type TradingDock } from '../trading/dock'
import { symbolKey } from '../trading/format'
import { createControlStrip, openStartDialog } from './controls'
import { Engine } from './engine'
import { ReplayFeedHub } from './feed'
import { type ReplayIntent, readIntent, restore, writeIntent } from './persist'
import { type AdvanceResult, ReplayTradingSession } from './session'
import { SignalBook } from './signals'
import { HttpBarSource, HttpSignalSource } from './source'
import { STORED_LADDER, fromWireDate, intervalStart, nominalMs, sortByLength } from './timeframes'

// GLUE. `mountBarReplay(chartPro, container, ...)` mirrors `mountPaperTrading`: the replay
// session bound to the shared trading dock, the control strip above it, and the wiring
// that keeps the chart, the plugins and the levels layer on the replay's clock.
//
// Entering or leaving replay rebuilds the wall (the datafeed differs), so the minimal
// intent -- session id + cursor -- lives in page-level storage (persist.ts) and the app
// (client/index.ts) reads it before mounting: a replay wall gets the replay datafeed and an
// inert stream, and the read clock is set before the first history load.

export const REPLAY_LOG = '[replay]'

export interface BarReplayController {
  toggle(): boolean
  isOpen(): boolean
  sync(panes: ChartProPane[]): void
  /** The pane datafeed factory for the replay wall (ChartProOptions.datafeed). */
  teardown(): void
}

export interface ReplayWallContext {
  pluginHost: PluginHost
  levelsController: LayerController
  /** Rebuild the wall (leaving replay). */
  rebuild: () => void
}

/** What a replay wall is mounted with, resolved BEFORE the chart exists (the datafeed and
 * the read clock are construction-time). */
export interface ReplayBoot {
  intent: ReplayIntent
  hub: ReplayFeedHub
  datafeed: () => Datafeed
}

export function replayAvailable(): boolean {
  return hasFeature('sim') && hasFeature('asof')
}

/** The stored intent, if the page is (still) in replay. */
export function currentIntent(): ReplayIntent | null {
  return readIntent(safeStorage())
}

function safeStorage(): Storage | null {
  try {
    return window.sessionStorage
  } catch {
    return null
  }
}

/** Prepare a replay wall: set the read clock to the cursor and build the feed hub the panes
 * will share. Called by the app before constructing the chart. */
export function bootReplay(intent: ReplayIntent, base: string): ReplayBoot {
  setReadClock(intent.cursor)
  const hub = new ReplayFeedHub(new HttpBarSource(), base, intent.cursor)
  return { intent, hub, datafeed: () => hub.createFeed() }
}

/** Leave replay: clear the clock and the intent. The caller rebuilds the wall. */
export function clearReplay(): void {
  setReadClock(null)
  writeIntent(safeStorage(), null)
}

// -- entering ------------------------------------------------------------------------------------

/** How far back the stored-ladder probe looks: a store's finest series may lag the newest
 * bar by days (a 5s backfill that stopped), and `limit=1` keeps the read to one bar. */
const PROBE_WINDOW_MS = 10 * 86_400_000

/** Probe which of the stored ladder the store holds for the instrument around `at`. */
async function storedIntervalsFor(symbol: string, at: number): Promise<string[]> {
  const out: string[] = []
  for (const code of STORED_LADDER) {
    try {
      const shift = at - fromWireDate(code, at)
      const body = await apiGet<OHLCVBar[] | { s: 'no_data' }>('/getbars', {
        symbol,
        resolution: code,
        from: at - Math.max(PROBE_WINDOW_MS, 30 * nominalMs(code)) + shift,
        to: at + shift,
        limit: 1,
        asof: null
      })
      if (Array.isArray(body) && body.length > 0 && !isNoData(body)) out.push(code)
    } catch (err) {
      if (!(err instanceof OhlcvApiError)) throw err
    }
  }
  return out
}

/** Open the start dialog on a live wall and, on confirm, create the replay session and
 * rebuild the wall in replay mode. */
export async function startReplayFlow(chartPro: KLineChartPro, anchor: HTMLElement, rebuild: () => void): Promise<void> {
  const active = chartPro.getPane(chartPro.getActivePaneId()) ?? chartPro.getPanes()[0]
  const symbolInfo = active?.getSymbol() ?? chartPro.getSymbol()
  const symbol = symbolKey(symbolInfo)
  const intervalsInUse = sortByLength([...new Set(chartPro.getPanes().map((p) => periodToResolution(p.getPeriod())))])
  const latest = capabilities().serverTime || Date.now()
  const stored = await storedIntervalsFor(symbol, latest)
  if (stored.length === 0) {
    console.warn(`${REPLAY_LOG} no stored bars for ${symbol}`)
    return
  }
  openStartDialog({
    anchor,
    symbol,
    intervalsInUse,
    stored,
    latest,
    onStart: ({ startAt, balance, base }) => {
      void (async () => {
        const cursor = intervalStart(base, startAt)
        const created = await simApi.create({ mode: 'replay', balance, symbol })
        const session = created.session
        const engine = new Engine(balance, session.account.currency)
        const state = new ReplayTradingSession({
          id: session.id,
          name: session.name,
          createdAt: session.createdAt,
          vendor: symbolVendor(symbolInfo),
          symbol,
          cursor,
          startedAt: cursor,
          base,
          advance: { interval: intervalsInUse[0] ?? base, multiple: 1 },
          pauseOnFill: false,
          storedIntervals: stored,
          engine,
          signals: new SignalBook([], new HttpSignalSource()),
          barSource: new HttpBarSource(),
          dataEnd: () => latest,
          save: async () => {},
          onAdvanced: () => {}
        }).toState()
        await simApi.putState(session.id, session.rev, state)
        writeIntent(safeStorage(), { sessionId: session.id, cursor })
        rebuild()
      })().catch((err) => console.error(`${REPLAY_LOG} could not start`, err))
    }
  })
}

// -- the replay wall -------------------------------------------------------------------------------

/** Mount the replay on a wall built with `bootReplay`'s datafeed. Resolves null (and clears
 * the intent) when the session cannot be loaded, so the app falls back to a live wall. */
export async function mountBarReplay(
  chartPro: KLineChartPro,
  container: HTMLElement,
  boot: ReplayBoot,
  ctx: ReplayWallContext
): Promise<BarReplayController | null> {
  let answer: Awaited<ReturnType<typeof simApi.get>>
  try {
    answer = await simApi.get(boot.intent.sessionId)
  } catch (err) {
    console.error(`${REPLAY_LOG} session ${boot.intent.sessionId} unavailable; leaving replay`, err)
    clearReplay()
    ctx.rebuild()
    return null
  }
  const stored = restore(answer.session.state)
  if (!stored) {
    console.error(`${REPLAY_LOG} session ${boot.intent.sessionId} has no readable state; leaving replay`)
    clearReplay()
    ctx.rebuild()
    return null
  }
  let rev = answer.session.rev
  const catalogue = await loadSignalCatalogue().catch(() => [])
  const signals = new SignalBook(catalogue, new HttpSignalSource())
  for (const ref of stored.starred) signals.star(ref)
  signals.setArmed(stored.armed)
  const storedIntervals = await storedIntervalsFor(stored.symbol, stored.cursor)
  const latest = capabilities().serverTime || Date.now()
  const hub = boot.hub
  hub.setBase(stored.base)
  hub.cursor = stored.cursor
  setReadClock(stored.cursor)

  const intervalsInUse = (): string[] => sortByLength([...new Set(chartPro.getPanes().map((p) => periodToResolution(p.getPeriod())))])

  const session = new ReplayTradingSession({
    id: answer.session.id,
    name: answer.session.name,
    createdAt: answer.session.createdAt,
    vendor: stored.vendor,
    symbol: stored.symbol,
    cursor: stored.cursor,
    startedAt: stored.startedAt,
    base: stored.base,
    advance: stored.advance,
    pauseOnFill: stored.pauseOnFill,
    storedIntervals: storedIntervals.length > 0 ? storedIntervals : [stored.base],
    engine: Engine.fromState(stored.engine),
    signals,
    barSource: new HttpBarSource(),
    dataEnd: () => latest,
    save: async (state) => {
      try {
        const saved = await simApi.putState(answer.session.id, rev, state)
        rev = saved.session.rev
      } catch (err) {
        if (err instanceof OhlcvApiError && err.status === 409) {
          // Another tab saved: take its rev and save again on the next change.
          const fresh = await simApi.get(answer.session.id)
          rev = fresh.session.rev
          console.warn(`${REPLAY_LOG} stale rev; resynced to ${rev}`)
          return
        }
        throw err
      }
      writeIntent(safeStorage(), { sessionId: answer.session.id, cursor: state.cursor })
    },
    onAdvanced: async (result: AdvanceResult) => {
      // The one place the clock moves for the chart: every read from here on is clamped
      // to the new cursor, the panes are brought up to it, and everything that fetched
      // under the old clock forgets its coverage past the old cursor.
      setReadClock(result.to)
      hub.cursor = result.to
      hub.setBase(session.base)
      const reports = await hub.push(chartPro.getPanes(), result.from)
      const problems = reports.filter((r) => r.problem)
      if (problems.length > 0) console.error(`${REPLAY_LOG} pane contiguity problems`, problems)
      ctx.pluginHost.invalidateFrom(result.from - nominalMs(session.base))
      ctx.levelsController.invalidate()
      dock.overlays.update(session.snapshot)
    }
  })
  session.setIntervalsInUse(intervalsInUse())

  const strip = createControlStrip({
    controller: session,
    intervalsInUse,
    onExit: () => {
      clearReplay()
      ctx.rebuild()
    },
    onStop: (result) => {
      if (result.events.length > 0) dock.panel.showTab(result.events.some((e) => e.kind === 'close') ? 'history' : 'positions')
    }
  })

  const dock: TradingDock = mountTradingDock(session, {
    chartPro,
    container,
    title: 'Replay account',
    tag: 'replay',
    header: strip.element
  })
  dock.setOpen(true)
  // The panes mounted while this function was awaiting the session (onPanesChange fired
  // before the controller existed), so the dock's overlays are synced here explicitly.
  dock.sync(chartPro.getPanes())
  await session.primeQuote()

  return {
    toggle: () => dock.toggle(),
    isOpen: () => dock.isOpen(),
    sync(panes: ChartProPane[]): void {
      dock.sync(panes)
      const check = session.setIntervalsInUse(panes.map((p) => periodToResolution(p.getPeriod())))
      if (!check.ok) console.warn(`${REPLAY_LOG} base ${session.base} no longer fits the wall: ${check.reason}`)
      strip.refresh()
    },
    teardown(): void {
      strip.dispose()
      dock.teardown()
      session.dispose()
      hub.dumpAll()
    }
  }
}
