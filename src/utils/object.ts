/**
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at

 * http://www.apache.org/licenses/LICENSE-2.0

 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// Small plain-object helpers shared between ChartPane (style application) and the shell's
// settings/indicator-settings dialogs (display-side cloning). Kept dependency-free on
// purpose -- both call sites need this before klinecharts or Svelte state exist.

export function clone<T>(value: T): T {
  if (Array.isArray(value)) return value.map(clone) as T
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, clone(child)])
    ) as T
  }
  return value
}

// Writes `value` at a dotted path inside `target`, creating intermediate objects as needed.
// Used to build a minimal klinecharts `setStyles` patch from a single settings-dialog field.
export function setByPath(target: object, path: string, value: unknown): void {
  const keys = path.split('.')
  let current = target as Record<string, unknown>
  for (const key of keys.slice(0, -1)) {
    const child = current[key]
    if (!child || typeof child !== 'object' || Array.isArray(child)) current[key] = {}
    current = current[key] as Record<string, unknown>
  }
  current[keys.at(-1) as string] = value
}
