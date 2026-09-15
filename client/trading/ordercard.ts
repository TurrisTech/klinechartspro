import type { SimOrder, SimTrade } from './api'
import {
  formatInstant,
  formatLots,
  formatMoney,
  formatPercent,
  formatPips,
  formatPrice,
  formatUnits,
  formatUnitsShort
} from './format'
import type { DraftOrder } from './lines'
import {
  closingPrice,
  type Outcome,
  orderFigures,
  type PricingContext,
  positionSummary,
  outcome,
  protectionValid,
  quoteToAccountRate,
  rewardToRisk,
  sizeFigures,
  tradeFigures
} from './metrics'

// The order card: the collapsible widget in the candle pane's lower left that lists what is
// working on the pane's instrument -- every open trade and pending order -- with the forex
// figures behind each and the actions that manage them. Rolled up, its header still answers the
// question it is open for: how many are working, and what they are making.
//
// Plain DOM like the rest of client/trading. Elements are built ONCE per trade or order and
// updated in place on every snapshot, because a paper session notifies every two seconds: a
// card rebuilt on each poll would drop keyboard focus and a half-finished hover every time.
//
// It knows nothing about the chart. Every gesture goes out as a `CardAction` to the layer
// (onchart.ts), which owns confirmation, the session call and the error.

export type CardAction =
  | { kind: 'toggle' }
  | { kind: 'select'; id: string }
  | { kind: 'close'; trade: SimTrade; units?: number }
  | { kind: 'breakeven'; trade: SimTrade }
  | { kind: 'cancel'; order: SimOrder }
  | { kind: 'protect'; owner: 'trade' | 'order'; id: string; role: 'stop' | 'target' }
  | { kind: 'unprotect'; owner: 'trade' | 'order'; id: string; role: 'stop' | 'target' }
  /** The stop at `riskPercent` of the balance; the target at `rewardRatio` times the stop. */
  | { kind: 'riskStop'; owner: 'trade' | 'order'; id: string }
  | { kind: 'rewardTarget'; owner: 'trade' | 'order'; id: string }
  | { kind: 'flatten' }
  /** The ticket's draft: add a level, clear one, apply a preset, or place it. */
  | { kind: 'draftProtect'; role: 'stop' | 'target' }
  | { kind: 'draftClear'; role: 'entry' | 'stop' | 'target' }
  | { kind: 'draftPreset'; role: 'stop' | 'target' }
  | { kind: 'draftPlace' }
  | { kind: 'draftDiscard' }

export interface CardModel {
  symbol: string
  ctx: PricingContext
  trades: SimTrade[]
  orders: SimOrder[]
  collapsed: boolean
  compact: boolean
  /** The row shown with its details: the selection, or the only entry there is. */
  expanded: string | null
  /** The action key waiting for its confirming second press ('close:t1', 'flatten'). */
  armed: string | null
  /** The shared presets behind the "Risk N%" and "NR" buttons (prefs.ts). */
  riskPercent: number
  rewardRatio: number
  /** The order being written in the ticket, when it is for this instrument. */
  draft: DraftOrder | null
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = '',
  text?: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function btn(className: string, text: string, onClick: () => void, label?: string): HTMLButtonElement {
  const b = h('button', className, text)
  b.type = 'button'
  if (label) {
    b.setAttribute('aria-label', label)
    b.title = label
  }
  b.addEventListener('click', (event) => {
    event.stopPropagation()
    onClick()
  })
  return b
}

function tone(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value) || value === 0) return ''
  return value > 0 ? 'is-up' : 'is-down'
}

function setTone(node: HTMLElement, value: number | null | undefined): void {
  node.classList.toggle('is-up', tone(value) === 'is-up')
  node.classList.toggle('is-down', tone(value) === 'is-down')
}

/** A move in pips, or in percent for an instrument not priced in pips. */
export function moveText(outcome: Pick<Outcome, 'pips' | 'percent'> | null, signed = true): string {
  if (!outcome) return '—'
  if (outcome.pips !== null) {
    return signed ? `${formatPips(outcome.pips)}p` : `${Math.abs(outcome.pips).toFixed(1)}p`
  }
  return signed ? formatPercent(outcome.percent) : `${Math.abs(outcome.percent).toFixed(2)}%`
}

/** An amount in the quote currency, then -- only where it differs and converts exactly -- the
 * account-currency figure. */
function amountText(
  amount: number | null,
  accountAmount: number | null,
  ctx: PricingContext,
  signed = true
): string {
  if (amount === null) return '—'
  const quote = ctx.currencies.quote
  const main = formatMoney(amount, quote, signed)
  if (quote === ctx.account.currency || accountAmount === null) return main
  return `${main} ≈ ${formatMoney(accountAmount, ctx.account.currency, signed)}`
}

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
  private readonly flattenButton: HTMLButtonElement
  private readonly errorNode: HTMLElement
  private readonly rows = new Map<string, TradeRow | OrderRow>()
  private readonly draftRow: DraftRow
  private flashTimer: ReturnType<typeof setTimeout> | null = null
  private errorTimer: ReturnType<typeof setTimeout> | null = null
  private flashing = false
  private empty = true

  constructor(private readonly dispatch: (action: CardAction) => void) {
    this.element = h('section', 'wd-oc-card')
    this.element.setAttribute('aria-label', 'Working orders')

    const head = h('div', 'wd-oc-card-head')
    this.toggle = btn('wd-oc-card-toggle', '', () => dispatch({ kind: 'toggle' }))
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
    this.flattenButton = btn('wd-oc-btn is-danger', 'Flatten', () => dispatch({ kind: 'flatten' }))
    this.foot.append(this.footText, this.flattenButton)
    this.errorNode = h('div', 'wd-oc-card-error')
    this.errorNode.setAttribute('role', 'alert')
    this.errorNode.hidden = true
    this.draftRow = new DraftRow(dispatch)
    this.body.append(this.draftRow.element, this.list, this.foot, this.errorNode)

    this.element.append(head, this.body)
    this.element.hidden = true
  }

  render(model: CardModel): void {
    const { trades, orders, ctx } = model
    this.empty = trades.length === 0 && orders.length === 0 && model.draft === null
    this.element.hidden = this.empty && !this.flashing
    this.element.classList.toggle('is-collapsed', model.collapsed)
    this.element.classList.toggle('is-empty', this.empty)
    this.toggle.setAttribute('aria-expanded', String(!model.collapsed))
    this.toggle.title = model.collapsed ? 'Show working orders' : 'Hide working orders'

    // Header: instrument, what is working, and the open P&L -- in the quote currency, which is
    // uniform across one instrument, so the sum is exact.
    const summary = positionSummary(trades, orders, ctx)
    this.symbol.textContent = model.symbol
    const parts: string[] = []
    if (trades.length > 0) parts.push(model.compact ? `${trades.length} pos` : `${trades.length} open`)
    if (orders.length > 0) {
      parts.push(model.compact ? `${orders.length} ord` : `${orders.length} order${orders.length === 1 ? '' : 's'}`)
    }
    if (model.draft) parts.push('draft')
    this.count.textContent = parts.join(' · ')
    this.count.hidden = parts.length === 0
    if (summary.pnlAccount !== null || trades.length > 0) {
      this.pnl.textContent = formatMoney(summary.pnl, model.compact ? '' : ctx.currencies.quote)
      setTone(this.pnl, summary.pnl)
      this.pnl.hidden = false
    } else {
      this.pnl.hidden = true
    }

    this.draftRow.element.hidden = model.draft === null
    if (model.draft) this.draftRow.update(model.draft, model)

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
      this.footText.classList.toggle('is-warning', trades.length > 0 && summary.riskAtStops === null)
      const armed = model.armed === 'flatten'
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

// -- rows ------------------------------------------------------------------------------------------

/** One "Stop" / "Target" line of a row's details, with its add/remove control. */
class LevelLine {
  readonly element: HTMLElement
  private readonly price: HTMLElement
  private readonly move: HTMLElement
  private readonly amount: HTMLElement
  private readonly extra: HTMLElement
  readonly preset: HTMLButtonElement
  readonly add: HTMLButtonElement
  readonly remove: HTMLButtonElement

  constructor(role: 'stop' | 'target', onAdd: () => void, onRemove: () => void, onPreset: () => void) {
    this.element = h('div', `wd-oc-level is-${role}`)
    const label = h('span', 'wd-oc-level-label', role === 'stop' ? 'Stop' : 'Target')
    const figures = h('span', 'wd-oc-level-figures')
    this.price = h('span', 'wd-oc-level-price')
    this.move = h('span', 'wd-oc-level-move')
    this.amount = h('span', 'wd-oc-level-amount')
    this.extra = h('span', 'wd-oc-level-extra')
    figures.append(this.price, this.move, this.amount, this.extra)
    const name = role === 'stop' ? 'stop loss' : 'take profit'
    this.preset = btn('wd-oc-btn wd-oc-preset', '', onPreset)
    this.add = btn('wd-oc-btn', '+ Add', onAdd, `Add a ${name}`)
    this.remove = btn('wd-oc-btn wd-oc-icon', '×', onRemove, `Remove the ${name}`)
    this.element.append(label, figures, this.preset, this.add, this.remove)
  }

  /** The preset button: its label, and the reason it cannot be used (null when it can). */
  setPreset(text: string, title: string, refusal: string | null): void {
    this.preset.textContent = text
    this.preset.disabled = refusal !== null
    this.preset.title = refusal ?? title
    this.preset.setAttribute('aria-label', refusal ? `${title} (${refusal})` : title)
  }

  update(outcome: Outcome | null, ctx: PricingContext, extra: string): void {
    const set = outcome !== null
    this.add.hidden = set
    this.remove.hidden = !set
    this.price.textContent = set ? formatPrice(outcome.price, ctx.info.precision) : 'none'
    this.element.classList.toggle('is-unset', !set)
    this.move.textContent = set ? moveText(outcome) : ''
    this.amount.textContent = set ? amountText(outcome.amount, outcome.amountAccount, ctx) : ''
    setTone(this.move, outcome?.amount)
    setTone(this.amount, outcome?.amount)
    this.extra.textContent = extra
    this.extra.hidden = extra === ''
  }
}

/** The order still being written in the ticket: always open, since it is what is being worked
 * on, with what it would risk and make, and Place. Nothing here is sent until Place is pressed
 * twice -- a second press, as for close and flatten, because the chart is an easy place to press
 * by accident. */
class DraftRow {
  readonly element: HTMLElement
  private readonly badge: HTMLElement
  private readonly size: HTMLElement
  private readonly prices: HTMLElement
  private readonly ratio: HTMLElement
  private readonly stop: LevelLine
  private readonly target: LevelLine
  private readonly units: { element: HTMLElement; value: HTMLElement }
  private readonly margin: { element: HTMLElement; value: HTMLElement }
  private readonly problem: HTMLElement
  private readonly discard: HTMLButtonElement
  private readonly placeButton: HTMLButtonElement

  constructor(dispatch: (action: CardAction) => void) {
    this.element = h('div', 'wd-oc-row is-draft is-expanded')
    const main = h('div', 'wd-oc-row-main')
    this.badge = h('span', 'wd-oc-badge is-pending', 'Draft')
    this.size = h('span', 'wd-oc-row-size')
    this.prices = h('span', 'wd-oc-row-prices')
    this.ratio = h('span', 'wd-oc-row-pips')
    main.append(this.badge, this.size, this.prices, this.ratio)
    const detail = h('div', 'wd-oc-row-detail')
    this.stop = new LevelLine(
      'stop',
      () => dispatch({ kind: 'draftProtect', role: 'stop' }),
      () => dispatch({ kind: 'draftClear', role: 'stop' }),
      () => dispatch({ kind: 'draftPreset', role: 'stop' })
    )
    this.target = new LevelLine(
      'target',
      () => dispatch({ kind: 'draftProtect', role: 'target' }),
      () => dispatch({ kind: 'draftClear', role: 'target' }),
      () => dispatch({ kind: 'draftPreset', role: 'target' })
    )
    const grid = h('div', 'wd-oc-kvs')
    this.units = keyValue('Size')
    this.margin = keyValue('Margin')
    grid.append(this.units.element, this.margin.element)
    this.problem = h('div', 'wd-oc-draft-problem')
    const actions = h('div', 'wd-oc-actions')
    this.discard = btn('wd-oc-btn', 'Discard', () => dispatch({ kind: 'draftDiscard' }))
    this.discard.title = 'Clear the draft: back to a market order with no stop or target'
    this.placeButton = btn('wd-oc-btn is-primary', 'Place', () => dispatch({ kind: 'draftPlace' }))
    actions.append(this.discard, this.placeButton)
    detail.append(this.stop.element, this.target.element, grid, this.problem, actions)
    this.element.append(main, detail)
  }

  update(draft: DraftOrder, model: CardModel): void {
    const { ctx } = model
    const buy = draft.side === 'buy'
    const precision = ctx.info.precision
    this.element.dataset.side = draft.side
    this.badge.className = `wd-oc-badge is-pending ${buy ? 'is-buy' : 'is-sell'}`
    this.size.textContent = `${buy ? 'Buy' : 'Sell'} ${draft.type} ${draft.units !== null ? formatUnitsShort(draft.units) : '—'}`
    this.prices.textContent = `@ ${formatPrice(draft.entry, precision)}`
    const at = (price: number | null): Outcome | null =>
      price === null || draft.units === null ? null : outcome(draft.side, draft.units, draft.entry, price, ctx)
    const stop = at(draft.stop)
    const target = at(draft.target)
    const rr = rewardToRisk(stop, target)
    this.ratio.textContent = rr !== null ? `R:R ${rr.toFixed(2)}` : ''

    const ofBalance = stop?.ofBalance ?? null
    this.stop.update(stop, ctx, ofBalance !== null ? `${formatPercent(ofBalance)} of balance` : '')
    this.target.update(target, ctx, rr !== null ? `R:R ${rr.toFixed(2)}` : '')
    // A level with no size (the size comes from a stop that is not set yet) still shows its price.
    if (draft.stop !== null && !stop) this.stop.update(null, ctx, formatPrice(draft.stop, precision))
    if (draft.target !== null && !target) this.target.update(null, ctx, formatPrice(draft.target, precision))
    const risk = `${Number(model.riskPercent.toFixed(2))}%`
    this.stop.setPreset(
      `Risk ${risk}`,
      `Put the stop where it loses ${risk} of the balance`,
      draft.riskPercent !== null
        ? 'the size already comes from the risk'
        : quoteToAccountRate(ctx) === null
          ? `no ${ctx.account.currency} rate for ${ctx.currencies.quote}`
          : null
    )
    const ratio = `${Number(model.rewardRatio.toFixed(2))}R`
    this.target.setPreset(
      ratio,
      `Put the target at ${ratio}: ${Number(model.rewardRatio.toFixed(2))}× the stop's distance`,
      draft.stop === null ? 'set a stop loss first' : !protectionValid(draft.side, 'stop', draft.stop, draft.entry) ? 'the stop is past the entry' : null
    )

    const size = draft.units !== null ? sizeFigures(draft.units, ctx) : null
    this.units.value.textContent =
      draft.units === null
        ? '—'
        : `${formatUnits(draft.units)}${size?.lots != null ? ` · ${formatLots(size.lots)}` : ''}${draft.riskPercent !== null ? ` · ${Number(draft.riskPercent.toFixed(2))}% risk` : ''}`
    this.margin.element.hidden = size?.margin == null
    this.margin.value.textContent = formatMoney(size?.margin ?? null, ctx.account.currency, false)
    this.problem.textContent = draft.problem ?? ''
    this.problem.hidden = draft.problem === null
    this.discard.hidden = draft.type === 'market' && draft.stop === null && draft.target === null
    const armed = model.armed === 'place'
    this.placeButton.disabled = draft.problem !== null
    this.placeButton.title = draft.problem ?? ''
    this.placeButton.textContent = armed ? 'Confirm' : `Place ${buy ? 'buy' : 'sell'} ${draft.type}`
    this.placeButton.classList.toggle('is-armed', armed)
  }
}

/** The "Risk N%" and "NR" buttons. What they would do is priced by the layer when pressed;
 * here only whether they can: a stop from a share of the balance needs a conversion to the account
 * currency, and a target as a multiple of the risk needs a stop that is a loss. */
function presets(stop: LevelLine, target: LevelLine, stopOutcome: Outcome | null, model: CardModel): void {
  const { riskPercent, rewardRatio, ctx } = model
  const risk = `${Number(riskPercent.toFixed(2))}%`
  stop.setPreset(
    `Risk ${risk}`,
    `Put the stop where it loses ${risk} of the balance`,
    quoteToAccountRate(ctx) === null ? `no ${ctx.account.currency} rate for ${ctx.currencies.quote}` : null
  )
  const ratio = `${Number(rewardRatio.toFixed(2))}R`
  target.setPreset(
    ratio,
    `Put the target at ${ratio}: ${Number(rewardRatio.toFixed(2))}× the stop's distance`,
    !stopOutcome ? 'set a stop loss first' : stopOutcome.amount >= 0 ? 'the stop is past the entry and risks nothing' : null
  )
}

function keyValue(label: string): { element: HTMLElement; value: HTMLElement } {
  const element = h('div', 'wd-oc-kv')
  const value = h('span', 'wd-oc-kv-value')
  element.append(h('span', 'wd-oc-kv-label', label), value)
  return { element, value }
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
  private readonly stop: LevelLine
  private readonly target: LevelLine
  private readonly units: { element: HTMLElement; value: HTMLElement }
  private readonly pipValue: { element: HTMLElement; value: HTMLElement }
  private readonly margin: { element: HTMLElement; value: HTMLElement }
  private readonly opened: { element: HTMLElement; value: HTMLElement }
  private readonly breakeven: HTMLButtonElement
  private readonly half: HTMLButtonElement
  private readonly close: HTMLButtonElement
  private trade: SimTrade | null = null

  constructor(
    readonly id: string,
    dispatch: (action: CardAction) => void
  ) {
    const withTrade = (fn: (trade: SimTrade) => void) => () => {
      if (this.trade) fn(this.trade)
    }
    this.element = h('div', 'wd-oc-row')
    this.element.setAttribute('role', 'listitem')
    this.main = btn('wd-oc-row-main', '', () => dispatch({ kind: 'select', id }))
    this.badge = h('span', 'wd-oc-badge')
    this.size = h('span', 'wd-oc-row-size')
    this.prices = h('span', 'wd-oc-row-prices')
    this.pips = h('span', 'wd-oc-row-pips')
    this.pnl = h('span', 'wd-oc-row-pnl')
    this.main.append(this.badge, this.size, this.prices, this.pips, this.pnl)

    this.detail = h('div', 'wd-oc-row-detail')
    this.stop = new LevelLine(
      'stop',
      () => dispatch({ kind: 'protect', owner: 'trade', id, role: 'stop' }),
      () => dispatch({ kind: 'unprotect', owner: 'trade', id, role: 'stop' }),
      () => dispatch({ kind: 'riskStop', owner: 'trade', id })
    )
    this.target = new LevelLine(
      'target',
      () => dispatch({ kind: 'protect', owner: 'trade', id, role: 'target' }),
      () => dispatch({ kind: 'unprotect', owner: 'trade', id, role: 'target' }),
      () => dispatch({ kind: 'rewardTarget', owner: 'trade', id })
    )
    const grid = h('div', 'wd-oc-kvs')
    this.units = keyValue('Size')
    this.pipValue = keyValue('Pip value')
    this.margin = keyValue('Margin')
    this.opened = keyValue('Opened')
    grid.append(this.units.element, this.pipValue.element, this.margin.element, this.opened.element)
    const actions = h('div', 'wd-oc-actions')
    this.breakeven = btn('wd-oc-btn', 'Breakeven', withTrade((trade) => dispatch({ kind: 'breakeven', trade })))
    this.half = btn('wd-oc-btn', 'Close ½', withTrade((trade) => dispatch({ kind: 'close', trade, units: Math.floor(trade.units / 2) })))
    this.close = btn('wd-oc-btn is-danger', 'Close', withTrade((trade) => dispatch({ kind: 'close', trade })))
    actions.append(this.breakeven, this.half, this.close)
    this.detail.append(this.stop.element, this.target.element, grid, actions)
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
    this.main.title = `${long ? 'Long' : 'Short'} ${formatUnits(trade.units)} ${model.symbol} from ${formatPrice(trade.entryPrice, ctx.info.precision)}${
      f.pnl ? `, ${amountText(f.pnl.amount, f.pnl.amountAccount, ctx)}` : ''
    }`

    this.detail.hidden = !expanded
    if (!expanded) return
    const ofBalance = f.stop?.ofBalance ?? null
    const stopExtra = ofBalance !== null ? `${formatPercent(ofBalance)} of balance` : ''
    const targetExtra = f.rewardToRisk !== null ? `R:R ${f.rewardToRisk.toFixed(2)}` : ''
    this.stop.update(f.stop, ctx, stopExtra)
    this.target.update(f.target, ctx, targetExtra)
    presets(this.stop, this.target, f.stop, model)
    this.units.value.textContent = f.lots !== null ? `${formatUnits(trade.units)} · ${formatLots(f.lots)}` : formatUnits(trade.units)
    this.pipValue.element.hidden = f.pipValue === null
    this.pipValue.value.textContent = amountText(f.pipValue, f.pipValueAccount, ctx, false)
    this.margin.element.hidden = f.margin === null
    this.margin.value.textContent = formatMoney(f.margin, ctx.account.currency, false)
    this.opened.value.textContent = formatInstant(trade.openedAt)

    // Breakeven: the stop moved to the entry, which the engine accepts only once the market is
    // past the entry in the trade's favour.
    const mark = closingPrice(trade.side, ctx.quote)
    const canBreakeven =
      mark !== null && trade.stopLoss !== trade.entryPrice && protectionValid(trade.side, 'stop', trade.entryPrice, mark)
    this.breakeven.disabled = !canBreakeven
    this.breakeven.title = canBreakeven
      ? `Move the stop to the entry, ${formatPrice(trade.entryPrice, ctx.info.precision)}`
      : trade.stopLoss === trade.entryPrice
        ? 'The stop is already at the entry'
        : 'Available once the price is past the entry in your favour'
    this.half.hidden = trade.units < 2
    const armedClose = model.armed === `close:${trade.id}`
    this.close.textContent = armedClose ? 'Confirm close' : 'Close'
    this.close.classList.toggle('is-armed', armedClose)
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
  private readonly stop: LevelLine
  private readonly target: LevelLine
  private readonly units: { element: HTMLElement; value: HTMLElement }
  private readonly pipValue: { element: HTMLElement; value: HTMLElement }
  private readonly margin: { element: HTMLElement; value: HTMLElement }
  private readonly placed: { element: HTMLElement; value: HTMLElement }
  private readonly cancel: HTMLButtonElement
  private order: SimOrder | null = null

  constructor(
    readonly id: string,
    dispatch: (action: CardAction) => void
  ) {
    this.element = h('div', 'wd-oc-row is-pending')
    this.element.setAttribute('role', 'listitem')
    this.main = btn('wd-oc-row-main', '', () => dispatch({ kind: 'select', id }))
    this.badge = h('span', 'wd-oc-badge')
    this.size = h('span', 'wd-oc-row-size')
    this.prices = h('span', 'wd-oc-row-prices')
    this.distance = h('span', 'wd-oc-row-pips')
    this.main.append(this.badge, this.size, this.prices, this.distance)

    this.detail = h('div', 'wd-oc-row-detail')
    this.stop = new LevelLine(
      'stop',
      () => dispatch({ kind: 'protect', owner: 'order', id, role: 'stop' }),
      () => dispatch({ kind: 'unprotect', owner: 'order', id, role: 'stop' }),
      () => dispatch({ kind: 'riskStop', owner: 'order', id })
    )
    this.target = new LevelLine(
      'target',
      () => dispatch({ kind: 'protect', owner: 'order', id, role: 'target' }),
      () => dispatch({ kind: 'unprotect', owner: 'order', id, role: 'target' }),
      () => dispatch({ kind: 'rewardTarget', owner: 'order', id })
    )
    const grid = h('div', 'wd-oc-kvs')
    this.units = keyValue('Size')
    this.pipValue = keyValue('Pip value')
    this.margin = keyValue('Margin')
    this.placed = keyValue('Placed')
    grid.append(this.units.element, this.pipValue.element, this.margin.element, this.placed.element)
    const actions = h('div', 'wd-oc-actions')
    this.cancel = btn('wd-oc-btn is-danger', 'Cancel order', () => {
      if (this.order) dispatch({ kind: 'cancel', order: this.order })
    })
    actions.append(this.cancel)
    this.detail.append(this.stop.element, this.target.element, grid, actions)
    this.element.append(this.main, this.detail)
  }

  update(order: SimOrder, model: CardModel): void {
    this.order = order
    const { ctx } = model
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
    this.main.title = `${buy ? 'Buy' : 'Sell'} ${type} ${formatUnits(order.units)} ${model.symbol} at ${formatPrice(order.price, ctx.info.precision)}`

    this.detail.hidden = !expanded
    if (!expanded) return
    const ofBalance = f.stop?.ofBalance ?? null
    const stopExtra = ofBalance !== null ? `${formatPercent(ofBalance)} of balance` : ''
    const targetExtra = f.rewardToRisk !== null ? `R:R ${f.rewardToRisk.toFixed(2)}` : ''
    this.stop.update(f.stop, ctx, stopExtra)
    this.target.update(f.target, ctx, targetExtra)
    presets(this.stop, this.target, f.stop, model)
    this.units.value.textContent = f.lots !== null ? `${formatUnits(order.units)} · ${formatLots(f.lots)}` : formatUnits(order.units)
    this.pipValue.element.hidden = f.pipValue === null
    this.pipValue.value.textContent = amountText(f.pipValue, f.pipValueAccount, ctx, false)
    this.margin.element.hidden = f.margin === null
    this.margin.value.textContent = formatMoney(f.margin, ctx.account.currency, false)
    this.placed.value.textContent = formatInstant(order.createdAt)
  }
}
