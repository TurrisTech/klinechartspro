import { afterAll, describe, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

// THE DOM KIT in a real DOM (happy-dom): the markup each builder makes -- which is what every
// surface built with it renders -- and the one event each reports. The DOM is registered for this
// file only and removed after it, so every other suite keeps the bare environment it was written
// for.

GlobalRegistrator.register({ url: 'http://test/' })
afterAll(() => GlobalRegistrator.unregister())

const { button, el, iconButton, input, select } = await import('./dom')

describe('el', () => {
  test('an element with its classes, and no text unless given', () => {
    const node = el('div', 'wd-a wd-b')
    expect(node.outerHTML).toBe('<div class="wd-a wd-b"></div>')
  })

  test('an empty class list is still written, as every copy it replaced wrote it', () => {
    expect(el('span', '').outerHTML).toBe('<span class=""></span>')
  })

  test('the text, when given, and the element typed by its tag', () => {
    const b = el('button', 'kc-button', 'Done')
    expect(b.outerHTML).toBe('<button class="kc-button">Done</button>')
    // Typed as the tag's element: no cast to reach a button's own properties.
    b.disabled = true
    expect(b.disabled).toBe(true)
    expect(el('p', 'note', '').textContent).toBe('')
  })
})

describe('button', () => {
  test('type="button", its classes and text, and the click', () => {
    let clicks = 0
    const b = button('kc-button wd-x', 'Delete', () => clicks++)
    expect(b.outerHTML).toBe('<button type="button" class="kc-button wd-x">Delete</button>')
    b.click()
    b.click()
    expect(clicks).toBe(2)
  })

  test('inside a form it submits nothing', () => {
    const form = document.createElement('form')
    let submitted = 0
    form.addEventListener('submit', (event) => {
      event.preventDefault()
      submitted++
    })
    const b = button('kc-button', 'Go', () => {})
    form.appendChild(b)
    document.body.appendChild(form)
    b.click()
    expect(submitted).toBe(0)
    form.remove()
  })
})

test('iconButton: the glyph, and its title for the pointer and the screen reader', () => {
  let clicks = 0
  const b = iconButton('×', 'Remove this rule', () => clicks++)
  expect(b.className).toBe('kc-button wd-alert-icon')
  expect(b.textContent).toBe('×')
  expect(b.title).toBe('Remove this rule')
  expect(b.getAttribute('aria-label')).toBe('Remove this rule')
  b.click()
  expect(clicks).toBe(1)
})

describe('select', () => {
  const options = [
    { value: 'a', label: 'Alpha' },
    { value: 'b', label: 'Beta' }
  ]

  test('the options in order, `kc-input` by default, on the value given', () => {
    const s = select(options, 'b', () => {})
    expect(s.className).toBe('kc-input')
    expect([...s.options].map((o) => [o.value, o.textContent])).toEqual([
      ['a', 'Alpha'],
      ['b', 'Beta']
    ])
    expect(s.value).toBe('b')
  })

  test('a change reports the value chosen', () => {
    const seen: string[] = []
    const s = select(options, 'a', (value) => seen.push(value))
    s.value = 'b'
    s.dispatchEvent(new Event('change'))
    expect(seen).toEqual(['b'])
  })

  test('a value it does not have chooses none -- or, with keepFirst, leaves the first showing', () => {
    expect(select(options, 'zz', () => {}).selectedIndex).toBe(-1)
    const kept = select(options, 'zz', () => {}, { className: 'kc-input wd-replay-select', keepFirst: true })
    expect(kept.className).toBe('kc-input wd-replay-select')
    expect(kept.value).toBe('a')
    expect(select(options, 'b', () => {}, { keepFirst: true }).value).toBe('b')
  })
})

test('input: its type, `kc-input`, the value, and every keystroke', () => {
  const seen: string[] = []
  const i = input('text', 'EURUSD', (value) => seen.push(value))
  expect(i.type).toBe('text')
  expect(i.className).toBe('kc-input')
  expect(i.value).toBe('EURUSD')
  i.value = 'GBPUSD'
  i.dispatchEvent(new Event('input'))
  expect(seen).toEqual(['GBPUSD'])
})
