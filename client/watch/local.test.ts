import { expect, test } from 'bun:test'
import { resolve } from 'node:path'
import { type LocalWatchSource, LocalWatchRegistry } from './local'
import type { Observation } from './evaluate'
import type { Condition, SourceField, WatchDraft } from './types'

// PARITY, part two. `watch_cases.json`'s `policy` cases are one watch driven through a script
// of events by the SERVER's registry, with what each step left behind recorded. Running them
// here is what says the replay's arming, seeding, edge memory, repeat and cooldown are the
// server's and not a second opinion.
//
// The fixture's source is deliberately neither `price` nor `bar`: these cases are about the
// registry's policy, which is the same whatever produces the observations.

const FIELDS: Array<[string, 'number' | 'text']> = [
  ['price', 'number'],
  ['close', 'number'],
  ['high', 'number'],
  ['low', 'number'],
  ['spread', 'number'],
  ['volume', 'number'],
  ['state', 'text'],
  ['signal', 'text']
]

class FixtureSource implements LocalWatchSource {
  readonly id = 'fixture'
  readonly title = 'Fixture'
  readonly description = ''
  readonly targetHint = 'TARGET'
  seed: Observation | null = null
  available(): boolean {
    return true
  }
  fields(): SourceField[] {
    return FIELDS.map(([name, kind]) => ({ name, label: name, kind, unit: null, description: '', choices: [] }))
  }
  normaliseTarget(target: string): string {
    const cleaned = target.trim()
    if (!cleaned) throw new Error('target is required')
    return cleaned
  }
  async current(): Promise<Observation | null> {
    return this.seed
  }
}

function observation(row: unknown): Observation {
  const out: Observation = {}
  for (const [name, value] of Object.entries(row as Record<string, unknown>)) {
    out[name] = typeof value === 'number' || typeof value === 'string' ? { value } : (value as Observation[string])
  }
  return out
}

interface Step {
  at?: number
  observation?: unknown
  seed?: unknown
  arm?: boolean
  update?: Partial<WatchDraft>
}

interface Snapshot {
  fired: boolean
  status: string
  fireCount: number
  wasTrue: boolean
  firedSinceArm: number | null
}

interface PolicyCase {
  name: string
  watch: { condition: Condition; name?: string; note?: string; trigger?: 'edge' | 'level'; repeat?: 'once' | 'always'; cooldownMs?: number; enabled?: boolean }
  seed: unknown
  steps: Step[]
  expect: Snapshot[]
}

const cases = ((await Bun.file(resolve(import.meta.dir, 'fixtures/watch_cases.json')).json()) as { policy: PolicyCase[] }).policy

const TARGET = 'TARGET'

async function run(policy: PolicyCase): Promise<Snapshot[]> {
  const source = new FixtureSource()
  const fired: number[] = []
  const registry = new LocalWatchRegistry({ sources: [source], onFire: () => fired.push(1) })
  if (policy.seed !== null && policy.seed !== undefined) source.seed = observation(policy.seed)
  const watch = await registry.create({
    source: source.id,
    target: TARGET,
    condition: policy.watch.condition,
    name: policy.watch.name ?? '',
    note: policy.watch.note ?? '',
    trigger: policy.watch.trigger ?? 'edge',
    repeat: policy.watch.repeat ?? 'once',
    cooldownMs: policy.watch.cooldownMs,
    enabled: policy.watch.enabled ?? true
  })
  const snap = (): Snapshot => {
    const state = registry.toState().find((row) => row.wire.id === watch.id)
    if (!state) throw new Error('the watch vanished')
    const current = registry.get(watch.id)
    if (!current) throw new Error('the watch vanished')
    return {
      fired: false,
      status: current.status,
      fireCount: current.fireCount,
      wasTrue: state.wasTrue,
      firedSinceArm: state.firedSinceArm
    }
  }
  const out: Snapshot[] = [snap()]
  for (const step of policy.steps) {
    const before = fired.length
    if (step.seed !== undefined) source.seed = observation(step.seed)
    if (step.arm) await registry.arm(watch.id)
    else if (step.update) await registry.update(watch.id, step.update)
    else if (step.observation !== undefined) {
      registry.onEvent(source.id, TARGET, step.at ?? 0, observation(step.observation))
    }
    out.push({ ...snap(), fired: fired.length > before })
  }
  return out
}

test('the policy fixtures load', () => {
  expect(cases.length).toBeGreaterThan(10)
})

for (const policy of cases) {
  test(`policy: ${policy.name}`, async () => {
    expect(await run(policy)).toEqual(policy.expect)
  })
}
