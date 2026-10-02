// expr.js — the small expression language of derived quantities: window bounds
// (e.g. center `stimulusFrequency`, half width `0.01*stimulusFrequency` or
// `3*ResolutionBWs`) and formulas (`peak - floor`). Lexer + recursive-descent
// parser -> plain-object AST, a vectorized evaluator (each node is computed once
// over a whole Float64Array, never re-parsed per element), the units rules and
// a token-level rename. Pure, no imports: runs in the browser and in Node.
// The Python report script implements the same language — keep them in step.
//
// Syntax: numbers `12`, `1.5e6`, with an optional SI suffix `5k` `2.5M` `10u`
// (p n u µ μ m k K M G T); names `stimulusFrequency` or quoted `"odd name-1"`
// (a `"` directly followed by a letter, digit or _ belongs to the name, so a
// variable named a"b is written `"a"b"`); `+ - * / ^` (`**` = `^`,
// right-associative, binds tighter than unary minus: -a^2 = -(a^2));
// parentheses (at most MAX_DEPTH levels of parens / signs / ^ / calls, in the
// Python script too); the functions in FUNCTIONS; the constant `pi`.

export const FUNCTIONS = [
  { name: "abs", sig: "abs(x)", doc: "absolute value |x|" },
  { name: "sqrt", sig: "sqrt(x)", doc: "square root" },
  { name: "exp", sig: "exp(x)", doc: "e to the power x" },
  { name: "ln", sig: "ln(x)", doc: "natural logarithm" },
  { name: "log", sig: "log(x)", doc: "natural logarithm (same as ln)" },
  { name: "log10", sig: "log10(x)", doc: "base-10 logarithm" },
  { name: "floor", sig: "floor(x)", doc: "round down to an integer" },
  { name: "ceil", sig: "ceil(x)", doc: "round up to an integer" },
  { name: "round", sig: "round(x)", doc: "round half up: floor(x + 0.5)" },
  { name: "db2lin", sig: "db2lin(x)", doc: "dB to linear power: 10^(x/10)" },
  { name: "lin2db", sig: "lin2db(x)", doc: "linear power to dB: 10·log10(x) (NaN for x ≤ 0)" },
  { name: "pow", sig: "pow(a, b)", doc: "a to the power b (same as a^b)" },
  { name: "min", sig: "min(a, b, …)", doc: "smallest argument (NaN if any argument is NaN)" },
  { name: "max", sig: "max(a, b, …)", doc: "largest argument (NaN if any argument is NaN)" },
];
export const SI = { p: 1e-12, n: 1e-9, u: 1e-6, "µ": 1e-6, "μ": 1e-6, m: 1e-3,
  k: 1e3, K: 1e3, M: 1e6, G: 1e9, T: 1e12 };

export class ExprError extends Error {
  // reason = the bare message; pos = 0-based character index (-1: none)
  constructor(reason, pos) {
    const p = Number.isInteger(pos) && pos >= 0 ? pos : -1;
    super(p >= 0 ? `${reason} at position ${p}` : reason);
    this.name = "ExprError";
    this.reason = reason;
    this.pos = p;
  }
}

const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const MAX_DEPTH = 64;                         // nesting limit (parens, unary, ^, calls)
// [min, max] argument count
const ARITY = { abs: [1, 1], sqrt: [1, 1], exp: [1, 1], ln: [1, 1], log: [1, 1], log10: [1, 1],
  floor: [1, 1], ceil: [1, 1], round: [1, 1], db2lin: [1, 1], lin2db: [1, 1], pow: [2, 2],
  min: [1, Infinity], max: [1, Infinity] };
const RESERVED = new Set([...FUNCTIONS.map((f) => f.name), "pi"]);
const ID_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// ---- lexer -------------------------------------------------------------------
const NUM_RE = /(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/y;
const IDENT_RE = /[A-Za-z_][A-Za-z0-9_]*/y;
const NUM_TAIL = /[A-Za-z0-9_.µμ]/;     // may not follow a number
const ID_CHAR = /[A-Za-z0-9_]/;         // after a '"' inside a quoted name: not its end
const PUNCT = "+-*/^(),";
const charAt = (s, i) => String.fromCodePoint(s.codePointAt(i));

// tokens: {t:"num", value, text, pos, end} | {t:"name", name, quoted, pos, end}
// | {t:"op", op, text, pos, end}. lenient (for renaming): never throws — bad
// spans become {t:"bad"} tokens and are skipped by the caller.
function lex(src, lenient) {
  const toks = [];
  const n = src.length;
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\r" || c === "\n") { i++; continue; }
    if ((c >= "0" && c <= "9") || c === ".") {
      NUM_RE.lastIndex = i;
      const m = NUM_RE.exec(src);
      if (m) {
        let j = i + m[0].length;
        let value = parseFloat(m[0]);
        if (j < n && hasOwn(SI, src[j])) { value *= SI[src[j]]; j++; }   // one IEEE multiply
        if (j < n && NUM_TAIL.test(src[j])) {
          let e = j;
          while (e < n && NUM_TAIL.test(src[e])) e++;
          if (!lenient) throw new ExprError(`invalid number '${src.slice(i, e)}'`, i);
          toks.push({ t: "bad", pos: i, end: e });
          i = e;
          continue;
        }
        toks.push({ t: "num", value, text: src.slice(i, j), pos: i, end: j });
        i = j;
        continue;
      }
    }
    if (c === '"') {
      // the name ends at the first '"' NOT directly followed by a letter,
      // digit or _ (such a quote is part of the name: "a"b" is the name a"b,
      // as a variable named a"b is quoted by quoteName)
      let k = src.indexOf('"', i + 1);
      while (k >= 0 && k + 1 < n && ID_CHAR.test(src[k + 1])) k = src.indexOf('"', k + 1);
      if (k < 0 || k === i + 1) {
        if (!lenient) throw new ExprError(k < 0 ? "unterminated quoted name" : "empty quoted name", i);
        toks.push({ t: "bad", pos: i, end: k < 0 ? n : k + 1 });
        i = k < 0 ? n : k + 1;
        continue;
      }
      toks.push({ t: "name", name: src.slice(i + 1, k), quoted: true, pos: i, end: k + 1 });
      i = k + 1;
      continue;
    }
    if ((c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || c === "_") {
      IDENT_RE.lastIndex = i;
      const name = IDENT_RE.exec(src)[0];
      toks.push({ t: "name", name, quoted: false, pos: i, end: i + name.length });
      i += name.length;
      continue;
    }
    if (c === "*" && src[i + 1] === "*") {
      toks.push({ t: "op", op: "^", text: "**", pos: i, end: i + 2 });
      i += 2;
      continue;
    }
    if (PUNCT.includes(c)) {
      toks.push({ t: "op", op: c, text: c, pos: i, end: i + 1 });
      i++;
      continue;
    }
    if (!lenient) throw new ExprError(`unexpected character '${charAt(src, i)}'`, i);
    i += charAt(src, i).length;
  }
  return toks;
}

// ---- parser ------------------------------------------------------------------
// AST nodes (plain objects):
//   {type:"num", value, text, pos}   {type:"name", name, quoted, pos}
//   {type:"unary", op:"-"|"+", arg, pos}   {type:"bin", op:"+"|"-"|"*"|"/"|"^", left, right, pos}
//   {type:"call", fn, args:[...], pos}
export function parseExpr(text) {
  const src = typeof text === "string" ? text : String(text ?? "");
  const toks = lex(src, false);
  if (!toks.length) throw new ExprError("empty expression", -1);
  let p = 0, depth = 0;
  const peek = () => toks[p];
  const isOp = (t, op) => !!t && t.t === "op" && t.op === op;
  const desc = (t) => (t.t === "num" ? `number '${t.text}'`
    : t.t === "name" ? `name '${t.quoted ? `"${t.name}"` : t.name}'` : `'${t.text}'`);
  const unexpected = (t) => (t ? new ExprError(`unexpected ${desc(t)}`, t.pos)
    : new ExprError("unexpected end of expression", src.length));
  const expect = (op, what) => {
    const t = peek();
    if (isOp(t, op)) { p++; return t; }
    throw t ? new ExprError(`expected ${what} but found ${desc(t)}`, t.pos)
      : new ExprError(`missing '${op}'`, src.length);
  };
  const enter = (t) => { if (++depth > MAX_DEPTH) throw new ExprError("expression is nested too deeply", t.pos); };

  function expr() {
    let left = term();
    while (isOp(peek(), "+") || isOp(peek(), "-")) {
      const t = toks[p++];
      left = { type: "bin", op: t.op, left, right: term(), pos: t.pos };
    }
    return left;
  }
  function term() {
    let left = unary();
    while (isOp(peek(), "*") || isOp(peek(), "/")) {
      const t = toks[p++];
      left = { type: "bin", op: t.op, left, right: unary(), pos: t.pos };
    }
    return left;
  }
  function unary() {
    const t = peek();
    if (isOp(t, "-") || isOp(t, "+")) {
      p++; enter(t);
      const arg = unary();
      depth--;
      return { type: "unary", op: t.op, arg, pos: t.pos };
    }
    return power();
  }
  function power() {
    const base = atom();
    const t = peek();
    if (!isOp(t, "^")) return base;
    p++; enter(t);
    const exp = unary();                       // 2^-x; a^b^c = a^(b^c)
    depth--;
    return { type: "bin", op: "^", left: base, right: exp, pos: t.pos };
  }
  function atom() {
    const t = peek();
    if (!t) throw unexpected(null);
    if (t.t === "num") { p++; return { type: "num", value: t.value, text: t.text, pos: t.pos }; }
    if (t.t === "name") {
      p++;
      if (t.quoted || !isOp(peek(), "(")) return { type: "name", name: t.name, quoted: t.quoted, pos: t.pos };
      // NAME '(' -> a function call
      if (!hasOwn(ARITY, t.name)) throw new ExprError(`unknown function '${t.name}'`, t.pos);
      p++; enter(t);
      const args = [];
      if (!isOp(peek(), ")")) {
        args.push(expr());
        while (isOp(peek(), ",")) { p++; args.push(expr()); }
      }
      expect(")", "',' or ')'");
      depth--;
      const [lo, hi] = ARITY[t.name];
      if (args.length < lo || args.length > hi) {
        const need = lo === hi ? `${lo} argument${lo === 1 ? "" : "s"}` : `at least ${lo} argument`;
        throw new ExprError(`${t.name}() takes ${need}, not ${args.length}`, t.pos);
      }
      return { type: "call", fn: t.name, args, pos: t.pos };
    }
    if (isOp(t, "(")) {
      p++; enter(t);
      const e = expr();
      expect(")", "')'");
      depth--;
      return e;
    }
    throw unexpected(t);
  }

  const ast = expr();
  if (p < toks.length) throw unexpected(toks[p]);
  return ast;
}

// [{name, pos, quoted}] of every referenced name, first appearance first
// (depth-first, left before right = text order)
export function exprRefs(ast) {
  const out = [], seen = new Set();
  const walk = (nd) => {
    if (!nd) return;
    if (nd.type === "name") {
      if (!seen.has(nd.name)) { seen.add(nd.name); out.push({ name: nd.name, pos: nd.pos, quoted: nd.quoted }); }
    } else if (nd.type === "unary") walk(nd.arg);
    else if (nd.type === "bin") { walk(nd.left); walk(nd.right); }
    else if (nd.type === "call") nd.args.forEach(walk);
  };
  walk(ast);
  return out;
}
export function exprNames(ast) { return exprRefs(ast).map((r) => r.name); }

// ---- evaluation ----------------------------------------------------------------
// C99 pow: 1 when a == 1 or b == 0 (even with NaN), 1 for (-1)^±Inf; else Math.pow
const cpow = (a, b) => (a === 1 || b === 0 || (a === -1 && (b === Infinity || b === -Infinity))
  ? 1 : Math.pow(a, b));
const UNARY = {
  abs: Math.abs, sqrt: Math.sqrt, exp: Math.exp, ln: Math.log, log: Math.log, log10: Math.log10,
  floor: Math.floor, ceil: Math.ceil, round: (x) => Math.floor(x + 0.5),
  db2lin: (x) => cpow(10, x / 10), lin2db: (x) => (x > 0 ? 10 * Math.log10(x) : NaN),
};

// a op b where each is a number (scalar) or a Float64Array(n); the result is a
// number only when both are numbers, else written into out(a, b) (a fresh
// array, or an operand that is a temporary of this evaluation)
function binop(op, a, b, n, alloc) {
  const sa = typeof a === "number", sb = typeof b === "number";
  if (sa && sb) {
    switch (op) {
      case "+": return a + b;
      case "-": return a - b;
      case "*": return a * b;
      case "/": return a / b;
      default: return cpow(a, b);
    }
  }
  const out = alloc(a, b);
  switch (op) {
    case "+":
      if (sa) for (let i = 0; i < n; i++) out[i] = a + b[i];
      else if (sb) for (let i = 0; i < n; i++) out[i] = a[i] + b;
      else for (let i = 0; i < n; i++) out[i] = a[i] + b[i];
      break;
    case "-":
      if (sa) for (let i = 0; i < n; i++) out[i] = a - b[i];
      else if (sb) for (let i = 0; i < n; i++) out[i] = a[i] - b;
      else for (let i = 0; i < n; i++) out[i] = a[i] - b[i];
      break;
    case "*":
      if (sa) for (let i = 0; i < n; i++) out[i] = a * b[i];
      else if (sb) for (let i = 0; i < n; i++) out[i] = a[i] * b;
      else for (let i = 0; i < n; i++) out[i] = a[i] * b[i];
      break;
    case "/":
      if (sa) for (let i = 0; i < n; i++) out[i] = a / b[i];
      else if (sb) for (let i = 0; i < n; i++) out[i] = a[i] / b;
      else for (let i = 0; i < n; i++) out[i] = a[i] / b[i];
      break;
    default:
      for (let i = 0; i < n; i++) out[i] = cpow(sa ? a : a[i], sb ? b : b[i]);
  }
  return out;
}

function call(fn, args, n, alloc) {
  if (fn === "pow") return binop("^", args[0], args[1], n, alloc);
  if (fn === "min" || fn === "max") {            // Math.min/max propagate NaN
    const f = fn === "min" ? Math.min : Math.max;
    if (args.every((a) => typeof a === "number")) return f(...args);
    const a0 = args[0];
    const out = alloc(a0, 0);                    // never another argument (the fold reads them)
    if (typeof a0 === "number") out.fill(a0); else if (out !== a0) out.set(a0);
    for (let j = 1; j < args.length; j++) {
      const a = args[j];
      if (typeof a === "number") for (let i = 0; i < n; i++) out[i] = f(out[i], a);
      else for (let i = 0; i < n; i++) out[i] = f(out[i], a[i]);
    }
    return out;
  }
  const x = args[0];
  if (typeof x === "number") return UNARY[fn](x);
  // one monomorphic loop per function (a shared loop calling f(x[i]) goes
  // megamorphic and is several times slower)
  const out = alloc(x, 0);
  switch (fn) {
    case "abs": for (let i = 0; i < n; i++) out[i] = Math.abs(x[i]); break;
    case "sqrt": for (let i = 0; i < n; i++) out[i] = Math.sqrt(x[i]); break;
    case "exp": for (let i = 0; i < n; i++) out[i] = Math.exp(x[i]); break;
    case "ln": case "log": for (let i = 0; i < n; i++) out[i] = Math.log(x[i]); break;
    case "log10": for (let i = 0; i < n; i++) out[i] = Math.log10(x[i]); break;
    case "floor": for (let i = 0; i < n; i++) out[i] = Math.floor(x[i]); break;
    case "ceil": for (let i = 0; i < n; i++) out[i] = Math.ceil(x[i]); break;
    case "round": for (let i = 0; i < n; i++) out[i] = Math.floor(x[i] + 0.5); break;
    case "db2lin": for (let i = 0; i < n; i++) out[i] = Math.pow(10, x[i] / 10); break;   // = cpow(10, ·)
    case "lin2db": for (let i = 0; i < n; i++) { const v = x[i]; out[i] = v > 0 ? 10 * Math.log10(v) : NaN; } break;
    default: { const f = UNARY[fn]; for (let i = 0; i < n; i++) out[i] = f(x[i]); }
  }
  return out;
}

// Evaluate over n elements. lookup(name) -> Float64Array(n) (any array-like
// of length n) | number (broadcast) | null/undefined (unknown: `pi` then falls
// back to the constant, anything else is an "unknown name" error). Each lookup
// is called once per distinct name. Returns a fresh Float64Array(n).
export function evalExpr(ast, lookup, n) {
  const len = Math.max(0, Math.floor(Number(n) || 0));
  const cache = new Map();
  const given = new Set();                       // arrays owned by the caller
  // Every array an op creates is a temporary consumed by exactly one parent
  // (the AST is a tree), so an op may overwrite a temporary operand in place
  // instead of allocating (elementwise: out[i] depends on operand[i] only).
  const temps = new Set();
  const alloc = (a, b) => {
    if (temps.has(a)) return a;
    if (temps.has(b)) return b;
    const out = new Float64Array(len);
    temps.add(out);
    return out;
  };
  const get = (nd) => {
    if (cache.has(nd.name)) return cache.get(nd.name);
    let v = lookup(nd.name);
    if (v === undefined || v === null) {
      if (nd.name !== "pi") throw new ExprError(`unknown name '${nd.name}'`, nd.pos);
      v = Math.PI;
    } else if (typeof v !== "number") {
      if (typeof v.length !== "number") throw new ExprError(`'${nd.name}' has no numeric values`, nd.pos);
      v = v instanceof Float64Array ? v : Float64Array.from(v, Number);
      if (v.length !== len) throw new ExprError(`'${nd.name}' has ${v.length} values, expected ${len}`, nd.pos);
      given.add(v);
    }
    cache.set(nd.name, v);
    return v;
  };
  const ev = (nd) => {
    switch (nd.type) {
      case "num": return nd.value;
      case "name": return get(nd);
      case "unary": {
        const a = ev(nd.arg);
        if (nd.op === "+") return a;
        if (typeof a === "number") return -a;
        const out = alloc(a, 0);
        for (let i = 0; i < len; i++) out[i] = -a[i];
        return out;
      }
      case "bin": { const a = ev(nd.left); return binop(nd.op, a, ev(nd.right), len, alloc); }
      case "call": return call(nd.fn, nd.args.map(ev), len, alloc);
      default: throw new ExprError("invalid expression tree", -1);
    }
  };
  const r = ev(ast);
  if (typeof r === "number") return new Float64Array(len).fill(r);
  return given.has(r) ? Float64Array.from(r) : r;
}

// ---- units ---------------------------------------------------------------------
const trimU = (u) => String(u ?? "").trim();
const normU = (u) => trimU(u).toLowerCase();
const isDbU = (u) => normU(u).includes("db");
// a number literal, possibly with one unary minus: its value, else null
function literal(nd) {
  if (nd.type === "num") return nd.value;
  if (nd.type === "unary" && nd.op === "-" && nd.arg.type === "num") return -nd.arg.value;
  return null;
}
const powUnits = (ua, bnode) => {
  const b = literal(bnode);
  return ua && b !== null ? `${ua}^${String(b)}` : "";
};

// units of the expression's result; unitsOf(name) -> units string
export function exprUnits(ast, unitsOf) {
  const U = (nd) => {
    switch (nd.type) {
      case "num": return "";
      case "name": return trimU(unitsOf(nd.name));
      case "unary": return U(nd.arg);
      case "bin": {
        const ua = U(nd.left);
        if (nd.op === "^") return powUnits(ua, nd.right);
        const ub = U(nd.right);
        switch (nd.op) {
          case "+":
            if (!ua) return ub;
            if (!ub) return ua;
            if (isDbU(ua) && isDbU(ub)) return normU(ua) === "db" ? ub : ua;
            return ua;
          case "-":
            if (isDbU(ua) && isDbU(ub) && normU(ua) === normU(ub)) return "dB";
            if (!ub) return ua;
            if (!ua) return ub;
            return ua;
          case "*": return ua && ub ? `${ua}·${ub}` : (ua || ub);
          default:                                // "/"
            if (ua && normU(ua) === normU(ub)) return "";
            if (ua && ub) return `${ua}/${ub}`;
            if (ua) return ua;
            return ub ? `1/${ub}` : "";
        }
      }
      case "call": {
        const f = nd.fn;
        if (f === "pow") return powUnits(U(nd.args[0]), nd.args[1]);
        if (f === "abs" || f === "floor" || f === "ceil" || f === "round" || f === "min" || f === "max") {
          for (const a of nd.args) { const u = U(a); if (u) return u; }
          return "";
        }
        if (f === "lin2db") {
          const nu = normU(U(nd.args[0]));
          return nu === "mw" ? "dBm" : nu === "w" ? "dBW" : "dB";
        }
        if (f === "db2lin") {
          const ux = U(nd.args[0]), nu = normU(ux);
          return nu === "dbm" ? "mW" : nu === "dbw" ? "W" : nu === "db" ? "" : (ux ? `lin(${ux})` : "");
        }
        return "";                               // sqrt exp ln log log10
      }
      default: return "";
    }
  };
  return U(ast);
}

// ---- names ---------------------------------------------------------------------
// a name as it must be written in an expression: bare when identifier-safe and
// not a function name / `pi`, else "quoted"
export function quoteName(name) {
  const s = String(name ?? "");
  return ID_RE.test(s) && !RESERVED.has(s) ? s : `"${s}"`;
}
export function num(x) { return String(x); }

// Rename every reference to oldName (bare or quoted; never a function name in
// a call) to quoteName(newName); everything else stays byte-identical. Works
// on text that does not parse (the bad spans are left alone).
export function renameInExpr(text, oldName, newName) {
  const src = typeof text === "string" ? text : String(text ?? "");
  if (!oldName || oldName === newName) return src;
  const toks = lex(src, true);
  let out = "", last = 0;
  toks.forEach((t, i) => {
    if (t.t !== "name" || t.name !== oldName) return;
    const nx = toks[i + 1];
    if (!t.quoted && nx && nx.t === "op" && nx.op === "(") return;     // a function call
    out += src.slice(last, t.pos) + quoteName(newName);
    last = t.end;
  });
  return last ? out + src.slice(last) : src;
}
