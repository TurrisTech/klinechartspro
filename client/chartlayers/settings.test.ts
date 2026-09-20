import { afterAll, afterEach, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

// THE SETTINGS PANEL's number fields, rendered into a real DOM (happy-dom) and typed into the
// way a user types into them. What they pin: a number field never claims a value the layer is
// not drawing with. The panel deliberately does not re-render a number field (it would steal
// the caret mid-keystroke), so the correction happens on 'change' -- blur or Enter -- and the
// box is left alone while 'input' fires.
//
// The DOM is registered for this file only and removed after it, so every other suite keeps
// the bare environment it was written for.

GlobalRegistrator.register({ url: 'http://test/' })
afterAll(() => GlobalRegistrator.unregister())

const { openSettingsPanel, settleNumber } = await import('./settings')
const { LAB_DEFAULTS, LAB_FIELDS } = await import('../arevlab/config')

interface Config {
  bars: number
  width: number
}

const DEFAULTS: Config = { bars: 100, width: 1 }

const FIELDS = [
  { kind: 'number' as const, key: 'bars', label: 'Window (bars)', min: 20, max: 5000, step: 10, integer: true },
  { kind: 'number' as const, key: 'width', label: 'Line width', min: 0.5, max: 4, step: 0.5 }
]

const open: Array<{ close(): void; anchor: HTMLElement }> = []
afterEach(() => {
  for (const panel of open.splice(0)) {
    panel.close()
    panel.anchor.remove()
  }
})

function panel(config: Config = { ...DEFAULTS }): {
  box(label: string): HTMLInputElement
  committed: Config[]
  config: Config
} {
  const anchor = document.createElement('div')
  document.body.appendChild(anchor)
  const committed: Config[] = []
  const handle = openSettingsPanel<Config>({
    anchor,
    title: 'Test layer',
    fields: FIELDS,
    config,
    defaults: { ...DEFAULTS },
    onChange: (next) => committed.push(structuredClone(next))
  })
  open.push({ close: () => handle.close(), anchor })
  const box = (label: string): HTMLInputElement => {
    const input = [...document.querySelectorAll('input[type=number]')].find(
      (el) => (el.previousElementSibling as HTMLElement | null)?.textContent === label
    )
    if (!input) throw new Error(`no number field labelled ${label}`)
    return input as HTMLInputElement
  }
  return { box, committed, config }
}

/** Typing, as the browser delivers it: one 'input' per keystroke, then 'change' on blur. */
function type(input: HTMLInputElement, text: string): void {
  input.value = text
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

function leave(input: HTMLInputElement): void {
  input.dispatchEvent(new Event('change', { bubbles: true }))
}

describe('settleNumber', () => {
  test('clamps to the field and rounds only an integer lever', () => {
    expect(settleNumber({ min: 20, max: 5000 }, 9999)).toBe(5000)
    expect(settleNumber({ min: 20, max: 5000 }, 1)).toBe(20)
    expect(settleNumber({ min: 0.5, max: 4 }, 2.5)).toBe(2.5)
    expect(settleNumber({ min: 20, max: 5000, integer: true }, 25.6)).toBe(26)
    expect(settleNumber({ min: 0.5, max: 4 }, 2.25)).toBe(2.25)
  })
})

describe('a number field states what the layer draws', () => {
  test('an over-range value is corrected in the box when the field is left', () => {
    const { box, committed } = panel()
    const bars = box('Window (bars)')
    type(bars, '9999')
    // Still exactly what was typed: correcting here would fight the caret.
    expect(bars.value).toBe('9999')
    expect(committed.at(-1)?.bars).toBe(5000)
    leave(bars)
    expect(bars.value).toBe('5000')
  })

  test('an under-range value is corrected the same way', () => {
    const { box } = panel()
    const bars = box('Window (bars)')
    type(bars, '2')
    leave(bars)
    expect(bars.value).toBe('20')
  })

  test('a value inside the range is left as typed and committed once', () => {
    const { box, committed } = panel()
    const width = box('Line width')
    type(width, '2.5')
    leave(width)
    expect(width.value).toBe('2.5')
    expect(committed.map((c) => c.width)).toEqual([2.5])
  })

  test('an emptied box settles back to the stored value, committing nothing', () => {
    const { box, committed } = panel()
    const bars = box('Window (bars)')
    type(bars, '')
    leave(bars)
    expect(bars.value).toBe('100')
    expect(committed).toEqual([])
  })

  test('typing towards a legal number passes through clamped values, as it always has', () => {
    // 500 into a min-20 field is typed as 5, 50, 500: the first keystroke is below the floor.
    // The chart follows what is typed (that is the point of the live preview), so it draws 20
    // for an instant -- but the box must not be rewritten to 20 under the typist's fingers.
    const { box, committed } = panel()
    const bars = box('Window (bars)')
    type(bars, '5')
    type(bars, '50')
    type(bars, '500')
    expect(bars.value).toBe('500')
    expect(committed.map((c) => c.bars)).toEqual([20, 50, 500])
    leave(bars)
    expect(bars.value).toBe('500')
  })
})

describe('the AREV lab passes its integer levers through', () => {
  test("a lab lever that rounds is declared integer to the panel", () => {
    const group = LAB_FIELDS[0]
    if (group?.kind !== 'group') throw new Error('expected a generation group')
    const settings = group.fields.find((f) => f.kind === 'group')
    if (settings?.kind !== 'group') throw new Error('expected a settings group')
    const byLabel = (label: string) => settings.fields.find((f) => 'label' in f && f.label === label)
    expect(byLabel('Min neighbours')).toMatchObject({ kind: 'number', integer: true })
    expect(byLabel('Window (bars)')).toMatchObject({ kind: 'number', integer: true })
    // A lever that is genuinely fractional must NOT be rounded to 1.
    expect(byLabel('Line width')).toMatchObject({ kind: 'number' })
    expect(byLabel('Line width')).not.toMatchObject({ integer: true })
    expect(LAB_DEFAULTS.generations.arev21.lineWidth).toBeLessThan(2)
  })
})
