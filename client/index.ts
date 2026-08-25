import { KLineChartPro, type ChartProPane } from '../src'
import { currentSession, logout } from './auth'
import { capabilities, hasFeature, loadCapabilities } from './capabilities'
import { attachToSlot, createLayerController } from './chartlayers/controller'
import { WdashboardDatafeed } from './datafeed'
import {
  defaultLayout,
  hydrateLayout,
  toPaneOptions,
  toPersistedLayout,
  type PersistedLayout
} from './layout'
import { levelsLayer } from './levels/layer'
import { levels2Layer } from './levels2/layer'
import type { MtfConfig } from './mtf/config'
import { builtinPlugins, createFacilities, createPluginHost } from './plugins'
import { renderLogin } from './login'
import { availablePeriods } from './periods'
import { loadStarredTimeframes, saveStarredTimeframes } from './preferences'
import { stream, type StreamStatus } from './stream'
import {
  type BarReplayController,
  bootReplay,
  clearReplay,
  currentIntent,
  mountBarReplay,
  type ReplayBoot,
  replayAvailable,
  startReplayFlow
} from './replay'
import { inertStream } from './replay/feed'
import { mountPaperTrading, type PaperTradingController } from './trading'
import { createWorkspaceSwitcher } from './workspaces/menu'
import { loadWorkspaces, type WorkspaceStore } from './workspaces/store'

import './style.css'

// Used only when the server doesn't advertise 'preferences' (prod, today) or a fetch of the
// user's own set fails — the account's real starred set otherwise comes from
// loadStarredTimeframes(), seeded server-side by wdashboard-server's appstate migration.
const DEFAULT_STARRED_TIMEFRAMES = ['1m', '1h', '1D', '1W', '1M']

// Ceiling on the one-frame settle between tearing a wall down and building the next -- see
// remount(). Long enough that a live tab always resolves on the frame, short enough that a
// tab which never paints one is not perceptibly slower.
const SETTLE_TIMEOUT_MS = 50

declare global {
  interface Window {
    __wdPanes?: ChartProPane[]
  }
}

const params = new URLSearchParams(window.location.search)

async function bootstrap(): Promise<void> {
  await loadCapabilities()

  const appContainer = document.getElementById('app')
  if (!appContainer) throw new Error('#app not found')

  // The login gate is dev-only, and the client is one bundle deployed to both dev and
  // prod: gating unconditionally would leave prod (which has no appstate database, so
  // 'auth' is never advertised) stuck at a login form nothing could ever satisfy. See
  // capabilities.ts's Feature union and appstate.py's module docstring.
  if (hasFeature('auth')) {
    const session = await currentSession()
    if (!session) {
      renderLogin(appContainer, () => {
        void bootstrap()
      })
      return
    }
  }

  await runWall(appContainer)
}

/** A mounted wall's one obligation: give back everything it took when the next one replaces
 * it. Held by runWall so a switch can close the outgoing wall down before opening the next. */
interface MountedWall {
  teardown(): void
}

// A `?symbol=` link is a deliberate deep link to one instrument -- it wins outright over any
// saved workspace, rather than silently landing on some other pane's saved symbol. What it
// mounts is a SCRATCH wall: it belongs to no workspace, so panning around it can't quietly
// overwrite whichever workspace happened to be active when the link was opened. Picking a
// workspace from the switcher leaves the mode.
function deepLinkedSymbol(): string | null {
  return params.get('symbol')
}

async function runWall(container: HTMLElement): Promise<void> {
  const store = await loadWorkspaces()
  const linked = deepLinkedSymbol()
  // ?workspace= names one by id or (case-insensitively) by name: the other half of the
  // "same account, another machine" story -- a link that opens the desk you mean rather than
  // whichever one that machine last looked at.
  const requestedWorkspace = params.get('workspace')
  if (requestedWorkspace) {
    const match = store
      .list()
      .find(
        (workspace) =>
          workspace.id === requestedWorkspace ||
          workspace.name.toLowerCase() === requestedWorkspace.toLowerCase()
      )
    if (match) store.setActive(match.id)
    else console.warn(`[workspaces] no workspace named ${requestedWorkspace}`)
  }

  let scratch = linked !== null
  const switcher = createWorkspaceSwitcher({
    store,
    transientLabel: () => (scratch ? `${linked} (link)` : null),
    onSwitch: (id) => {
      store.setActive(id)
      // A workspace switch that stayed on the deep link would show the linked symbol under
      // another workspace's name, so leaving scratch mode is part of switching.
      scratch = false
      void remount()
    }
  })

  let mounted: MountedWall | null = null
  let remounting = false
  let queued = false

  // Building a wall is asynchronous (instrument config, the starred set, the indicator
  // catalogue), so two switches CAN overlap -- and un-serialized they corrupt each other:
  // the second reads a null `mounted`, skips the teardown the first is midway through, and
  // both mount into the same container, leaving one orphaned chart and, once the first
  // resolves last, a `mounted` handle pointing at DOM that has already been replaced. The
  // next teardown then removes nothing and the wall goes blank.
  //
  // Coalesced rather than merely queued: clicking through three workspaces while the first
  // is still loading should end on the third, not build all three in turn. Whatever is in
  // flight finishes, then ONE more pass runs against whatever the store now says is active.
  async function remount(): Promise<void> {
    if (remounting) {
      queued = true
      return
    }
    remounting = true
    try {
      do {
        queued = false
        const previous = mounted
        mounted = null
        // Torn down BEFORE the new wall is built, not after: the old panes' stream
        // subscriptions and the new ones' overlap otherwise, and two charts briefly share
        // one container.
        if (previous) {
          previous.teardown()
          await settle()
        }
        const name = scratch ? (linked as string) : store.active().name
        // The container is empty for as long as the mount takes, which on a cold cache is
        // a second or more -- long enough that saying nothing reads as a broken page.
        showPlaceholder(container, `Loading ${name}…`)
        try {
          mounted = await mountWall(container, {
            store,
            switcher,
            layout: scratch ? defaultLayout(linked as string) : store.active().layout,
            persist: !scratch,
            rebuild: () => void remount()
          })
        } catch (err) {
          // The switcher is detached with the wall it was attached to, so a failed mount
          // would otherwise leave no way to pick a different workspace -- hence a control
          // in the placeholder rather than a console message and a blank page.
          console.error(`[workspaces] could not open ${name}`, err)
          showFailure(container, name, () => {
            void remount()
          })
        }
        switcher.refresh()
      } while (queued)
    } finally {
      remounting = false
    }
  }

  await remount()
}

/** One frame, so the disposed charts' own ResizeObservers deliver and settle before a new
 * grid starts resizing in front of them. Without it, tearing down an N-pane wall and building
 * an M-pane one raises "ResizeObserver loop completed with undelivered notifications" --
 * harmless in itself, but it surfaces as a full-screen Runtime Error overlay under
 * `bun run dev:client`, where it would sit on top of real ones.
 *
 * Raced against a timer because requestAnimationFrame does not fire at all in a hidden or
 * throttled tab: on its own it would park a switch made just before the tab was backgrounded
 * forever on an empty container, with the old wall already gone. */
function settle(): Promise<void> {
  return new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve())
    setTimeout(resolve, SETTLE_TIMEOUT_MS)
  })
}

function showPlaceholder(container: HTMLElement, text: string): HTMLElement {
  container.innerHTML = ''
  const placeholder = document.createElement('div')
  placeholder.className = 'wd-wall-placeholder'
  const message = document.createElement('p')
  message.textContent = text
  placeholder.appendChild(message)
  container.appendChild(placeholder)
  return placeholder
}

function showFailure(container: HTMLElement, name: string, retry: () => void): void {
  const placeholder = showPlaceholder(container, `Could not open “${name}”.`)
  const button = document.createElement('button')
  button.type = 'button'
  button.className = 'wd-wall-retry'
  button.textContent = 'Try again'
  button.addEventListener('click', retry)
  placeholder.appendChild(button)
}

interface WallOptions {
  store: WorkspaceStore
  switcher: ReturnType<typeof createWorkspaceSwitcher>
  layout: PersistedLayout
  /** False for the `?symbol=` scratch wall, which deliberately saves nothing. */
  persist: boolean
  /** Tear this wall down and build the next (entering or leaving replay). */
  rebuild: () => void
}

async function mountWall(container: HTMLElement, options: WallOptions): Promise<MountedWall> {
  const { store, switcher, persist: persistEnabled } = options

  // A wall is EITHER live or a replay. The replay intent (session + cursor) is page-level
  // state (client/replay/persist.ts) read before anything is built, because the datafeed,
  // the read clock and the plugins' stream are all construction-time: a replay wall loads
  // its history clamped to the cursor and its plugins never hear a live point.
  const intent = replayAvailable() ? currentIntent() : null
  if (!replayAvailable()) clearReplay()
  const replayBoot: ReplayBoot | null = intent ? bootReplay(intent, '1m') : null

  // Svelte's mount() appends to its target rather than replacing its contents, so a prior
  // renderLogin() left in place would sit visually on top of (or behind) the chart forever
  // — the chart mounts and works underneath, but the page reads as permanently stuck on
  // "Signing in…" since nothing ever tears the login form down.
  container.innerHTML = ''

  // The wall's instruments and this account's starred timeframes have to resolve before
  // the chart mounts -- price precision, the starred set and the pane layout are all
  // construction-time properties of the library component (src/types.ts: ChartProOptions
  // has no setSymbol-style setter for any of them). So does the plugin host: it registers
  // every plugin's klinecharts templates (a restored layout may name them) and collects
  // their picker groups, which are construction-time too.
  //
  // Every plugin, and the host, is built per MOUNT, not once per page: each holds per-pane
  // state keyed by pane id, and the host seeds the plugins' per-pane document state from
  // the workspace being switched TO. `teardown` below is what closes the outgoing set down.
  // `persist` is declared below; the thunk is not called until a user edits something,
  // long after it is initialised.
  const [hydrated, starredTimeframes] = await Promise.all([
    hydrateLayout(options.layout),
    hasFeature('preferences') ? loadStarredTimeframes() : Promise.resolve(DEFAULT_STARRED_TIMEFRAMES)
  ])
  const pluginHost = await createPluginHost({
    plugins: builtinPlugins(),
    facilities: createFacilities({ requestPersist: () => persist(), stream: replayBoot ? inertStream : undefined }),
    paneState: {
      // The AREV21 overlay's per-pane settings: app state the library's PaneSnapshot has
      // never heard of, carried in the pane's own document entry (layout.ts).
      mtf: Object.fromEntries(
        hydrated.panes.flatMap((pane, index) => (pane.mtfConfig ? [[index, pane.mtfConfig]] : []))
      )
    }
  })

  // Every chart layer (Levels, and the levels2 Zones beside it) is built before the chart
  // exists: its `sync` becomes the wall's onPanesChange, which is a constructor argument.
  const levelsController = createLayerController(levelsLayer)
  const levels2Controller = createLayerController(levels2Layer)

  const periods = availablePeriods()

  // Every one of these fires only after the chart exists (Svelte effects, never
  // synchronously during the constructor below), so `chartPro` is always assigned by the
  // time any of them runs.
  let chartPro: KLineChartPro | null = null
  // Assigned after the chart exists (mountPaperTrading needs it), and referenced by
  // onPanesChange, which never fires before the constructor returns.
  let paper: PaperTradingController | null = null
  let replay: BarReplayController | null = null
  const persist = (): void => {
    const cp = chartPro
    if (!cp || !persistEnabled) return
    const panes = cp.getPaneSnapshots()
    if (panes.length === 0) return
    const activeIndex = Math.max(0, panes.findIndex((pane) => pane.id === cp.getActivePaneId()))
    store.saveActiveLayout(
      toPersistedLayout(
        cp.getPaneLayout(),
        panes,
        activeIndex,
        latestSync,
        // The plugins' per-pane document state (today: the AREV21 overlay's settings),
        // supplied here rather than read off the snapshots.
        (pluginHost.paneState().mtf ?? {}) as Record<number, MtfConfig>
      )
    )
    // The switcher's row for the active workspace shows its pane count and instrument, so it
    // has to follow the wall it is describing.
    switcher.refresh()
  }
  let latestSync = { ...hydrated.sync }

  chartPro = new KLineChartPro({
    container,
    locale: 'en-US',
    theme: params.get('theme') ?? 'dark',
    // wdashboard-server states every bar timestamp on the market's clock: intraday bars
    // open on the America/New_York session grid, and daily-and-coarser ones are dated by
    // their canonical date, 00:00 New York of the session. Any other display timezone
    // splits those days mid-bar and shifts the date a daily candle reads as.
    timezone: 'America/New_York',
    symbol: hydrated.panes[0].symbol,
    period: hydrated.panes[0].period,
    periods,
    starredPeriods: starredTimeframes,
    onStarredPeriodsChange: hasFeature('preferences') ? saveStarredTimeframes : () => {},
    mainIndicators: ['MA'],
    subIndicators: ['VOL'],
    // Every plugin's picker groups, params validation and settings entry point, through
    // the one host (client/plugins). A plugin that owns its own settings UI (the AREV21
    // overlay: a colour and two sizes PER TIMEFRAME, which the built-in numeric dialog
    // cannot express) claims the gear; every other indicator gets the dialog as before.
    indicatorGroups: pluginHost.groups,
    indicatorParamsValidator: pluginHost.validateParams,
    indicatorSettingsHandler: pluginHost.handleSettings,
    // A factory: WdashboardDatafeed keys its `listeners`/`latest` watermark maps by
    // `vendor symbol interval`, so each pane needs its own instance -- two panes on the same
    // symbol+interval sharing one would clobber each other's stream subscription.
    datafeed: replayBoot ? replayBoot.datafeed : () => new WdashboardDatafeed(),
    paneLayout: hydrated.preset,
    panes: hydrated.panes.map(toPaneOptions),
    activePane: `p${hydrated.active + 1}`,
    syncCrosshair: latestSync.crosshair,
    syncTime: latestSync.time,
    syncAuto: latestSync.auto,
    // The definitive "which panes are actually live" signal -- fires once per pane mount and
    // once per pane teardown (including every layout grow/shrink), never before a pane's
    // chart exists. Every mounted chart layer resyncs from this directly; nothing here polls
    // getChart().
    onPanesChange: (panes) => {
      // Debug hook, like window.__wdPlugins: the live wall panes, so a console (or a
      // headless test) can reach a pane's chart. Read-only by convention.
      window.__wdPanes = panes
      levelsController.sync(panes)
      levels2Controller.sync(panes)
      pluginHost.sync(panes)
      paper?.sync(panes)
      replay?.sync(panes)
    },
    onPaneLayoutChange: persist,
    onActivePaneChange: persist,
    // Everything else a pane can change on its own: an indicator added, removed or
    // re-parameterised, and -- debounced to the end of the gesture -- a pan, a zoom or a
    // hand-scaled price axis. Before this, those survived only until some OTHER change
    // (a symbol, a timeframe, a layout) happened to persist the wall on their behalf.
    onPaneStateChange: persist,
    onSymbolChange: persist,
    onPeriodChange: persist,
    onSyncChange: (options) => {
      latestSync = options
      persist()
    }
  })

  // The paper-trading account: the panel dock below the chart and the per-pane overlays.
  // Gated on the server's `sim` capability (returns null otherwise); its rail button is added
  // in mountChartExtras beside the stream status.
  // A replay wall mounts the replay dock instead (client/replay/index.ts); a live wall the
  // paper account. The "Replay" rail button starts one here, or exits it there.
  if (replayBoot) {
    replay = await mountBarReplay(chartPro, container, replayBoot, {
      pluginHost,
      levelsController,
      rebuild: options.rebuild
    })
  } else {
    paper = mountPaperTrading(chartPro, container)
  }

  const detachExtras = mountChartExtras(
    chartPro,
    [levelsController, levels2Controller],
    switcher,
    paper,
    {
      inReplay: replayBoot !== null,
      controller: replay,
      rebuild: options.rebuild
    }
  )

  return {
    teardown(): void {
      // Order matters: the controllers unsubscribe their indicator streams and clear their
      // overlays against charts that are still alive, and only then does removing the
      // component unmount each ChartPane (which unsubscribes its own bar stream).
      // ChartPro.svelte's onPanesChange effect is destroyed with the component, so it never
      // fires an empty list of its own -- this is the only teardown signal they get.
      levelsController.sync([])
      levels2Controller.sync([])
      pluginHost.teardown()
      // Clears its overlays against the still-alive charts and removes the dock, before the
      // component (and its panes) is unmounted below.
      paper?.teardown()
      replay?.teardown()
      levelsController.detach()
      levels2Controller.detach()
      detachExtras()
      chartPro?.remove()
      chartPro = null
      window.__wdPanes = []
    }
  }
}

// Populates the two slots the library exposes (src/types.ts ChartPro.getSlot): the top-rail
// toolbar gets the workspace switcher and each mounted chart layer's toggle (today just
// Levels), the bottom of the left drawing rail gets the stream-liveness dot, server version,
// and (when logged in) a sign-out control. The rail-footer trio lives in the chrome because
// it answers questions the chart itself cannot — a chart with a dead socket looks exactly
// like a quiet market.
//
// Returns a disposer, because a workspace switch replaces the chart these are attached to.
function mountChartExtras(
  chartPro: KLineChartPro,
  layerControllers: ReturnType<typeof createLayerController>[],
  switcher: ReturnType<typeof createWorkspaceSwitcher>,
  paper: PaperTradingController | null,
  replay: { inReplay: boolean; controller: BarReplayController | null; rebuild: () => void }
): () => void {
  const footer = document.createElement('div')
  footer.className = 'wd-rail-footer-content'

  // Paper-trading toggle: no top-toolbar button by design -- it lives in the rail footer's
  // lower-left corner, beside the stream status and version. Prompt 2's "Bar replay" button
  // goes right next to it. Only present when the server advertises the `sim` capability
  // (mountPaperTrading returns null otherwise).
  if (paper) {
    const paperButton = document.createElement('button')
    paperButton.type = 'button'
    paperButton.className = 'wd-rail-button'
    paperButton.textContent = 'Paper'
    paperButton.title = 'Paper trading'
    paperButton.addEventListener('click', () => {
      paperButton.classList.toggle('is-on', paper.toggle())
    })
    footer.appendChild(paperButton)
  }

  // Bar replay toggle, right next to Paper. On a live wall it opens the start dialog (and
  // rebuilds the wall in replay mode); on a replay wall it exits replay. Only present when
  // the server advertises both `sim` and `asof`.
  if (replayAvailable()) {
    const replayButton = document.createElement('button')
    replayButton.type = 'button'
    replayButton.className = `wd-rail-button${replay.inReplay ? ' is-on' : ''}`
    replayButton.textContent = 'Replay'
    replayButton.title = replay.inReplay ? 'Exit bar replay' : 'Bar replay'
    replayButton.addEventListener('click', () => {
      if (replay.inReplay) {
        clearReplay()
        replay.rebuild()
        return
      }
      void startReplayFlow(chartPro, replayButton, replay.rebuild)
    })
    footer.appendChild(replayButton)
  }

  const status = document.createElement('span')
  status.className = 'wd-status'
  const dot = document.createElement('span')
  dot.className = 'wd-status-dot'
  const statusText = document.createElement('span')
  status.append(dot, statusText)

  const version = document.createElement('span')
  version.className = 'wd-version'
  version.textContent = capabilities().version
  version.title = `server ${capabilities().version}`

  footer.append(status, version)

  if (hasFeature('auth')) {
    const logoutButton = document.createElement('button')
    logoutButton.type = 'button'
    logoutButton.className = 'wd-logout'
    logoutButton.textContent = 'Sign out'
    logoutButton.addEventListener('click', () => {
      void logout().then(() => window.location.reload())
    })
    footer.append(logoutButton)
  }

  // The rail is 3rem (48px) wide, so the visible label has to be short — the full word
  // ('connecting', 'offline') lives in `title` for anyone who hovers.
  const STATUS_LABELS: Record<StreamStatus, string> = {
    connected: 'live',
    connecting: 'conn',
    offline: 'off'
  }
  // Disposed on teardown: `stream` is a page-lifetime singleton, so a listener left behind by
  // each workspace switch would accumulate, each writing into a detached footer.
  const unsubscribeStatus = stream.onStatus((value: StreamStatus) => {
    status.dataset.stream = value
    statusText.textContent = STATUS_LABELS[value]
    statusText.title = value
  })

  // First in the toolbar slot: which wall you are on is the outermost thing about it, and it
  // reads left-to-right with the symbol and timeframe controls the library owns.
  const detachSwitcher = attachToSlot(chartPro, 'toolbar', switcher.element)
  const detachFooter = attachToSlot(chartPro, 'rail-footer', footer)
  for (const controller of layerControllers) controller.attach(chartPro)

  return () => {
    switcher.close()
    unsubscribeStatus()
    detachSwitcher()
    detachFooter()
  }
}

void bootstrap()
