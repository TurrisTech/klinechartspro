import type { ChartProPane, Datafeed, KLineChartPro } from '../../src'
import { capabilities, hasFeature } from '../capabilities'
import type { LayerController } from '../chartlayers/controller'
import { apiGet, OhlcvApiError, setReadClock } from '../config'
import type { NotificationSink } from '../notifications'
import { isNoData, type OHLCVBar } from '../ohlcv'
import type { PluginHost } from '../plugins/host'
import { periodToResolution } from '../periods'
import { symbolVendor } from '../symbols'
import { type SimQuote, simApi } from '../trading/api'
import { mountTradingDock, type TradingDock } from '../trading/dock'
import { formatInstant, symbolKey } from '../trading/format'
import type { ServerCatalogue } from '../alerts/catalogue'
import type { AlertSearch } from '../alerts/search'
import type { Alert } from '../alerts/types'
import { ReplayAlerts } from './alerts'
import { createReplayControls, openStartDialog } from './controls'
import { pickBarOnChart } from './pickbar'
import { Engine } from './engine'
import { ReplayFeedHub } from './feed'
import { type ReplayIntent, readIntent, restore, writeIntent } from './persist'
import { type AdvanceResult, ReplayTradingSession } from './session'
import { HttpBarSource } from './source'
import { ReplayWatches } from './watches'
import { STORED_LADDER, fromWireDate, intervalStart, nominalMs, sortByLength } from './timeframes'

// GLUE. `mountBarReplay(chartPro, container, ...)` mirrors `mountPaperTrading`: the replay
// session bound to the shared trading dock, the floating control window over the chart, and
// the wiring that keeps the chart, the plugins and the levels layer on the replay's clock.
//
// Entering or leaving replay rebuilds the wall (the datafeed differs), so the minimal
// intent -- session id + cursor -- lives in page-level storage (persist.ts) and the app
// (client/index.ts) reads it before mounting: a replay wall gets the replay datafeed and an
// inert stream, and the read clock is set before the first history load.

export const REPLAY_LOG = '[replay]'

export interface BarReplayController {
  /** Resync the dock's overlays and the base check to the wall's panes. */
  sync(panes: ChartProPane[]): void
  /** The replay's own price watches, for `mountPriceWatches` to draw. A replay's market
   * exists only in this tab, so its watches are evaluated here, against the base bars the
   * walk consumes. */
  watches: ReplayWatches
  /** The instrument's bid/ask at the cursor -- the replay's own market, so no fetch. */
  quote(key: string): Promise<SimQuote | undefined>
  teardown(): void
}

/** The alert manager, as a replay uses it: the alerts Next alert stops at, the search that
 * finds them, and the window the controls' Alerts toggle opens. */
export interface ReplayAlertsContext {
  enabledOn(symbol: string): Alert[]
  subscribe(listener: () => void): () => void
  search: AlertSearch
  catalogue: () => Promise<ServerCatalogue>
  manager: { isOpen: () => boolean; toggle: () => void }
}

export interface ReplayWallContext {
  pluginHost: PluginHost
  levelsController: LayerController
  /** Where a fired replay watch, and an alert Next alert stops at, is announced. Supplied by
   * client/index.ts, the one module that knows the Notification Center, the watches and the
   * alerts exist together. */
  notify: NotificationSink
  /** Null where the page has no alert manager. */
  alerts: ReplayAlertsContext | null
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

/** The longest Play waits for the wall to load between two steps. */
const PLAY_SETTLE_MS = 5_000

/** How far back the stored-ladder probe looks: a store's finest series may lag the newest
 * bar by days (a 5s backfill that stopped), and `limit=1` keeps the read to one bar. */
const PROBE_WINDOW_MS = 10 * 86_400_000

/** Probe which of the stored ladder the store holds for the instrument around `at`. */
async function storedIntervalsFor(symbol: string, at: number): Promise<string[]> {
  // All at once, not one after another: they are independent one-bar reads, and the user is
  // waiting on the last of them (the start dialog, or the replay wall's mount).
  const held = await Promise.all(
    STORED_LADDER.map(async (code) => {
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
        return Array.isArray(body) && body.length > 0 && !isNoData(body)
      } catch (err) {
        if (!(err instanceof OhlcvApiError)) throw err
        return false
      }
    })
  )
  return STORED_LADDER.filter((_, i) => held[i])
}

/** Open the start dialog on a live wall and, on confirm, create the replay session and
 * rebuild the wall in replay mode. Resolves once the dialog is open (or refused); a refusal
 * comes back as the reason, for the caller to show. */
export async function startReplayFlow(chartPro: KLineChartPro, anchor: HTMLElement, rebuild: () => void): Promise<string | null> {
  const active = chartPro.getPane(chartPro.getActivePaneId()) ?? chartPro.getPanes()[0]
  const symbolInfo = active?.getSymbol() ?? chartPro.getSymbol()
  const symbol = symbolKey(symbolInfo)
  const intervalsInUse = sortByLength([...new Set(chartPro.getPanes().map((p) => periodToResolution(p.getPeriod())))])
  const latest = capabilities().serverTime || Date.now()
  const stored = await storedIntervalsFor(symbol, latest)
  if (stored.length === 0) {
    console.warn(`${REPLAY_LOG} no stored bars for ${symbol}`)
    return `No stored bars for ${symbolInfo.ticker}`
  }
  openStartDialog({
    anchor,
    symbol,
    intervalsInUse,
    stored,
    latest,
    pickOnChart: (done) => {
      pickBarOnChart(chartPro.getPanes(), (pick) => done(pick?.startAt ?? null))
    },
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
          barSource: new HttpBarSource(),
          dataEnd: () => latest,
          save: async () => {},
          onAdvanced: () => {}
          // No observer: this session exists only to write the opening blob, which starts
          // with no watches.
        }).toState()
        await simApi.putState(session.id, session.rev, state)
        writeIntent(safeStorage(), { sessionId: session.id, cursor })
        rebuild()
      })().catch((err) => console.error(`${REPLAY_LOG} could not start`, err))
    }
  })
  return null
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
  const storedIntervals = await storedIntervalsFor(stored.symbol, stored.cursor)
  const latest = capabilities().serverTime || Date.now()
  const hub = boot.hub
  hub.setBase(stored.base)
  hub.cursor = stored.cursor
  setReadClock(stored.cursor)

  const intervalsInUse = (): string[] => sortByLength([...new Set(chartPro.getPanes().map((p) => periodToResolution(p.getPeriod())))])

  // The replay's price watches. Built before the session because the session takes it as its
  // observer, and bound to the session (`attach`) straight after -- the two cannot both be
  // constructed first.
  const watches = new ReplayWatches({ symbol: stored.symbol, notify: ctx.notify })
  watches.restore(stored.watches)

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
    observer: watches,
    alerts: ctx.alerts ? new ReplayAlerts(stored.symbol, (symbol) => ctx.alerts?.enabledOn(symbol) ?? [], ctx.alerts.search, ctx.alerts.catalogue) : undefined,
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
      // under the OLD clock forgets the coverage that clock made incomplete. The old cursor
      // is what is handed over, not a margin off it: each source's answer was final only
      // through the bar IT had forming at that instant, which the host works out per source
      // from its own interval (plugins/horizon.ts).
      setReadClock(result.to)
      hub.cursor = result.to
      hub.setBase(session.base)
      const reports = await hub.push(chartPro.getPanes(), result.from)
      const problems = reports.filter((r) => r.problem)
      if (problems.length > 0) console.error(`${REPLAY_LOG} pane contiguity problems`, problems)
      ctx.pluginHost.invalidateFrom(result.from)
      // Levels are computed on 1W/1M, so one can only appear -- or be spent -- when a candle
      // of those intervals closes, and every such close is at 17:00 on a market day, i.e. a
      // DAILY boundary. Refetching on every step instead cost three slow reads per 15-minute
      // step, which saturated the browser's six-connection budget and starved the panes' own
      // history loads (measured: 31 `/levels` reads, the slowest 4.5s, during a short run).
      if (intervalStart('1D', result.from) !== intervalStart('1D', result.to)) ctx.levelsController.invalidate()
      dock.overlays.update(session.snapshot)
      // A pane that was reloaded at the new cursor (a long jump) has a new oldest bar, which
      // is what every watch line is anchored to; re-emitting redraws them against it.
      watches.refresh()
    }
  })
  session.setIntervalsInUse(intervalsInUse())
  watches.attach(session)
  await watches.load()

  const dock: TradingDock = mountTradingDock(session, {
    chartPro,
    container,
    title: 'Replay account',
    tag: 'replay',
    // Whatever opens or closes the dock -- the Account toggle, or the panel's own close
    // button -- redraws that toggle, so it never disagrees with what is on screen. Safe as a
    // forward reference: nothing calls setOpen before the controls exist.
    onOpenChange: () => controls.refresh(),
    onTicketOpenChange: () => controls.refresh()
  })
  // It starts CLOSED (mountTradingDock's default): the wall is what a replay is for, and the
  // Account toggle is what opens the account, ticket and tables. An advance that produced
  // events opens it by itself (below) -- a fill the user cannot see is worse than a panel
  // they did not ask for.
  //
  // The panes mounted while this function was awaiting the session (onPanesChange fired
  // before the controller existed), so the dock's overlays are synced here explicitly.
  dock.sync(chartPro.getPanes())

  const controls = createReplayControls({
    controller: session,
    intervalsInUse,
    bounds: container,
    onExit: () => {
      clearReplay()
      ctx.rebuild()
    },
    onStop: (result) => {
      if (result.reason === 'alert' && result.alert) {
        // Announced like a replay watch: dated when raised, the replay instant in the body,
        // tagged `replay` so it never reads as news about the live market.
        ctx.notify.notify({
          title: result.alert.name,
          body: [stored.symbol.split(':')[1] ?? stored.symbol, result.alert.readings, `replay ${formatInstant(result.alert.effective)}`].filter(Boolean).join(' · '),
          level: 'alert',
          source: 'replay',
          data: { alertId: result.alert.alertId, eventAt: result.alert.effective, replay: true }
        })
      }
      if (result.events.length === 0) return
      dock.setOpen(true)
      dock.panel.showTab(result.events.some((e) => e.kind === 'close') ? 'history' : 'positions')
    },
    // Play's backpressure: the next step waits until the panes' plugins have fetched what the
    // last one invalidated. Bounded, so a slow source slows the play rather than stalling it.
    settled: () => ctx.pluginHost.settled(PLAY_SETTLE_MS),
    account: { isOpen: () => dock.isOpen(), toggle: () => dock.toggle() },
    trade: { isOpen: () => dock.isTicketOpen(), toggle: () => dock.toggleTicket() },
    alerts: ctx.alerts?.manager
  })
  // An alert added, switched or removed changes what Next alert can stop at.
  const unsubscribeAlerts = ctx.alerts?.subscribe(() => controls.refresh()) ?? (() => {})
  await session.primeQuote()

  return {
    watches,
    sync(panes: ChartProPane[]): void {
      dock.sync(panes)
      const check = session.setIntervalsInUse(panes.map((p) => periodToResolution(p.getPeriod())))
      if (!check.ok) console.warn(`${REPLAY_LOG} base ${session.base} no longer fits the wall: ${check.reason}`)
      controls.refresh()
    },
    quote: async (key: string) => session.snapshot.quotes[key],
    teardown(): void {
      unsubscribeAlerts()
      controls.dispose()
      dock.teardown()
      session.dispose()
      hub.dumpAll()
    }
  }
}
