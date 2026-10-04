// THE FIRING POLICY -- what happens once the condition language has answered. Ported from
// `wdashboard_server/watch/registry.py`, and shared by every alert evaluated in this client:
// the replay's price watches (client/watch/local.ts) and the alert manager's client alerts
// (./timeline.ts). Kept honest by the `policy` cases of `fixtures/watch_cases.json`, which
// drive client/watch/local.ts through this.
//
//   trigger  edge   fires when the condition BECOMES true (true after false); the default
//            level  fires on every evaluation the condition holds
//   repeat   once   fires once, then stays fired until re-armed
//            always keeps watching, subject to the cooldown
//
// An unknowable answer (`null`, ./conditions.ts) changes nothing: it neither fires nor resets
// the edge, so a gap in the data cannot manufacture a fresh "became true".
//
// PURE: the state is handed in and mutated; the caller owns the clock.

export type Trigger = 'edge' | 'level'
export type Repeat = 'once' | 'always'

export interface PolicySettings {
  trigger: Trigger
  repeat: Repeat
  cooldownMs: number
}

export interface PolicyState {
  status: 'armed' | 'fired'
  /** The edge trigger's memory: the condition held at the last known evaluation. */
  wasTrue: boolean
  /** When it last fired SINCE THE CURRENT ARM, on the source's clock -- what the cooldown
   * reads. Separate from any "last fired" a client shows, because a re-arm is a deliberate
   * "watch this again, from now". */
  firedSinceArm: number | null
}

/** A freshly armed state: nothing remembered, nothing cooling. */
export function armedState(): PolicyState {
  return { status: 'armed', wasTrue: false, firedSinceArm: null }
}

/** (Re-)arm in place. The crossing baseline is not policy -- the caller seeds it. */
export function rearm(state: PolicyState): void {
  state.status = 'armed'
  state.wasTrue = false
  state.firedSinceArm = null
}

/** One evaluation's answer through the policy, at `at` on the source's clock. True when it
 * fires -- and the state then records the firing. The caller checks that the watch is armed
 * and enabled before asking. */
export function decide(state: PolicyState, settings: PolicySettings, result: boolean | null, at: number): boolean {
  if (result === null) return false
  if (!result) {
    state.wasTrue = false
    return false
  }
  const already = state.wasTrue
  state.wasTrue = true
  if (settings.trigger === 'edge' && already) return false
  if (cooling(state, settings, at)) return false
  state.firedSinceArm = at
  if (settings.repeat === 'once') state.status = 'fired'
  return true
}

/** Whether a firing is too soon after the last one. Only for a REPEATING watch (a one-shot
 * fires once, so a cooldown could only ever suppress the one firing it exists for) and only
 * for a firing since the current arm. */
export function cooling(state: PolicyState, settings: PolicySettings, at: number): boolean {
  if (settings.repeat !== 'always' || settings.cooldownMs <= 0) return false
  if (state.firedSinceArm === null) return false
  return at - state.firedSinceArm < settings.cooldownMs
}
