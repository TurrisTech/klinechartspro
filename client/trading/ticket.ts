import type { SymbolInfo } from '../../src'
import { OhlcvApiError } from '../config'
import type { SimOrderType, SimSide } from './api'
import {
  type AtrReading,
  breakevenReadout,
  defaultExit,
  distanceWords,
  EXIT_UNITS,
  type ExitBasis,
  type ExitUnit,
  exitText,
  exitUnitRefusal,
  milestonesReadout,
  milestoneValues,
  stepExitText,
  toggleMilestone,
  trailReadout,
  unitSize
} from './exits'
import { formatMoney, formatPrice, formatUnits, formatUnitsShort, symbolKey, toPips } from './format'
import type { InstrumentInfo } from './instrument'
import { Arming, allow, armKey, ExitField, FigureList, h, kbtn, LevelField, NumberField } from './kit'
import {
  defaultRestingPrice,
  type LevelRole,
  levelModeRefusal,
  levelReadout,
  levelText,
  priceStep,
  type ReadoutPart,
  restingDistance,
  stepLevelText
} from './levels'
import { type DraftController, type DraftOrder, workingFor } from './lines'
import { positionSummary, pricingContext, type PricingContext, roundTo, sizeFigures } from './metrics'
import {
  atRatio,
  atTrailPreset,
  breakevenWarning,
  draftOf,
  EXIT_PREF,
  type ExitRole,
  enteredSize,
  entryAt,
  exitUnitFor,
  levelBasis,
  notifyValue,
  type OrderFields,
  isSendable,
  type OrderPlan,
  orderRequest,
  planFigures,
  planOrder,
  problemSlot,
  protectModeFor,
  ratioRefusal,
  restateDistance,
  restateMilestones,
  restingProblem,
  riskStopLevel,
  riskStopRefusal,
  SIZE_SPECS,
  type Slot,
  sendRefusal,
  sizeAs,
  sizeRefusal,
  steppedSize,
  targetAt,
  trailPresetDistance,
  usableSizeMode
} from './order'
import { type ProtectMode, SIZE_MODES, type SizeMode, setTradePrefs, sizedByStop, subscribeTradePrefs, tradePrefs } from './prefs'
import type { TradingSession } from './session'

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
// - EXIT MANAGEMENT beside them (exits.ts; user, 2026-11-15): a TRAILING STOP (its distance, where
//   it starts and its step), an AUTO-BREAKEVEN (the profit that moves the stop to the entry, and
//   what it locks in), and NOTIFY AT -- distances from the entry, multiples of R by default, each a
//   notification the first time the price reaches it. Each is stated in pips, a price difference,
//   % of the price, × the active chart's ATR(14) or R, and is sent as a price distance;
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
//
// WHAT THE FIELDS ADD UP TO -- the entry, the units, the stop and target, the exits, the request
// and why it cannot be sent yet -- is planned in order.ts, which is pure and tested; this class
// holds what is typed, asks there, and draws the answer.

interface TicketContext {
  activeSymbol: () => SymbolInfo
  instrumentFor: (key: string) => InstrumentInfo
  /** The active pane's ATR(14) on its own timeframe, for distances stated in ATR; null without
   * enough bars. */
  activeAtr?: () => AtrReading | null
}

const REWARD_RATIOS = [1, 2, 3]
const NOTE_MAX = 64
const NOTIFY_MULTIPLES = [1, 2, 3]

/** A number for a field: no float noise, at most `digits` decimals. */
function tidy(value: number, digits = 2): string {
  return String(Number(value.toFixed(digits)))
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
  /** Exit management, as typed: a trail's distance, start and step; a breakeven's trigger and
   * lock; the milestones' list. Each in its own unit (prefs.ts). */
  private trail = { distance: '', start: '', step: '' }
  private breakeven = { trigger: '', lock: '' }
  private notify = ''
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
  private readonly trailField: ExitField
  private readonly breakevenField: ExitField
  private readonly notifyField: ExitField
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
    this.trailField = new ExitField({
      role: 'trail',
      label: 'Trailing stop',
      extras: [
        { label: 'Start at +', title: 'How far in profit the best price must be before the stop trails; empty: from the fill' },
        { label: 'Step', title: 'The least the stop moves by; empty: on every new best price' }
      ],
      onInput: (text) => this.change(() => (this.trail.distance = text)),
      onStep: (direction, big) => this.stepExit('trail', direction, big),
      onUnit: (unit) => this.setExitUnit('trail', unit),
      onPreset: (i) => this.trailPreset(i),
      onClear: () => this.clearExit('trail'),
      onEnter: press,
      onExtraInput: (i, text) =>
        this.change(() => {
          if (i === 0) this.trail.start = text
          else this.trail.step = text
        })
    })
    this.breakevenField = new ExitField({
      role: 'breakeven',
      label: 'Breakeven',
      extras: [{ label: 'Lock +', title: 'Where the stop goes, beyond the entry in the trade\'s favour; empty: the entry itself' }],
      onInput: (text) => this.change(() => (this.breakeven.trigger = text)),
      onStep: (direction, big) => this.stepExit('breakeven', direction, big),
      onUnit: (unit) => this.setExitUnit('breakeven', unit),
      onPreset: () => this.breakevenPreset(),
      onClear: () => this.clearExit('breakeven'),
      onEnter: press,
      onExtraInput: (_i, text) => this.change(() => (this.breakeven.lock = text))
    })
    this.notifyField = new ExitField({
      role: 'notify',
      label: 'Notify at',
      list: true,
      onInput: (text) => this.change(() => (this.notify = text)),
      onUnit: (unit) => this.setExitUnit('notify', unit),
      onPreset: (i) => this.notifyPreset(NOTIFY_MULTIPLES[i]),
      onClear: () => this.clearExit('notify'),
      onEnter: press
    })

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
    this.resetButton = kbtn('Reset', () => this.reset(), ['quiet'], 'Back to a market order with no price, stop, target, trail, breakeven, notifications or note')
    foot.append(oneClickLabel, this.resetButton)

    this.element.append(
      head,
      this.sides.element,
      this.typeControl.element,
      this.priceField.element,
      this.sizeBlock,
      this.stopField.element,
      this.targetField.element,
      this.trailField.element,
      this.breakevenField.element,
      this.notifyField.element,
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
        const text = stepLevelText(this.textOf(role), this.protectMode(), role, direction, big, levelBasis(this.side, plan))
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
    return draftOf(this.key, this.fields(), plan, tradePrefs())
  }

  setLevel(role: 'entry' | 'stop' | 'target', price: number): void {
    if (role === 'entry') {
      // Dropped off the market, a market order becomes a limit or a stop by which side it lands on.
      const entry = entryAt(this.side, price, this.session.snapshot.quotes[this.key], this.info())
      if (entry === null) return
      this.type = entry.type
      this.price = entry.price
      this.priceField.write(this.price)
    } else {
      this.writeLevel(role, levelText(price, this.protectMode(), levelBasis(this.side, this.plan())), false)
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
    return restingProblem(this.fields(), this.session.snapshot.quotes[this.key], this.info().precision)
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
    const mode = this.sizeMode()
    const n = enteredSize(text, mode)
    this.error = ''
    this.arming.disarm()
    if (n !== null) setTradePrefs({ [SIZE_SPECS[mode].pref]: n })
    else this.refresh()
  }

  private stepSize(direction: 1 | -1, big: boolean): void {
    const mode = this.sizeMode()
    const spec = SIZE_SPECS[mode]
    const next = steppedSize(mode, tradePrefs(), this.info(), direction, big)
    if (next === null) return
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
    this.trail = { distance: '', start: '', step: '' }
    this.breakeven = { trigger: '', lock: '' }
    this.notify = ''
    this.writeExits()
    this.error = ''
    this.refresh()
  }

  // -- exit management ------------------------------------------------------------------------------

  /** The stored unit for an exit, or the nearest one this position allows. */
  private exitUnit(role: ExitRole, basis: ExitBasis): ExitUnit {
    return exitUnitFor(role, tradePrefs(), basis)
  }

  /** Every exit field shows what the ticket holds (after a reset, a unit change or a preset). */
  private writeExits(): void {
    this.trailField.write(this.trail.distance)
    this.trailField.writeExtra(0, this.trail.start)
    this.trailField.writeExtra(1, this.trail.step)
    this.breakevenField.write(this.breakeven.trigger)
    this.breakevenField.writeExtra(0, this.breakeven.lock)
    this.notifyField.write(this.notify)
  }

  private clearExit(role: ExitRole): void {
    if (role === 'trail') this.trail = { distance: '', start: '', step: '' }
    else if (role === 'breakeven') this.breakeven = { trigger: '', lock: '' }
    else this.notify = ''
    this.writeExits()
    this.change(() => {})
  }

  private stepExit(role: 'trail' | 'breakeven', direction: 1 | -1, big: boolean): void {
    const basis = this.plan().exits
    const unit = this.exitUnit(role, basis)
    const info = this.info()
    const current = role === 'trail' ? this.trail.distance : this.breakeven.trigger
    const next = stepExitText(current, unit, info, direction, big, defaultExit(unit, info), unit === 'pips' ? 0.1 : 0)
    if (Number(next) <= 0) return
    if (role === 'trail') this.trail.distance = next
    else this.breakeven.trigger = next
    this.writeExits()
    this.change(() => {})
  }

  /** Switching an exit's unit restates what was typed -- the same distances, the new way. */
  private setExitUnit(role: ExitRole, next: ExitUnit): void {
    const basis = this.plan().exits
    const from = this.exitUnit(role, basis)
    if (exitUnitRefusal(next, basis) !== null) {
      this.refresh()
      return
    }
    setTradePrefs({ [EXIT_PREF[role]]: next })
    if (from === next) return
    const restate = (text: string, allow: { zero?: boolean; negative?: boolean } = {}): string => restateDistance(text, from, next, basis, allow)
    if (role === 'trail') {
      this.trail = { distance: restate(this.trail.distance), start: restate(this.trail.start, { zero: true }), step: restate(this.trail.step) }
    } else if (role === 'breakeven') {
      this.breakeven = { trigger: restate(this.breakeven.trigger), lock: restate(this.breakeven.lock, { zero: true, negative: true }) }
    } else {
      this.notify = restateMilestones(this.notify, from, next, basis)
    }
    this.writeExits()
    this.change(() => {})
  }

  private trailPreset(i: number): void {
    const basis = this.plan().exits
    const distance = trailPresetDistance(i, basis)
    if (distance === null) return
    this.trail.distance = exitText(distance, this.exitUnit('trail', basis), basis)
    this.writeExits()
    this.change(() => {})
  }

  private breakevenPreset(): void {
    const basis = this.plan().exits
    if (basis.risk === null) return
    this.breakeven.trigger = exitText(basis.risk, this.exitUnit('breakeven', basis), basis)
    this.writeExits()
    this.change(() => {})
  }

  /** A multiple of R, stated in the notify unit, put in the list or taken out of it. */
  private notifyPreset(multiple: number): void {
    const basis = this.plan().exits
    const value = notifyValue(multiple, this.exitUnit('notify', basis), basis)
    if (value === null) return
    this.notify = toggleMilestone(this.notify, value)
    this.writeExits()
    this.change(() => {})
  }

  private renderExits(plan: OrderPlan, quote: { bid: number; ask: number } | undefined): void {
    const basis = plan.exits
    const refusals = Object.fromEntries(EXIT_UNITS.map(([u]) => [u, exitUnitRefusal(u, basis)]))
    const rRefusal = exitUnitRefusal('r', basis)
    const atrRefusal = exitUnitRefusal('atr', basis)
    const note = (unit: ExitUnit): Array<{ text: string; tone: '' }> => {
      const size = unitSize(unit, basis)
      if (size === null) return []
      if (unit === 'atr' && basis.atr) return [{ text: `ATR(${basis.atr.period}, ${basis.atr.interval}) ${distanceWords(basis.atr.value, basis.info)}`, tone: '' }]
      if (unit === 'r') return [{ text: `1R ${distanceWords(size, basis.info)}`, tone: '' }]
      return []
    }
    const mark = this.type === 'market' && quote ? (this.side === 'buy' ? quote.bid : quote.ask) : null

    const trailUnit = this.exitUnit('trail', basis)
    this.trailField.update({
      text: this.trail.distance,
      placeholder: 'none',
      unit: trailUnit,
      unitRefusals: refusals,
      readout: plan.trail ? [...trailReadout(plan.trail, trailUnit, basis, mark, plan.stop ?? null), ...note(trailUnit)] : [],
      presets: [0, 1].map((i) => ({
        text: i === 0 ? '1R' : '2 ATR',
        title: i === 0 ? "Trail at the stop loss's distance" : `Trail at twice the ATR${basis.atr ? `(${basis.atr.period}) of the ${basis.atr.interval} chart` : ''}`,
        refusal: i === 0 ? rRefusal : atrRefusal,
        active: atTrailPreset(i, plan)
      })),
      removable: this.trail.distance !== '',
      problem: plan.problems.trail ?? null,
      pending: false,
      stepRefusal: plan.entry === null ? 'No price yet' : null,
      extras: [
        { text: this.trail.start, placeholder: 'fill' },
        { text: this.trail.step, placeholder: 'any' }
      ]
    })

    const beUnit = this.exitUnit('breakeven', basis)
    this.breakevenField.update({
      text: this.breakeven.trigger,
      placeholder: 'none',
      unit: beUnit,
      unitRefusals: refusals,
      readout: plan.breakeven ? [...breakevenReadout(plan.breakeven, basis), ...breakevenWarning(this.side, plan), ...note(beUnit)] : [],
      presets: [{ text: '1R', title: 'Move the stop to the entry once the trade is 1R in profit', refusal: rRefusal }],
      removable: this.breakeven.trigger !== '',
      problem: plan.problems.breakeven ?? null,
      pending: false,
      stepRefusal: plan.entry === null ? 'No price yet' : null,
      extras: [{ text: this.breakeven.lock, placeholder: '0' }]
    })

    const notifyUnit = this.exitUnit('notify', basis)
    const listed = milestoneValues(this.notify)
    this.notifyField.update({
      text: this.notify,
      placeholder: notifyUnit === 'r' ? 'e.g. 1, 2, -0.5' : 'none',
      unit: notifyUnit,
      unitRefusals: refusals,
      readout: plan.milestones.length > 0 ? [...milestonesReadout(plan.milestones, basis), ...note(notifyUnit)] : [],
      presets: NOTIFY_MULTIPLES.map((multiple) => {
        const value = notifyValue(multiple, notifyUnit, basis)
        return {
          text: `${multiple}R`,
          title: `Notify the first time the trade is ${multiple}R in profit (click again to remove)`,
          refusal: rRefusal,
          active: value !== null && listed.includes(value)
        }
      }),
      removable: this.notify !== '',
      problem: plan.problems.notify ?? null,
      pending: false
    })
  }

  // -- modes --------------------------------------------------------------------------------------

  private info(): InstrumentInfo {
    return this.ctx.instrumentFor(this.key)
  }

  /** The stored way of sizing, or units where this instrument does not allow it. */
  private sizeMode(): SizeMode {
    return usableSizeMode(tradePrefs(), this.info())
  }

  private pricing(): PricingContext {
    const s = this.session.snapshot
    return pricingContext(this.key, this.info(), s.account, s.quotes[this.key], s.quotes)
  }

  /** The stored unit for stops and targets, or the nearest one this instrument and size allow. */
  private protectMode(): ProtectMode {
    return protectModeFor(tradePrefs(), this.pricing())
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

  private restate(plan: OrderPlan, to: ProtectMode): void {
    const basis = levelBasis(this.side, plan)
    if (plan.stop !== undefined) this.writeLevel('stop', levelText(plan.stop, to, basis), false)
    if (plan.target !== undefined) this.writeLevel('target', levelText(plan.target, to, basis), false)
  }

  private setSizeMode(next: SizeMode): void {
    if (sizeRefusal(next, this.info()) !== null) {
      this.refresh()
      return
    }
    const plan = this.plan()
    // The size the order has now, stated the new way, so switching does not change the order.
    const carried = plan.units !== null && plan.units > 0 && plan.entry !== null ? sizeAs(next, this.side, plan) : null
    if (carried !== null) setTradePrefs({ [SIZE_SPECS[next].pref]: carried })
    // Sizing from the stop, a stop stated as a share of the balance is re-stated in pips or price first.
    if (sizedByStop(next) && this.protectMode() === 'percent') this.restate(plan, this.info().pipSize !== null ? 'pips' : 'price')
    this.error = ''
    this.arming.disarm()
    const value = carried ?? Number(tradePrefs()[SIZE_SPECS[next].pref])
    this.sizeField.write(tidy(value, SIZE_SPECS[next].digits))
    setTradePrefs({ sizeMode: next })
  }

  // -- presets ------------------------------------------------------------------------------------

  private riskStop(): void {
    const plan = this.plan()
    const level = riskStopLevel(this.side, tradePrefs(), plan)
    if (level !== null) this.writeLevel('stop', levelText(level, this.protectMode(), levelBasis(this.side, plan)))
  }

  private targetAtRatio(ratio: number): void {
    const plan = this.plan()
    const target = targetAt(this.side, plan, ratio)
    if (target === null) return
    this.writeLevel('target', levelText(target, this.protectMode(), levelBasis(this.side, plan)), false)
    setTradePrefs({ rewardRatio: ratio })
  }

  // -- the order as it would be sent --------------------------------------------------------------

  /** What is typed, as order.ts plans it. */
  private fields(): OrderFields {
    return {
      side: this.side,
      type: this.type,
      price: this.price,
      stopLoss: this.stopLoss,
      takeProfit: this.takeProfit,
      trail: this.trail,
      breakeven: this.breakeven,
      notify: this.notify,
      note: this.note
    }
  }

  private plan(): OrderPlan {
    const s = this.session.snapshot
    return planOrder(this.fields(), {
      info: this.info(),
      quote: s.quotes[this.key],
      ctx: this.pricing(),
      prefs: tradePrefs(),
      ready: this.session.ready,
      atr: this.ctx.activeAtr?.() ?? null
    })
  }

  private refresh(): void {
    const s = this.session.snapshot
    const info = this.info()
    const prefs = tradePrefs()
    const quote = s.quotes[this.key]
    const plan = this.plan()
    const { ctx } = plan
    const precision = info.precision
    const basis = levelBasis(this.side, plan)
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
      unitRefusals: Object.fromEntries(SIZE_MODES.map((m) => [m, sizeRefusal(m, info)])),
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
      presets: [{ text: `Risk ${risk}`, title: `Put the stop where it loses ${risk} of the balance`, refusal: riskStopRefusal(prefs, plan) }],
      removable: this.stopLoss !== '',
      problem: plan.problems.stop ?? null,
      pending: false,
      stepRefusal: plan.entry === null ? 'No price yet' : null
    })
    const ratios = ratioRefusal(this.side, plan)
    this.targetField.update({
      text: this.takeProfit,
      placeholder: 'none',
      unit: mode,
      unitRefusals,
      readout: readout(plan.target),
      presets: REWARD_RATIOS.map((ratio) => ({
        text: `${ratio}R`,
        title: `Take profit at ${ratio}× the stop's distance`,
        refusal: ratios,
        active: atRatio(this.side, plan, ratio)
      })),
      removable: this.takeProfit !== '',
      problem: plan.problems.target ?? null,
      pending: false,
      stepRefusal: plan.entry === null ? 'No price yet' : null
    })

    // Figures: the same rows the card and the popup show for a working order.
    const rows = planFigures(this.side, plan)
    this.renderExits(plan, quote)

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
    this.resetButton.hidden =
      this.type === 'market' &&
      this.stopLoss === '' &&
      this.takeProfit === '' &&
      this.note === '' &&
      this.trail.distance === '' &&
      this.breakeven.trigger === '' &&
      this.notify === ''
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

  /** The input a field's problem is shown under, where Enter with that problem takes the focus. */
  private inputFor(slot: Exclude<Slot, 'general'>): HTMLInputElement {
    if (slot === 'price') return this.priceField.field.input
    if (slot === 'size') return this.sizeField.input
    if (slot === 'stop') return this.stopField.field.input
    if (slot === 'target') return this.targetField.field.input
    if (slot === 'trail') return this.trailField.input
    if (slot === 'breakeven') return this.breakevenField.input
    return this.notifyField.input
  }

  /** The button, or Enter: the first press arms it, the second sends -- or the first, one-click. */
  private press(): void {
    const plan = this.plan()
    const refusal = sendRefusal(plan)
    if (refusal !== null) {
      // A field's own problem is already under it: go there. Anything else is said at the bottom.
      const slot = problemSlot(plan.problems)
      const input = slot !== null && slot !== 'general' ? this.inputFor(slot) : null
      if (input) input.focus()
      else this.showError(refusal)
      return
    }
    if (!this.arming.press(armKey.place, tradePrefs().oneClick)) return
    void this.submit().catch(() => {})
  }

  private async submit(): Promise<void> {
    const plan = this.plan()
    if (!isSendable(plan)) {
      const problem = sendRefusal(plan) ?? 'Nothing to send'
      this.showError(problem)
      throw new Error(problem)
    }
    this.error = ''
    try {
      await this.session.watch(this.key)
      await this.session.placeOrder(orderRequest(this.key, this.fields(), plan))
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
