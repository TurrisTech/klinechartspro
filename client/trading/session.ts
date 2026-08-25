import { OhlcvApiError } from '../config'
import {
  type OrderPatch,
  type OrderRequest,
  type SimAnswer,
  type SimEvent,
  type SimSnapshot,
  type TradePatch,
  simApi
} from './api'

// The interface the whole trading UI reads and acts through -- the panel, the order ticket,
// the positions/orders/history tables and the chart overlays. NOTHING in the UI talks to the
// server (or to any engine) directly; everything goes through a `TradingSession`.
//
// This is the seam for the next mode. Today the only implementation is `PaperTradingSession`,
// backed by the `/sim` routes; a later bar-replay mode is a second implementation of the same
// interface (backed by a client-side engine over stored bars), and the same panel, ticket,
// tables and overlays work against it unchanged.

export type SessionListener = (snapshot: SimSnapshot, events: SimEvent[]) => void

export interface TradingSession {
  /** The current account state. Always a valid snapshot -- a placeholder until the session
   * has loaded (`ready` is false until then). */
  readonly snapshot: SimSnapshot
  /** False until the backing session has loaded; the panel shows a connecting state. */
  readonly ready: boolean
  /** Subscribe to state changes; returns an unsubscribe. */
  subscribe(listener: SessionListener): () => void
  /** Bring an instrument in (its quote, and -- for paper -- keep its ticks flowing). */
  watch(instrument: string): Promise<void>
  placeOrder(order: OrderRequest): Promise<void>
  cancelOrder(orderId: string): Promise<void>
  modifyOrder(orderId: string, patch: OrderPatch): Promise<void>
  modifyTrade(tradeId: string, patch: TradePatch): Promise<void>
  closeTrade(tradeId: string, units?: number): Promise<void>
  flatten(symbol?: string): Promise<void>
}

const POLL_WORKING_MS = 2_000
const POLL_IDLE_MS = 15_000

const PLACEHOLDER: SimSnapshot = {
  id: '',
  mode: 'paper',
  name: 'Paper',
  createdAt: 0,
  rev: -1,
  account: { currency: 'USD', initialBalance: 0, balance: 0, unrealizedPnl: 0, equity: 0 },
  quotes: {},
  orders: [],
  trades: [],
  symbols: []
}

/** The paper account: one per owner, backed by the server's `/sim` routes.
 *
 * A paper session changes without the client asking (a resting order fills on a tick, a stop
 * loss fires), so it is polled: quickly while it has something working, slowly when it is
 * flat, and never while the tab is hidden. */
export class PaperTradingSession implements TradingSession {
  snapshot: SimSnapshot = PLACEHOLDER
  private listeners = new Set<SessionListener>()
  private loadPromise: Promise<void> | null = null
  private pollTimer: ReturnType<typeof setTimeout> | null = null
  private polling = false
  private disposed = false

  get ready(): boolean {
    return this.snapshot.id !== ''
  }

  private get id(): string {
    return this.snapshot.id
  }

  subscribe(listener: SessionListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private accept(answer: SimAnswer): void {
    if (this.disposed) return
    this.snapshot = answer.session
    for (const listener of [...this.listeners]) {
      try {
        listener(this.snapshot, answer.events)
      } catch (err) {
        console.error('[paper] session listener failed', err)
      }
    }
  }

  /** Resolve the account: the owner's existing paper session, or a new one. Idempotent --
   * every action awaits this, and it runs the load exactly once. */
  load(): Promise<void> {
    if (!this.loadPromise) this.loadPromise = this.doLoad()
    return this.loadPromise
  }

  private async doLoad(): Promise<void> {
    const sessions = await simApi.list()
    const paper = sessions
      .filter((s) => s.mode === 'paper')
      .sort((a, b) => a.createdAt - b.createdAt)[0]
    this.accept(paper ? { session: paper, events: [] } : await simApi.create({ mode: 'paper' }))
    this.startPolling()
  }

  // -- actions (each ensures the session is loaded first) ------------------------------

  async watch(instrument: string): Promise<void> {
    await this.load()
    this.accept(await simApi.watch(this.id, instrument))
  }

  async placeOrder(order: OrderRequest): Promise<void> {
    await this.load()
    this.accept(await simApi.placeOrder(this.id, order))
  }

  async cancelOrder(orderId: string): Promise<void> {
    await this.load()
    this.accept(await simApi.cancelOrder(this.id, orderId))
  }

  async modifyOrder(orderId: string, patch: OrderPatch): Promise<void> {
    await this.load()
    this.accept(await simApi.patchOrder(this.id, orderId, patch))
  }

  async modifyTrade(tradeId: string, patch: TradePatch): Promise<void> {
    await this.load()
    this.accept(await simApi.patchTrade(this.id, tradeId, patch))
  }

  async closeTrade(tradeId: string, units?: number): Promise<void> {
    await this.load()
    this.accept(await simApi.closeTrade(this.id, tradeId, units))
  }

  async flatten(symbol?: string): Promise<void> {
    await this.load()
    this.accept(await simApi.flatten(this.id, symbol))
  }

  // -- polling -------------------------------------------------------------------------

  private hasWorking(): boolean {
    return (
      this.snapshot.orders.some((o) => o.status === 'pending') ||
      this.snapshot.trades.some((t) => t.closedAt === null)
    )
  }

  private startPolling(): void {
    if (this.polling || this.disposed) return
    this.polling = true
    document.addEventListener('visibilitychange', this.onVisibility)
    this.schedulePoll()
  }

  private onVisibility = (): void => {
    if (document.visibilityState === 'visible' && this.polling) this.schedulePoll(0)
  }

  private schedulePoll(delay?: number): void {
    if (this.pollTimer) clearTimeout(this.pollTimer)
    const wait = delay ?? (this.hasWorking() ? POLL_WORKING_MS : POLL_IDLE_MS)
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null
      void this.poll()
    }, wait)
  }

  private async poll(): Promise<void> {
    if (!this.polling || this.disposed) return
    // Never poll a hidden tab: the account is on the server, so nothing is missed, and a
    // backgrounded tab should not keep hitting the API.
    if (document.visibilityState === 'hidden') return
    try {
      const answer = await simApi.get(this.id)
      // A poll cannot know which events fired since the last one -- the fills and closes are
      // visible as state; listeners that care compare snapshots.
      this.accept({ ...answer, events: [] })
    } catch (err) {
      if (err instanceof OhlcvApiError && err.status === 404) {
        // Deleted elsewhere (another tab): stop rather than 404 forever.
        this.polling = false
        return
      }
      console.warn('[paper] poll failed', err)
    } finally {
      if (this.polling) this.schedulePoll()
    }
  }

  dispose(): void {
    this.disposed = true
    this.polling = false
    if (this.pollTimer) clearTimeout(this.pollTimer)
    this.pollTimer = null
    document.removeEventListener('visibilitychange', this.onVisibility)
    this.listeners.clear()
  }
}
