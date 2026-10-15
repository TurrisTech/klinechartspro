// THE LAB'S EXPRESSION LANGUAGE -- what a rule slot is written in when its presets are not
// enough: "the child went at least half an ATR further than its parent", "the root is a 1D or
// an 8h signal", "the graph has taken no entry yet".
//
//   (child.price - parent.price) * dir > 0.5 * atr(14)
//   root.tf >= tf('8h') and graph.entries == 0
//
// A CLOSED grammar, parsed here and evaluated by walking the tree -- never `eval`, never a
// `Function`: numbers, 'strings', true/false, dotted names the slot offers, the operators
// below and the functions the slot lists. Anything else is refused when it is typed, with the
// place it went wrong, so a strategy that cannot be evaluated is never saved.
//
//   precedence, loosest first:   or ||   and &&   not !   < <= > >= == !=   + -   * / %   unary -
//
// Values are numbers, booleans and strings, and one more: UNKNOWN (`undefined`) -- a field the
// slot has no value for here (a root has no parent; an indicator still warming up). Unknown
// propagates through arithmetic and comparisons, and the logic is Kleene's, so `false and ?` is
// false and `true or ?` is true. A condition HOLDS only when it is exactly `true`: unknown never
// passes, the same rule the alert condition language keeps (client/alerts/conditions.ts).
//
// PURE: no data, no DOM. What a name or a function MEANS is the caller's (`ExprEnv`); this
// module only knows how to read and combine them.

export type ExprValue = number | boolean | string | undefined

export type Ast =
  | { k: 'num'; v: number; at: number }
  | { k: 'str'; v: string; at: number }
  | { k: 'bool'; v: boolean; at: number }
  | { k: 'id'; name: string; at: number }
  | { k: 'un'; op: '-' | 'not'; a: Ast; at: number }
  | { k: 'bin'; op: BinOp; a: Ast; b: Ast; at: number }
  | { k: 'call'; name: string; args: Ast[]; at: number }

export type BinOp = 'or' | 'and' | '<' | '<=' | '>' | '>=' | '==' | '!=' | '+' | '-' | '*' | '/' | '%'

export class ExprError extends Error {
  constructor(
    message: string,
    /** Character offset the problem was found at. */
    readonly at: number
  ) {
    super(message)
    this.name = 'ExprError'
  }
}

/** A name a slot offers, and what it means -- shown in the slot's field list. */
export interface FieldSpec {
  name: string
  doc: string
}

/** A function a slot offers. `literal` functions take literal arguments only, because the
 * runner has to know what they read BEFORE anything is evaluated (which bars to fetch). */
export interface FnSpec {
  name: string
  /** How it is called, for the field list: `atr(period, 'tf')`. */
  signature: string
  doc: string
  minArgs: number
  maxArgs: number
  literal?: boolean
}

/** What a slot's expressions may read. A `prefixes` entry admits any `prefix.<name>`: a signal
 * carries the fields its plugin wrote (`p`, `n`, `centre`), which are not known until it is read. */
export interface ExprScope {
  fields: readonly FieldSpec[]
  prefixes?: readonly string[]
  functions: readonly FnSpec[]
}

/** What evaluation reads names and calls through. */
export interface ExprEnv {
  get(name: string): ExprValue
  call(name: string, args: ExprValue[]): ExprValue
}

// -- the functions every slot has --------------------------------------------------------------

export const COMMON_FUNCTIONS: readonly FnSpec[] = [
  { name: 'abs', signature: 'abs(x)', doc: 'Absolute value', minArgs: 1, maxArgs: 1 },
  { name: 'min', signature: 'min(a, b, …)', doc: 'The smallest', minArgs: 1, maxArgs: 16 },
  { name: 'max', signature: 'max(a, b, …)', doc: 'The largest', minArgs: 1, maxArgs: 16 },
  { name: 'round', signature: 'round(x, digits)', doc: 'Rounded, to `digits` decimals (0 if left out)', minArgs: 1, maxArgs: 2 },
  { name: 'tf', signature: "tf('8h')", doc: 'A timeframe in minutes, to compare with a .tf field', minArgs: 1, maxArgs: 1, literal: true }
]

/** Evaluated here rather than by the caller: they need nothing but their arguments. */
function common(name: string, args: ExprValue[]): ExprValue | typeof NOT_COMMON {
  const nums = (): number[] | null => (args.every((a) => typeof a === 'number' && Number.isFinite(a)) ? (args as number[]) : null)
  switch (name) {
    case 'abs': {
      const n = nums()
      return n ? Math.abs(n[0]) : undefined
    }
    case 'min': {
      const n = nums()
      return n ? Math.min(...n) : undefined
    }
    case 'max': {
      const n = nums()
      return n ? Math.max(...n) : undefined
    }
    case 'round': {
      const n = nums()
      if (!n) return undefined
      const f = 10 ** Math.max(0, Math.min(12, Math.round(n[1] ?? 0)))
      return Math.round(n[0] * f) / f
    }
    case 'tf':
      return typeof args[0] === 'string' ? timeframeMinutes(args[0]) : undefined
    default:
      return NOT_COMMON
  }
}

const NOT_COMMON = Symbol('not-common')

const UNIT_MINUTES: Record<string, number> = { s: 1 / 60, m: 1, h: 60, D: 1440, W: 10080 }

/** `'8h'` -> 480. Calendar months and years have no fixed length and are refused. */
export function timeframeMinutes(code: string): number | undefined {
  const m = /^(\d+)([smhDW])$/.exec(code)
  if (!m) return undefined
  return Number(m[1]) * UNIT_MINUTES[m[2]]
}

// -- tokens ------------------------------------------------------------------------------------

type Token =
  | { t: 'num'; v: number; at: number }
  | { t: 'str'; v: string; at: number }
  | { t: 'id'; v: string; at: number }
  | { t: 'op'; v: string; at: number }
  | { t: 'end'; at: number }

const KEYWORDS = new Set(['and', 'or', 'not', 'true', 'false'])
const OPERATORS = ['<=', '>=', '==', '!=', '&&', '||', '<', '>', '+', '-', '*', '/', '%', '(', ')', ',', '!']

function tokenize(text: string): Token[] {
  const out: Token[] = []
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (/\s/.test(ch)) {
      i++
      continue
    }
    const at = i
    const num = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(text.slice(i))
    if (num) {
      out.push({ t: 'num', v: Number(num[0]), at })
      i += num[0].length
      // `3m` reads as a timeframe someone forgot to quote, not as 3 then m.
      if (/[A-Za-z_]/.test(text[i] ?? '')) throw new ExprError(`'${num[0]}${text[i]}…' -- a timeframe is written in quotes: tf('${num[0]}${text[i]}')`, at)
      continue
    }
    if (ch === "'" || ch === '"') {
      const end = text.indexOf(ch, i + 1)
      if (end < 0) throw new ExprError('a string is not closed', at)
      out.push({ t: 'str', v: text.slice(i + 1, end), at })
      i = end + 1
      continue
    }
    const id = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*/.exec(text.slice(i))
    if (id) {
      out.push({ t: 'id', v: id[0], at })
      i += id[0].length
      continue
    }
    const op = OPERATORS.find((o) => text.startsWith(o, i))
    if (op) {
      out.push({ t: 'op', v: op, at })
      i += op.length
      continue
    }
    if (ch === '=') throw new ExprError("'=' -- to compare, write '=='", at)
    throw new ExprError(`unexpected '${ch}'`, at)
  }
  out.push({ t: 'end', at: text.length })
  return out
}

// -- parser ------------------------------------------------------------------------------------

/** Parse, or throw `ExprError` saying where it went wrong. An empty text is refused too. */
export function parseExpr(text: string): Ast {
  const tokens = tokenize(text)
  let p = 0
  const peek = (): Token => tokens[p]
  const next = (): Token => tokens[p++]
  const isOp = (v: string): boolean => {
    const tok = peek()
    return tok.t === 'op' && tok.v === v
  }
  const isWord = (v: string): boolean => {
    const tok = peek()
    return tok.t === 'id' && tok.v === v
  }

  const orExpr = (): Ast => {
    let a = andExpr()
    while (isWord('or') || isOp('||')) {
      const at = next().at
      a = { k: 'bin', op: 'or', a, b: andExpr(), at }
    }
    return a
  }
  const andExpr = (): Ast => {
    let a = notExpr()
    while (isWord('and') || isOp('&&')) {
      const at = next().at
      a = { k: 'bin', op: 'and', a, b: notExpr(), at }
    }
    return a
  }
  const notExpr = (): Ast => {
    if (isWord('not') || isOp('!')) {
      const at = next().at
      return { k: 'un', op: 'not', a: notExpr(), at }
    }
    return compare()
  }
  const COMPARISONS = ['<', '<=', '>', '>=', '==', '!=']
  const compare = (): Ast => {
    const a = additive()
    const tok = peek()
    if (tok.t === 'op' && COMPARISONS.includes(tok.v)) {
      next()
      const b = additive()
      const after = peek()
      // `a < b < c` means something different in every language that allows it.
      if (after.t === 'op' && COMPARISONS.includes(after.v)) throw new ExprError('chain comparisons with and: a < b and b < c', after.at)
      return { k: 'bin', op: tok.v as BinOp, a, b, at: tok.at }
    }
    return a
  }
  const additive = (): Ast => {
    let a = multiplicative()
    while (isOp('+') || isOp('-')) {
      const tok = next() as { v: string; at: number }
      a = { k: 'bin', op: tok.v as BinOp, a, b: multiplicative(), at: tok.at }
    }
    return a
  }
  const multiplicative = (): Ast => {
    let a = unary()
    while (isOp('*') || isOp('/') || isOp('%')) {
      const tok = next() as { v: string; at: number }
      a = { k: 'bin', op: tok.v as BinOp, a, b: unary(), at: tok.at }
    }
    return a
  }
  const unary = (): Ast => {
    if (isOp('-')) {
      const at = next().at
      return { k: 'un', op: '-', a: unary(), at }
    }
    if (isOp('+')) {
      next()
      return unary()
    }
    return primary()
  }
  const primary = (): Ast => {
    const tok = next()
    if (tok.t === 'num') return { k: 'num', v: tok.v, at: tok.at }
    if (tok.t === 'str') return { k: 'str', v: tok.v, at: tok.at }
    if (tok.t === 'op' && tok.v === '(') {
      const inner = orExpr()
      if (!isOp(')')) throw new ExprError("a '(' is not closed", peek().at)
      next()
      return inner
    }
    if (tok.t === 'id') {
      if (tok.v === 'true' || tok.v === 'false') return { k: 'bool', v: tok.v === 'true', at: tok.at }
      if (KEYWORDS.has(tok.v)) throw new ExprError(`'${tok.v}' needs something before it`, tok.at)
      if (isOp('(')) {
        next()
        const args: Ast[] = []
        if (!isOp(')')) {
          args.push(orExpr())
          while (isOp(',')) {
            next()
            args.push(orExpr())
          }
        }
        if (!isOp(')')) throw new ExprError(`${tok.v}( is not closed`, peek().at)
        next()
        return { k: 'call', name: tok.v, args, at: tok.at }
      }
      return { k: 'id', name: tok.v, at: tok.at }
    }
    if (tok.t === 'end') throw new ExprError(p <= 1 ? 'empty' : 'it ends too soon', tok.at)
    throw new ExprError(`unexpected '${tok.v}'`, tok.at)
  }

  const ast = orExpr()
  const rest = peek()
  if (rest.t !== 'end') throw new ExprError(`unexpected '${rest.t === 'str' ? `'${rest.v}'` : String(rest.v)}'`, rest.at)
  return ast
}

// -- checking ----------------------------------------------------------------------------------

/** Every problem with `ast` against what the slot offers: names it does not have, functions it
 * does not have or called with the wrong number of arguments, and non-literal arguments to a
 * literal function. Empty when the expression can be evaluated. */
export function checkExpr(ast: Ast, scope: ExprScope): ExprError[] {
  const problems: ExprError[] = []
  const fields = new Set(scope.fields.map((f) => f.name))
  const functions = new Map([...COMMON_FUNCTIONS, ...scope.functions].map((f) => [f.name, f]))
  const walk = (node: Ast): void => {
    switch (node.k) {
      case 'id':
        if (!fields.has(node.name) && !(scope.prefixes ?? []).some((prefix) => node.name.startsWith(`${prefix}.`) && node.name.length > prefix.length + 1)) {
          problems.push(new ExprError(`no field '${node.name}' here`, node.at))
        }
        return
      case 'un':
        walk(node.a)
        return
      case 'bin':
        walk(node.a)
        walk(node.b)
        return
      case 'call': {
        const fn = functions.get(node.name)
        if (!fn) {
          problems.push(new ExprError(`no function '${node.name}' here`, node.at))
          return
        }
        if (node.args.length < fn.minArgs || node.args.length > fn.maxArgs) {
          const want = fn.minArgs === fn.maxArgs ? `${fn.minArgs}` : `${fn.minArgs} to ${fn.maxArgs}`
          problems.push(new ExprError(`${fn.signature} takes ${want} argument${fn.maxArgs === 1 ? '' : 's'}`, node.at))
        }
        if (fn.literal) {
          for (const arg of node.args) if (literalOf(arg) === undefined) problems.push(new ExprError(`${node.name}(…) takes numbers and 'quoted' words only`, arg.at))
        } else node.args.forEach(walk)
        return
      }
      default:
        return
    }
  }
  walk(ast)
  return problems
}

/** A literal argument's value (a negative number is a literal too), or undefined. */
export function literalOf(node: Ast): number | string | boolean | undefined {
  if (node.k === 'num' || node.k === 'str' || node.k === 'bool') return node.v
  if (node.k === 'un' && node.op === '-' && node.a.k === 'num') return -node.a.v
  return undefined
}

/** Every call to `name` in `ast`, with its literal arguments: what the runner must fetch. */
export function callsOf(ast: Ast, name: string): Array<Array<number | string | boolean>> {
  const out: Array<Array<number | string | boolean>> = []
  const walk = (node: Ast): void => {
    if (node.k === 'call') {
      if (node.name === name) out.push(node.args.map((a) => literalOf(a) as number | string | boolean))
      else node.args.forEach(walk)
    } else if (node.k === 'un') walk(node.a)
    else if (node.k === 'bin') {
      walk(node.a)
      walk(node.b)
    }
  }
  walk(ast)
  return out
}

/** Every name `ast` reads. */
export function namesOf(ast: Ast): Set<string> {
  const out = new Set<string>()
  const walk = (node: Ast): void => {
    if (node.k === 'id') out.add(node.name)
    else if (node.k === 'un') walk(node.a)
    else if (node.k === 'bin') {
      walk(node.a)
      walk(node.b)
    } else if (node.k === 'call') node.args.forEach(walk)
  }
  walk(ast)
  return out
}

// -- evaluation --------------------------------------------------------------------------------

function isNum(v: ExprValue): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

export function evalExpr(node: Ast, env: ExprEnv): ExprValue {
  switch (node.k) {
    case 'num':
    case 'str':
    case 'bool':
      return node.v
    case 'id': {
      const v = env.get(node.name)
      return typeof v === 'number' && !Number.isFinite(v) ? undefined : v
    }
    case 'un': {
      const a = evalExpr(node.a, env)
      if (node.op === '-') return isNum(a) ? -a : undefined
      return typeof a === 'boolean' ? !a : undefined
    }
    case 'call': {
      const args = node.args.map((arg) => literalOf(arg) ?? evalExpr(arg, env))
      const value = common(node.name, args)
      if (value !== NOT_COMMON) return value
      const out = env.call(node.name, args)
      return typeof out === 'number' && !Number.isFinite(out) ? undefined : out
    }
    case 'bin':
      return binary(node, env)
  }
}

function binary(node: Extract<Ast, { k: 'bin' }>, env: ExprEnv): ExprValue {
  if (node.op === 'and' || node.op === 'or') {
    // Kleene: a false (and) / a true (or) decides it whatever the other side is.
    const a = evalExpr(node.a, env)
    const decisive = node.op === 'or'
    if (a === decisive) return decisive
    const b = evalExpr(node.b, env)
    if (b === decisive) return decisive
    if (typeof a !== 'boolean' || typeof b !== 'boolean') return undefined
    return !decisive
  }
  const a = evalExpr(node.a, env)
  const b = evalExpr(node.b, env)
  if (node.op === '==' || node.op === '!=') {
    if (a === undefined || b === undefined) return undefined
    if (typeof a !== typeof b) return undefined
    return node.op === '==' ? a === b : a !== b
  }
  if (!isNum(a) || !isNum(b)) return undefined
  switch (node.op) {
    case '<':
      return a < b
    case '<=':
      return a <= b
    case '>':
      return a > b
    case '>=':
      return a >= b
    case '+':
      return a + b
    case '-':
      return a - b
    case '*':
      return a * b
    case '/':
      return b === 0 ? undefined : a / b
    case '%':
      return b === 0 ? undefined : a % b
  }
}

// -- compiled ------------------------------------------------------------------------------------

/** An expression ready to evaluate many times. */
export interface Compiled {
  readonly text: string
  readonly ast: Ast
  /** Whether it holds: exactly `true`. */
  holds(env: ExprEnv): boolean
  /** Its number, or undefined. */
  number(env: ExprEnv): number | undefined
}

/** Parse and check against `scope`; throws the first problem as an `ExprError`. */
export function compileExpr(text: string, scope: ExprScope): Compiled {
  const ast = parseExpr(text)
  const problems = checkExpr(ast, scope)
  if (problems.length > 0) throw problems[0]
  return {
    text,
    ast,
    holds: (env) => evalExpr(ast, env) === true,
    number: (env) => {
      const v = evalExpr(ast, env)
      return isNum(v) ? v : undefined
    }
  }
}

/** The problem with `text` against `scope`, as one line, or '' when there is none. */
export function exprProblem(text: string, scope: ExprScope): string {
  try {
    compileExpr(text, scope)
    return ''
  } catch (err) {
    if (err instanceof ExprError) return `${err.message} (at ${err.at + 1})`
    return String(err)
  }
}
