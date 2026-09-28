import { afterAll, describe, expect, test } from 'bun:test'
import type { PersistedLayout } from '../layout'

// What this file pins down: a wall is saved when the user presses Save and at no other time.
// Every change is a draft in memory (store.ts's header); these are the rules for when there is
// one, when it counts as unsaved work, and what Save and Revert do with it.
//
// `window` does not exist under bun, and client/config.ts reads it at MODULE LOAD (this module
// reaches it through ../capabilities and ../preferences) -- so it is installed before the
// dynamic import, as client/preferences.test.ts explains. The store's local mirror writes
// through `window.localStorage`, recorded here like the remote backend is.
const hadWindow = 'window' in globalThis
const local = new Map<string, string>()
;(globalThis as Record<string, unknown>).window = {
  location: { href: 'http://localhost/', origin: 'http://localhost' },
  localStorage: {
    getItem: (key: string) => local.get(key) ?? null,
    setItem: (key: string, value: string) => local.set(key, value),
    removeItem: (key: string) => local.delete(key)
  }
}

const { WorkspaceStore } = await import('./store')
const { layoutSettingsSignature } = await import('../layout')

afterAll(() => {
  if (!hadWindow) delete (globalThis as Record<string, unknown>).window
})

function layout(overrides: Partial<PersistedLayout> = {}): PersistedLayout {
  return {
    version: 1,
    preset: '1',
    active: 0,
    panes: [{ s: 'EURUSD', p: '1h', mi: ['MA'], si: ['VOL'], vw: { bs: 8, live: true } }],
    sync: { crosshair: true, time: true, auto: false, symbol: false, period: false },
    ...overrides
  }
}

function withPane(base: PersistedLayout, pane: Partial<PersistedLayout['panes'][number]>): PersistedLayout {
  return { ...base, panes: [{ ...base.panes[0], ...pane }] }
}

// Two workspaces, as a store loaded from a server would hold them. `writes` records every
// workspace DOCUMENT sent to the remote backend -- the index is written on every switch and is
// not a wall.
function setup() {
  local.clear()
  const writes: string[] = []
  const remote = {
    readAll: async () => ({}),
    write: (key: string) => {
      if (key.startsWith('workspace.')) writes.push(key)
    },
    remove: () => {}
  }
  const store = new WorkspaceStore(
    remote,
    [
      { id: 'a', name: 'Majors', updatedAt: 1, layout: layout(), indicatorParams: {} },
      { id: 'b', name: 'Metals', updatedAt: 1, layout: layout({ preset: '2h' }), indicatorParams: {} }
    ],
    'a'
  )
  let notified = 0
  store.onChange(() => {
    notified += 1
  })
  return { store, writes, notifications: () => notified }
}

describe('staging', () => {
  test('a change is a draft, and nothing is written', () => {
    const { store, writes } = setup()
    const changed = withPane(layout(), { mi: ['MA', 'EMA'] })
    store.stageActiveLayout(changed)
    expect(writes).toEqual([])
    expect(local.size).toBe(0)
    expect(store.working()).toBe(changed)
    expect(store.active().layout).toEqual(layout())
    expect(store.hasDraft()).toBe(true)
    expect(store.isDirty()).toBe(true)
    expect(store.hasUnsavedChanges()).toBe(true)
  })

  test('where the panes look is a draft Save can write, but not unsaved work', () => {
    const { store } = setup()
    store.stageActiveLayout(withPane(layout({ active: 0 }), { vw: { bs: 12, live: false, at: 1_700_000_000_000, f: 0.5 } }))
    expect(store.hasDraft()).toBe(true)
    expect(store.isDirty()).toBe(false)
    expect(store.hasUnsavedChanges()).toBe(false)
  })

  test('the price axis type rides in the view and still counts as a setting', () => {
    const { store } = setup()
    store.stageActiveLayout(withPane(layout(), { vw: { bs: 8, live: true, y: { t: 'logarithm' } } }))
    expect(store.isDirty()).toBe(true)
  })

  test('undoing a change by hand leaves no draft', () => {
    const { store, notifications } = setup()
    store.stageActiveLayout(withPane(layout(), { p: '4h' }))
    store.stageActiveLayout(layout())
    expect(store.hasDraft()).toBe(false)
    expect(store.isDirty()).toBe(false)
    expect(notifications()).toBe(2)
  })

  test('staging the same wall again notifies nobody', () => {
    const { store, notifications } = setup()
    store.stageActiveLayout(withPane(layout(), { p: '4h' }))
    store.stageActiveLayout(withPane(layout(), { p: '4h' }))
    expect(notifications()).toBe(1)
  })
})

describe('save', () => {
  test('writes the draft once, as the saved workspace', () => {
    const { store, writes } = setup()
    const changed = withPane(layout(), { si: ['VOL', 'RSI'] })
    store.stageActiveLayout(changed)
    expect(store.saveActive()).toBe(true)
    expect(writes).toEqual(['workspace.a'])
    expect(JSON.parse(local.get('wd.workspace.a') as string).layout).toEqual(changed)
    expect(store.active().layout).toBe(changed)
    expect(store.active().updatedAt).toBeGreaterThan(1)
    expect(store.hasDraft()).toBe(false)
    expect(store.isDirty()).toBe(false)
  })

  test('with no draft there is nothing to write', () => {
    const { store, writes } = setup()
    expect(store.saveActive()).toBe(false)
    expect(writes).toEqual([])
  })

  test('saves a view-only draft too', () => {
    const { store, writes } = setup()
    store.stageActiveLayout(layout({ active: 0, panes: [{ ...layout().panes[0], vw: { bs: 20, live: true } }] }))
    expect(store.saveActive()).toBe(true)
    expect(writes).toEqual(['workspace.a'])
  })
})

describe('revert', () => {
  test('drops the draft and writes nothing; the wall is rebuilt from what is saved', () => {
    const { store, writes } = setup()
    store.stageActiveLayout(withPane(layout(), { s: 'GBPUSD' }))
    store.revertActive()
    expect(writes).toEqual([])
    expect(store.hasDraft()).toBe(false)
    expect(store.working()).toEqual(layout())
  })
})

describe('adopting a freshly mounted wall', () => {
  test('stands in for the stored bytes without writing them', () => {
    const { store, writes } = setup()
    // What hydrating an older document looks like: a sync switch it predates, now spelled out.
    const normalised = layout({ sync: { crosshair: true, time: true, auto: false, symbol: false, period: false } })
    store.adoptMountedLayout(normalised)
    expect(writes).toEqual([])
    expect(store.active().layout).toBe(normalised)
    store.stageActiveLayout(normalised)
    expect(store.hasDraft()).toBe(false)
  })

  test('drops a draft that turns out to be the same wall', () => {
    const { store } = setup()
    const reported = withPane(layout(), { mi: [] })
    store.stageActiveLayout(reported)
    store.adoptMountedLayout(reported)
    expect(store.hasDraft()).toBe(false)
  })
})

describe('drafts across the set', () => {
  test('survive a switch, and still count as unsaved from another workspace', () => {
    const { store } = setup()
    const changed = withPane(layout(), { p: '15m' })
    store.stageActiveLayout(changed)
    store.setActive('b')
    expect(store.isDirty()).toBe(false)
    expect(store.isDirty('a')).toBe(true)
    expect(store.hasUnsavedChanges()).toBe(true)
    store.setActive('a')
    expect(store.working()).toBe(changed)
  })

  test('a duplicate copies what is saved, never the draft', () => {
    const { store } = setup()
    store.stageActiveLayout(withPane(layout(), { p: '15m' }))
    const copy = store.duplicate('a')
    expect(copy?.layout).toEqual(layout())
  })

  test('deleting a workspace forgets its draft', () => {
    const { store } = setup()
    store.stageActiveLayout(withPane(layout(), { p: '15m' }))
    store.remove('a')
    expect(store.hasUnsavedChanges()).toBe(false)
  })
})

describe('layoutSettingsSignature', () => {
  test('ignores key order, the active pane and where the panes look', () => {
    const a = layout({ active: 0 })
    const b: PersistedLayout = {
      sync: { period: false, symbol: false, auto: false, time: true, crosshair: true },
      panes: [{ vw: { live: false, bs: 3, at: 5, f: 0.8 }, si: ['VOL'], mi: ['MA'], p: '1h', s: 'EURUSD' }],
      active: 3,
      preset: '1',
      version: 1
    }
    expect(layoutSettingsSignature(a)).toBe(layoutSettingsSignature(b))
  })

  test('a normal axis is the same as no axis setting at all', () => {
    const plain = layout()
    const normal = withPane(layout(), { vw: { bs: 8, live: true, y: { t: 'normal' } } })
    expect(layoutSettingsSignature(plain)).toBe(layoutSettingsSignature(normal))
  })
})
