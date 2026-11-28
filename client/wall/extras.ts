import type { KLineChartPro } from '../../src'
import { logout } from '../auth'
import { capabilities, hasFeature } from '../capabilities'
import { attachToSlot } from '../chrome/slot'
import { clearReplay, replayAvailable, startReplayFlow, takeReplayNotice } from '../replay'
import { stream, type StreamRefusal, type StreamStatus } from '../stream'
import type { PaperTradingController } from '../trading'
import type { createWorkspaceSwitcher } from '../workspaces/menu'
import type { WorkspaceSaveControls } from '../workspaces/save'

// A WALL'S OWN CHROME, beside the chart the library draws: what client/index.ts mounts into the
// library's slots once a wall is built, and takes down with it. Until 2026-11-28 it was in
// client/index.ts, which now keeps only the boot, the routing and the mounting of a wall.

/** A few words beside a rail button for a few seconds: the rail is 3rem wide, too narrow to
 * say why a press did nothing, and a press that silently does nothing reads as a broken one. */
function railNote(anchor: HTMLElement, text: string, ms = 4000): void {
  const note = document.createElement('div')
  note.className = 'wd-rail-note'
  note.setAttribute('role', 'status')
  note.textContent = text
  const box = anchor.getBoundingClientRect()
  note.style.left = `${box.right + 8}px`
  note.style.top = `${box.top + box.height / 2}px`
  document.body.appendChild(note)
  setTimeout(() => note.remove(), ms)
}

/** Where the Strategy Lab is from the dashboard: `lab` beside the page, under any base path. */
function labHref(): string {
  const base = window.location.pathname.endsWith('/') ? window.location.pathname : window.location.pathname.replace(/[^/]*$/, '')
  return `${base}lab`
}

// Populates the two slots the library exposes (src/types.ts ChartPro.getSlot): the top-rail
// toolbar gets the workspace switcher and its Save and Revert, the bottom of the left drawing rail gets the stream-liveness dot, server version,
// and (when logged in) a sign-out control. The rail-footer trio lives in the chrome because
// it answers questions the chart itself cannot — a chart with a dead socket looks exactly
// like a quiet market.
//
// Returns a disposer, because a workspace switch replaces the chart these are attached to.
export function mountChartExtras(
  chartPro: KLineChartPro,
  switcher: ReturnType<typeof createWorkspaceSwitcher>,
  saveControls: WorkspaceSaveControls,
  paper: PaperTradingController | null,
  replay: { inReplay: boolean; rebuild: () => void }
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
    paperButton.addEventListener('click', () => paper.toggle())
    // Driven by the window, not by the click: it can also be closed from its own title bar.
    paper.onOpenChange((open) => paperButton.classList.toggle('is-on', open))
    footer.appendChild(paperButton)

    // The trade box: the order ticket in a floating window of its own, apart from the account.
    const tradeButton = document.createElement('button')
    tradeButton.type = 'button'
    tradeButton.className = 'wd-rail-button'
    tradeButton.textContent = 'Trade'
    tradeButton.title = 'Order ticket: buy or sell'
    tradeButton.addEventListener('click', () => paper.toggleTicket())
    paper.onTicketOpenChange((open) => tradeButton.classList.toggle('is-on', open))
    footer.appendChild(tradeButton)
  }

  // Bar replay toggle, right next to Paper. On a live wall it opens the start dialog (and
  // rebuilds the wall in replay mode); on a replay wall it exits replay. Only present when
  // the server advertises both `sim` and `asof`.
  if (replayAvailable()) {
    const replayButton = document.createElement('button')
    replayButton.type = 'button'
    replayButton.className = `wd-rail-button${replay.inReplay ? ' is-on' : ''}`
    const idleTitle = replay.inReplay ? 'Exit bar replay (it is kept: Replay → Sessions resumes it)' : 'Bar replay: step through history from a date you choose, or resume a past replay'
    const showIdle = (): void => {
      replayButton.textContent = 'Replay'
      replayButton.title = idleTitle
    }
    showIdle()
    // Leaving keeps the replay -- the start dialog's Sessions tab resumes it -- so, like the
    // controls' own Exit, it is one press.
    replayButton.addEventListener('click', () => {
      if (replay.inReplay) {
        clearReplay()
        replay.rebuild()
        return
      }
      // The start dialog needs the store probed first; say so while it is. An instrument with
      // nothing to replay still opens it, on Sessions, saying why (startReplayFlow).
      replayButton.disabled = true
      replayButton.textContent = 'Replay…'
      void startReplayFlow(chartPro, replayButton, replay.rebuild)
        .catch((err) => {
          console.error('[replay] could not open the start dialog', err)
          railNote(replayButton, "Couldn't open replay")
        })
        .finally(() => {
          replayButton.disabled = false
          showIdle()
        })
    })
    footer.appendChild(replayButton)
    // A replay that could not open drops the page on this live wall (client/replay/index.ts
    // `takeReplayNotice`): say why beside the button that reopens it, once the rail is laid out.
    // Longer than a press's note: nobody pressed anything here, so nobody is looking yet.
    const notice = replay.inReplay ? null : takeReplayNotice()
    if (notice) requestAnimationFrame(() => railNote(replayButton, notice, 10_000))
  }

  // The Strategy Lab, in a tab of its own so the wall stays where it is.
  const labLink = document.createElement('a')
  labLink.className = 'wd-rail-button'
  labLink.textContent = 'Lab'
  labLink.title = 'Strategy Lab: develop entry and exit rules from signals and indicators'
  labLink.href = labHref()
  labLink.target = '_blank'
  labLink.rel = 'noopener'
  footer.appendChild(labLink)

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
  let streamStatus: StreamStatus = 'offline'
  let refusals: StreamRefusal[] = []
  const renderStatus = () => {
    // A replay wall is not live, whatever the socket is doing (it still carries notifications):
    // a green "live" under a chart frozen in 2024 was the one thing on screen that lied.
    if (replay.inReplay) {
      status.dataset.stream = 'replay'
      delete status.dataset.refused
      statusText.textContent = 'replay'
      statusText.title = 'Bar replay: the chart shows stored history up to the replay clock, not the live market'
      return
    }
    status.dataset.stream = streamStatus
    if (refusals.length === 0) {
      delete status.dataset.refused
      statusText.textContent = STATUS_LABELS[streamStatus]
      statusText.title = streamStatus
      return
    }
    // A pane whose live bars (or live plugin points) the server refused goes quiet with nothing
    // else on screen to say why: the warning, and the server's own reasons on hover.
    status.dataset.refused = String(refusals.length)
    statusText.textContent = `${STATUS_LABELS[streamStatus]}⚠`
    statusText.title = [
      streamStatus,
      '',
      `The server refused ${refusals.length === 1 ? 'one live subscription' : `${refusals.length} live subscriptions`}:`,
      ...refusals.map((r) => `${r.label} -- ${r.code}: ${r.errmsg}`)
    ].join('\n')
  }
  const unsubscribeStatus = stream.onStatus((value: StreamStatus) => {
    streamStatus = value
    renderStatus()
  })
  const unsubscribeRefusals = stream.onRefusals((value: StreamRefusal[]) => {
    refusals = value
    renderStatus()
  })

  // First in the toolbar slot: which wall you are on is the outermost thing about it, and it
  // reads left-to-right with the symbol and timeframe controls the library owns.
  const detachSwitcher = attachToSlot(chartPro, 'toolbar', switcher.element)
  // Save and Revert right after it: they act on the workspace the switcher names.
  const detachSaveControls = attachToSlot(chartPro, 'toolbar', saveControls.element)
  const detachFooter = attachToSlot(chartPro, 'rail-footer', footer)

  return () => {
    switcher.close()
    saveControls.close()
    unsubscribeStatus()
    unsubscribeRefusals()
    detachSwitcher()
    detachSaveControls()
    detachFooter()
  }
}
