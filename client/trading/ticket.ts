import type { SymbolInfo } from '../../src'
import { OhlcvApiError } from '../config'
import type { SimOrderType, SimSide } from './api'
import { formatMoney, formatPrice, formatUnits, formatUnitsShort, symbolKey, toPips } from './format'
import type { InstrumentInfo } from './instrument'
import { Arming, allow, armKey, FigureList, h, kbtn, LevelField, NumberField } from './kit'
import {
  defaultRestingPrice,
  type LevelBasis,
  type LevelRole,
  levelModeRefusal,
  levelReadout,
  levelRefusal,
  levelText,
  parseLevel,
  priceStep,
  type ReadoutPart,
  restingDistance,
  restingRefusal,
  stepLevelText,
  usableMode
} from './levels'
import { type DraftController, type DraftOrder, workingFor } from './lines'
import {
  fillingPrice,
  levelForBalancePercent,
  outcome,
  type PricingContext,
  positionSummary,
  pricingContext,
  quoteToAccountRate,
  rewardToRisk,
  roundTo,
  sizeFigures,
  targetForReward,
  unitsForMarginPercent,
  unitsForNotional,
  unitsForRisk,
  unitsForRiskAmount
} from './metrics'
import {
  type ProtectMode,
  SIZE_MODES,
  type SizeMode,
  setTradePrefs,
  sizedByStop,
  subscribeTradePrefs,
  type TradePrefs,
  tradePrefs
} from './prefs'
import type { TradingSession } from './session'
import { sizeRows, type StatRow } from './stats'

// The order ticket: the TRADE BOX's contents. Side, type, size, price, stop and target -- and what
// they add up to before anything is sent.
//
// It is built from the same kit (kit.ts) as the order card on the pane, so a stop loss here is the
// same field, with the same unit, steps, presets and readout, as the stop loss of a working order
// there (user, 2026-10-03). Top to bottom:
//
// - the instrument, and what is already open on it;
// - SELL at the bid / BUY at the ask, with the spread between: picks the side, sends nothing;
// - Market / Limit / Stop. A limit or stop starts at a valid price ten pips clear of the market
//   (`defaultRestingPrice`), so it is drawn on the chart at once, where it can be dragged;
// - the PRICE (limit/stop), how far it is from where it would fill, and why the engine would
//   refuse it;
// - the SIZE, given one of six ways (`SizeMode`, the unit after the number): units; standard lots
//   (forex); RISK % or a RISK AMOUNT -- the units that lose that share of the balance, or that
//   much money, if the stop is hit, floored so the loss never exceeds it; the position's VALUE in
//   the account currency; or the MARGIN it ties up as a share of the balance. Every way ends as
//   units, and switching carries the size across rather than reinterpreting the number;
// - STOP LOSS and TAKE PROFIT in pips, price or % of balance (levels.ts), with Risk N% and
//   1R/2R/3R presets; % of balance is not offered while the size itself comes from the stop;
// - the figures of the order as it would be sent (the same rows the card and popup show), a note
//   sent with it, the reason it cannot be sent yet, and the button.
//
// PLACING takes two presses -- the button turns into "Confirm" for three seconds -- unless
// one-click trading is on; the same rule as Place, Close and Cancel on the pane and in the popup.
// Enter in any field presses it.
//
// ON THE CHART the order being written is a DRAFT (`draft()`), which the trading layer draws on
// the instrument's panes while the trade box is open. Dragging its lines calls `setLevel`, which
// writes the new price back into these fields in whatever way they are stated -- so the ticket
// stays the one place the order lives, and the chart and the fields cannot disagree.
//
// BUILT ONCE and updated in place. It re-renders on every session notification, which is every
// two seconds while anything is working; a ticket rebuilt each time took the focus (and a
// half-typed price) away from whoever was typing in it.

export interface TicketContext {
  activeSymbol: () => SymbolInfo
  instrumentFor: (key: string) => InstrumentInfo
}

const REWARD_RATIOS = [1, 2, 3]
const LOT = 100_000
const NOTE_MAX = 64

/** Each way of sizing: the unit after the number, the preference it reads, its cap, and a step
 * (the big step is ten of them). */
const SIZE_SPECS: Record<SizeMode, { unit: (currency: string) => string; pref: keyof TradePrefs; max?: number; step: (info: InstrumentInfo) => number; digits: number }> = {
  units: { unit: () => 'units', pref: 'units', step: (i) => (i.assetClass === 'forex' ? 1000 : 10 ** -i.unitsPrecision), digits: 5 },
  lots: { unit: () => 'lots', pref: 'lots', step: () => 0.01, digits: 2 },
  risk: { unit: () => '% risk', pref: 'riskPercent', max: 100, step: () => 0.25, digits: 2 },
  riskAmount: { unit: (c) => `${c} risk`, pref: 'riskAmount', step: () => 10, digits: 2 },
  notional: { unit: (c) => `${c} value`, pref: 'notional', step: () => 1000, digits: 2 },
  margin: { unit: () => '% margin', pref: 'marginPercent', max: 100, step: () => 0.5, digits: 2 }
}

/** A number for a field: no float noise, at most `digits` decimals. */
function tidy(value: number, digits = 2): string {
  return String(Number(value.toFixed(digits)))
}

type Slot = 'general' | 'price' | 'size' | 'stop' | 'target'

interface Plan {
  units: number | null
  entry: number | null
  price: number | undefined
  stop: number | undefined
  target: number | undefined
  /** Why it cannot be sent, by the field that is wrong. */
  problems: Partial<Record<Slot, string>>
  /** The first of them; null when it can be sent. */
  problem: string | null
  ctx: PricingContext
}

/** A segmented choice whose active option is re-read on every refresh. */
class Segmented<T extends string> {
  readonly element: HTMLElement
  private readonly buttons = new Map<T, HTMLButtonElement>()

  constructor(options: Array<[T, string]>, onPick: (value: T) => void) {
    this.element = h('div', 'wd-tk-seg')
    this.element.setAttribute('role', 'radiogroup')
    for (const [value, text] of options) {
      const b = kbtn(text, () => onPick(value))
      b.setAttribute('role', 'radio')
      this.buttons.set(value, b)
      this.element.appendChild(b)
    }
  }

  set(active: T): void {
    for (const [value, b] of this.buttons) {
      b.classList.toggle('is-active', value === active)
      b.setAttribute('aria-checked', String(value === active))
    }
  }
}

/** SELL at the bid and BUY at the ask, the spread between them. A press picks the side. */
class SidePicker {
  readonly element: HTMLElement
  private readonly sell: { button: HTMLButtonElement; price: HTMLElement }
  private readonly buy: { button: HTMLButtonElement; price: HTMLElement }
  private readonly spread: HTMLElement

  constructor(onPick: (side: SimSide) => void) {
    this.element = h('div', 'wd-tk-sides')
    this.element.setAttribute('role', 'radiogroup')
    const make = (side: SimSide) => {
      const button = kbtn('', () => onPick(side), [side])
      button.classList.add('wd-tk-side')
      button.setAttribute('role', 'radio')
      const price = h('span', 'wd-tk-side-price')
      button.append(h('span', 'wd-tk-side-name', side === 'buy' ? 'Buy' : 'Sell'), price)
      return { button, price }
    }
    this.sell = make('sell')
    this.buy = make('buy')
    this.spread = h('span', 'wd-tk-spread')
    this.element.append(this.sell.button, this.spread, this.buy.button)
  }

  set(side: SimSide, bid: string, ask: string, spread: string): void {
    this.sell.price.textContent = bid
    this.buy.price.textContent = ask
    this.spread.textContent = spread
    this.spread.title = 'Spread'
    for (const [s, part] of [['sell', this.sell], ['buy', this.buy]] as const) {
      part.button.classList.toggle('is-active', s === side)
      part.button.setAttribute('aria-checked', String(s === side))
      part.button.title = `${s === 'buy' ? 'Buy at the ask' : 'Sell at the bid'}: picks the side, sends nothing`
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
  private note = ''
  private error = ''
  private symbol: SymbolInfo
  private key: string
  private readonly arming: Arming

  private readonly symbolNode: HTMLElement
  private readonly positionNode: HTMLElement
  private readonly sides: SidePicker
  private readonly typeControl: Segmented<SimOrderType>
  private readonly priceField: LevelField
  private readonly sizeBlock: HTMLElement
  private readonly sizeField: NumberField
  private readonly sizeReadout: HTMLElement
  private readonly sizeProblem: HTMLElement
  private readonly stopField: LevelField
  private readonly targetField: LevelField
  private readonly figures: FigureList
  private readonly noteInput: HTMLInputElement
  private readonly problemNode: HTMLElement
  private readonly submitButton: HTMLButtonElement
  private readonly oneClick: HTMLInputElement
  private readonly resetButton: HTMLButtonElement
  private readonly unsubscribe: () => void
  private readonly unsubscribeSession: () => void
  private draftListener: (() => void) | null = null

  constructor(
    private readonly session: TradingSession,
    private readonly ctx: TicketContext
  ) {
    this.symbol = ctx.activeSymbol()
    this.key = symbolKey(this.symbol)
    this.arming = new Arming(() => this.refresh())
    this.element = h('div', 'wd-tk wd-trade-ticket')

    const head = h('div', 'wd-tk-head')
    this.symbolNode = h('span', 'wd-tk-symbol')
    this.positionNode = h('span', 'wd-tk-position')
    head.append(this.symbolNode, this.positionNode)

    this.sides = new SidePicker((side) => this.change(() => this.setSide(side)))
    this.typeControl = new Segmented<SimOrderType>(
      [
        ['market', 'Market'],
        ['limit', 'Limit'],
        ['stop', 'Stop']
      ],
      (type) => this.change(() => this.setType(type))
    )

    const press = () => this.press()
    this.priceField = new LevelField({
      role: 'entry',
      label: 'Price',
      withUnits: false,
      onInput: (text) => this.change(() => (this.price = text)),
      onStep: (direction, big) => this.stepPrice(direction, big),
      onEnter: press
    })

    // Size: the same layout as a level -- a label, the number with its unit, and a readout.
    this.sizeBlock = h('div', 'wd-tk-level')
    this.sizeBlock.dataset.role = 'size'
    const sizeHead = h('div', 'wd-tk-level-head')
    sizeHead.append(h('span', 'wd-tk-level-label', 'Size'))
    this.sizeField = new NumberField({
      label: 'Size',
      onInput: (text) => this.typeSize(text),
      onStep: (direction, big) => this.stepSize(direction, big),
      units: SIZE_MODES.map((mode) => [mode, SIZE_SPECS[mode].unit('USD')]),
      onUnit: (mode) => this.setSizeMode(mode as SizeMode),
      onEnter: press
    })
    this.sizeReadout = h('span', 'wd-tk-readout')
    const sizeBody = h('div', 'wd-tk-level-body')
    sizeBody.append(this.sizeField.element, this.sizeReadout)
    this.sizeProblem = h('div', 'wd-tk-problem')
    this.sizeBlock.append(sizeHead, sizeBody, this.sizeProblem)

    this.stopField = this.levelField('stop', 'Stop loss', press)
    this.targetField = this.levelField('target', 'Take profit', press)

    this.figures = new FigureList()

    const noteRow = h('label', 'wd-tk-note')
    this.noteInput = h('input', 'wd-tk-note-input')
    this.noteInput.type = 'text'
    this.noteInput.maxLength = NOTE_MAX
    this.noteInput.placeholder = 'Note (optional, sent with the order)'
    this.noteInput.setAttribute('aria-label', 'Note')
    this.noteInput.addEventListener('input', () => (this.note = this.noteInput.value))
    this.noteInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        press()
      }
    })
    noteRow.append(this.noteInput)

    this.problemNode = h('div', 'wd-tk-problem is-block')
    this.problemNode.setAttribute('aria-live', 'polite')
    this.submitButton = kbtn('', press, ['primary'])
    this.submitButton.classList.add('wd-tk-submit')

    const foot = h('div', 'wd-tk-row wd-tk-foot')
    const oneClickLabel = h('label', 'wd-tk-check')
    this.oneClick = h('input')
    this.oneClick.type = 'checkbox'
    this.oneClick.addEventListener('change', () => setTradePrefs({ oneClick: this.oneClick.checked }))
    oneClickLabel.append(this.oneClick, 'One-click trading')
    oneClickLabel.title = 'Place, close and cancel on the first press, here, on the chart and in the position popup'
    this.resetButton = kbtn('Reset', () => this.reset(), ['quiet'], 'Back to a market order with no price, stop, target or note')
    foot.append(oneClickLabel, this.resetButton)

    this.element.append(
      head,
      this.sides.element,
      this.typeControl.element,
      this.priceField.element,
      this.sizeBlock,
      this.stopField.element,
      this.targetField.element,
      this.figures.element,
      noteRow,
      this.problemNode,
      this.submitButton,
      foot
    )
    this.element.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.arming.disarm()
    })
    // Another tab, or the card, changed a shared number: show it unless it is being typed here.
    this.unsubscribe = subscribeTradePrefs(() => this.refresh())
    // New quotes and a new balance re-price the order; nothing being typed is touched.
    this.unsubscribeSession = session.subscribe(() => this.refresh())
    this.refresh()
  }

  private levelField(role: LevelRole, label: string, press: () => void): LevelField {
    return new LevelField({
      role,
      label,
      withUnits: true,
      onInput: (text) => this.change(() => this.setText(role, text)),
      onStep: (direction, big) => {
        const plan = this.plan()
        const text = stepLevelText(this.textOf(role), this.protectMode(), role, direction, big, this.basis(plan))
        this.writeLevel(role, text)
      },
      onUnit: (mode) => this.setProtectMode(mode),
      onPreset: (i) => (role === 'stop' ? this.riskStop() : this.targetAtRatio(REWARD_RATIOS[i])),
      onClear: () => this.clearLevel(role),
      onEnter: press
    })
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
      riskPercent: this.riskPercentOf(prefs, plan)
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
      this.priceField.write(this.price)
    } else {
      this.writeLevel(role, levelText(price, this.protectMode(), this.basis(this.plan())), false)
    }
    this.error = ''
    this.refresh()
  }

  clearLevel(role: 'entry' | 'stop' | 'target'): void {
    if (role === 'entry') {
      this.type = 'market'
      this.price = ''
      this.priceField.write('')
    } else {
      this.writeLevel(role, '', false)
    }
    this.error = ''
    this.refresh()
  }

  place(): Promise<void> {
    return this.submit()
  }

  syncInstrument(): void {
    const key = symbolKey(this.ctx.activeSymbol())
    const moved = key !== this.key
    this.symbol = this.ctx.activeSymbol()
    this.key = key
    // A price for another instrument means nothing here.
    if (moved && this.type !== 'market') this.prefillPrice()
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
    this.arming.disarm()
    this.refresh()
  }

  // -- fields ---------------------------------------------------------------------------------------

  private textOf(role: LevelRole): string {
    return role === 'stop' ? this.stopLoss : this.takeProfit
  }

  private setText(role: LevelRole, text: string): void {
    if (role === 'stop') this.stopLoss = text
    else this.takeProfit = text
  }

  /** A level's text written by a step, a preset, a drag or a unit change -- into the field even
   * while it has the focus. */
  private writeLevel(role: LevelRole, text: string, refresh = true): void {
    this.setText(role, text)
    ;(role === 'stop' ? this.stopField : this.targetField).write(text)
    this.error = ''
    this.arming.disarm()
    if (refresh) this.refresh()
  }

  private setSide(side: SimSide): void {
    this.side = side
    // A resting price valid for the other side is usually on the wrong side of this one.
    if (this.type !== 'market' && this.restingProblem() !== null) this.prefillPrice()
  }

  private setType(type: SimOrderType): void {
    this.type = type
    if (type === 'market') return
    if (this.price.trim() === '' || this.restingProblem() !== null) this.prefillPrice()
  }

  private restingProblem(): string | null {
    const price = Number(this.price)
    if (this.price.trim() === '' || !(price > 0)) return 'no price'
    return restingRefusal(this.side, this.type, price, this.session.snapshot.quotes[this.key], this.info().precision)
  }

  /** A valid starting price for the limit or stop being written, so it shows on the chart. */
  private prefillPrice(): void {
    const price = defaultRestingPrice(this.side, this.type, this.session.snapshot.quotes[this.key], this.info())
    this.price = price === null ? '' : formatPrice(price, this.info().precision)
    this.priceField.write(this.price)
  }

  private stepPrice(direction: 1 | -1, big: boolean): void {
    const info = this.info()
    const current = Number(this.price)
    if (this.price.trim() === '' || !(current > 0)) {
      this.prefillPrice()
    } else {
      const next = roundTo(current + direction * priceStep(info) * (big ? 10 : 1), info.precision)
      if (next > 0) this.price = formatPrice(next, info.precision)
      this.priceField.write(this.price)
    }
    this.change(() => {})
  }

  private typeSize(text: string): void {
    const spec = SIZE_SPECS[this.sizeMode()]
    const n = Number(text)
    this.error = ''
    this.arming.disarm()
    if (n > 0 && n <= (spec.max ?? Number.POSITIVE_INFINITY)) setTradePrefs({ [spec.pref]: n })
    else this.refresh()
  }

  private stepSize(direction: 1 | -1, big: boolean): void {
    const mode = this.sizeMode()
    const spec = SIZE_SPECS[mode]
    const step = spec.step(this.info()) * (big ? 10 : 1)
    const current = Number(tradePrefs()[spec.pref])
    // Snap to the step's grid, so 10,250 steps to 11,000 and back to 10,000 rather than drifting.
    const snapped = direction > 0 ? Math.floor(current / step + 1e-9) * step + step : Math.ceil(current / step - 1e-9) * step - step
    const next = Number(snapped.toFixed(spec.digits))
    if (!(next > 0) || next > (spec.max ?? Number.POSITIVE_INFINITY)) return
    this.sizeField.write(tidy(next, spec.digits))
    this.error = ''
    this.arming.disarm()
    setTradePrefs({ [spec.pref]: next })
  }

  private reset(): void {
    this.type = 'market'
    this.price = ''
    this.note = ''
    this.noteInput.value = ''
    this.priceField.write('')
    this.writeLevel('stop', '', false)
    this.writeLevel('target', '', false)
    this.error = ''
    this.refresh()
  }

  // -- modes --------------------------------------------------------------------------------------

  private info(): InstrumentInfo {
    return this.ctx.instrumentFor(this.key)
  }

  /** Why a way of sizing is not open to this instrument, or null when it is. */
  private sizeRefusal(mode: SizeMode): string | null {
    const info = this.info()
    if (mode === 'lots' && info.assetClass !== 'forex') return 'Lots are a forex convention'
    if (mode === 'margin' && info.marginRate === null) return 'No margin rate for this instrument'
    return null
  }

  /** The stored way of sizing, or units where this instrument does not allow it. */
  private sizeMode(): SizeMode {
    const mode = tradePrefs().sizeMode
    return this.sizeRefusal(mode) === null ? mode : 'units'
  }

  /** The share of the balance the order risks, when its size comes from the stop; the draft
   * carries it so the chart re-sizes rather than re-prices when the stop moves. */
  private riskPercentOf(prefs: TradePrefs, plan: Plan): number | null {
    const mode = this.sizeMode()
    if (mode === 'risk') return prefs.riskPercent
    if (mode === 'riskAmount' && plan.ctx.account.balance > 0) return (prefs.riskAmount / plan.ctx.account.balance) * 100
    return null
  }

  private pricing(): PricingContext {
    const s = this.session.snapshot
    return pricingContext(this.key, this.info(), s.account, s.quotes[this.key], s.quotes)
  }

  /** The stored unit for stops and targets, or the nearest one this instrument and size allow. */
  private protectMode(): ProtectMode {
    return usableMode(tradePrefs().protectMode, this.pricing(), sizedByStop(this.sizeMode()))
  }

  private setProtectMode(next: ProtectMode): void {
    const plan = this.plan()
    const from = this.protectMode()
    setTradePrefs({ protectMode: next })
    const to = this.protectMode()
    if (from === to) return
    // Carry what was typed across: the same price, stated the new way.
    this.restate(plan, to)
    this.refresh()
  }

  private restate(plan: Plan, to: ProtectMode): void {
    const basis = this.basis(plan)
    if (plan.stop !== undefined) this.writeLevel('stop', levelText(plan.stop, to, basis), false)
    if (plan.target !== undefined) this.writeLevel('target', levelText(plan.target, to, basis), false)
  }

  private setSizeMode(next: SizeMode): void {
    if (this.sizeRefusal(next) !== null) {
      this.refresh()
      return
    }
    const plan = this.plan()
    // The size the order has now, stated the new way, so switching does not change the order.
    const carried = plan.units !== null && plan.units > 0 && plan.entry !== null ? this.sizeAs(next, plan) : null
    if (carried !== null) setTradePrefs({ [SIZE_SPECS[next].pref]: carried })
    // Sizing from the stop, a stop stated as a share of the balance is re-stated in pips or price first.
    if (sizedByStop(next) && this.protectMode() === 'percent') this.restate(plan, this.info().pipSize !== null ? 'pips' : 'price')
    this.error = ''
    this.arming.disarm()
    const value = carried ?? Number(tradePrefs()[SIZE_SPECS[next].pref])
    this.sizeField.write(tidy(value, SIZE_SPECS[next].digits))
    setTradePrefs({ sizeMode: next })
  }

  /** `plan`'s size stated as `mode` would state it, or null where that cannot be worked out (a
   * risk with no stop, a value with no conversion). */
  private sizeAs(mode: SizeMode, plan: Plan): number | null {
    const units = plan.units
    if (units === null || plan.entry === null) return null
    const size = sizeFigures(units, plan.ctx)
    const balance = plan.ctx.account.balance
    const risk = plan.stop !== undefined ? outcome(this.side, units, plan.entry, plan.stop, plan.ctx) : null
    const loss = risk?.amountAccount !== null && risk?.amountAccount !== undefined && risk.amountAccount < 0 ? -risk.amountAccount : null
    let value: number | null = null
    if (mode === 'units') value = units
    else if (mode === 'lots') value = units / LOT
    else if (mode === 'risk') value = loss !== null && balance > 0 ? (loss / balance) * 100 : null
    else if (mode === 'riskAmount') value = loss
    else if (mode === 'notional') value = size.notionalAccount
    else value = size.margin !== null && balance > 0 ? (size.margin / balance) * 100 : null
    if (value === null || !(value > 0)) return null
    return Number(value.toFixed(mode === 'lots' || mode === 'units' ? 5 : 2))
  }

  // -- presets ------------------------------------------------------------------------------------

  /** Why "Risk N%" cannot place the stop now, or null. */
  private riskStopRefusal(plan: Plan): string | null {
    if (sizedByStop(this.sizeMode())) return 'the size already comes from the risk'
    if (plan.entry === null || plan.units === null) return 'no size yet'
    if (quoteToAccountRate(plan.ctx) === null) return `no ${plan.ctx.account.currency} rate for ${plan.ctx.currencies.quote}`
    return null
  }

  private riskStop(): void {
    const plan = this.plan()
    if (this.riskStopRefusal(plan) !== null || plan.entry === null || plan.units === null) return
    const level = levelForBalancePercent(this.side, 'stop', plan.units, plan.entry, tradePrefs().riskPercent, plan.ctx)
    if (level !== null) this.writeLevel('stop', levelText(level, this.protectMode(), this.basis(plan)))
  }

  private targetAtRatio(ratio: number): void {
    const plan = this.plan()
    if (plan.entry === null || plan.stop === undefined) return
    const target = targetForReward(this.side, plan.entry, plan.stop, ratio, this.info().precision)
    if (target === null) return
    this.writeLevel('target', levelText(target, this.protectMode(), this.basis(plan)), false)
    setTradePrefs({ rewardRatio: ratio })
  }

  // -- the order as it would be sent --------------------------------------------------------------

  private basis(plan: Pick<Plan, 'entry' | 'units' | 'ctx'>): LevelBasis {
    return { side: this.side, entry: plan.entry, units: plan.units, ctx: plan.ctx }
  }

  private plan(): Plan {
    const s = this.session.snapshot
    const info = this.info()
    const quote = s.quotes[this.key]
    const ctx = this.pricing()
    const prefs = tradePrefs()
    const problems: Plan['problems'] = {}
    const fail = (slot: Slot, problem: string): void => {
      problems[slot] ??= problem
    }
    const plan: Plan = { units: null, entry: null, price: undefined, stop: undefined, target: undefined, problems, problem: null, ctx }

    if (!quote) fail('general', this.session.ready ? 'No quote yet' : 'Connecting…')
    if (this.type !== 'market') {
      const price = Number(this.price)
      if (this.price.trim() === '' || !Number.isFinite(price) || price <= 0) {
        fail('price', `A ${this.type} order needs a price`)
      } else {
        plan.price = price
        const refusal = restingRefusal(this.side, this.type, price, quote, info.precision)
        if (refusal) fail('price', refusal)
      }
    }
    plan.entry = plan.price ?? fillingPrice(this.side, quote)

    const mode = this.sizeMode()
    const protect = this.protectMode()
    const level = (role: LevelRole, units: number | null): number | undefined => {
      try {
        return parseLevel(this.textOf(role), protect, role, this.basis({ entry: plan.entry, units, ctx })) ?? undefined
      } catch (err) {
        fail(role, err instanceof Error ? err.message : `Invalid ${role}`)
        return undefined
      }
    }
    const noRate = `No ${ctx.account.currency} rate for ${ctx.currencies.quote}: size another way`
    if (sizedByStop(mode)) {
      // The stop decides the size, so it resolves first, without one.
      plan.stop = level('stop', null)
      if (plan.stop === undefined) {
        if (!problems.stop) fail('size', 'Sizing by risk needs a stop loss')
      } else if (plan.entry !== null) {
        if (quoteToAccountRate(ctx) === null) fail('size', noRate)
        else {
          const units =
            mode === 'risk' ? unitsForRisk(prefs.riskPercent, plan.entry, plan.stop, ctx) : unitsForRiskAmount(prefs.riskAmount, plan.entry, plan.stop, ctx)
          if (units === null || units <= 0) fail('size', 'The risk is too small for a single unit at that stop')
          else plan.units = units
        }
      }
    } else {
      let units: number | null
      if (mode === 'units') units = prefs.units
      else if (mode === 'lots') units = Math.round(prefs.lots * LOT * 10 ** info.unitsPrecision) / 10 ** info.unitsPrecision
      else if (mode === 'notional') units = unitsForNotional(prefs.notional, ctx)
      else units = unitsForMarginPercent(prefs.marginPercent, ctx)
      if (units === null) {
        if (quote) fail('size', noRate)
      } else if (units <= 0) fail('size', 'Too small for a single unit')
      else plan.units = units
      plan.stop = level('stop', plan.units)
    }
    plan.target = level('target', plan.units)

    if (plan.entry !== null) {
      const where = this.type === 'market' ? `the ${this.side === 'buy' ? 'ask' : 'bid'}` : 'the order price'
      if (plan.stop !== undefined) {
        const refusal = levelRefusal(this.side, 'stop', plan.stop, plan.entry, where)
        if (refusal) fail('stop', refusal)
      }
      if (plan.target !== undefined) {
        const refusal = levelRefusal(this.side, 'target', plan.target, plan.entry, where)
        if (refusal) fail('target', refusal)
      }
    }
    plan.problem = problems.general ?? problems.price ?? problems.size ?? problems.stop ?? problems.target ?? null
    return plan
  }

  private refresh(): void {
    const s = this.session.snapshot
    const info = this.info()
    const prefs = tradePrefs()
    const quote = s.quotes[this.key]
    const plan = this.plan()
    const { ctx } = plan
    const precision = info.precision
    const basis = this.basis(plan)
    const sell = this.side === 'sell'

    this.element.dataset.side = this.side
    this.symbolNode.textContent = this.key.includes(':') ? this.key.split(':', 2)[1] : this.key
    this.renderPosition(ctx)
    const spread = quote ? toPips(quote.ask - quote.bid, info.pipSize) : null
    this.sides.set(
      this.side,
      quote ? formatPrice(quote.bid, precision) : '—',
      quote ? formatPrice(quote.ask, precision) : '—',
      spread !== null ? spread.toFixed(1) : quote ? formatPrice(quote.ask - quote.bid, precision) : ''
    )
    this.typeControl.set(this.type)

    // Price.
    this.priceField.element.hidden = this.type === 'market'
    const distance = plan.price !== undefined ? restingDistance(this.side, plan.price, quote, info) : null
    this.priceField.update({
      text: this.price,
      placeholder: 'price',
      readout: distance ? [{ text: distance, tone: '' }] : [],
      presets: [],
      removable: false,
      problem: plan.problems.price ?? null,
      pending: false
    })

    // Size.
    const sizeMode = this.sizeMode()
    const spec = SIZE_SPECS[sizeMode]
    if (this.sizeField.select) {
      for (const option of this.sizeField.select.options) option.textContent = SIZE_SPECS[option.value as SizeMode].unit(s.account.currency)
    }
    this.sizeField.show(tidy(Number(prefs[spec.pref]), spec.digits))
    this.sizeField.set({
      unit: sizeMode,
      unitRefusals: Object.fromEntries(SIZE_MODES.map((m) => [m, this.sizeRefusal(m)])),
      invalid: plan.problems.size !== undefined
    })
    const size = plan.units !== null ? sizeFigures(plan.units, ctx) : null
    const sizeParts: ReadoutPart[] = []
    if (plan.units !== null && sizeMode !== 'units') sizeParts.push({ text: `${formatUnits(plan.units)} units`, tone: '' })
    if (size?.lots != null && sizeMode !== 'lots') sizeParts.push({ text: `${size.lots.toFixed(2)} lots`, tone: '' })
    this.sizeReadout.textContent = sizeParts.map((p) => p.text).join(' · ')
    this.sizeProblem.textContent = plan.problems.size ?? ''
    this.sizeProblem.hidden = plan.problems.size === undefined

    // Stop and target.
    const mode = this.protectMode()
    const unitRefusals = Object.fromEntries(
      (['pips', 'price', 'percent'] as ProtectMode[]).map((m) => [m, levelModeRefusal(m, ctx, sizedByStop(sizeMode))])
    )
    const readout = (price: number | undefined): ReadoutPart[] => (price !== undefined ? levelReadout(price, mode, basis) : [])
    const risk = `${tidy(prefs.riskPercent)}%`
    this.stopField.update({
      text: this.stopLoss,
      placeholder: 'none',
      unit: mode,
      unitRefusals,
      readout: readout(plan.stop),
      presets: [{ text: `Risk ${risk}`, title: `Put the stop where it loses ${risk} of the balance`, refusal: this.riskStopRefusal(plan) }],
      removable: this.stopLoss !== '',
      problem: plan.problems.stop ?? null,
      pending: false,
      stepRefusal: plan.entry === null ? 'No price yet' : null
    })
    const ratioRefusal = plan.entry === null || plan.stop === undefined ? 'set a stop loss first' : targetForReward(this.side, plan.entry, plan.stop, 1, precision) === null ? 'the stop is past the entry' : null
    this.targetField.update({
      text: this.takeProfit,
      placeholder: 'none',
      unit: mode,
      unitRefusals,
      readout: readout(plan.target),
      presets: REWARD_RATIOS.map((ratio) => ({
        text: `${ratio}R`,
        title: `Take profit at ${ratio}× the stop's distance`,
        refusal: ratioRefusal,
        active:
          ratioRefusal === null && plan.entry !== null && plan.stop !== undefined && plan.target !== undefined &&
          targetForReward(this.side, plan.entry, plan.stop, ratio, precision) === plan.target
      })),
      removable: this.takeProfit !== '',
      problem: plan.problems.target ?? null,
      pending: false,
      stepRefusal: plan.entry === null ? 'No price yet' : null
    })

    // Figures: the same rows the card and the popup show for a working order.
    const rows: StatRow[] = plan.units !== null ? sizeRows(plan.units, ctx) : []
    if (plan.units !== null && plan.entry !== null && plan.stop !== undefined && plan.target !== undefined) {
      const rr = rewardToRisk(outcome(this.side, plan.units, plan.entry, plan.stop, ctx), outcome(this.side, plan.units, plan.entry, plan.target, ctx))
      if (rr !== null) rows.push({ label: 'R:R', value: rr.toFixed(2) })
    }
    this.figures.update(rows)
    if (document.activeElement !== this.noteInput) this.noteInput.value = this.note

    // What stops it being sent that no field shows, and a refusal from the server.
    const general = this.error || plan.problems.general || ''
    this.problemNode.textContent = general
    this.problemNode.hidden = general === ''
    this.problemNode.classList.toggle('is-error', this.error !== '')

    const armed = this.arming.key === armKey.place
    const what = `${sell ? 'Sell' : 'Buy'} ${plan.units !== null ? `${formatUnitsShort(plan.units)} ` : ''}${this.symbolNode.textContent} ${
      this.type === 'market' ? 'at market' : `${this.type} @ ${formatPrice(plan.price, precision)}`
    }`
    this.submitButton.textContent = armed ? `Confirm: ${what}` : what
    this.submitButton.className = `wd-tk-btn wd-tk-submit is-${this.side}${armed ? ' is-armed' : ''}`
    allow(this.submitButton, !quote ? (this.session.ready ? 'No quote yet' : 'Connecting…') : plan.problem, armed ? 'Press again to send it' : 'Enter in any field does the same')
    this.oneClick.checked = prefs.oneClick
    this.resetButton.hidden = this.type === 'market' && this.stopLoss === '' && this.takeProfit === '' && this.note === ''
    this.draftListener?.()
  }

  /** What is already open on this instrument, so an order is written knowing it. */
  private renderPosition(ctx: PricingContext): void {
    const { trades, orders } = workingFor(this.session.snapshot, this.key)
    const parts: string[] = []
    if (trades.length > 0) {
      const summary = positionSummary(trades, orders, ctx)
      const net = summary.netUnits
      parts.push(net === 0 ? 'Hedged' : `${net > 0 ? 'Long' : 'Short'} ${formatUnitsShort(net)}`)
      parts.push(formatMoney(summary.pnl, ctx.currencies.quote))
      this.positionNode.classList.toggle('is-up', summary.pnl > 0)
      this.positionNode.classList.toggle('is-down', summary.pnl < 0)
    }
    if (orders.length > 0) parts.push(`${orders.length} order${orders.length === 1 ? '' : 's'}`)
    this.positionNode.textContent = parts.join(' · ')
    this.positionNode.hidden = parts.length === 0
    this.positionNode.title = 'Open on this instrument'
  }

  /** The button, or Enter: the first press arms it, the second sends -- or the first, one-click. */
  private press(): void {
    const plan = this.plan()
    if (plan.problem || plan.units === null || plan.units <= 0) {
      // A field's own problem is already under it: go there. Anything else is said at the bottom.
      const { problems } = plan
      const input = problems.general
        ? null
        : problems.price
          ? this.priceField.field.input
          : problems.size
            ? this.sizeField.input
            : problems.stop
              ? this.stopField.field.input
              : problems.target
                ? this.targetField.field.input
                : null
      if (input) input.focus()
      else this.showError(plan.problem ?? 'Nothing to send')
      return
    }
    if (!this.arming.press(armKey.place, tradePrefs().oneClick)) return
    void this.submit().catch(() => {})
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
        takeProfit: plan.target,
        label: this.note.trim() || undefined
      })
      // Back to a clean market order: a type kept without its price is a draft with nothing to
      // show, which would sit on the chart and keep the order just placed dimmed behind it.
      this.reset()
    } catch (err) {
      this.showError(err instanceof OhlcvApiError ? err.message : err instanceof Error ? err.message : 'Order rejected')
      throw err
    }
  }

  dispose(): void {
    this.arming.disarm()
    this.unsubscribe()
    this.unsubscribeSession()
  }
}
