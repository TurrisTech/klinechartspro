import { afterAll, afterEach, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

// AN ANCHORED POPOVER in a real DOM (happy-dom), driven as a user drives it: the button toggles it,
// a press anywhere else or Escape closes it, and a press inside it or on the button does not. The
// DOM is registered for this file only and removed after it.

GlobalRegistrator.register({ url: 'http://test/' })
afterAll(() => GlobalRegistrator.unregister())

const { anchoredPopover } = await import('./popover')

/** A themed chart root holding the button, and a popover on it that counts its opens and closes. */
function mount(onOpen?: (panel: HTMLElement) => void) {
  const root = document.createElement('div')
  root.className = 'klinecharts-pro dark'
  const anchor = document.createElement('button')
  anchor.setAttribute('aria-expanded', 'false')
  root.appendChild(anchor)
  const outside = document.createElement('div')
  document.body.append(root, outside)
  const counts = { built: 0, closed: 0 }
  const popover = anchoredPopover(anchor, {
    build: () => {
      counts.built++
      const panel = document.createElement('div')
      panel.className = 'kc-popover wd-test-panel'
      panel.appendChild(document.createElement('button'))
      return panel
    },
    onOpen,
    onClose: () => counts.closed++
  })
  const panel = (): HTMLElement | null => document.querySelector<HTMLElement>('.wd-test-panel')
  const press = (target: Element): void => {
    target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
  }
  return { root, anchor, outside, popover, counts, panel, press }
}

/** Past the microtask the outside listener waits for. */
const settle = (): Promise<void> => new Promise((resolve) => queueMicrotask(resolve))

afterEach(() => {
  document.body.innerHTML = ''
})

test('the button opens it inside the themed root, fixed under the button, built afresh each time', () => {
  const opened: HTMLElement[] = []
  const m = mount((panel) => opened.push(panel))
  m.anchor.click()
  const panel = m.panel() as HTMLElement
  expect(panel.parentElement).toBe(m.root)
  expect(panel.style.position).toBe('fixed')
  // happy-dom lays nothing out: a zero rect, so the gap under it and the margin from the edge.
  expect(panel.style.top).toBe('6px')
  expect(panel.style.left).toBe('8px')
  expect(m.anchor.getAttribute('aria-expanded')).toBe('true')
  expect(opened).toEqual([panel])

  m.anchor.click()
  expect(m.panel()).toBeNull()
  expect(m.anchor.getAttribute('aria-expanded')).toBe('false')
  expect(m.counts.closed).toBe(1)

  m.anchor.click()
  expect(m.counts.built).toBe(2)
  expect(m.panel()).not.toBe(panel)
})

test('a press outside closes it; one inside it or on the button does not', async () => {
  const m = mount()
  m.anchor.click()
  await settle()
  m.press(m.panel()?.firstElementChild as Element)
  m.press(m.anchor)
  expect(m.panel()).not.toBeNull()
  m.press(m.outside)
  expect(m.panel()).toBeNull()
  expect(m.counts.closed).toBe(1)
  // Closed, it stops listening: another press closes nothing twice.
  m.press(m.outside)
  expect(m.counts.closed).toBe(1)
})

test('Escape closes it, and close() does too, once', () => {
  const m = mount()
  m.anchor.click()
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
  expect(m.panel()).toBeNull()
  m.anchor.click()
  m.popover.close()
  m.popover.close()
  expect(m.panel()).toBeNull()
  expect(m.counts.closed).toBe(2)
})

test('the press that opened it is not taken for an outside one', async () => {
  const m = mount()
  // The outside listener starts a microtask after the open, so a press in the same turn as the
  // click that opened it is not one.
  m.anchor.click()
  m.press(m.outside)
  expect(m.panel()).not.toBeNull()
  await settle()
  m.press(m.outside)
  expect(m.panel()).toBeNull()
})
