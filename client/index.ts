import { KLineChartPro, type ChartProPane } from '../src'
import { createArevController } from './arev/controller'
import { registerArevIndicators } from './arev/templates'
import { currentSession, logout } from './auth'
import { capabilities, hasFeature, loadCapabilities } from './capabilities'
import { attachToSlot, createLayerController } from './chartlayers/controller'
import { WdashboardDatafeed } from './datafeed'
import { loadDiscovery } from './indicators/api'
import { createKrevController } from './krev/controller'
import { registerKrevIndicators } from './krev/templates'
import { createIndicatorController } from './indicators/controller'
import { createMtfController } from './mtf/controller'
import { registerMtfIndicators } from './mtf/templates'
import { createParamsValidator, registerServerIndicators } from './indicators/templates'
import {
  defaultLayout,
  hydrateLayout,
  toPaneOptions,
  toPersistedLayout,
  type PersistedLayout
} from './layout'
import { levelsLayer } from './levels/layer'
import { renderLogin } from './login'
import { availablePeriods } from './periods'
import { loadStarredTimeframes, saveStarredTimeframes } from './preferences'
import { stream, type StreamStatus } from './stream'
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
            persist: !scratch
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
}

async function mountWall(container: HTMLElement, options: WallOptions): Promise<MountedWall> {
  const { store, switcher, persist: persistEnabled } = options

  // Svelte's mount() appends to its target rather than replacing its contents, so a prior
  // renderLogin() left in place would sit visually on top of (or behind) the chart forever
  // — the chart mounts and works underneath, but the page reads as permanently stuck on
  // "Signing in…" since nothing ever tears the login form down.
  container.innerHTML = ''

  // The wall's instruments, this account's starred timeframes and the server's indicator
  // catalogue all have to resolve before the chart mounts — price precision, the starred set
  // and the pane layout are all construction-time properties of the library component
  // (src/types.ts: ChartProOptions has no setSymbol-style setter for any of them).
  const [hydrated, starredTimeframes, discovery] = await Promise.all([
    hydrateLayout(options.layout),
    hasFeature('preferences') ? loadStarredTimeframes() : Promise.resolve(DEFAULT_STARRED_TIMEFRAMES),
    // Server-computed indicators: the whole library, registered as klinecharts templates
    // before any pane can create one (a restored layout may name them). A server without
    // the feature simply contributes no picker groups.
    hasFeature('indicators')
      ? loadDiscovery().catch((err) => {
          console.error('[indicators] discovery failed', err)
          return null
        })
      : Promise.resolve(null)
  ])

  const serverSpecs = discovery?.indicators ?? []
  const indicatorGroups = registerServerIndicators(serverSpecs)
  // Every controller below is built per MOUNT, not once per page: each holds per-pane state
  // keyed by pane id, and the indicator controller reads the active workspace's saved
  // indicator parameters at construction. A switch therefore rebuilds them against the
  // workspace being switched TO, and `teardown` below is what closes the outgoing set down.
  const indicatorController = createIndicatorController(serverSpecs)
  // AREV research predictions (client/arev/): two fixed sub-pane templates over
  // GET /arev/values, registered only when the server can actually serve them.
  const arevGroups = hasFeature('arev') ? registerArevIndicators() : []
  const arevController = createArevController()
  // krev01 reversal votes (client/krev/): one sub-pane template over GET /krev/values,
  // registered only when the server can serve it.
  const krevGroups = hasFeature('krev') ? registerKrevIndicators() : []
  const krevController = createKrevController()
  // AREV21 across timeframes (client/mtf/): one price-pane template per source timeframe
  // over the same GET /arev/values the AREV panes read, which is why it gates on 'arev'
  // and not on a capability of its own -- there is no new server surface behind it.
  const mtfGroups = hasFeature('arev') ? registerMtfIndicators() : []
  const mtfController = createMtfController()
  // The settings dialog asks this before it will commit params, so a combination the server
  // cannot serve is refused with its own explanation instead of being drawn and then
  // failing on the first fetch. Null against a server without `indicators.resolve`, which
  // leaves the dialog exactly as it behaved before.
  const indicatorParamsValidator = createParamsValidator(serverSpecs)

  // Every chart layer (today: just Levels) is built before the chart exists: its `sync`
  // becomes the wall's onPanesChange, which is a constructor argument.
  const levelsController = createLayerController(levelsLayer)

  const periods = availablePeriods()

  // Every one of these fires only after the chart exists (Svelte effects, never
  // synchronously during the constructor below), so `chartPro` is always assigned by the
  // time any of them runs.
  let chartPro: KLineChartPro | null = null
  const persist = (): void => {
    const cp = chartPro
    if (!cp || !persistEnabled) return
    const panes = cp.getPaneSnapshots()
    if (panes.length === 0) return
    const activeIndex = Math.max(0, panes.findIndex((pane) => pane.id === cp.getActivePaneId()))
    store.saveActiveLayout(toPersistedLayout(cp.getPaneLayout(), panes, activeIndex, latestSync))
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
    indicatorGroups: [...indicatorGroups, ...arevGroups, ...krevGroups, ...mtfGroups],
    indicatorParamsValidator,
    // The AREV21 multi-timeframe overlay owns its own settings: one indicator whose
    // settings are a colour and two sizes PER TIMEFRAME, which the built-in dialog (a flat
    // numeric calcParams array) cannot express. Every other indicator is untouched -- the
    // handler answers false and the numeric dialog opens as before.
    indicatorSettingsHandler: mtfController.handleSettings,
    // A factory: WdashboardDatafeed keys its `listeners`/`latest` watermark maps by
    // `vendor symbol interval`, so each pane needs its own instance -- two panes on the same
    // symbol+interval sharing one would clobber each other's stream subscription.
    datafeed: () => new WdashboardDatafeed(),
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
      // Debug hook, like window.__wdIndicators: the live wall panes, so a console (or a
      // headless test) can reach a pane's chart. Read-only by convention.
      window.__wdPanes = panes
      levelsController.sync(panes)
      indicatorController.sync(panes)
      arevController.sync(panes)
      krevController.sync(panes)
      mtfController.sync(panes)
    },
    onPaneLayoutChange: persist,
    onActivePaneChange: persist,
    onSymbolChange: persist,
    onPeriodChange: persist,
    onSyncChange: (options) => {
      latestSync = options
      persist()
    }
  })

  const detachExtras = mountChartExtras(chartPro, levelsController, switcher)

  return {
    teardown(): void {
      // Order matters: the controllers unsubscribe their indicator streams and clear their
      // overlays against charts that are still alive, and only then does removing the
      // component unmount each ChartPane (which unsubscribes its own bar stream).
      // ChartPro.svelte's onPanesChange effect is destroyed with the component, so it never
      // fires an empty list of its own -- this is the only teardown signal they get.
      levelsController.sync([])
      indicatorController.sync([])
      arevController.sync([])
      krevController.sync([])
      mtfController.sync([])
      levelsController.detach()
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
  levelsController: ReturnType<typeof createLayerController>,
  switcher: ReturnType<typeof createWorkspaceSwitcher>
): () => void {
  const footer = document.createElement('div')
  footer.className = 'wd-rail-footer-content'

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
  levelsController.attach(chartPro)

  return () => {
    switcher.close()
    unsubscribeStatus()
    detachSwitcher()
    detachFooter()
  }
}

void bootstrap()
