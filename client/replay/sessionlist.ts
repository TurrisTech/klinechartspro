import { FigureList } from '../trading/kit'
import { formatSpan, zoneName } from '../time/format'
import { Arming } from '../ui/arming'
import { button, el } from '../ui/dom'
import { resultHeadline, resultRows } from './results'
import { lastPlayed, type ReplaySessionSummary, resumable, sessionFacts } from './sessions'
import { flash } from './dom'

// GLUE (DOM). Past replays: the list the start dialog's Sessions tab (./startdialog.ts) and the
// replay window's Sessions panel (./controls.ts) both show -- each row what it replayed, how far,
// its score (sessions.ts, results.ts), and Stats, Delete (two presses) and Resume. The host says
// what an empty list reads, what happens before a Resume goes ahead, and reflows after a render;
// what a row shows and does is the same in both.

/** A past replay as the Sessions tab lists it: its summary, and the zone its dates read in. */
export interface ListedSession {
  summary: ReplaySessionSummary
  /** The instrument's own clock, as its chart and the replay's clock read; UTC when its market
   * hours could not be resolved -- named so beside the dates. */
  zone: string
}

export interface SessionsSource {
  /** The list, most recently played first. */
  load(): Promise<ListedSession[]>
  /** Reopen it where it was left: the dialog has closed by then; the replay window's list says
   * "Opening…" until the wall rebuilds, and that a rejection could not open it. */
  resume(session: ReplaySessionSummary): void | Promise<void>
  /** Delete it on the server; resolves once that is done. */
  remove(id: string): Promise<void>
}

/** How long an armed Delete waits for its second press. */
const CONFIRM_MS = 3_000

interface SessionListOptions {
  source: SessionsSource
  /** What it says when there is nothing to list. */
  empty: string
  /** Resume was pressed: true goes ahead at once, false refuses (the caller says why), and a
   * promise goes ahead when it resolves true -- the replay window waiting out a step in flight. */
  beforeResume?: () => boolean | Promise<boolean>
  /** After every render but the first (which is inside the call that builds it): it loaded, a
   * row went or opened its figures. */
  onRender?: () => void
}

export interface SessionList {
  /** Mounted by the caller and kept for the list's life: it re-renders inside it. */
  readonly element: HTMLElement
  /** The rows listed; null while loading, or when the list would not load. */
  readonly count: number | null
  /** Where the rows scroll. Kept across the list's own renders, so a Stats or a Delete far down
   * thirty replays does not jump back to the top; a caller that detaches `element` to re-render
   * around it puts `scrollTop` back. */
  readonly scroller: HTMLElement
  dispose(): void
}

/** Past replays, loaded once, each with what it replayed, how far, its score, and Stats, Delete
 * (two presses) and Resume. */
export function createSessionList(options: SessionListOptions): SessionList {
  const { source } = options
  const element = el('div', 'wd-tk wd-replay-sessions')
  const scroller = el('div', 'wd-replay-session-list')
  let listed: ListedSession[] | null = null
  let failed = false
  let disposed = false
  /** The row whose Resume is on its way: the rest wait for it. */
  let resuming: string | null = null
  /** The rows whose figures are showing. */
  const expanded = new Set<string>()
  /** The rows whose delete is on its way to the server. */
  const deleting = new Set<string>()
  const arming = new Arming(() => render(), CONFIRM_MS)

  function render(notify = true): void {
    if (disposed) return
    if (failed) element.replaceChildren(muted('Could not load your replays.'))
    else if (listed === null) element.replaceChildren(muted('Loading your replays…'))
    else if (listed.length === 0) element.replaceChildren(muted(options.empty))
    else {
      // The rows change, never the box they scroll in.
      scroller.replaceChildren(...listed.map(row))
      if (scroller.parentElement !== element) element.replaceChildren(scroller)
    }
    if (notify) options.onRender?.()
  }

  function pressResume(s: ReplaySessionSummary): void {
    if (resuming !== null) return
    // Not refused once disposed: the dialog's own `beforeResume` is what closed it.
    const go = (): void => {
      if (resuming !== null) return
      resuming = s.id
      render()
      const fail = (err: unknown): void => {
        console.error('[replay] could not resume session', s.id, err)
        resuming = null
        render()
        if (!disposed) flash(element, 'Could not open that replay')
      }
      try {
        void Promise.resolve(source.resume(s)).catch(fail)
      } catch (err) {
        fail(err)
      }
    }
    const ready = options.beforeResume ? options.beforeResume() : true
    if (ready === true) go()
    // Waited for: the window may have gone in the meantime (the wall rebuilt by something else).
    else if (ready !== false) void ready.then((ok) => ok && !disposed && go())
  }

  function row({ summary: s, zone }: ListedSession): HTMLElement {
    const box = el('div', 'wd-replay-session')
    box.dataset.session = s.id

    const head = el('div', 'wd-replay-session-head')
    const name = el('span', 'wd-replay-session-ticker')
    name.textContent = s.ticker || 'Unknown instrument'
    head.appendChild(name)
    if (s.state) {
      const base = el('span', 'wd-replay-session-base')
      base.textContent = `${s.state.base} base`
      head.appendChild(base)
    }
    // Net P&L only once something was traded: "0.00 USD · 0.00%" on every idle replay is noise.
    if (s.results && s.results.closed + s.results.open > 0) {
      const headline = resultHeadline(s.results)
      const net = el('span', `wd-replay-session-net${headline.tone ? ` is-${headline.tone}` : ''}`)
      net.textContent = headline.text
      net.title = 'Net P&L: realised plus what is still open, against the starting balance'
      head.appendChild(net)
    }
    box.appendChild(head)

    if (s.state) {
      const span = el('div', 'wd-replay-session-span')
      span.textContent = formatSpan(s.state.startedAt, s.state.cursor, zone)
      span.title = `Where the replay started and how far it got (${zoneName(zone)})`
      box.appendChild(span)
    }
    const facts = el('div', 'wd-replay-session-facts')
    facts.textContent = `${sessionFacts(s)} · ${s.savedAt === null ? 'started' : 'played'} ${formatLocal(lastPlayed(s))}`
    box.appendChild(facts)

    const actions = el('div', 'wd-replay-session-actions')
    const open = expanded.has(s.id)
    if (s.results && s.results.closed + s.results.open > 0) {
      const stats = button(`kc-button kc-button-outline wd-replay-session-stats${open ? ' is-on' : ''}`, open ? 'Hide stats' : 'Stats', () => {
        if (expanded.has(s.id)) expanded.delete(s.id)
        else expanded.add(s.id)
        render()
      })
      stats.setAttribute('aria-expanded', String(open))
      actions.appendChild(stats)
    }
    const busy = deleting.has(s.id)
    const armed = arming.key === `delete:${s.id}`
    const remove = button(`kc-button kc-button-outline wd-replay-session-delete${armed ? ' is-armed' : ''}`, busy ? 'Deleting…' : armed ? 'Confirm delete' : 'Delete', () => {
      if (deleting.has(s.id) || !arming.press(`delete:${s.id}`, false)) return
      deleting.add(s.id)
      render()
      source
        .remove(s.id)
        .then(() => {
          deleting.delete(s.id)
          expanded.delete(s.id)
          listed = (listed ?? []).filter((l) => l.summary.id !== s.id)
          render()
        })
        .catch((err) => {
          console.error('[replay] could not delete session', s.id, err)
          deleting.delete(s.id)
          render()
          if (!disposed) flash(element, 'Could not delete that replay')
        })
    })
    remove.disabled = busy || resuming !== null
    remove.title = armed ? 'Press again to delete. This replay, its account and its trades are gone for good.' : 'Delete this replay'
    actions.appendChild(remove)
    const opening = resuming === s.id
    const resume = button('kc-button kc-button-primary wd-replay-session-resume', opening ? 'Opening…' : 'Resume', () => pressResume(s))
    resume.disabled = busy || resuming !== null || !resumable(s)
    resume.title = resumable(s) ? 'Reopen this replay where you left it: its clock, account, orders and watches' : 'This replay was saved by another version and cannot be reopened'
    actions.appendChild(resume)
    box.appendChild(actions)

    if (open && s.results) {
      const figures = new FigureList('wd-replay-results-figures')
      figures.update(resultRows(s.results))
      box.appendChild(figures.element)
    }
    return box
  }

  function muted(text: string): HTMLElement {
    const note = el('div', 'wd-replay-muted')
    note.textContent = text
    return note
  }

  source
    .load()
    .then((rows) => {
      listed = rows
      render()
    })
    .catch((err) => {
      console.error('[replay] could not list sessions', err)
      failed = true
      render()
    })
  render(false)
  return {
    element,
    scroller,
    get count() {
      return failed ? null : (listed?.length ?? null)
    },
    dispose(): void {
      disposed = true
      arming.disarm()
    }
  }
}

const localDate = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
const localDateThisYear = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

/** When a session was last played, on the VIEWER's clock -- this is when you sat at it, not a
 * market instant: "Nov 14, 10:22", with the year once it is not this one. */
function formatLocal(ms: number, now = Date.now()): string {
  const year = (t: number): number => new Date(t).getFullYear()
  return (year(ms) === year(now) ? localDateThisYear : localDate).format(new Date(ms))
}
