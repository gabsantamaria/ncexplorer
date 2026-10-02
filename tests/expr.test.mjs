// expr.test.mjs — tests for docs/js/expr.js (the expression language of
// derived quantities: window bounds and formulas).
//   node tests/expr.test.mjs            (exit code 1 on any failure)
// lexer (numbers, SI suffixes, quoted names), grammar (precedence and
// associativity), every function, C99 pow, vectorized evaluation, errors with
// positions, the units rules (SPEC_EXPR E1), renameInExpr, quoteName / num.

import { check, summary, moduleUrl } from "./node_env.mjs";

const E = await import(moduleUrl("expr.js"));
const { parseExpr, evalExpr, exprNames, exprRefs, exprUnits, quoteName, num, renameInExpr, ExprError, FUNCTIONS, SI } = E;

const isNaNum = (v) => typeof v === "number" && Number.isNaN(v);
const J = (x) => JSON.stringify(x);
// evaluate a constant expression (scalar), or with variables {name: number | array}
const ev = (text, vars = {}, n = 1) => {
  const r = evalExpr(parseExpr(text), (k) => (Object.prototype.hasOwnProperty.call(vars, k) ? vars[k] : undefined), n);
  return n === 1 ? r[0] : Array.from(r);
};
const is = (a, b) => Object.is(a, b) || (isNaNum(a) && isNaNum(b));
const err = (text) => { try { parseExpr(text); return null; } catch (e) { return e; } };
const evErr = (text, vars) => { try { ev(text, vars); return null; } catch (e) { return e; } };

// ---- lexer: numbers + SI suffixes ------------------------------------------------
{
  const nums = [["12", 12], ["1.5", 1.5], [".5", 0.5], ["1.", 1], ["1e3", 1000], ["1E-3", 0.001], ["2.5e+2", 250],
    ["1.e5", 1e5], ["0", 0], ["007", 7], ["123456789012345678901234567890", 1.2345678901234568e29]];
  for (const [t, v] of nums) check(`lex: number ${t}`, ev(t) === v, ev(t));
  const si = [["5k", 5 * 1e3], ["2.5M", 2.5 * 1e6], ["10u", 10 * 1e-6], ["3µ", 3 * 1e-6], ["3μ", 3 * 1e-6],
    ["7p", 7 * 1e-12], ["7n", 7 * 1e-9], ["20m", 20 * 1e-3], ["4K", 4 * 1e3], ["1G", 1e9], ["0.25G", 0.25 * 1e9],
    ["2T", 2 * 1e12], ["2e3k", 2e3 * 1e3], ["1.5e-3M", 1.5e-3 * 1e6], [".1k", 0.1 * 1e3]];
  for (const [t, v] of si) check(`lex: SI ${t} = parseFloat * factor`, ev(t) === v, [ev(t), v]);
  check("lex: SI table", J(SI) === J({ p: 1e-12, n: 1e-9, u: 1e-6, "µ": 1e-6, "μ": 1e-6, m: 1e-3, k: 1e3, K: 1e3,
    M: 1e6, G: 1e9, T: 1e12 }));
  check("lex: a suffix is one IEEE multiply (no rounding of the product)", ev("0.1k") === 0.1 * 1000 && ev("3u") === 3 * 1e-6);
  for (const [t, pos] of [["5ms", 0], ["2e", 0], ["1.2.3", 0], ["3kk", 0], ["2pi", 0], ["5_", 0], ["1µm", 0],
    ["5µμ", 0], ["1e5e", 0], ["x + 12abc", 4], ["2 * 3x", 4], ["1..2", 0], ["5k.", 0], ["1e3_", 0]]) {
    const e = err(t);
    check(`lex: invalid number ${J(t)}`, e instanceof ExprError && /^invalid number/.test(e.message) && e.pos === pos,
      e && [e.message, e.pos]);
  }
  check("lex: invalid number message shows the token", err("x + 5ms*2").message === "invalid number '5ms' at position 4");
  check("lex: a number may be followed by a quote / paren (the grammar rejects it)", err('2"a"').message === "unexpected name '\"a\"' at position 1"
    && err("2(3)").message === "unexpected '(' at position 1" && ev("2*(3)") === 6);
  check("lex: whitespace (space tab CR LF) ignored", ev(" \t1\r\n+\n 2 ") === 3);
  check("lex: ** is ^", ev("2**3") === 8 && ev("2 ** 3 ** 2") === 512);
  for (const [t, c, pos] of [["a $ b", "$", 2], ["a # b", "#", 2], ["a % 2", "%", 2], ["a + b", " ", 1], ["a = b", "=", 2],
    ["[1]", "[", 0], ["a;b", ";", 1], ["'a'", "'", 0], ["1 . 2", ".", 2], ["2 @", "@", 2], ["\u{1F600}", "\u{1F600}", 0]]) {
    const e = err(t);
    check(`lex: unexpected character ${J(c)}`, e && e.message === `unexpected character '${c}' at position ${pos}` && e.pos === pos,
      e && e.message);
  }
  // quoted names
  check("lex: quoted name", J(exprNames(parseExpr('"my var-1" + 1'))) === '["my var-1"]' && ev('"a.b" * 2', { "a.b": 3 }) === 6);
  check("lex: quoted name with spaces/odd chars, and next to operators", ev('"x y"+"z-w"', { "x y": 1, "z-w": 2 }) === 3);
  check("lex: quoted function name is a reference", ev('"max" + 1', { max: 4 }) === 5 && J(exprNames(parseExpr('"max"'))) === '["max"]');
  check("lex: empty quoted name", err('""').message === "empty quoted name at position 0" && err('1 + ""').pos === 4);
  check("lex: unterminated quoted name", err('a + "abc').message === "unterminated quoted name at position 4");
  check("lex: quoted name followed by ( is not a call", /unexpected '\('/.test(err('"abs"(2)').message));
  // a '"' directly followed by a letter / digit / _ belongs to the name, so a
  // variable named a"b (legal in NetCDF; migrated bc9812f centers quote it as
  // "a"b") can be referenced; other closing quotes are unchanged
  check("lex: quoted name containing a quote", J(exprNames(parseExpr('"a"b" + 1'))) === J(['a"b'])
    && ev('2*"a"b"', { 'a"b': 4 }) === 8 && J(exprNames(parseExpr('"x"1_"*"y"'))) === J(['x"1_', "y"]));
  check("lex: closing quote rules", err('"a"b').message === "unterminated quoted name at position 0"
    && err('"a""b"').message === "unexpected name '\"b\"' at position 3" && err('"a"5').pos === 0
    && J(exprNames(parseExpr('"a"^2'))) === J(["a"]) && J(exprNames(parseExpr('("a")'))) === J(["a"]));
  check("lex: positions count UTF-16 units (as the Python script now does)", err('"\u{1F600}" + @').pos === 7);
}

// ---- grammar: precedence / associativity ------------------------------------------
{
  const cases = [["-2^2", -4], ["(-2)^2", 4], ["2^3^2", 512], ["(2^3)^2", 64], ["2^-1", 0.5], ["2*-3", -6], ["2--3", 5],
    ["1-2-3", -4], ["8/4/2", 1], ["2+3*4", 14], ["2*3^2", 18], ["-2**2", -4], ["+3", 3], ["2^-2^2", 2 ** -4], ["12/3*2", 8],
    ["-3^2*2", -18], ["2^+2", 4], ["- - 2", 2], ["2*(3+4)", 14], ["((((5))))", 5], ["-(2+3)^2", -25], ["2^3*2", 16],
    ["1/2/2", 0.25], ["2-3+4", 3], ["--2^2", 4], ["-2^-2", -0.25], ["10-2*3^2/9", 8]];
  for (const [t, v] of cases) check(`grammar: ${t} = ${v}`, ev(t) === v, ev(t));
  check("grammar: -a^2 = -(a^2)", ev("-a^2", { a: 3 }) === -9);
  check("grammar: a^b^c right-assoc AST", J(parseExpr("a^b^c")) === J({ type: "bin", op: "^",
    left: { type: "name", name: "a", quoted: false, pos: 0 },
    right: { type: "bin", op: "^", left: { type: "name", name: "b", quoted: false, pos: 2 },
      right: { type: "name", name: "c", quoted: false, pos: 4 }, pos: 3 }, pos: 1 }));
  check("grammar: unary minus binds looser than ^ (AST)", (() => { const a = parseExpr("-x^2"); return a.type === "unary"
    && a.arg.type === "bin" && a.arg.op === "^"; })());
  check("grammar: 2^-x (signed exponent)", ev("2^-x", { x: 3 }) === 0.125);
  check("grammar: the constant pi", ev("pi") === Math.PI && ev("2*pi") === 2 * Math.PI && ev("pi", { pi: 3 }) === 3);
  check("grammar: name ( is a call, even with whitespace", ev("abs (-2)") === 2 && /unknown function 'x'/.test(err("x (2)").message));
  check("grammar: empty", err("").message === "empty expression" && err("").pos === -1 && err(" \n\t ").pos === -1);
  const errs = [["1 +", "unexpected end of expression at position 3", 3], ["(1 + 2", "missing ')' at position 6", 6],
    ["1 2", "unexpected number '2' at position 2", 2], [")", "unexpected ')' at position 0", 0],
    ["a b", "unexpected name 'b' at position 2", 2], ['a "b c"', "unexpected name '\"b c\"' at position 2", 2],
    ["max(1 2)", "expected ',' or ')' but found number '2' at position 6", 6], ["*2", "unexpected '*' at position 0", 0],
    ["(", "unexpected end of expression at position 1", 1], ["2*", "unexpected end of expression at position 2", 2],
    ["(1))", "unexpected ')' at position 3", 3], ["(1 2)", "expected ')' but found number '2' at position 3", 3],
    ["max(1,)", "unexpected ')' at position 6", 6], ["max(,1)", "unexpected ',' at position 4", 4], ["1,2", "unexpected ',' at position 1", 1],
    ["2^", "unexpected end of expression at position 2", 2], ["a**/b", "unexpected '/' at position 3", 3],
    ["foo(1)", "unknown function 'foo' at position 0", 0], ["pi(2)", "unknown function 'pi' at position 0", 0],
    ["1 + Max(2)", "unknown function 'Max' at position 4", 4]];
  for (const [t, msg, pos] of errs) {
    const e = err(t);
    check(`grammar error: ${J(t)}`, e instanceof ExprError && e.message === msg && e.pos === pos, e && [e.message, e.pos]);
  }
  check("grammar: ExprError fields", (() => { const e = err("1 +"); return e instanceof Error && e.name === "ExprError"
    && e.reason === "unexpected end of expression" && e.pos === 3; })());
  check("grammar: nesting limit", /nested too deeply/.test(err("(".repeat(100) + "1" + ")".repeat(100)).message)
    && ev("(".repeat(60) + "1" + ")".repeat(60)) === 1 && /nested too deeply/.test(err("-".repeat(80) + "1").message)
    && ev("-".repeat(60) + "1") === 1);
  check("grammar: long flat expressions are fine", ev(Array(400).fill("1").join("+")) === 400);
  check("grammar: non-string input", ev(42) === 42 && err(null).message === "empty expression");
}

// ---- functions -------------------------------------------------------------------
{
  check("functions: list/order/doc", FUNCTIONS.map((f) => f.name).join() === "abs,sqrt,exp,ln,log,log10,floor,ceil,round,db2lin,lin2db,pow,min,max"
    && FUNCTIONS.every((f) => f.sig.startsWith(f.name + "(") && f.doc && !/[<>]/.test(f.doc)));
  const cases = [["abs(-3)", 3], ["abs(-0)", 0], ["sqrt(16)", 4], ["sqrt(-1)", NaN], ["exp(0)", 1], ["exp(1)", Math.E],
    ["ln(1)", 0], ["ln(exp(2))", 2], ["log(1)", 0], ["log(0)", -Infinity], ["log10(1000)", 3], ["log10(-1)", NaN],
    ["floor(-1.5)", -2], ["floor(2.7)", 2], ["ceil(-1.5)", -1], ["ceil(2.1)", 3],
    ["round(2.5)", 3], ["round(-2.5)", -2], ["round(-0.5)", 0], ["round(1.4999)", 1], ["round(0.49999999999999994)", 1],
    ["db2lin(10)", 10], ["db2lin(-30)", Math.pow(10, -3)], ["db2lin(0)", 1], ["lin2db(100)", 20], ["lin2db(1)", 0],
    ["lin2db(0)", NaN], ["lin2db(-1)", NaN], ["pow(2, 10)", 1024], ["pow(2, 0.5)", Math.SQRT2], ["min(3, 1, 2)", 1],
    ["max(3, 1, 2)", 3], ["min(5)", 5], ["max(-1)", -1], ["min(1, lin2db(0))", NaN], ["max(lin2db(0), 1)", NaN],
    ["max(1, 2, lin2db(0), 3)", NaN], ["min(1/0, 2)", 2], ["max(-1/0, -5)", -5]];
  for (const [t, v] of cases) check(`functions: ${t}`, is(ev(t), v), ev(t));
  check("functions: round = floor(x + 0.5) exactly", [0.5, 1.5, -1.5, 2.4999999999999996, -0.49999999999999994, 4503599627370495.5]
    .every((x) => is(ev("round(x)", { x }), Math.floor(x + 0.5))));
  check("functions: lin2db(x) = 10*log10(x) bitwise", [1e-12, 0.5, 3, 1e300].every((x) => ev("lin2db(x)", { x }) === 10 * Math.log10(x)));
  check("functions: db2lin(x) = pow(10, x/10) bitwise", [-123.4, -3, 0.1, 27].every((x) => ev("db2lin(x)", { x }) === Math.pow(10, x / 10)));
  for (const [t, msg] of [["abs()", "abs() takes 1 argument, not 0 at position 0"], ["abs(1, 2)", "abs() takes 1 argument, not 2 at position 0"],
    ["pow(1)", "pow() takes 2 arguments, not 1 at position 0"], ["pow(1, 2, 3)", "pow() takes 2 arguments, not 3 at position 0"],
    ["1 + min()", "min() takes at least 1 argument, not 0 at position 4"], ["max()", "max() takes at least 1 argument, not 0 at position 0"],
    ["log10(1, 2)", "log10() takes 1 argument, not 2 at position 0"]]) {
    check(`functions: arity ${t}`, err(t) && err(t).message === msg, err(t) && err(t).message);
  }
  // C99 pow (both a^b and pow(a, b))
  const NaN_ = "lin2db(0)", INF = "(1/0)";
  const c99 = [[`1^${NaN_}`, 1], [`pow(1, ${NaN_})`, 1], [`${NaN_}^0`, 1], [`pow(${NaN_}, -0)`, 1], [`(-1)^${INF}`, 1],
    [`(-1)^-${INF}`, 1], [`pow(-1, -${INF})`, 1], [`1^${INF}`, 1], [`1^-${INF}`, 1], [`2^${NaN_}`, NaN], [`${NaN_}^1`, NaN],
    ["(-8)^(1/3)", NaN], ["0^-1", Infinity], ["(0*-1)^-1", -Infinity], ["0^0", 1], [`${INF}^0`, 1], [`0^${INF}`, 0],
    ["(-2)^3", -8], ["(-2)^2", 4], ["2^1024", Infinity], [`(0.5)^${INF}`, 0], [`2^-${INF}`, 0]];
  for (const [t, v] of c99) check(`pow C99: ${t}`, is(ev(t), v), ev(t));
  check("pow C99: vectorized too", J(ev("a^b", { a: [1, NaN, -1, 2], b: [NaN, 0, Infinity, 3] }, 4)) === "[1,1,1,8]"
    && J(ev("pow(a, b)", { a: [1, NaN, -1, 2], b: [NaN, 0, -Infinity, 3] }, 4)) === "[1,1,1,8]");
  check("arithmetic: IEEE division by zero / NaN", ev("1/0") === Infinity && ev("-1/0") === -Infinity && isNaNum(ev("0/0"))
    && isNaNum(ev(`1 + ${NaN_}`)));
}

// ---- vectorized evaluation -----------------------------------------------------
{
  const a = Float64Array.of(1, 2, 3, 4), b = [10, 20, 30, 40];
  const vars = { a, b, s: 2 };
  const v = (t) => ev(t, vars, 4);
  check("eval: array op array", J(v("a + b")) === "[11,22,33,44]" && J(v("b - a")) === "[9,18,27,36]"
    && J(v("a * b")) === "[10,40,90,160]" && J(v("b / a")) === "[10,10,10,10]" && J(v("a ^ s")) === "[1,4,9,16]");
  check("eval: scalar op array / array op scalar", J(v("1 + a")) === "[2,3,4,5]" && J(v("a - 1")) === "[0,1,2,3]"
    && J(v("12 / a")) === "[12,6,4,3]" && J(v("2 ^ a")) === "[2,4,8,16]" && J(v("s*a")) === "[2,4,6,8]");
  check("eval: scalar-only expressions broadcast", J(v("s + 1")) === "[3,3,3,3]" && J(v("pi")) === J(Array(4).fill(Math.PI)));
  check("eval: unary / functions over arrays", J(v("-a")) === "[-1,-2,-3,-4]" && J(v("+a")) === "[1,2,3,4]"
    && J(v("min(a, 2.5, b)")) === "[1,2,2.5,2.5]" && J(v("max(a*a, 5)")) === "[5,5,9,16]" && J(v("abs(-a)")) === "[1,2,3,4]"
    && J(v("max(s, 3)")) === "[3,3,3,3]");
  check("eval: every function over arrays == scalar evaluation", FUNCTIONS.every((f) => {
    const text = f.name === "pow" ? "pow(x, y)" : (f.name === "min" || f.name === "max") ? `${f.name}(x, y, 0.5)` : `${f.name}(x)`;
    const xs = [-2.5, -1, -0, 0, 0.3, 1, 2.5, 100, NaN, Infinity], ys = [3, NaN, 0, -1, 2.5, Infinity, -0.5, 1, 2, 0];
    const vec = ev(text, { x: xs, y: ys }, xs.length);
    return xs.every((x, i) => is(vec[i], ev(text, { x, y: ys[i] })));
  }));
  const r1 = evalExpr(parseExpr("a"), (k) => (k === "a" ? a : undefined), 4);
  r1[0] = 99;
  check("eval: the result never aliases a lookup array", a[0] === 1 && r1 instanceof Float64Array);
  const r2 = evalExpr(parseExpr("+(a)"), (k) => (k === "a" ? a : undefined), 4);
  check("eval: unary plus of a lookup is copied too", r2 !== a && r2[3] === 4);
  check("eval: lookup arrays are never written (temporaries reused in place)", (() => {
    const x = Float64Array.of(1, 2, 3), y = Float64Array.of(4, 5, 6);
    const r = evalExpr(parseExpr("-(abs(x - y) * 2 + max(x, y)^2) / min(-x, y, 0)"), (k) => ({ x, y })[k], 3);
    return J(Array.from(x)) === "[1,2,3]" && J(Array.from(y)) === "[4,5,6]"
      && J(Array.from(r)) === J([1, 2, 3].map((xx, i) => -(Math.abs(xx - [4, 5, 6][i]) * 2 + Math.max(xx, [4, 5, 6][i]) ** 2)
        / Math.min(-xx, [4, 5, 6][i], 0)));
  })());
  let calls = 0;
  evalExpr(parseExpr("a + a*a - max(a, a)"), (k) => { calls++; return a; }, 4);
  check("eval: lookup called once per distinct name", calls === 1);
  check("eval: unknown name -> ExprError with position", (() => { const e = evErr("1 + zz*2"); return e instanceof ExprError
    && e.message === "unknown name 'zz' at position 4" && e.pos === 4; })());
  check("eval: wrong-length array -> error", /has 2 values, expected 4/.test((() => { try { evalExpr(parseExpr("a"), () => [1, 2], 4); }
    catch (e) { return e.message; } return ""; })()));
  check("eval: n = 0", evalExpr(parseExpr("a + 1"), () => new Float64Array(0), 0).length === 0
    && evalExpr(parseExpr("2"), () => undefined, 0).length === 0);
  check("eval: plain arrays and typed arrays accepted", J(ev("a + b", { a: [1, 2], b: Int16Array.of(3, 4) }, 2)) === "[4,6]");
  check("eval: left-to-right as parsed (no rewriting)", ev("0.1 + 0.2 - 0.3") === 0.1 + 0.2 - 0.3 && ev("1e16 + 1 - 1e16") === 1e16 + 1 - 1e16
    && ev("a*b/c", { a: 0.1, b: 3, c: 7 }) === 0.1 * 3 / 7);
  // performance: one pass per node over 2M elements
  const N = 2000000, X = new Float64Array(N).map((_, i) => i % 977), Y = new Float64Array(N).map((_, i) => -60 + (i % 13));
  const ast = parseExpr("lin2db(db2lin(y) * 2 + abs(x - 3)) - 0.01*x + 3*max(x, 5)");
  evalExpr(ast, (k) => (k === "x" ? X : Y), N);
  const t0 = performance.now();
  evalExpr(ast, (k) => (k === "x" ? X : Y), N);
  const ms = performance.now() - t0;
  console.log(`PERF evalExpr 2M elements, 10 nodes: ${ms.toFixed(1)} ms`);
  check("eval: perf 2M elements < 1000 ms", ms < 1000, ms);
}

// ---- names / refs ----------------------------------------------------------------
{
  check("names: first appearance, no function names, deduped", J(exprNames(parseExpr('c + max(a, b) * c + pi - "x y" + log10(a)')))
    === '["c","a","b","pi","x y"]');
  check("names: refs carry positions", J(exprRefs(parseExpr('2*b + "a c"'))) === J([{ name: "b", pos: 2, quoted: false },
    { name: "a c", pos: 6, quoted: true }]));
  check("names: none", J(exprNames(parseExpr("2 + 3k"))) === "[]");
}

// ---- units (SPEC_EXPR E1, every row) -----------------------------------------------
{
  const U = { V: "V", v: "v", A: "A", dBm: "dBm", DBM: " DBM\n", dB: "dB", dBW: "dBW", mW: "mW", W: "W", MW: " MW ",
    none: "", nul: null, Hz: "Hz", dbc: "dBc" };
  const u = (t) => exprUnits(parseExpr(t), (n) => U[n]);
  const rows = [
    ["V", "V"], ["DBM", "DBM"], ["none", ""], ["nul", ""], ["unknownName", ""], ["2", ""], ["2k", ""], ["pi", ""],
    ["-V", "V"], ["+V", "V"], ["-(-dBm)", "dBm"],
    // a + b
    ["none + V", "V"], ["2 + V", "V"], ["V + 2", "V"], ["dB + dBm", "dBm"], ["dBm + dB", "dBm"], ["DBM + dBm", "DBM"],
    ["V + A", "V"], ["dB + dB", "dB"], ["dBm + V", "dBm"], ["dbc + dBm", "dBc"],
    // a - b
    ["dBm - dBm", "dB"], ["DBM - dBm", "dB"], ["dBm - dB", "dBm"], ["dB - dBm", "dB"], ["V - none", "V"], ["V - 3", "V"],
    ["none - V", "V"], ["3 - V", "V"], ["V - A", "V"], ["dB - dB", "dB"], ["dBW - dBm", "dBW"], ["V - v", "V"],
    // a * b
    ["V * A", "V·A"], ["V * none", "V"], ["2 * A", "A"], ["2 * 3", ""], ["V*A*Hz", "V·A·Hz"],
    // a / b
    ["V / V", ""], ["V / v", ""], ["DBM / dBm", ""], ["V / A", "V/A"], ["V / 2", "V"], ["1 / A", "1/A"], ["2 / 3", ""],
    ["none / none", ""],
    // ^ and pow
    ["V^2", "V^2"], ["V^-1", "V^-1"], ["V^0.5", "V^0.5"], ["V**3", "V^3"], ["V^-(2)", "V^-2"], ["V^A", ""], ["V^(1+1)", ""],
    ["2^V", ""], ["none^2", ""], ["pow(V, 2)", "V^2"], ["pow(V, -2)", "V^-2"], ["pow(V, A)", ""], ["pow(2, 2)", ""],
    ["V^1e21", "V^1e+21"], ["V^1k", "V^1000"],
    // functions
    ["abs(V)", "V"], ["abs(-dBm)", "dBm"], ["floor(V)", "V"], ["ceil(A)", "A"], ["round(Hz)", "Hz"], ["min(none, A, V)", "A"],
    ["max(V, A)", "V"], ["max(2, 3)", ""], ["min(none)", ""],
    ["lin2db(mW)", "dBm"], ["lin2db(MW)", "dBm"], ["lin2db(W)", "dBW"], ["lin2db(V)", "dB"], ["lin2db(none)", "dB"], ["lin2db(2)", "dB"],
    ["db2lin(dBm)", "mW"], ["db2lin(DBM)", "mW"], ["db2lin(dBW)", "W"], ["db2lin(dB)", ""], ["db2lin(V)", "lin(V)"],
    ["db2lin(none)", ""], ["db2lin(dbc)", "lin(dBc)"],
    ["sqrt(V)", ""], ["exp(V)", ""], ["ln(V)", ""], ["log(V)", ""], ["log10(V)", ""],
    // composites (the PI's examples)
    ["dBm - 10*log10(Hz)", "dBm"], ["DBM - dBm + V", "dB"], ["lin2db(db2lin(dBm))", "dBm"], ["db2lin(dBm)/db2lin(dBm)", ""],
    ["(V*A)/(V*A)", ""], ["V^2/A", "V^2/A"],
  ];
  for (const [t, want] of rows) check(`units: ${t} -> ${J(want)}`, u(t) === want, u(t));
}

// ---- renameInExpr / quoteName / num -------------------------------------------------
{
  const R = renameInExpr;
  check("rename: tokens only", R("a + ab + a*2 + b_a", "a", "x") === "x + ab + x*2 + b_a");
  check("rename: whitespace / layout byte-identical", R("  a\t*\n a ", "a", "b") === "  b\t*\n b ");
  check("rename: quoted old token", R('"my var" + 1 + "my var"', "my var", "b") === "b + 1 + b");
  check("rename: quoted -> bare when identifier-safe, bare -> quoted when not", R('"a" + a', "a", "b") === "b + b"
    && R("a + 1", "a", "my var") === '"my var" + 1' && R("a", "a", "2nd") === '"2nd"' && R("a", "a", "pi") === '"pi"'
    && R("a", "a", "max") === '"max"' && R("a", "a", "a.b") === '"a.b"');
  check("rename: function calls untouched", R("max(max, 2) + max (3)", "max", "m") === "max(m, 2) + max (3)"
    && R('"max"(1)', "max", "m") === 'm(1)');
  check("rename: numbers and SI suffixes untouched", R("2e3 + e3", "e3", "x") === "2e3 + x" && R("5k + k", "k", "kk") === "5k + kk"
    && R("1.5M*M", "M", "m2") === "1.5M*m2");
  check("rename: text that does not parse", R("a + $ + a", "a", "b") === "b + $ + b" && R("5ms + a", "a", "b") === "5ms + b"
    && R('a + "unterminated a', "a", "b") === 'b + "unterminated a' && R("a +", "a", "b") === "b +" && R('"" + a', "a", "b") === '"" + b');
  check("rename: no occurrence -> same text", R("x*2 + y", "a", "b") === "x*2 + y" && R("a", "a", "a") === "a"
    && R("a", "", "b") === "a" && R("", "a", "b") === "");
  check("rename: only the renamed tokens change (random layouts)", (() => {
    const parts = ["a", " ", "+", "\t", "(", ")", "ab", '"a"', "*", "2", "\n", "max(", "pi", ",", '"a b"', "-", "1.5k", "^"];
    let seed = 3;
    const rnd = (n) => ((seed = (seed * 1103515245 + 12345) % 2147483648) % n);
    for (let t = 0; t < 300; t++) {
      const toks = Array.from({ length: 12 }, () => parts[rnd(parts.length)]);
      const text = toks.join(" ");
      const want = toks.map((p) => (p === "a" || p === '"a"' ? "zz" : p)).join(" ");
      // a bare "a" whose next non-blank part is "(" is a function call (left alone)
      const next = (i) => toks.slice(i + 1).find((p) => p.trim() !== "");
      const callLike = toks.some((p, i) => p === "a" && next(i) === "(");
      if (!callLike && R(text, "a", "zz") !== want) return false;
    }
    return true;
  })());
  check("quoteName", quoteName("abc") === "abc" && quoteName("a_1") === "a_1" && quoteName("_x") === "_x"
    && quoteName("1a") === '"1a"' && quoteName("a b") === '"a b"' && quoteName("a-b") === '"a-b"' && quoteName("a.b") === '"a.b"'
    && quoteName("max") === '"max"' && quoteName("log10") === '"log10"' && quoteName("pi") === '"pi"' && quoteName("Pi") === "Pi"
    && quoteName("maxi") === "maxi" && quoteName("") === '""' && quoteName("µ") === '"µ"');
  check("quoteName: every quoted name parses back to itself", ["a b", "1a", "max", "pi", "x.y+z", "SNR-1", "µW",
    'a"b', 'a"b"c', 'x"_1'].every((n) => J(exprNames(parseExpr(quoteName(n)))) === J([n])));
  check("rename: names containing a quote", renameInExpr('"a"b" + a', 'a"b', "c") === "c + a"
    && renameInExpr("x * 2", "x", 'p"q') === '"p"q" * 2');
  check("num", num(1e6) === "1000000" && num(0.02) === "0.02" && num(1e-7) === "1e-7" && num(1e21) === "1e+21"
    && num(-1500) === "-1500" && num(1 / 3) === "0.3333333333333333");
  let seed = 11, ok = true;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let i = 0; i < 3000 && ok; i++) {
    const x = (rnd() - 0.5) * Math.pow(10, Math.floor(rnd() * 600) - 300);
    if (ev(num(x)) !== x) ok = false;
  }
  check("num: parses back exactly (3000 random doubles incl. tiny / huge)", ok && ev(num(Number.MAX_VALUE)) === Number.MAX_VALUE
    && ev(num(5e-324)) === 5e-324 && ev(num(-0.1)) === -0.1);
}

summary("expr");
