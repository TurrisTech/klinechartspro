import type { SymbolInfo } from '../../src'
import { OhlcvApiError } from '../config'
import type { SimOrderType, SimSide } from './api'
import { formatLots, formatMoney, formatPercent, formatPrice, formatUnits, sideLabel, symbolKey, toPips } from './format'
import type { InstrumentInfo } from './instrument'
import type { DraftController, DraftOrder } from './lines'
import {
  fillingPrice,
  levelForBalancePercent,
  outcome,
  type PricingContext,
  pricingContext,
  protectionValid,
  quoteToAccountRate,
  roundTo,
  sizeFigures,
  targetForReward,
  unitsForRisk
} from './metrics'
import { type ProtectMode, setTradePrefs, subscribeTradePrefs, tradePrefs } from './prefs'
import type { TradingSession } from './session'

// The order ticket. Side, type, size, price, stop and target -- and what they add up to before
// anything is sent.
//
// SIZE is units, or RISK %: the units that lose that share of the balance if the stop is hit,
// floored so the loss never exceeds it. A stop and a target are stated in PIPS (forex), as a
// PRICE, or as a PERCENT of the balance lost or made -- the last needs a size, so it is not
// offered while the size itself comes from the risk. 1R/2R/3R put the target at that multiple of
// the stop's distance. Switching how a level is stated converts what was typed rather than
// reinterpreting the digits.
//
// The summary line under the fields is the order as it would be sent: units and lots, margin,
// the loss at the stop and the gain at the target (with their share of the balance), and R:R --
// or the reason it cannot be sent yet.
//
// ON THE CHART the order being written is a DRAFT (`draft()`), which the trading layer draws on
// the instrument's panes while the account window is open. Dragging its lines calls `setLevel`,
// which writes the new price back into these fields in whatever way they are stated -- so the
// ticket stays the one place the order lives, and the chart and the fields cannot disagree.
//
// BUILT ONCE and updated in place. The panel re-renders on every session notification, which is
// every two seconds while anything is working; a ticket rebuilt each time took the focus (and a
// half-typed price) away from whoever was typing in it.

export interface TicketContext {
  activeSymbol: () => SymbolInfo
  instrumentFor: (key: string) => InstrumentInfo
}

const REWARD_RATIOS = [1, 2, 3]

interface Plan {
  units: number | null
  entry: number | null
  price: number | undefined
  stop: number | undefined
  target: number | undefined
  /** Why it cannot be sent as it stands; null when it can. */
  problem: string | null
  ctx: PricingContext
}

interface Field {
  element: HTMLElement
  label: HTMLElement
  input: HTMLInputElement
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  node.className = className
  if (text !== undefined) node.textContent = text
  return node
}

function button(className: string, text: string, onClick: () => void): HTMLButtonElement {
  const b = el('button', className, text)
  b.type = 'button'
  b.addEventListener('click', onClick)
  return b
}

function field(label: string, onInput: (value: string) => void, cls = ''): Field {
  const element = el('label', `wd-trade-field ${cls}`)
  const labelNode = el('span', 'wd-trade-field-label', label)
  const input = el('input', 'kc-input wd-trade-input')
  input.type = 'text'
  input.inputMode = 'decimal'
  input.autocomplete = 'off'
  input.addEventListener('input', () => onInput(input.value))
  element.append(labelNode, input)
  return { element, label: labelNode, input }
}

/** A segmented control whose active option is re-read on every refresh. */
class Segmented<T extends string> {
  readonly element: HTMLElement
  private readonly buttons = new Map<T, HTMLButtonElement>()

  constructor(options: Array<[T, string]>, onPick: (value: T) => void, classes: Partial<Record<T, string>> = {}) {
    this.element = el('div', 'wd-trade-segmented')
    for (const [value, text] of options) {
      const b = button(`wd-trade-seg ${classes[value] ?? ''}`, text, () => onPick(value))
      this.buttons.set(value, b)
      this.element.appendChild(b)
    }
  }

  set(active: T, disabled: Partial<Record<T, string>> = {}): void {
    for (const [value, b] of this.buttons) {
      b.classList.toggle('is-active', value === active)
      const reason = disabled[value]
      b.disabled = reason !== undefined
      b.title = reason ?? ''
    }
  }
}

export class OrderTicket implements DraftController {
  readonly element: HTMLElement
  private type: SimOrderType = 'market'
  private side: SimSide = 'buy'
  private price = ''
  private stopLoss = ''
  private takeProfit = ''
  private error = ''
  private symbol: SymbolInfo
  private key: string

  private readonly symbolNode: HTMLElement
  private readonly quoteNode: HTMLElement
  private readonly sideControl: Segmented<SimSide>
  private readonly typeControl: Segmented<SimOrderType>
  private readonly sizeControl: Segmented<'units' | 'risk'>
  private readonly unitsField: Field
  private readonly riskField: Field
  private readonly priceField: Field
  private readonly stopField: Field
  private readonly targetField: Field
  private readonly ratioRow: HTMLElement
  private readonly ratioButtons: HTMLButtonElement[] = []
  private readonly modeRow: HTMLElement
  private readonly modeControl: Segmented<ProtectMode>
  private readonly summary: HTMLElement
  private readonly errorNode: HTMLElement
  private readonly submitButton: HTMLButtonElement
  private readonly unsubscribe: () => void
  private draftListener: (() => void) | null = null

  constructor(
    private readonly session: TradingSession,
    private readonly ctx: TicketContext
  ) {
    this.symbol = ctx.activeSymbol()
    this.key = symbolKey(this.symbol)
    this.element = el('div', 'wd-trade-ticket')

    const head = el('div', 'wd-trade-ticket-head')
    this.symbolNode = el('span', 'wd-trade-ticket-symbol')
    this.quoteNode = el('span', 'wd-trade-ticket-quote')
    head.append(this.symbolNode, this.quoteNode)

    const controls = el('div', 'wd-trade-ticket-row')
    this.sideControl = new Segmented<SimSide>(
      [
        ['buy', 'Buy'],
        ['sell', 'Sell']
      ],
      (v) => this.change(() => (this.side = v)),
      { buy: 'wd-trade-buy', sell: 'wd-trade-sell' }
    )
    this.typeControl = new Segmented<SimOrderType>(
      [
        ['market', 'Market'],
        ['limit', 'Limit'],
        ['stop', 'Stop']
      ],
      (v) => this.change(() => (this.type = v))
    )
    controls.append(this.sideControl.element, this.typeControl.element)

    // Size: units, or the units a risk budget buys.
    const sizeRow = el('div', 'wd-trade-ticket-mode')
    this.sizeControl = new Segmented<'units' | 'risk'>(
      [
        ['units', 'Units'],
        ['risk', 'Risk %']
      ],
      (v) => this.setSizeMode(v)
    )
    sizeRow.append(el('span', 'wd-trade-field-label', 'Size by'), this.sizeControl.element)

    const fields = el('div', 'wd-trade-ticket-fields')
    this.unitsField = field('Units', (v) => this.change(() => setTradePrefs({ units: Number(v) || tradePrefs().units })), 'wd-trade-units')
    this.riskField = field('Risk (% of balance)', (v) => {
      const n = Number(v)
      if (n > 0 && n <= 100) setTradePrefs({ riskPercent: n })
      else this.refresh()
    })
    this.priceField = field('Price', (v) => this.change(() => (this.price = v)))
    this.stopField = field('Stop loss', (v) => this.change(() => (this.stopLoss = v)))
    this.targetField = field('Take profit', (v) => this.change(() => (this.takeProfit = v)))
    fields.append(this.unitsField.element, this.riskField.element, this.priceField.element, this.stopField.element, this.targetField.element)

    this.ratioRow = el('div', 'wd-trade-ticket-mode wd-trade-ratios')
    this.ratioRow.appendChild(el('span', 'wd-trade-field-label', 'Target at'))
    for (const ratio of REWARD_RATIOS) {
      const b = button('wd-trade-seg wd-trade-ratio', `${ratio}R`, () => this.targetAtRatio(ratio))
      b.title = `Take profit at ${ratio}× the stop's distance`
      this.ratioButtons.push(b)
      this.ratioRow.appendChild(b)
    }

    this.modeRow = el('div', 'wd-trade-ticket-mode')
    this.modeControl = new Segmented<ProtectMode>(
      [
        ['pips', 'Pips'],
        ['price', 'Price'],
        ['percent', '% bal']
      ],
      (v) => this.setProtectMode(v)
    )
    this.modeRow.append(el('span', 'wd-trade-field-label', 'SL / TP as'), this.modeControl.element)

    this.summary = el('div', 'wd-trade-ticket-summary')
    this.summary.setAttribute('aria-live', 'polite')
    this.errorNode = el('div', 'kc-field-error wd-trade-ticket-error')
    this.submitButton = button('kc-button kc-button-primary wd-trade-submit', '', () => void this.submit().catch(() => {}))

    this.element.append(head, controls, sizeRow, fields, this.ratioRow, this.modeRow, this.summary, this.errorNode, this.submitButton)
    this.unitsField.input.value = String(tradePrefs().units)
    this.riskField.input.value = String(tradePrefs().riskPercent)
    // Another tab, or the card, changed a shared number: show it unless it is being typed here.
    this.unsubscribe = subscribeTradePrefs((prefs) => {
      if (document.activeElement !== this.unitsField.input) this.unitsField.input.value = String(prefs.units)
      if (document.activeElement !== this.riskField.input) this.riskField.input.value = String(prefs.riskPercent)
      this.refresh()
    })
    this.refresh()
  }

  // -- the draft ------------------------------------------------------------------------------------

  /** Told after every change that can move the draft: a keystroke, a mode, a quote, a drag. */
  onDraftChange(listener: () => void): void {
    this.draftListener = listener
  }

  draft(): DraftOrder | null {
    const plan = this.plan()
    if (plan.entry === null || !this.session.ready) return null
    const prefs = tradePrefs()
    return {
      symbol: this.key,
      side: this.side,
      type: this.type,
      units: plan.units,
      entry: plan.entry,
      stop: plan.stop ?? null,
      target: plan.target ?? null,
      problem: plan.problem,
      riskPercent: prefs.sizeMode === 'risk' ? prefs.riskPercent : null
    }
  }

  setLevel(role: 'entry' | 'stop' | 'target', price: number): void {
    const info = this.info()
    if (role === 'entry') {
      const fill = fillingPrice(this.side, this.session.snapshot.quotes[this.key])
      if (fill === null) return
      const rounded = roundTo(price, info.precision)
      // A buy below the ask waits for the price to come down (limit); above it, for the price to
      // break up (stop). A sell the mirror. At the market it is a market order again.
      const below = rounded < fill
      this.type = rounded === fill ? 'market' : this.side === 'buy' ? (below ? 'limit' : 'stop') : below ? 'stop' : 'limit'
      this.price = this.type === 'market' ? '' : formatPrice(rounded, info.precision)
      this.priceField.input.value = this.price
    } else {
      const text = this.express(price, this.protectMode(), this.plan())
      if (role === 'stop') {
        this.stopLoss = text
        this.stopField.input.value = text
      } else {
        this.takeProfit = text
        this.targetField.input.value = text
      }
    }
    this.error = ''
    this.refresh()
  }

  clearLevel(role: 'entry' | 'stop' | 'target'): void {
    if (role === 'entry') {
      this.type = 'market'
      this.price = ''
      this.priceField.input.value = ''
    } else if (role === 'stop') {
      this.stopLoss = ''
      this.stopField.input.value = ''
    } else {
      this.takeProfit = ''
      this.targetField.input.value = ''
    }
    this.error = ''
    this.refresh()
  }

  place(): Promise<void> {
    return this.submit()
  }

  syncInstrument(): void {
    this.symbol = this.ctx.activeSymbol()
    this.key = symbolKey(this.symbol)
    void this.session.watch(this.key).catch(() => {})
    this.refresh()
  }

  showError(message: string): void {
    this.error = message
    this.refresh()
  }

  /** The panel's re-render: new quotes, a new balance. Never touches what is being typed. */
  render(): void {
    this.refresh()
  }

  private change(apply: () => void): void {
    apply()
    this.error = ''
    this.refresh()
  }

  // -- modes --------------------------------------------------------------------------------------

  private info(): InstrumentInfo {
    return this.ctx.instrumentFor(this.key)
  }

  /** The stored mode, or the nearest one this instrument and size mode allow. */
  private protectMode(): ProtectMode {
    const { protectMode, sizeMode } = tradePrefs()
    if (protectMode === 'percent' && sizeMode === 'risk') return this.info().pipSize !== null ? 'pips' : 'price'
    if (protectMode === 'pips' && this.info().pipSize === null) return 'price'
    return protectMode
  }

  private setProtectMode(next: ProtectMode): void {
    const plan = this.plan()
    const from = this.protectMode()
    setTradePrefs({ protectMode: next })
    const to = this.protectMode()
    if (from === to) return
    // Carry what was typed across: the same price, stated the new way.
    if (plan.stop !== undefined) this.stopLoss = this.express(plan.stop, to, plan)
    if (plan.target !== undefined) this.takeProfit = this.express(plan.target, to, plan)
    this.stopField.input.value = this.stopLoss
    this.targetField.input.value = this.takeProfit
    this.refresh()
  }

  private setSizeMode(next: 'units' | 'risk'): void {
    const plan = this.plan()
    // Leaving risk sizing keeps the size it had worked out, rather than jumping back.
    if (next === 'units' && plan.units !== null && plan.units > 0) setTradePrefs({ units: plan.units })
    // Entering it, a stop stated as a share of the balance is re-stated in pips or price first.
    if (next === 'risk' && this.protectMode() === 'percent' && plan.stop !== undefined) {
      const to: ProtectMode = this.info().pipSize !== null ? 'pips' : 'price'
      this.stopLoss = this.express(plan.stop, to, plan)
      if (plan.target !== undefined) this.takeProfit = this.express(plan.target, to, plan)
      this.stopField.input.value = this.stopLoss
      this.targetField.input.value = this.takeProfit
    }
    setTradePrefs({ sizeMode: next })
  }

  private targetAtRatio(ratio: number): void {
    const plan = this.plan()
    if (plan.entry === null || plan.stop === undefined) return
    const target = targetForReward(this.side, plan.entry, plan.stop, ratio, this.info().precision)
    if (target === null) return
    this.takeProfit = this.express(target, this.protectMode(), plan)
    this.targetField.input.value = this.takeProfit
    this.error = ''
    setTradePrefs({ rewardRatio: ratio })
  }

  // -- the order as it would be sent --------------------------------------------------------------

  private below(role: 'stop' | 'target'): boolean {
    return role === 'stop' ? this.side === 'buy' : this.side === 'sell'
  }

  /** A price, stated in `mode` for the field: pips from the entry, a price, or the share of the
   * balance that price would lose or make at the planned size. */
  private express(price: number, mode: ProtectMode, plan: Plan): string {
    const info = this.info()
    if (mode === 'price' || plan.entry === null) return formatPrice(price, info.precision)
    if (mode === 'pips' && info.pipSize !== null) return (Math.abs(price - plan.entry) / info.pipSize).toFixed(1)
    const o = plan.units ? outcome(this.side, plan.units, plan.entry, price, plan.ctx) : null
    if (o?.ofBalance === null || o?.ofBalance === undefined) return formatPrice(price, info.precision)
    return Math.abs(o.ofBalance).toFixed(2)
  }

  /** A field to a price. Throws a sentence when the value cannot become one. */
  private resolve(raw: string, role: 'stop' | 'target', entry: number | null, units: number | null, ctx: PricingContext): number | undefined {
    const trimmed = raw.trim()
    if (trimmed === '') return undefined
    const value = Number(trimmed)
    const name = role === 'stop' ? 'stop loss' : 'take profit'
    if (!Number.isFinite(value) || value <= 0) throw new Error(`Invalid ${name}`)
    const mode = this.protectMode()
    const info = this.info()
    if (mode === 'price') return value
    if (entry === null) throw new Error(`No price to measure the ${name} from yet`)
    if (mode === 'pips' && info.pipSize !== null) {
      const off = value * info.pipSize
      return roundTo(this.below(role) ? entry - off : entry + off, info.precision)
    }
    if (units === null || units <= 0) throw new Error(`A ${name} in % of balance needs a size`)
    const level = levelForBalancePercent(this.side, role, units, entry, value, ctx)
    if (level === null) throw new Error(`No ${ctx.account.currency} rate for ${ctx.currencies.quote}, so % of balance cannot be priced`)
    return level
  }

  private plan(): Plan {
    const s = this.session.snapshot
    const info = this.info()
    const quote = s.quotes[this.key]
    const ctx = pricingContext(this.key, info, s.account, quote, s.quotes)
    const prefs = tradePrefs()
    const plan: Plan = { units: null, entry: null, price: undefined, stop: undefined, target: undefined, problem: null, ctx }
    const fail = (problem: string): Plan => {
      plan.problem ??= problem
      return plan
    }

    if (this.type !== 'market') {
      const price = Number(this.price)
      if (this.price.trim() === '' || !Number.isFinite(price) || price <= 0) {
        fail(`A ${this.type} order needs a price`)
      } else {
        plan.price = price
      }
    }
    plan.entry = plan.price ?? fillingPrice(this.side, quote)
    if (!quote) fail('No quote yet')

    try {
      if (prefs.sizeMode === 'risk') {
        // The stop decides the size, so it resolves first, without one.
        plan.stop = this.resolve(this.stopLoss, 'stop', plan.entry, null, ctx)
        if (plan.stop === undefined) return fail('Sizing by risk needs a stop loss')
        if (plan.entry === null) return plan
        if (quoteToAccountRate(ctx) === null) {
          return fail(`No ${ctx.account.currency} rate for ${ctx.currencies.quote}: size in units instead`)
        }
        plan.units = unitsForRisk(prefs.riskPercent, plan.entry, plan.stop, ctx)
        if (plan.units === null || plan.units <= 0) return fail('The risk is too small for a single unit at that stop')
      } else {
        plan.units = prefs.units
        plan.stop = this.resolve(this.stopLoss, 'stop', plan.entry, plan.units, ctx)
      }
      plan.target = this.resolve(this.takeProfit, 'target', plan.entry, plan.units, ctx)
    } catch (err) {
      return fail(err instanceof Error ? err.message : 'Invalid stop or target')
    }

    if (plan.entry !== null) {
      const where = this.type === 'market' ? `the ${this.side === 'buy' ? 'ask' : 'bid'}` : 'the order price'
      if (plan.stop !== undefined && !protectionValid(this.side, 'stop', plan.stop, plan.entry)) {
        fail(`The stop loss must be ${this.below('stop') ? 'below' : 'above'} ${where}`)
      }
      if (plan.target !== undefined && !protectionValid(this.side, 'target', plan.target, plan.entry)) {
        fail(`The take profit must be ${this.below('target') ? 'below' : 'above'} ${where}`)
      }
    }
    return plan
  }

  private refresh(): void {
    const s = this.session.snapshot
    const info = this.info()
    const prefs = tradePrefs()
    const quote = s.quotes[this.key]
    const plan = this.plan()

    this.symbolNode.textContent = this.key.includes(':') ? this.key.split(':', 2)[1] : this.key
    if (quote) {
      const spread = toPips(quote.ask - quote.bid, info.pipSize)
      this.quoteNode.textContent =
        `${formatPrice(quote.bid, info.precision)} / ${formatPrice(quote.ask, info.precision)}` +
        (spread !== null ? ` · ${spread.toFixed(1)} pip${spread === 1 ? '' : 's'}` : '')
    } else {
      this.quoteNode.textContent = 'no quote yet'
    }

    this.sideControl.set(this.side)
    this.typeControl.set(this.type)
    this.sizeControl.set(prefs.sizeMode)
    const byRisk = prefs.sizeMode === 'risk'
    this.unitsField.element.hidden = byRisk
    this.riskField.element.hidden = !byRisk
    this.priceField.element.hidden = this.type === 'market'

    const mode = this.protectMode()
    this.modeControl.set(mode, {
      ...(info.pipSize === null ? { pips: 'This instrument is not priced in pips' } : {}),
      ...(byRisk ? { percent: 'Sizing by risk already fixes the loss: state the stop in pips or price' } : {})
    })
    const unit = mode === 'pips' ? ' (pips)' : mode === 'percent' ? ' (% bal)' : ''
    this.stopField.label.textContent = `Stop loss${unit}`
    this.targetField.label.textContent = `Take profit${unit}`

    const canRatio = plan.entry !== null && plan.stop !== undefined && targetForReward(this.side, plan.entry, plan.stop, 1, info.precision) !== null
    for (const b of this.ratioButtons) {
      b.disabled = !canRatio
      b.classList.toggle('is-active', canRatio && b.textContent === `${prefs.rewardRatio}R`)
    }
    this.ratioRow.title = canRatio ? '' : 'Set a stop loss first'

    this.renderSummary(plan)

    this.errorNode.textContent = this.error
    this.errorNode.hidden = this.error === ''
    const label = `${sideLabel(this.side)} ${this.type === 'market' ? 'market' : this.type}`
    this.submitButton.textContent =
      plan.units !== null && plan.units > 0 && !plan.problem ? `${label} · ${formatUnits(plan.units)}` : label
    this.submitButton.className = `kc-button kc-button-primary wd-trade-submit ${this.side === 'buy' ? 'is-buy' : 'is-sell'}`
    this.submitButton.disabled = !quote
    this.draftListener?.()
  }

  private renderSummary(plan: Plan): void {
    this.summary.innerHTML = ''
    const { ctx } = plan
    const line = (className = ''): HTMLElement => {
      const node = el('div', `wd-trade-summary-line ${className}`)
      this.summary.appendChild(node)
      return node
    }
    if (plan.units === null || plan.entry === null) {
      if (plan.problem && tradePrefs().sizeMode === 'risk') line('is-muted').textContent = plan.problem
      return
    }
    const size = sizeFigures(plan.units, ctx)
    const currency = quoteToAccountRate(ctx) !== null ? ctx.account.currency : ctx.currencies.quote
    const money = (o: ReturnType<typeof outcome>): string =>
      formatMoney(o.amountAccount ?? o.amount, currency) + (o.ofBalance !== null ? ` (${formatPercent(o.ofBalance)})` : '')

    const first = line()
    const bits = [`${formatUnits(plan.units)} units`]
    if (size.lots !== null) bits.push(formatLots(size.lots))
    if (size.margin !== null) bits.push(`margin ${formatMoney(size.margin, ctx.account.currency, false)}`)
    first.textContent = bits.join(' · ')
    // The engine does not enforce margin, but a live account would refuse this.
    if (size.margin !== null && size.margin > ctx.account.equity) {
      first.append(' · ', el('span', 'is-warning', 'more than your equity'))
    }

    const risk = plan.stop !== undefined ? outcome(this.side, plan.units, plan.entry, plan.stop, ctx) : null
    const reward = plan.target !== undefined ? outcome(this.side, plan.units, plan.entry, plan.target, ctx) : null
    const second = line()
    const riskNode = el('span', risk ? 'is-down' : 'is-warning', risk ? `Risk ${money(risk)}` : 'No stop loss')
    second.appendChild(riskNode)
    if (reward) {
      second.append(' · ', el('span', 'is-up', `Reward ${money(reward)}`))
      if (risk && risk.amount < 0 && reward.amount > 0) second.append(` · R:R ${(reward.amount / -risk.amount).toFixed(2)}`)
    }
    if (plan.problem) line('is-muted').textContent = plan.problem
  }

  private async submit(): Promise<void> {
    const plan = this.plan()
    if (plan.problem || plan.units === null || plan.units <= 0) {
      const problem = plan.problem ?? 'Nothing to send'
      this.showError(problem)
      throw new Error(problem)
    }
    this.error = ''
    try {
      await this.session.watch(this.key)
      await this.session.placeOrder({
        symbol: this.key,
        side: this.side,
        type: this.type,
        units: plan.units,
        price: plan.price,
        stopLoss: plan.stop,
        takeProfit: plan.target
      })
      // Back to a clean market order: a type kept without its price is a draft with nothing to
      // show, which would sit on the chart and keep the order just placed dimmed behind it.
      this.type = 'market'
      this.price = ''
      this.stopLoss = ''
      this.takeProfit = ''
      this.priceField.input.value = ''
      this.stopField.input.value = ''
      this.targetField.input.value = ''
      this.refresh()
    } catch (err) {
      this.showError(err instanceof OhlcvApiError ? err.message : 'Order rejected')
      throw err
    }
  }

  dispose(): void {
    this.unsubscribe()
  }
}
