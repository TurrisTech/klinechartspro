import type { ChartProPane, Datafeed, KLineChartPro, SymbolInfo } from '../../src'
import { capabilities, hasFeature } from '../capabilities'
import { OhlcvApiError, setReadClock } from '../config'
import type { NotificationSink } from '../notifications'
import type { PluginHost } from '../plugins/host'
import { fetchSymbolInfo, symbolVendor } from '../symbols'
import { type SimQuote, simApi } from '../trading/api'
import { mountTradingDock, type TradingDock } from '../trading/dock'
import { milestoneNotice } from '../trading/exits'
import { instrumentInfo } from '../trading/instrument'
import { symbolKey } from '../trading/format'
import type { ServerCatalogue } from '../alerts/catalogue'
import type { AlertSearch } from '../alerts/search'
import type { Alert } from '../alerts/types'
import { ReplayAlerts } from './alerts'
import { passesDailyClose } from './clock'
import { createReplayControls } from './controls'
import type { ListedSession } from './sessionlist'
import { openStartDialog } from './startdialog'
import { ReplayQuiet } from './quiet'
import { pickBarOnChart } from './pickbar'
import { Engine } from '../sim/engine'
import { ReplayFeedHub } from './feed'
import { LandingWarmer } from './landing'
import { type FollowSources, followOnMount, followRequest, followTarget } from './follow'
import { type ReplayIntent, type ReplayState, readIntent, restore, stampSaved, writeIntent } from './persist'
import { type AdvanceResult, ReplayTradingSession } from './session'
import { type ReplaySessionSummary, summarizeSessions } from './sessions'
import { probeStoredIntervals } from '../bars/source'
import { TiledBarSource } from '../bars/tiled'
import { ReplayWatches } from './watches'
import { type CandleGrid, gridOf, scheduleOf } from '../time/timeframes'
import { sortByLength, periodToResolution } from '../time/intervals'
import { formatInstant } from '../time/format'

// GLUE. `mountBarReplay(chartPro, container, ...)` mirrors `mountPaperTrading`: the replay
// session bound to the shared trading dock, the floating control window over the chart, and
// the wiring that keeps the chart, the plugins and the levels layer on the replay's clock.
//
// Entering or leaving replay rebuilds the wall (the datafeed differs), so the minimal
// intent -- session id + cursor -- lives in page-level storage (persist.ts) and the app
// (client/index.ts) reads it before mounting: a replay wall gets the replay datafeed and an
// inert stream, and the read clock is set before the first history load.

const REPLAY_LOG = '[replay]'

/** On the wall's container while a replay is mounted: what draws the replay edge. */
export const REPLAY_WALL_CLASS = 'wd-replay-wall'

export interface BarReplayController {
  /** Resync the dock's overlays and the base check to the wall's panes. */
  sync(panes: ChartProPane[]): void
  /** The replay's own price watches, for `mountPriceWatches` to draw. A replay's market
   * exists only in this tab, so its watches are evaluated here, against the base bars the
   * walk consumes. */
  watches: ReplayWatches
  /** The instrument's bid/ask at the cursor -- the replay's own market, so no fetch. */
  quote(key: string): Promise<SimQuote | undefined>
  /** A pane's instrument changed (client/index.ts `onSymbolChange`). The active pane moved to
   * another instrument is followed -- the same session, account and cursor, the wall rebuilt on
   * it -- when nothing is left open on the instrument walked; otherwise the controls say why not
   * and what to do (follow.ts). */
  symbolChanged(paneId: string, symbol: SymbolInfo): void
  teardown(): void
}

/** The alert manager, as a replay uses it: the alerts Next alert stops at, the search that
 * finds them, and the window the controls' Alerts toggle opens. */
interface ReplayAlertsContext {
  /** The enabled alerts, on every instrument: Next alert stops at the next of any of them. */
  enabled(): Alert[]
  subscribe(listener: () => void): () => void
  search: AlertSearch
  catalogue: () => Promise<ServerCatalogue>
  manager: { isOpen: () => boolean; toggle: () => void }
}

interface ReplayWallContext {
  pluginHost: PluginHost
  /** Levels are computed on 1W/1M; a day boundary is when one can appear or be spent. */
  levelsController: { invalidate(): void }
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

/** Every bar a replay reads -- the walk, the skim, the quote, every pane's catch-up -- from tiles
 * held in memory a whole tile at a time (tiled.ts), one for the page: tiles never change, so what
 * one replay loaded serves the next. */
const replayBars = new TiledBarSource()

/** Prepare a replay wall: set the read clock to the cursor and build the feed hub the panes
 * will share. Called by the app before constructing the chart. */
export function bootReplay(intent: ReplayIntent, base: string): ReplayBoot {
  setReadClock(intent.cursor)
  const hub = new ReplayFeedHub(replayBars, base, intent.cursor, storedIntervalsFor)
  return { intent, hub, datafeed: () => hub.createFeed() }
}

/** Leave replay: clear the clock and the intent. The caller rebuilds the wall. */
export function clearReplay(): void {
  setReadClock(null)
  writeIntent(safeStorage(), null)
}

/** Why the replay the page last tried to open could not be, for the live wall it fell back to
 * to say (`takeReplayNotice`). A replay that will not open clears itself and rebuilds the wall,
 * which without this read as the replay closing itself. Page-lifetime, not stored like the
 * intent: it only has to outlive that one rebuild, and a reload must not say it again. */
let replayNotice: string | null = null

/** The reason the last replay could not open, once: the live wall shows it and it is gone. */
export function takeReplayNotice(): string | null {
  const notice = replayNotice
  replayNotice = null
  return notice
}

/** A replay that cannot be mounted: say why to the live wall the app rebuilds into. */
function abandonReplay(reason: string, ctx: ReplayWallContext): null {
  replayNotice = `Couldn't open the replay: ${reason}`
  clearReplay()
  ctx.rebuild()
  return null
}

// -- entering ------------------------------------------------------------------------------------

/** The longest Play waits for the wall to load between two steps. */
const PLAY_SETTLE_MS = 5_000

/** The longest a switch to another replay waits for this one's last save. */
const SWITCH_SAVE_WAIT_MS = 5_000

/** Which of the stored ladder the store holds for the instrument around `at` -- of the intervals
 * its vendor stores, never one the server would only fold (`probeStoredIntervals`). */
function storedIntervalsFor(symbol: string, at: number, grid: CandleGrid): Promise<string[]> {
  return probeStoredIntervals(symbol, at, grid)
}

/** What a follow found the store holds of the instrument it moved to, at the cursor: the mount it
 * rebuilds the wall into asks the same question at the same instant a moment later, and takes
 * this answer instead (once). Only a follow writes it, so a retry after a refusal probes afresh. */
let followProbe: { symbol: string; at: number; held: string[] } | null = null

/** Open the start dialog on a live wall and, on confirm, create the replay session and
 * rebuild the wall in replay mode. Resolves once the dialog is open. When the active pane's
 * instrument cannot start a replay, the dialog opens anyway, on Sessions, with the reason in its
 * New replay tab: every other replay stays reachable without moving the pane first. */
export async function startReplayFlow(chartPro: KLineChartPro, anchor: HTMLElement, rebuild: () => void): Promise<void> {
  // Asked for at once, beside the store probe below: the Sessions tab fills as soon as it lands.
  const sessions = listSessions()
  sessions.catch(() => {})
  const pastReplays = {
    load: () => sessions,
    resume: (session: ReplaySessionSummary) => {
      void resumeReplay(chartPro, session, rebuild).catch((err) => console.error(`${REPLAY_LOG} could not resume ${session.id}`, err))
    },
    remove: (id: string) => simApi.remove(id)
  }
  const active = chartPro.getPane(chartPro.getActivePaneId()) ?? chartPro.getPanes()[0]
  const symbolInfo = active?.getSymbol() ?? chartPro.getSymbol()
  const symbol = symbolKey(symbolInfo)
  const intervalsInUse = sortByLength([...new Set(chartPro.getPanes().map((p) => periodToResolution(p.getPeriod())))])
  const refuse = (refusal: string): void => {
    console.warn(`${REPLAY_LOG} ${refusal}`)
    openStartDialog({ anchor, symbol, intervalsInUse, refusal, sessions: pastReplays })
  }
  // The instrument's own candle schedule, from the market hours the server resolved for it.
  // Without one there is nowhere honest to put a candle boundary -- and a guess (the FX week)
  // would close a crypto day at 17:00 New York and skip its weekends -- so the replay says so.
  const schedule = scheduleOf(symbolInfo)
  if (!schedule) return refuse(`No market hours for ${symbolInfo.ticker}`)
  const grid = gridOf(schedule)
  const latest = capabilities().serverTime || Date.now()
  const stored = await storedIntervalsFor(symbol, latest, grid)
  if (stored.length === 0) return refuse(`No stored bars for ${symbolInfo.ticker}`)
  openStartDialog({
    anchor,
    symbol,
    intervalsInUse,
    stored,
    latest,
    grid,
    pickOnChart: (done) => {
      pickBarOnChart(chartPro.getPanes(), (pick) => done(pick?.startAt ?? null))
    },
    sessions: pastReplays,
    onStart: ({ startAt, balance, base }) => {
      void (async () => {
        const cursor = grid.start(base, startAt)
        const created = await simApi.create({ mode: 'replay', balance, symbol })
        const session = created.session
        const engine = new Engine(balance, session.account.currency)
        const state = new ReplayTradingSession({
          id: session.id,
          name: session.name,
          createdAt: session.createdAt,
          vendor: symbolVendor(symbolInfo),
          symbol,
          grid,
          cursor,
          startedAt: cursor,
          base,
          advance: { interval: intervalsInUse[0] ?? base, multiple: 1 },
          pauseOnFill: false,
          storedIntervals: stored,
          engine,
          barSource: replayBars,
          dataEnd: () => latest,
          save: async () => {},
          onAdvanced: () => {}
          // No observer: this session exists only to write the opening blob, which starts
          // with no watches.
        }).toState()
        await simApi.putState(session.id, session.rev, stampSaved(state, Date.now()))
        writeIntent(safeStorage(), { sessionId: session.id, cursor })
        rebuild()
      })().catch((err) => console.error(`${REPLAY_LOG} could not start`, err))
    }
  })
}

// -- past sessions -------------------------------------------------------------------------------

/** This owner's replays for the Sessions tab, each with the zone its dates read in: the
 * instrument's own clock, resolved once per instrument (`fetchSymbolInfo` is cached per page). */
async function listSessions(): Promise<ListedSession[]> {
  const summaries = summarizeSessions(await simApi.list())
  const zones = new Map<string, Promise<string>>()
  const zoneOf = (symbol: string): Promise<string> => {
    let zone = zones.get(symbol)
    if (!zone) {
      const [vendor, ticker] = symbol.includes(':') ? symbol.split(':', 2) : ['oanda', symbol]
      zone = fetchSymbolInfo(ticker, vendor)
        .then((info) => scheduleOf(info)?.timezone ?? 'UTC')
        .catch(() => 'UTC')
      zones.set(symbol, zone)
    }
    return zone
  }
  return Promise.all(summaries.map(async (summary) => ({ summary, zone: summary.symbol ? await zoneOf(summary.symbol) : 'UTC' })))
}

/** Reopen a past replay where it was left: the same intent a reload reads, then the wall rebuilt
 * into it -- the mount restores the clock, account, orders and watches from the session's blob.
 *
 * The wall is put on the replay's instrument first when no pane shows it. Left as it was, the
 * mount would take the wall for one that had moved off the instrument and follow its active pane
 * (follow.ts `followOnMount`): the past session would be rewritten to walk whatever the wall
 * happened to show. Changing the active pane is the same draft change a symbol pick makes. */
export async function resumeReplay(chartPro: KLineChartPro, session: ReplaySessionSummary, rebuild: () => void): Promise<void> {
  const state: ReplayState | null = session.state
  if (!state) return
  const shown = chartPro.getPaneSnapshots()
  if (!shown.some((p) => symbolKey(p.symbol) === state.symbol)) {
    const ticker = state.symbol.split(':').pop() ?? state.symbol
    const info = await fetchSymbolInfo(ticker, state.vendor)
    const active = chartPro.getPane(chartPro.getActivePaneId()) ?? chartPro.getPanes()[0]
    active?.setSymbol(info)
  }
  writeIntent(safeStorage(), { sessionId: session.id, cursor: state.cursor })
  rebuild()
}

// -- the replay wall -------------------------------------------------------------------------------

/** The market hours of the instrument a replay walks: off a pane showing it when there is one
 * (already resolved, no request), else asked of the server. */
async function replayScheduleFor(chartPro: KLineChartPro, symbol: string) {
  const onWall = chartPro
    .getPanes()
    .map((p) => p.getSymbol())
    .find((s) => `${symbolVendor(s)}:${s.ticker}` === symbol)
  if (onWall && scheduleOf(onWall)) return scheduleOf(onWall)
  const [vendor, ticker] = symbol.includes(':') ? symbol.split(':', 2) : ['oanda', symbol]
  try {
    return scheduleOf(await fetchSymbolInfo(ticker, vendor))
  } catch (err) {
    console.error(`${REPLAY_LOG} could not resolve ${symbol}`, err)
    return null
  }
}

/** Mount the replay on a wall built with `bootReplay`'s datafeed. Resolves null (and clears
 * the intent) when the session cannot be loaded, so the app falls back to a live wall, which
 * says why (`takeReplayNotice`). */
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
    return abandonReplay(err instanceof OhlcvApiError && err.status === 404 ? 'it no longer exists' : 'the server did not return it', ctx)
  }
  const stored = restore(answer.session.state)
  if (!stored) {
    console.error(`${REPLAY_LOG} session ${boot.intent.sessionId} has no readable state; leaving replay`)
    return abandonReplay('its saved state cannot be read', ctx)
  }
  let rev = answer.session.rev
  // The walked instrument's schedule, resolved again rather than stored in the blob: market
  // hours live in Postgres, and a copy carried in a session would go stale behind it.
  const schedule = await replayScheduleFor(chartPro, stored.symbol)
  if (!schedule) {
    console.error(`${REPLAY_LOG} no market hours for ${stored.symbol}; leaving replay`)
    return abandonReplay(`no market hours for ${stored.symbol.split(':').pop() ?? stored.symbol}`, ctx)
  }
  const grid = gridOf(schedule)
  const probed = followProbe?.symbol === stored.symbol && followProbe.at === stored.cursor ? followProbe.held : null
  followProbe = null
  const storedIntervals = probed ?? (await storedIntervalsFor(stored.symbol, stored.cursor, grid))
  const latest = capabilities().serverTime || Date.now()
  const hub = boot.hub
  hub.setBase(stored.base)
  hub.setStored(stored.symbol, storedIntervals)
  hub.cursor = stored.cursor
  setReadClock(stored.cursor)

  const intervalsInUse = (): string[] => sortByLength([...new Set(chartPro.getPanes().map((p) => periodToResolution(p.getPeriod())))])

  // The replay's price watches. Built before the session because the session takes it as its
  // observer, and bound to the session (`attach`) straight after -- the two cannot both be
  // constructed first.
  // The viewer's quiet hours (quiet.ts): on the replay's clock -- the walked instrument's zone,
  // the title bar's -- or the browser's. The watches, Next alert's search and the session (for a
  // trade's "Notify at") all ask it.
  const quiet = new ReplayQuiet(() => grid.schedule.timezone)
  const silenced = (at: number): boolean => quiet.isQuiet(at)
  const watches = new ReplayWatches({ symbol: stored.symbol, notify: ctx.notify, silenced })
  watches.restore(stored.watches)

  // A fresh look-ahead per replay: the search caches what it read, and near the end of the data
  // a server value written since an earlier replay on this page would otherwise read as missing.
  ctx.alerts?.search.reset()
  // Where the next press will land, warmed on the server before it (landing.ts): every pane's
  // overlay reads there, over the bars the push will leave it holding, once the wall is quiet.
  const landings = new LandingWarmer({
    settled: (timeoutMs) => ctx.pluginHost.settled(timeoutMs),
    loadsInFlight: () => hub.loadsInFlight,
    busy: () => session.busy,
    cursor: () => session.cursor,
    warm: (at) => ctx.pluginHost.warmAhead(at, (pane) => hub.landingRange(pane, at))
  })
  const session = new ReplayTradingSession({
    id: answer.session.id,
    name: answer.session.name,
    createdAt: answer.session.createdAt,
    vendor: stored.vendor,
    symbol: stored.symbol,
    grid,
    cursor: stored.cursor,
    startedAt: stored.startedAt,
    base: stored.base,
    advance: stored.advance,
    pauseOnFill: stored.pauseOnFill,
    storedIntervals: storedIntervals.length > 0 ? storedIntervals : [stored.base],
    engine: Engine.fromState(stored.engine),
    observer: watches,
    alerts: ctx.alerts ? new ReplayAlerts(() => ctx.alerts?.enabled() ?? [], ctx.alerts.search, ctx.alerts.catalogue, silenced) : undefined,
    silenced,
    warmLanding: (at) => void landings.warm(at),
    barSource: replayBars,
    dataEnd: () => latest,
    save: async (unstamped) => {
      const state = stampSaved(unstamped, Date.now())
      try {
        const saved = await simApi.putState(answer.session.id, rev, state)
        rev = saved.session.rev
      } catch (err) {
        if (!(err instanceof OhlcvApiError && err.status === 409)) throw err
        // Another tab saved: take its rev and write this state over it. Until a replay could
        // follow the chart this waited for the next change instead, which dropped THIS state --
        // harmless for a cursor the next step rewrites, not for the blob a follow rebuilds the
        // wall from, which has no next change.
        const fresh = await simApi.get(answer.session.id)
        rev = fresh.session.rev
        console.warn(`${REPLAY_LOG} stale rev; resynced to ${rev}`)
        rev = (await simApi.putState(answer.session.id, rev, state)).session.rev
      }
      // Only while the page is still in THIS replay: a save that lands after Exit -- a follow's,
      // or one queued by the last step -- must not write back the intent Exit cleared, which would
      // put the next rebuild or reload back into a replay the user left.
      if (readIntent(safeStorage())?.sessionId === answer.session.id) writeIntent(safeStorage(), { sessionId: answer.session.id, cursor: state.cursor })
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
      if (passesDailyClose(result.from, result.to, grid)) ctx.levelsController.invalidate()
      dock.overlays.update(session.snapshot)
      // A pane that was reloaded at the new cursor (a long jump) has a new oldest bar, which
      // is what every watch line is anchored to; re-emitting redraws them against it.
      watches.refresh()
    },
    // The blob now walks the instrument followed, at the same cursor (the save wrote the intent):
    // the wall is rebuilt from it exactly as a reload builds it, which is what resolves that
    // instrument's market hours and stored intervals, its base cache and its watches.
    onFollowed: () => ctx.rebuild()
  })
  session.setIntervalsInUse(intervalsInUse())
  watches.attach(session)
  await watches.load()

  // SWITCHING TO ANOTHER REPLAY (the controls' Sessions panel). Leaving is Exit's: nothing of this
  // replay is undone, its last save is let land, and the wall is rebuilt -- into the other one, the
  // way the start dialog's Resume rebuilds a live wall into it. While it runs this replay no longer
  // follows the chart: `resumeReplay` moves the active pane onto the other replay's instrument, and
  // a follow would rewrite THIS session to walk it.
  let leaving = false
  const switchTo = async (target: ReplaySessionSummary): Promise<void> => {
    // Unreadable: `resumeReplay` would do nothing, and this replay would stop following for good.
    if (leaving || !target.state) return
    leaving = true
    try {
      await Promise.race([session.flushSaves(), new Promise((resolve) => setTimeout(resolve, SWITCH_SAVE_WAIT_MS))])
      await resumeReplay(chartPro, target, ctx.rebuild)
    } catch (err) {
      leaving = false
      throw err
    }
  }

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

  // A milestone a replay trade reaches is told the way the server tells a paper one -- but here, in
  // the bell, tagged `replay` and dated when raised with the replay instant in the body: the engine
  // that reached it is this page's (trading/exits.ts `milestoneNotice`). One reached in quiet hours
  // never arrives here: the session does not hear it (session.ts `heard`).
  const unsubscribeMilestones = session.subscribe((snapshot, events) => {
    for (const event of events) {
      if (event.kind !== 'milestone' || event.tradeId === null) continue
      const trade = snapshot.trades.find((t) => t.id === event.tradeId)
      if (!trade) continue
      const info = instrumentInfo(trade.symbol)
      const { title, body } = milestoneNotice(trade, event, info)
      ctx.notify.notify({
        title,
        body: `${body} · replay ${formatInstant(event.time, info.timezone)}`,
        level: 'info',
        source: 'replay',
        data: { tradeId: trade.id, symbol: trade.symbol, label: event.reason, eventAt: event.time, replay: true }
      })
    }
  })

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
          // The alert's own instrument: any on the Alerts list, not only the one replayed.
          body: [result.alert.symbol.split(':')[1] ?? result.alert.symbol, result.alert.readings, `replay ${formatInstant(result.alert.effective, instrumentInfo(result.alert.symbol).timezone)}`].filter(Boolean).join(' · '),
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
    alerts: ctx.alerts?.manager,
    sessions: {
      load: async () => (await listSessions()).filter((listed) => listed.summary.id !== answer.session.id),
      resume: (target) => switchTo(target),
      remove: (id) => simApi.remove(id)
    },
    priceStop: {
      get: () => watches.stopPrice(),
      set: (price) => watches.setStopPrice(price),
      clear: () => watches.clearStopPrice()
    },
    quiet
  })
  // New quiet hours change where Next alert lands: the warmed landing is read again.
  const unsubscribeQuiet = quiet.subscribe(() => {
    controls.refresh()
    session.warmAlerts()
  })
  // An alert added, switched or removed changes what Next alert can stop at.
  const unsubscribeAlerts =
    ctx.alerts?.subscribe(() => {
      controls.refresh()
      session.warmAlerts()
    }) ?? (() => {})
  session.warmAlerts()
  await session.primeQuote()
  // The wall reads as history at a glance: a thin edge in the replay's orange round the chart,
  // however far away or rolled up the controls are (client/styles/replay.css `.wd-replay-wall`).
  container.classList.add(REPLAY_WALL_CLASS)

  // FOLLOWING THE CHART (follow.ts). What a follow reads to know it can walk the instrument the
  // active pane moved to: the two reads this mount made for the one it walks.
  const followSources: FollowSources = {
    schedule: (symbol) => replayScheduleFor(chartPro, symbol),
    stored: async (symbol, at, onGrid) => {
      const held = await storedIntervalsFor(symbol, at, onGrid)
      followProbe = { symbol, at, held }
      return held
    },
    intervalsInUse
  }
  const followPane = (info: SymbolInfo): void => {
    void session.follow(followTarget({ symbol: symbolKey(info), vendor: symbolVendor(info), ticker: info.ticker }, followSources))
  }
  // A wall that came back with no pane on the instrument walked (Revert, a reload, a workspace
  // switch) has moved off it: the replay follows its active pane, or says why it cannot. Read from
  // the snapshots, which list every visible pane whether or not its chart has mounted yet.
  const shown = chartPro.getPaneSnapshots()
  const activeInfo = (shown.find((p) => p.id === chartPro.getActivePaneId()) ?? shown[0])?.symbol
  if (activeInfo && followOnMount(shown.map((p) => symbolKey(p.symbol)), symbolKey(activeInfo), session.symbol)) followPane(activeInfo)

  return {
    watches,
    sync(panes: ChartProPane[]): void {
      dock.sync(panes)
      const check = session.setIntervalsInUse(panes.map((p) => periodToResolution(p.getPeriod())))
      if (!check.ok) console.warn(`${REPLAY_LOG} base ${session.base} no longer fits the wall: ${check.reason}`)
      controls.refresh()
      // A pane mounted since the last advance reads at the next landing too: warm it (what is
      // warmed already is not sent again).
      session.warmAlerts()
    },
    quote: async (key: string) => session.snapshot.quotes[key],
    symbolChanged(paneId: string, info: SymbolInfo): void {
      // Moved there by a switch to another replay (`switchTo`), not by the user: not followed.
      if (leaving) return
      const request = followRequest(paneId, chartPro.getActivePaneId(), symbolKey(info), session.symbol)
      if (request === 'back') session.dismissFollow()
      else if (request === 'follow') followPane(info)
    },
    teardown(): void {
      unsubscribeAlerts()
      unsubscribeQuiet()
      unsubscribeMilestones()
      landings.dispose()
      container.classList.remove(REPLAY_WALL_CLASS)
      controls.dispose()
      dock.teardown()
      session.dispose()
      hub.dumpAll()
    }
  }
}
