// Linear-time versions of pattern rules whose plain regex is quadratic on long lines.
//
// Each rule has the shape HEAD [^X]* TAIL (or HEAD .* TAIL). When TAIL is missing, a regex restarts
// at every HEAD and scans to the end again, so a minified line that repeats HEAD takes seconds.
// Every HEAD between two X characters reaches the same X and gets the same tail check, so it is
// enough to try the first HEAD in each X-delimited chunk. The matchers below do that and give the
// same answer as the regex in their comment. Each exposes `test(line)`, like a RegExp.
// This file is copied into projects with collect.mjs for the CI gate, so it imports nothing.

// `.` doesn't match line terminators, so a `.*` regex never spans them.
const DOT_BREAKS = /[\n\r\u2028\u2029]/;

// Calls fn(chunk, start) for each piece of `line` between `stop` characters. A chunk that ends at a
// stop character has `closed` true and `end` at that character.
function forEachChunk(line, stop, fn) {
  let start = 0;
  for (;;) {
    const end = line.indexOf(stop, start);
    const closed = end !== -1;
    if (fn(line.slice(start, closed ? end : line.length), start, closed, closed ? end : line.length)) return true;
    if (!closed) return false;
    start = end + 1;
  }
}

// head [^stop]* tail: true when a chunk's first head is followed, in the same chunk, by tail.
const headThenInChunk = (line, stop, head, tail) =>
  forEachChunk(line, stop, (chunk) => {
    const m = head.exec(chunk);
    return Boolean(m) && tail.test(chunk.slice(m.index + m[0].length));
  });

// head [^stop]* stop rest, where rest is a sticky regex tried right after the chunk's stop character.
const headThenAfterStop = (line, stop, head, rest) =>
  forEachChunk(line, stop, (chunk, _start, closed, end) => {
    if (!closed || !head.test(chunk)) return false;
    rest.lastIndex = end + 1;
    return rest.test(line);
  });

// first .* second. `first` must be global and its matches must not overlap. A head can itself
// span a line terminator (`\s` matches one), so heads are found in the whole line, and `.*` runs
// from a head's end to the next terminator. Later heads ending before that terminator only see
// part of the same stretch, so they are skipped.
function firstThenLater(line, first, second) {
  const breaks = new RegExp(DOT_BREAKS.source, "g");
  let checkedTo = -1;
  for (const m of line.matchAll(first)) {
    const from = m.index + m[0].length;
    if (from <= checkedTo) continue;
    breaks.lastIndex = from;
    checkedTo = breaks.exec(line)?.index ?? line.length;
    if (second.test(line.slice(from, checkedTo))) return true;
  }
  return false;
}

// /Math\.random\(\).*(?:token|secret|code|otp|password|id)|(?:token|secret|otp|code)\s*=.*Math\.random\(\)/i
// No keyword occurs inside another, so the heads never overlap.
export const INSECURE_RANDOM_TOKEN = {
  test: (line) =>
    firstThenLater(line, /Math\.random\(\)/gi, /token|secret|code|otp|password|id/i) ||
    firstThenLater(line, /(?:token|secret|otp|code)\s*=/gi, /Math\.random\(\)/i),
};

// /(?:NEXT_PUBLIC|VITE|EXPO_PUBLIC|REACT_APP)_[A-Z_]*(?:SECRET|PRIVATE|SERVICE_ROLE|PASSWORD)/
// A match is all [A-Z_], so it lies inside one run of those characters.
const CLIENT_PREFIX = /(?:NEXT_PUBLIC|VITE|EXPO_PUBLIC|REACT_APP)_/;
const CLIENT_SECRET_WORD = /SECRET|PRIVATE|SERVICE_ROLE|PASSWORD/;
export const CLIENT_EXPOSED_SECRET = {
  test: (line) => {
    for (const [run] of line.matchAll(/[A-Z_]+/g)) {
      const m = CLIENT_PREFIX.exec(run);
      if (m && CLIENT_SECRET_WORD.test(run.slice(m.index + m[0].length))) return true;
    }
    return false;
  },
};

// /(?:readFile|createReadStream|sendFile|res\.download)\s*\([^)]*req\.(?:params|query|body)/
export const PATH_TRAVERSAL_RISK = {
  test: (line) => headThenInChunk(line, ")", /(?:readFile|createReadStream|sendFile|res\.download)\s*\(/, /req\.(?:params|query|body)/),
};

// /catch\s*(?:\([^)]*\))?\s*\{\s*\}/
export const EMPTY_CATCH = {
  test: (line) => /catch\s*\{\s*\}/.test(line) || headThenAfterStop(line, ")", /catch\s*\(/, /\s*\{\s*\}/y),
};

// /catch\s*\([^)]*\)\s*\{\s*console\.(?:log|error)\([^)]*\);?\s*\}/
export const SWALLOWED_ERROR_LOG_ONLY = {
  test: (line) => headThenAfterStop(line, ")", /catch\s*\(/, /\s*\{\s*console\.(?:log|error)\([^)]*\);?\s*\}/y),
};

// Counts the matches of this regex over a whole file, as text.match(/.../g).length would:
// /for\s*\([^)]*\)\s*\{[^}]*\bawait\b|for\s+(?:const|let)\s+\w+\s+of[^{]*\{[^}]*\bawait\b/g
// Every part between the heads and `await` is decided by the next ")", "{" or "}", so each "for"
// is checked in constant time with lookup tables instead of a rescan.
export function countAwaitInLoop(text) {
  const n = text.length;
  const nextOf = (ch) => {
    const next = new Int32Array(n + 1).fill(n);
    for (let i = n - 1; i >= 0; i--) next[i] = text[i] === ch ? i : next[i + 1];
    return next;
  };
  const nextClose = nextOf(")"), nextOpen = nextOf("{"), nextBrace = nextOf("}");
  const nextNonSpace = new Int32Array(n + 1).fill(n);
  for (let i = n - 1; i >= 0; i--) nextNonSpace[i] = /\s/.test(text[i]) ? nextNonSpace[i + 1] : i;
  const awaits = [...text.matchAll(/\bawait\b/g)].map((m) => m.index);
  // End of the last `await` that starts in [from, to), or -1.
  const lastAwaitEnd = (from, to) => {
    let lo = 0, hi = awaits.length; // first index with awaits[i] >= to
    while (lo < hi) { const mid = (lo + hi) >> 1; if (awaits[mid] < to) lo = mid + 1; else hi = mid; }
    return lo > 0 && awaits[lo - 1] >= from ? awaits[lo - 1] + 5 : -1;
  };
  const parenHead = /for\s*\(/y, ofHead = /for\s+(?:const|let)\s+\w+\s+of/y;
  const matchAt = (p) => {
    parenHead.lastIndex = p;
    if (parenHead.test(text)) {
      const close = nextClose[parenHead.lastIndex];
      if (close === n) return -1;
      const open = nextNonSpace[close + 1];
      return open < n && text[open] === "{" ? lastAwaitEnd(open + 1, nextBrace[open + 1]) : -1;
    }
    ofHead.lastIndex = p;
    if (!ofHead.test(text)) return -1;
    const open = nextOpen[ofHead.lastIndex];
    return open === n ? -1 : lastAwaitEnd(open + 1, nextBrace[open + 1]);
  };
  let count = 0;
  for (let p = text.indexOf("for"); p !== -1; ) {
    const end = matchAt(p);
    if (end === -1) p = text.indexOf("for", p + 1);
    else { count++; p = text.indexOf("for", end); }
  }
  return count;
}
