// Differential fuzz: each linear matcher in lib/patterns.mjs must agree with the regex it replaced
// (ADR-020). This imports the library directly, unlike the black-box tests: collect only reports a
// count per rule, where a false positive and a false negative would cancel out, and a direct
// comparison can name the input that disagrees.
import assert from "node:assert/strict";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { test, describe } from "node:test";
import { PLUGIN } from "./helpers.mjs";

const P = await import(pathToFileURL(join(PLUGIN, "skills/audit/lib/patterns.mjs")).href);

// The oracle: the rules' regexes as they were before ADR-020, copied verbatim. Short inputs are
// fast for them, so the fuzz keeps inputs short.
const RULES = [
  ["insecure-random-token", P.INSECURE_RANDOM_TOKEN,
    /Math\.random\(\).*(?:token|secret|code|otp|password|id)|(?:token|secret|otp|code)\s*=.*Math\.random\(\)/i,
    ["Math.random()", "math.RANDOM()", "Math.random(", "token", "TOKEN", "tok", "secret", "otp", "code", "password", "id", "i", "d", "=", " ", "x", "\r", "\n", "\u2028", "\u2029"]],
  ["client-exposed-secret", P.CLIENT_EXPOSED_SECRET,
    /(?:NEXT_PUBLIC|VITE|EXPO_PUBLIC|REACT_APP)_[A-Z_]*(?:SECRET|PRIVATE|SERVICE_ROLE|PASSWORD)/,
    ["NEXT_PUBLIC", "NEXT_", "VITE", "EXPO_PUBLIC", "REACT_APP", "_", "SECRET", "secret", "PRIVATE", "SERVICE_ROLE", "SERVICE", "_ROLE", "PASSWORD", "A", "1", "x", " "]],
  ["path-traversal-risk", P.PATH_TRAVERSAL_RISK,
    /(?:readFile|createReadStream|sendFile|res\.download)\s*\([^)]*req\.(?:params|query|body)/,
    ["readFile", "readFile(", "createReadStream", "sendFile (", "res.download", "(", ")", " ", "\n", "req.", "req", ".", "params", "query", "body", "req.params", "req.body", "x"]],
  ["empty-catch", P.EMPTY_CATCH,
    /catch\s*(?:\([^)]*\))?\s*\{\s*\}/,
    ["catch", "(", ")", "{", "}", " ", "\t", "\n", "e", "x", ";"]],
  ["swallowed-error-log-only", P.SWALLOWED_ERROR_LOG_ONLY,
    /catch\s*\([^)]*\)\s*\{\s*console\.(?:log|error)\([^)]*\);?\s*\}/,
    ["catch", "catch (e) {", "catch(e){", "(", ")", ") {", "{", "}", " ", "\n", "e", "x", ";", "console.", "log", "error", "console.log(", "console.error(e)", "console.log(e);"]],
];
const AWAIT_IN_LOOP = /for\s*\([^)]*\)\s*\{[^}]*\bawait\b|for\s+(?:const|let)\s+\w+\s+of[^{]*\{[^}]*\bawait\b/g;
const AWAIT_TOKENS = ["for", "for (", "for\n(", "for let ", "for (const x of y) {", "for (let i = 0; i < n; i++) {", "for const x of xs {",
  "(", ")", "{", "}", " ", "\t", "\n", "const", "let", "x", "y", "a", "_", ";", "of", " of ", "e) {", "await", "awaits", "xawait", "await f();", "await x }"];

// A fixed seed, so a failure reproduces. Inputs join 1–14 tokens: long enough to combine heads,
// stop characters and tails, short enough for the regexes to stay fast. mulberry32, because the
// low bits of a plain LCG cycle so quickly that some token sequences never come up.
function inputs(tokens, count, seed) {
  let s = seed;
  const rnd = (k) => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) % k;
  };
  return Array.from({ length: count }, () => {
    let out = "";
    for (let n = 1 + rnd(14); n > 0; n--) out += tokens[rnd(tokens.length)];
    return out;
  });
}
const COUNT = 40000;

describe("pattern matchers agree with the regexes they replaced", () => {
  for (const [id, matcher, regex, tokens] of RULES) {
    test(id, () => {
      let hits = 0;
      for (const line of inputs(tokens, COUNT, 7)) {
        const want = regex.test(line);
        if (want) hits++;
        assert.equal(matcher.test(line), want, `${id} on ${JSON.stringify(line)}`);
      }
      // A fuzz where the regex never matches proves nothing about the matching side.
      assert.ok(hits > COUNT / 200, `only ${hits} of ${COUNT} inputs matched; the tokens don't exercise ${id}`);
    });
  }

  test("await-in-loop", () => {
    let matches = 0;
    for (const text of inputs(AWAIT_TOKENS, COUNT, 7)) {
      const want = (text.match(AWAIT_IN_LOOP) || []).length;
      matches += want;
      assert.equal(P.countAwaitInLoop(text), want, `await-in-loop on ${JSON.stringify(text)}`);
    }
    assert.ok(matches > COUNT / 200, `only ${matches} matches in ${COUNT} inputs; the tokens don't exercise await-in-loop`);
  });
});
