import { afterAll, expect, test } from 'bun:test'
import { GlobalRegistrator } from '@happy-dom/global-registrator'

// The theme the chart is mounted in, as chrome outside its root reads it. A real DOM (happy-dom),
// registered for this file only.

GlobalRegistrator.register({ url: 'http://test/' })
afterAll(() => GlobalRegistrator.unregister())

const { chartTheme } = await import('./theme')

test("'dark' while a dark chart is mounted, '' for a light one or none", () => {
  expect(chartTheme()).toBe('')
  const chart = document.createElement('div')
  chart.className = 'klinecharts-pro'
  document.body.appendChild(chart)
  expect(chartTheme()).toBe('')
  chart.classList.add('dark')
  expect(chartTheme()).toBe('dark')
  chart.remove()
  expect(chartTheme()).toBe('')
})
