import type { SimOrder, SimTrade } from './api'
import { formatInstant, formatMoney, formatPrice, formatUnitsShort, moveText } from './format'
import {
  allow,
  armKey,
  ConfirmBar,
  type ConfirmView,
  FigureList,
  h,
  kbtn,
  LevelField,
  type PresetView,
  type TradeAction,
  TradeActions
} from './kit'
import {
  amountText,
  type LevelBasis,
  type LevelRole,
  levelModeRefusal,
  levelReadout,
  levelText,
  parseLevel,
  priceStep,
  restingDistance,
  stepLevelText
} from './levels'
import { type Amendment, type DraftOrder, isComposing } from './lines'
import { tradeActionsView } from './manage'
import { orderFigures, outcome, type PricingContext, positionSummary, quoteToAccountRate, rewardToRisk, roundTo, targetForReward, tradeFigures } from './metrics'
import type { ProtectMode } from './prefs'
import { sizeRows, type StatRow } from './stats'

export { h } from './kit'
export { amountText } from './levels'

// The order card: the collapsible widget in the candle pane's lower left that lists what is
// working on the pane's instrument -- every open trade and pending order -- with the figures behind
// each and the controls that manage them. Rolled up, its header still answers the question it is
// open for: how many are working, and what they are making.
//
// It is built from the same kit (kit.ts) as the trade box, so the two read alike (user,
// 2026-10-03): a working trade's stop loss is the same field as the stop loss being written --
// pips, price or % of balance, −/+ steps, Risk N% and 1R/2R/3R, the readout beside it -- and its
// figures are the same rows. Editing a field here PROPOSES the change, which waits for Confirm
// like every other on-chart change (user, 2026-09-15); a step or a preset proposes too.
//
// The order being written in the trade box (the DRAFT) is the first row while it is for this
// instrument and has a level of its own: a summary with Place, not a second editor -- the trade box
// beside it is the editor, and two of them on screen at once was the inconsistency this replaced.
//
// Plain DOM like the rest of client/trading. Elements are built ONCE per trade or order and
// updated in place on every snapshot, because a paper session notifies every two seconds: a
// card rebuilt on each poll would drop keyboard focus and a half-finished hover every time.
//
// It knows nothing about the chart. Every gesture goes out as a `CardAction` to the layer
// (onchart.ts), which owns confirmation, the session call and the error.

type Owner = 'trade' | 'order'

export type CardAction =
  | { kind: 'toggle' }
  | { kind: 'select'; id: string }
  | { kind: 'close'; trade: SimTrade; fraction: number }
  | { kind: 'reverse'; trade: SimTrade }
  | { kind: 'breakeven'; trade: SimTrade }
  | { kind: 'cancel'; order: SimOrder }
  | { kind: 'protect'; owner: Owner; id: string; role: LevelRole }
  | { kind: 'unprotect'; owner: Owner; id: string; role: LevelRole }
  /** A field's value, or a step: propose this level (null removes it). */
  | { kind: 'setLevel'; owner: Owner; id: string; role: LevelRole | 'order'; price: number | null }
  /** The stop at `riskPercent` of the balance; the target at `ratio` times the stop. */
  | { kind: 'riskStop'; owner: Owner; id: string }
  | { kind: 'rewardTarget'; owner: Owner; id: string; ratio: number }
  /** How every stop and target is stated, here and in the trade box. */
  | { kind: 'unit'; mode: ProtectMode }
  | { kind: 'flatten' }
  | { kind: 'cancelOrders' }
  /** The ticket's draft: add a level from its label, clear one, place it, or discard it. */
  | { kind: 'draftProtect'; role: LevelRole }
  | { kind: 'draftClear'; role: 'entry' | LevelRole }
  | { kind: 'draftPlace' }
  | { kind: 'draftDiscard' }
  /** The on-chart change waiting for confirmation. */
  | { kind: 'amendConfirm' }
  | { kind: 'amendCancel' }
  /** A field held something that is not a level. */
  | { kind: 'error'; message: string }

export interface CardModel {
  symbol: string
  ctx: PricingContext
  trades: SimTrade[]
  orders: SimOrder[]
  collapsed: boolean
  compact: boolean
  /** The row shown with its details: the selection, or the only entry there is. */
  expanded: string | null
  /** The action key waiting for its confirming second press (kit.ts `armKey`). */
  armed: string | null
  /** The shared numbers behind the presets, and how levels are stated (prefs.ts). */
  riskPercent: number
  protectMode: ProtectMode
  /** The order being written in the ticket, when it is for this instrument. */
  draft: DraftOrder | null
  /** The change waiting for confirmation, and the same in words. */
  amendment: Amendment | null
  confirm: ConfirmView | null
}

export const REWARD_RATIOS = [1, 2, 3]

function tone(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value) || value === 0) return ''
  return value > 0 ? 'is-up' : 'is-down'
}

function setTone(node: HTMLElement, value: number | null | undefined): void {
  node.classList.toggle('is-up', tone(value) === 'is-up')
  node.classList.toggle('is-down', tone(value) === 'is-down')
}

export { moveText } from './format'

export class OrderCard {
  readonly element: HTMLElement
  private readonly toggle: HTMLButtonElement
  private readonly symbol: HTMLElement
  private readonly count: HTMLElement
  private readonly pnl: HTMLElement
  private readonly flashNode: HTMLElement
  private readonly body: HTMLElement
  private readonly list: HTMLElement
  private readonly foot: HTMLElement
  private readonly footText: HTMLElement
  private readonly cancelOrdersButton: HTMLButtonElement
  private readonly flattenButton: HTMLButtonElement
  private readonly errorNode: HTMLElement
  private readonly rows = new Map<string, TradeRow | OrderRow>()
  private readonly draftRow: DraftRow
  private readonly confirmBar: ConfirmBar
  private flashTimer: ReturnType<typeof setTimeout> | null = null
  private errorTimer: ReturnType<typeof setTimeout> | null = null
  private flashing = false
  private empty = true

  constructor(private readonly dispatch: (action: CardAction) => void) {
    this.element = h('section', 'wd-tk wd-oc-card')
    this.element.setAttribute('aria-label', 'Working orders')

    const head = h('div', 'wd-oc-card-head')
    this.toggle = kbtn('', () => dispatch({ kind: 'toggle' }))
    this.toggle.className = 'wd-oc-card-toggle'
    const chevron = h('span', 'wd-oc-card-chevron')
    chevron.setAttribute('aria-hidden', 'true')
    this.symbol = h('span', 'wd-oc-card-symbol')
    this.count = h('span', 'wd-oc-card-count')
    this.pnl = h('span', 'wd-oc-card-pnl')
    this.toggle.append(chevron, this.symbol, this.count, this.pnl)
    this.flashNode = h('span', 'wd-oc-card-flash')
    this.flashNode.setAttribute('role', 'status')
    this.flashNode.hidden = true
    head.append(this.toggle, this.flashNode)

    this.body = h('div', 'wd-oc-card-body')
    this.list = h('div', 'wd-oc-card-list')
    this.list.setAttribute('role', 'list')
    this.foot = h('div', 'wd-oc-card-foot')
    this.footText = h('span', 'wd-oc-card-foot-text')
    this.cancelOrdersButton = kbtn('Cancel orders', () => dispatch({ kind: 'cancelOrders' }))
    this.flattenButton = kbtn('Flatten', () => dispatch({ kind: 'flatten' }), ['danger'])
    this.foot.append(this.footText, this.cancelOrdersButton, this.flattenButton)
    this.errorNode = h('div', 'wd-oc-card-error')
    this.errorNode.setAttribute('role', 'alert')
    this.errorNode.hidden = true
    this.draftRow = new DraftRow(dispatch)
    // The confirmation for an on-chart change: first in the card, so it is where the eye goes.
    this.confirmBar = new ConfirmBar(
      () => dispatch({ kind: 'amendConfirm' }),
      () => dispatch({ kind: 'amendCancel' })
    )
    this.body.append(this.confirmBar.element, this.draftRow.element, this.list, this.foot, this.errorNode)

    this.element.append(head, this.body)
    this.element.hidden = true
  }

  render(model: CardModel): void {
    const { trades, orders, ctx } = model
    // The draft is listed once it has a level of its own -- the rule the chart draws it by. A bare
    // market order is only the trade box's button, which is right beside it.
    const draft = isComposing(model.draft) ? model.draft : null
    this.empty = trades.length === 0 && orders.length === 0 && draft === null
    this.element.hidden = this.empty && !this.flashing
    // A question waiting for an answer opens the card, whatever its rolled-up preference.
    const collapsed = model.collapsed && model.confirm === null
    this.element.classList.toggle('is-collapsed', collapsed)
    this.element.classList.toggle('is-empty', this.empty)
    this.element.classList.toggle('is-confirming', model.confirm !== null)
    this.toggle.setAttribute('aria-expanded', String(!collapsed))
    this.toggle.title = collapsed ? 'Show working orders' : 'Hide working orders'
    this.confirmBar.update(model.confirm)

    // Header: instrument, what is working, and the open P&L -- in the quote currency, which is
    // uniform across one instrument, so the sum is exact.
    const summary = positionSummary(trades, orders, ctx)
    this.symbol.textContent = model.symbol
    const parts: string[] = []
    if (trades.length > 0) parts.push(model.compact ? `${trades.length} pos` : `${trades.length} open`)
    if (orders.length > 0) {
      parts.push(model.compact ? `${orders.length} ord` : `${orders.length} order${orders.length === 1 ? '' : 's'}`)
    }
    if (draft) parts.push('draft')
    this.count.textContent = parts.join(' · ')
    this.count.hidden = parts.length === 0
    if (summary.pnlAccount !== null || trades.length > 0) {
      this.pnl.textContent = formatMoney(summary.pnl, model.compact ? '' : ctx.currencies.quote)
      setTone(this.pnl, summary.pnl)
      this.pnl.hidden = false
    } else {
      this.pnl.hidden = true
    }

    this.draftRow.element.hidden = draft === null
    if (draft) this.draftRow.update(draft, model)

    // Rows, keyed by id and kept in the order they opened.
    const wanted = new Set<string>()
    const ordered: HTMLElement[] = []
    for (const order of orders) {
      wanted.add(order.id)
      let row = this.rows.get(order.id)
      if (!(row instanceof OrderRow)) {
        row?.element.remove()
        row = new OrderRow(order.id, this.dispatch)
        this.rows.set(order.id, row)
      }
      row.update(order, model)
      ordered.push(row.element)
    }
    for (const trade of trades) {
      wanted.add(trade.id)
      let row = this.rows.get(trade.id)
      if (!(row instanceof TradeRow)) {
        row?.element.remove()
        row = new TradeRow(trade.id, this.dispatch)
        this.rows.set(trade.id, row)
      }
      row.update(trade, model)
      ordered.push(row.element)
    }
    for (const [id, row] of this.rows) {
      if (wanted.has(id)) continue
      row.element.remove()
      this.rows.delete(id)
    }
    ordered.forEach((node, i) => {
      if (this.list.children[i] !== node) this.list.insertBefore(node, this.list.children[i] ?? null)
    })

    // Footer: only when there is more than one thing to add up.
    const many = trades.length + orders.length > 1
    this.foot.hidden = !many
    if (many) {
      const bits: string[] = []
      if (trades.length > 0) {
        const net = summary.netUnits
        bits.push(net === 0 ? 'Flat' : `Net ${net > 0 ? 'long' : 'short'} ${formatUnitsShort(net)}`)
        if (summary.averageEntry !== null) bits.push(`avg ${formatPrice(summary.averageEntry, ctx.info.precision)}`)
        bits.push(
          summary.riskAtStops === null
            ? 'risk unbounded (no stop)'
            : `at stops ${formatMoney(summary.riskAtStops, model.compact ? '' : ctx.currencies.quote)}`
        )
      }
      this.footText.textContent = bits.join(' · ')
      this.footText.classList.toggle('is-warn', trades.length > 0 && summary.riskAtStops === null)
      const armedCancel = model.armed === 'cancelOrders'
      this.cancelOrdersButton.hidden = orders.length === 0 || trades.length === 0
      this.cancelOrdersButton.textContent = armedCancel ? 'Confirm cancel' : 'Cancel orders'
      this.cancelOrdersButton.classList.toggle('is-armed', armedCancel)
      this.cancelOrdersButton.title = `Cancel every pending ${model.symbol} order, keeping the trades`
      const armed = model.armed === armKey.flatten
      this.flattenButton.textContent = armed ? 'Confirm flatten' : 'Flatten'
      this.flattenButton.classList.toggle('is-armed', armed)
      this.flattenButton.title = `Close every ${model.symbol} trade and cancel every ${model.symbol} order`
    }
  }

  /** A one-line event (a fill, a stop hit) in the header for a few seconds. */
  flash(text: string, toneName: 'up' | 'down' | 'info', ms: number): void {
    this.flashNode.textContent = text
    this.flashNode.dataset.tone = toneName
    this.flashNode.hidden = false
    this.flashing = true
    this.element.hidden = false
    if (this.flashTimer) clearTimeout(this.flashTimer)
    this.flashTimer = setTimeout(() => {
      this.flashTimer = null
      this.flashing = false
      this.flashNode.hidden = true
      this.element.hidden = this.empty
    }, ms)
  }

  error(text: string, ms: number): void {
    this.errorNode.textContent = text
    this.errorNode.hidden = false
    if (this.errorTimer) clearTimeout(this.errorTimer)
    this.errorTimer = setTimeout(() => {
      this.errorTimer = null
      this.errorNode.hidden = true
    }, ms)
  }

  dispose(): void {
    if (this.flashTimer) clearTimeout(this.flashTimer)
    if (this.errorTimer) clearTimeout(this.errorTimer)
    this.element.remove()
  }
}

// -- levels on a working position ----------------------------------------------------------------

/** What a working position's level fields need: who it is, where it is measured from, and the
 * level it has now (the waiting change applied). */
interface Working {
  owner: Owner
  id: string
  basis: LevelBasis
  stop: number | null
  target: number | null
}

function unitRefusals(ctx: PricingContext): Record<string, string | null> {
  return Object.fromEntries((['pips', 'price', 'percent'] as ProtectMode[]).map((m) => [m, levelModeRefusal(m, ctx)]))
}

function pendingOn(model: CardModel, owner: Owner, id: string, role: LevelRole | 'order'): boolean {
  const a = model.amendment
  return a !== null && a.owner === owner && a.id === id && a.role === role
}

/** A working stop or target: the trade box's field, wired to propose rather than to write. */
class WorkingLevel {
  readonly field: LevelField
  private working: Working | null = null
  private mode: ProtectMode = 'pips'

  constructor(
    private readonly role: LevelRole,
    owner: Owner,
    id: string,
    dispatch: (action: CardAction) => void
  ) {
    const propose = (text: string): boolean => {
      const w = this.working
      if (!w) return false
      try {
        dispatch({ kind: 'setLevel', owner, id, role, price: parseLevel(text, this.mode, role, w.basis) })
        return true
      } catch (err) {
        dispatch({ kind: 'error', message: err instanceof Error ? err.message : 'Not a level' })
        return false
      }
    }
    this.field = new LevelField({
      role,
      label: role === 'stop' ? 'Stop loss' : 'Take profit',
      withUnits: true,
      onCommit: (text) => void propose(text),
      onStep: (direction, big) => {
        const w = this.working
        if (!w) return
        const text = stepLevelText(this.field.field.value(), this.mode, role, direction, big, w.basis)
        if (propose(text)) this.field.write(text)
      },
      onUnit: (mode) => dispatch({ kind: 'unit', mode }),
      onPreset: (i) =>
        role === 'stop' ? dispatch({ kind: 'riskStop', owner, id }) : dispatch({ kind: 'rewardTarget', owner, id, ratio: REWARD_RATIOS[i] }),
      onClear: () => dispatch({ kind: 'unprotect', owner, id, role })
    })
  }

  update(w: Working, model: CardModel): void {
    this.working = w
    const { ctx } = w.basis
    this.mode = model.protectMode
    if (levelModeRefusal(this.mode, ctx) !== null) this.mode = ctx.info.pipSize !== null ? 'pips' : 'price'
    const price = this.role === 'stop' ? w.stop : w.target
    const presets: PresetView[] =
      this.role === 'stop'
        ? [
            {
              text: `Risk ${Number(model.riskPercent.toFixed(2))}%`,
              title: `Put the stop where it loses ${Number(model.riskPercent.toFixed(2))}% of the balance`,
              refusal: quoteToAccountRate(ctx) === null ? `no ${ctx.account.currency} rate for ${ctx.currencies.quote}` : null
            }
          ]
        : REWARD_RATIOS.map((ratio) => {
            const stopOutcome = w.stop !== null && w.basis.entry !== null ? outcome(w.basis.side, 1, w.basis.entry, w.stop, ctx) : null
            const refusal = stopOutcome === null ? 'set a stop loss first' : stopOutcome.move >= 0 ? 'the stop is past the entry and risks nothing' : null
            const at = refusal === null && w.basis.entry !== null && w.stop !== null ? targetForReward(w.basis.side, w.basis.entry, w.stop, ratio, ctx.info.precision) : null
            return { text: `${ratio}R`, title: `Put the target at ${ratio}× the stop's distance`, refusal, active: at !== null && at === price }
          })
    this.field.update({
      text: price !== null ? levelText(price, this.mode, w.basis) : '',
      placeholder: 'none',
      unit: this.mode,
      unitRefusals: unitRefusals(ctx),
      readout: price !== null ? levelReadout(price, this.mode, w.basis) : [],
      presets,
      removable: price !== null,
      problem: null,
      pending: pendingOn(model, w.owner, w.id, this.role),
      stepRefusal: w.basis.entry === null ? 'No price yet' : null
    })
  }
}

// -- rows ------------------------------------------------------------------------------------------

/** The order still being written in the trade box, for this instrument: what it would do, and
 * Place -- two presses (or one, one-click), because the chart is an easy place to press by
 * accident. Its levels are edited in the trade box or by dragging its lines. */
class DraftRow {
  readonly element: HTMLElement
  private readonly badge: HTMLElement
  private readonly size: HTMLElement
  private readonly prices: HTMLElement
  private readonly ratio: HTMLElement
  private readonly figures: FigureList
  private readonly problem: HTMLElement
  private readonly discard: HTMLButtonElement
  private readonly placeButton: HTMLButtonElement

  constructor(dispatch: (action: CardAction) => void) {
    this.element = h('div', 'wd-oc-row is-draft is-expanded')
    this.element.title = 'The order in the trade box: edit it there, or drag its lines'
    const main = h('div', 'wd-oc-row-main')
    this.badge = h('span', 'wd-oc-badge is-pending', 'Draft')
    this.size = h('span', 'wd-oc-row-size')
    this.prices = h('span', 'wd-oc-row-prices')
    this.ratio = h('span', 'wd-oc-row-pips')
    main.append(this.badge, this.size, this.prices, this.ratio)
    const detail = h('div', 'wd-oc-row-detail')
    this.figures = new FigureList('is-single')
    this.problem = h('div', 'wd-tk-problem')
    const actions = h('div', 'wd-tk-row is-end')
    this.discard = kbtn('Discard', () => dispatch({ kind: 'draftDiscard' }), [], 'Clear the draft: back to a market order with no stop or target')
    this.placeButton = kbtn('Place', () => dispatch({ kind: 'draftPlace' }), ['primary'])
    actions.append(this.discard, this.placeButton)
    detail.append(this.figures.element, this.problem, actions)
    this.element.append(main, detail)
  }

  update(draft: DraftOrder, model: CardModel): void {
    const { ctx } = model
    const buy = draft.side === 'buy'
    const precision = ctx.info.precision
    this.element.dataset.side = draft.side
    this.badge.className = `wd-oc-badge is-pending ${buy ? 'is-buy' : 'is-sell'}`
    const what = `${buy ? 'Buy' : 'Sell'} ${draft.type === 'market' ? 'market' : draft.type} ${draft.units !== null ? formatUnitsShort(draft.units) : '—'}`
    this.size.textContent = what
    this.prices.textContent = `@ ${formatPrice(draft.entry, precision)}`
    const basis: LevelBasis = { side: draft.side, entry: draft.entry, units: draft.units, ctx }
    const at = (price: number | null) => (price === null || draft.units === null ? null : outcome(draft.side, draft.units, draft.entry, price, ctx))
    const rr = rewardToRisk(at(draft.stop), at(draft.target))
    this.ratio.textContent = rr !== null ? `R:R ${rr.toFixed(2)}` : ''

    const level = (price: number | null): string =>
      price === null ? 'none' : [formatPrice(price, precision), ...levelReadout(price, 'price', basis).map((p) => p.text)].join(' · ')
    const rows: StatRow[] = [
      { label: 'Stop loss', value: level(draft.stop), tone: draft.stop === null ? 'warn' : '' },
      { label: 'Take profit', value: level(draft.target) }
    ]
    if (draft.units !== null) rows.push(...sizeRows(draft.units, ctx).filter((r) => r.label === 'Size' || r.label === 'Margin'))
    this.figures.update(rows)
    this.problem.textContent = draft.problem ?? ''
    this.problem.hidden = draft.problem === null
    this.discard.hidden = draft.type === 'market' && draft.stop === null && draft.target === null
    const armed = model.armed === armKey.place
    this.placeButton.textContent = armed
      ? 'Confirm'
      : `Place ${buy ? 'buy' : 'sell'} ${draft.type} ${draft.units !== null ? formatUnitsShort(draft.units) : ''}`.trim()
    this.placeButton.className = `wd-tk-btn is-${draft.side}${armed ? ' is-armed' : ''}`
    allow(this.placeButton, draft.problem, armed ? 'Press again to send it' : '')
  }
}

function workingRows(units: number, ctx: PricingContext, rr: number | null, when: StatRow, label: string | null): StatRow[] {
  const rows = sizeRows(units, ctx)
  if (rr !== null) rows.push({ label: 'R:R', value: rr.toFixed(2) })
  rows.push(when)
  if (label) rows.push({ label: 'Note', value: label })
  return rows
}

class TradeRow {
  readonly element: HTMLElement
  private readonly main: HTMLButtonElement
  private readonly badge: HTMLElement
  private readonly size: HTMLElement
  private readonly prices: HTMLElement
  private readonly pips: HTMLElement
  private readonly pnl: HTMLElement
  private readonly detail: HTMLElement
  private readonly stop: WorkingLevel
  private readonly target: WorkingLevel
  private readonly figures: FigureList
  private readonly actions: TradeActions
  private trade: SimTrade | null = null

  constructor(
    readonly id: string,
    dispatch: (action: CardAction) => void
  ) {
    this.element = h('div', 'wd-oc-row')
    this.element.setAttribute('role', 'listitem')
    this.main = kbtn('', () => dispatch({ kind: 'select', id }))
    this.main.className = 'wd-oc-row-main'
    this.badge = h('span', 'wd-oc-badge')
    this.size = h('span', 'wd-oc-row-size')
    this.prices = h('span', 'wd-oc-row-prices')
    this.pips = h('span', 'wd-oc-row-pips')
    this.pnl = h('span', 'wd-oc-row-pnl')
    this.main.append(this.badge, this.size, this.prices, this.pips, this.pnl)

    this.detail = h('div', 'wd-oc-row-detail')
    this.stop = new WorkingLevel('stop', 'trade', id, dispatch)
    this.target = new WorkingLevel('target', 'trade', id, dispatch)
    this.figures = new FigureList()
    this.actions = new TradeActions((action: TradeAction) => {
      const trade = this.trade
      if (!trade) return
      if (action.kind === 'close') dispatch({ kind: 'close', trade, fraction: action.fraction })
      else dispatch({ kind: action.kind, trade })
    })
    this.detail.append(this.stop.field.element, this.target.field.element, this.figures.element, this.actions.element)
    this.element.append(this.main, this.detail)
  }

  update(trade: SimTrade, model: CardModel): void {
    this.trade = trade
    const { ctx } = model
    const f = tradeFigures(trade, ctx)
    const expanded = model.expanded === trade.id
    const long = trade.side === 'buy'
    this.element.classList.toggle('is-expanded', expanded)
    this.element.dataset.side = trade.side
    this.main.setAttribute('aria-expanded', String(expanded))
    this.badge.textContent = model.compact ? (long ? 'L' : 'S') : long ? 'Long' : 'Short'
    this.badge.className = `wd-oc-badge ${long ? 'is-buy' : 'is-sell'}`
    this.size.textContent = formatUnitsShort(trade.units)
    this.prices.textContent = `${formatPrice(trade.entryPrice, ctx.info.precision)} → ${formatPrice(f.mark, ctx.info.precision)}`
    this.pips.textContent = moveText(f.pnl)
    this.pnl.textContent = f.pnl ? formatMoney(f.pnl.amount) : '—'
    setTone(this.pips, f.pnl?.amount)
    setTone(this.pnl, f.pnl?.amount)
    this.main.title = `${long ? 'Long' : 'Short'} ${formatUnitsShort(trade.units)} ${model.symbol} from ${formatPrice(trade.entryPrice, ctx.info.precision)}${
      f.pnl ? `, ${amountText(f.pnl.amount, f.pnl.amountAccount, ctx)}` : ''
    }${trade.label ? ` — ${trade.label}` : ''}`

    this.detail.hidden = !expanded
    if (!expanded) return
    const working: Working = {
      owner: 'trade',
      id: trade.id,
      basis: { side: trade.side, entry: trade.entryPrice, units: trade.units, ctx },
      stop: trade.stopLoss,
      target: trade.takeProfit
    }
    this.stop.update(working, model)
    this.target.update(working, model)
    this.figures.update(workingRows(trade.units, ctx, f.rewardToRisk, { label: 'Opened', value: formatInstant(trade.openedAt) }, trade.label))
    this.actions.update(tradeActionsView(trade, ctx, model.armed))
  }
}

class OrderRow {
  readonly element: HTMLElement
  private readonly main: HTMLButtonElement
  private readonly badge: HTMLElement
  private readonly size: HTMLElement
  private readonly prices: HTMLElement
  private readonly distance: HTMLElement
  private readonly detail: HTMLElement
  private readonly price: LevelField
  private readonly stop: WorkingLevel
  private readonly target: WorkingLevel
  private readonly figures: FigureList
  private readonly cancel: HTMLButtonElement
  private order: SimOrder | null = null
  private precision = 5
  private step = 0.0001

  constructor(
    readonly id: string,
    dispatch: (action: CardAction) => void
  ) {
    this.element = h('div', 'wd-oc-row is-pending')
    this.element.setAttribute('role', 'listitem')
    this.main = kbtn('', () => dispatch({ kind: 'select', id }))
    this.main.className = 'wd-oc-row-main'
    this.badge = h('span', 'wd-oc-badge')
    this.size = h('span', 'wd-oc-row-size')
    this.prices = h('span', 'wd-oc-row-prices')
    this.distance = h('span', 'wd-oc-row-pips')
    this.main.append(this.badge, this.size, this.prices, this.distance)

    this.detail = h('div', 'wd-oc-row-detail')
    const propose = (text: string): boolean => {
      const value = Number(text.trim())
      if (text.trim() === '' || !(value > 0)) {
        dispatch({ kind: 'error', message: 'An order must keep a price' })
        return false
      }
      dispatch({ kind: 'setLevel', owner: 'order', id, role: 'order', price: roundTo(value, this.precision) })
      return true
    }
    this.price = new LevelField({
      role: 'entry',
      label: 'Price',
      withUnits: false,
      onCommit: (text) => void propose(text),
      onStep: (direction, big) => {
        const current = Number(this.price.field.value()) || this.order?.price || 0
        const next = roundTo(current + direction * this.step * (big ? 10 : 1), this.precision)
        if (next > 0 && propose(formatPrice(next, this.precision))) this.price.write(formatPrice(next, this.precision))
      }
    })
    this.stop = new WorkingLevel('stop', 'order', id, dispatch)
    this.target = new WorkingLevel('target', 'order', id, dispatch)
    this.figures = new FigureList()
    const actions = h('div', 'wd-tk-row is-end')
    this.cancel = kbtn('Cancel order', () => {
      if (this.order) dispatch({ kind: 'cancel', order: this.order })
    }, ['danger'])
    actions.append(this.cancel)
    this.detail.append(this.price.element, this.stop.field.element, this.target.field.element, this.figures.element, actions)
    this.element.append(this.main, this.detail)
  }

  update(order: SimOrder, model: CardModel): void {
    this.order = order
    const { ctx } = model
    this.precision = ctx.info.precision
    this.step = priceStep(ctx.info)
    const f = orderFigures(order, ctx)
    const expanded = model.expanded === order.id
    const buy = order.side === 'buy'
    const type = order.type === 'limit' ? 'limit' : 'stop'
    this.element.classList.toggle('is-expanded', expanded)
    this.element.dataset.side = order.side
    this.main.setAttribute('aria-expanded', String(expanded))
    this.badge.textContent = model.compact ? (buy ? 'B' : 'S') : buy ? 'Buy' : 'Sell'
    this.badge.className = `wd-oc-badge is-pending ${buy ? 'is-buy' : 'is-sell'}`
    this.size.textContent = `${type} ${formatUnitsShort(order.units)}`
    this.prices.textContent = `@ ${formatPrice(order.price, ctx.info.precision)}`
    this.distance.textContent = f.distance ? `${moveText(f.distance, false)} away` : '—'
    this.main.title = `${buy ? 'Buy' : 'Sell'} ${type} ${formatUnitsShort(order.units)} ${model.symbol} at ${formatPrice(order.price, ctx.info.precision)}${
      order.label ? ` — ${order.label}` : ''
    }`

    this.detail.hidden = !expanded
    if (!expanded) return
    const distance = order.price !== null ? restingDistance(order.side, order.price, ctx.quote, ctx.info) : null
    this.price.update({
      text: formatPrice(order.price, ctx.info.precision),
      placeholder: 'price',
      readout: distance ? [{ text: distance, tone: '' }] : [],
      presets: [],
      removable: false,
      problem: null,
      pending: pendingOn(model, 'order', order.id, 'order')
    })
    const working: Working = {
      owner: 'order',
      id: order.id,
      basis: { side: order.side, entry: order.price, units: order.units, ctx },
      stop: order.stopLoss,
      target: order.takeProfit
    }
    this.stop.update(working, model)
    this.target.update(working, model)
    this.figures.update(workingRows(order.units, ctx, f.rewardToRisk, { label: 'Placed', value: formatInstant(order.createdAt) }, order.label))
    const armed = model.armed === armKey.cancel(order.id)
    this.cancel.textContent = armed ? 'Confirm cancel' : 'Cancel order'
    this.cancel.classList.toggle('is-armed', armed)
  }
}
