#!/usr/bin/env node
// Turns verified findings and collected evidence into scores, finding ids and the audit baseline.
// The model supplies one judgment per category, the anchor. Everything else is computed here, so two
// runs on the same evidence can't disagree on the arithmetic. See ADR-009.
//
//   node score.mjs --input .audit/scoring.json [--summary .audit/raw/summary.json] [--dir docs/audits]
//
// Input: { "mode": "full", "anchors": { "security": { "score": 7, "why": "..." },
//          "performance": { "notApplicable": "why" }, ... }, "findings": [...], "strengths": [...] }
// Output: score.json beside the input. Only a full audit also writes latest.json and history.csv.
// Exit codes: 0 scored, 2 refused (the problems are printed, and nothing is written).
//
// The project is the `root` collect.mjs recorded in the summary, or else the current folder. Git,
// accepted risks, finding locations and --dir are all read against it.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRisks } from "./lib/exceptions.mjs";

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const inputPath = resolve(opt("--input", ".audit/scoring.json"));
const summaryPath = resolve(opt("--summary", ".audit/raw/summary.json"));

const here = dirname(fileURLToPath(import.meta.url));
const { rubricVersion: RUBRIC, weights: WEIGHTS, metricCaps: METRIC_CAPS, rules: RULES } = JSON.parse(readFileSync(join(here, "rules.json"), "utf8"));
const CATEGORIES = Object.keys(WEIGHTS);
const PREFIX = { security: "SEC", reliability: "REL", performance: "PERF", maintainability: "MNT", tooling: "TOOL" };
const SEVERITIES = ["critical", "high", "medium", "low"];
const CONFIDENCES = ["confirmed", "likely", "possible"];
const MODES = ["full", "quick", "since-last", ...CATEGORIES];
const TOOL_CATEGORY = {
  patterns: "security", exceptions: "security", gitleaks: "security", semgrep: "security", vulnerabilities: "security",
  tests: "reliability",
  typecheck: "maintainability", strict: "maintainability", eslint: "maintainability", boundaries: "maintainability", knip: "maintainability", duplication: "maintainability", hotspots: "maintainability",
  git: "tooling",
};
const BROKEN = ["failed", "timed-out"];

const HISTORY_OLD = "date,overall,security,reliability,performance,maintainability,tooling,critical,high,medium,low";
const HISTORY_HEADER = `${HISTORY_OLD},commit,rubricVersion`;

// What each measurable cap looks for. Returns a description when it fires, or { unknown } when the
// evidence it needs is broken.
const METRIC_CHECKS = {
  "secret-in-repo": (m) => m.secrets?.open > 0 && `${m.secrets.open} open secret finding(s)`,
  "secret-in-history": (m) => m.secretsInHistory > 0 && `${m.secretsInHistory} secret(s) in git history`,
  "tests-failing": (m) => m.tests?.exitCode > 0 && `tests exit ${m.tests.exitCode}`,
  "type-errors": (m) => m.typeErrors > 0 && `${m.typeErrors} type error(s)`,
  "strict-off": (m) => m.tsStrict === false && "strict is off in tsconfig.json",
  "many-cycles-or-violations": (m) => {
    const n = (m.boundaryViolations || 0) + (m.circularDeps || 0);
    return n > 5 && `${n} circular dependencies or boundary violations`;
  },
  "duplication-over-8": (m) => m.duplication?.percentage > 8 && `${m.duplication.percentage}% duplication`,
  "duplication-over-4": (m) => m.duplication?.percentage > 4 && `${m.duplication.percentage}% duplication`,
  "many-huge-files": (m) => m.largeFiles?.over800 > 3 && `${m.largeFiles.over800} files over 800 lines`,
  // A broken package.json hides whether there's anything to lock, which doesn't rule this out.
  "no-lockfile": (m) => !m.lockfile?.name && (m.lockfile?.hasDependencies ? "dependencies with no lockfile"
    : m.lockfile?.hasDependencies === null && { unknown: "package.json couldn't be read" }),
  "env-file-with-secrets": (m) => m.envFilesOpen?.length > 0 && `tracked: ${m.envFilesOpen.join(", ")}`,
  "no-ci": (m) => m.inventory?.hasCI === false && "no CI configuration",
  "no-claude-md": (m) => m.inventory?.claudeSetup && !m.inventory.claudeSetup.some((f) => /^(CLAUDE|AGENTS)\.md$/.test(f)) && "no CLAUDE.md or AGENTS.md at the root",
};

function refuse(problems) {
  console.error(`score.mjs refused to score:\n  - ${problems.join("\n  - ")}`);
  process.exit(2);
}

const readJson = (path, what) => {
  let text;
  try { text = readFileSync(path, "utf8"); } catch { refuse([`${what} not found at ${path}`]); }
  try { return JSON.parse(text); } catch (e) { refuse([`${what} isn't valid JSON: ${e.message}`]); }
};

const input = readJson(inputPath, "scoring input");
const summary = readJson(summaryPath, "evidence summary");
// summary.root counts only when the summary or the current folder is inside it. A summary copied into
// another clone still names the clone it came from, and that clone's HEAD says nothing about this one.
const inside = (dir, path) => { const rel = relative(dir, path); return !rel.startsWith("..") && !isAbsolute(rel); };
const recordedRoot = existsSync(summary.root ?? "") ? realpathSync(summary.root) : null;
const ROOT = recordedRoot && (inside(recordedRoot, realpathSync(summaryPath)) || inside(recordedRoot, realpathSync(process.cwd())))
  ? recordedRoot : realpathSync(process.cwd());
const auditDir = resolve(ROOT, opt("--dir", "docs/audits"));
const previous = existsSync(join(auditDir, "latest.json")) ? readJson(join(auditDir, "latest.json"), "previous latest.json") : null;

// ---------- Locations: always project-relative, because the project's folder must not change a result ----------
// The real path of the deepest part that exists, since a finding can name a file that's now deleted
// and a temp or home folder can be reached through a symlink.
function realPath(path) {
  const rest = [];
  for (let dir = path; ; dir = dirname(dir)) {
    try { return join(realpathSync(dir), ...rest); }
    catch { if (dirname(dir) === dir) return path; rest.unshift(basename(dir)); }
  }
}
// null when the file is outside the project.
function projectFile(file) {
  const rel = relative(ROOT, isAbsolute(file) ? realPath(file) : resolve(ROOT, file)).split(sep).join("/");
  return rel === ".." || rel.startsWith("../") || isAbsolute(rel) ? null : rel || ".";
}
const onDisk = (path) => Boolean(path) && existsSync(resolve(ROOT, path));
const LINE_SUFFIX = /(?::L?\d+(?:[-–:]L?\d+)*|#L\d+(?:[-–]L?\d+)?)$/i;
const LINES = String.raw`L?\d+(?:\s*[,–-]\s*L?\d+)*`;
// "a.ts (lines 1, 3)" and "a.ts line 12" become a.ts:1-3 and a.ts:12, before a comma can split them.
// Only numbers count, and only up to the end of the location, so "(line 12 also b.ts)" stays as text.
const LINE_WORDS = new RegExp(String.raw`\s+\((?:lines?\s+)?(${LINES})\)|\s+lines?\s+(${LINES})(?=\s*(?:$|[,;\n(]|and\s))`, "gi");
const lineNumbers = (text) => text.match(/\d+/g)?.join("-") ?? "";
// A merged finding lists its locations: "src/a.ts:1, lib/b.ts:9". "src/a.ts:12,40" is one file.
// A part has `file` if it reads as a path: nothing but a real file may contain a space or a colon.
// It's `real` only if it exists, which is what lets a risk cover it. Guessing from its characters
// whether a string names one file can't work, since "a.ts->lib/b.ts" and "app/(auth)/page.tsx" look
// no different. Everything else (a URL, a route with its method, prose) is only `text`.
const locationParts = (location) => location.replace(/`/g, "")
  .replace(LINE_WORDS, (_, inNote, inWords) => `:${lineNumbers(inNote ?? inWords)}`)
  .split(/[,;\n]|\s+and\s+/i)
  .map((part) => part.trim())
  .filter((part) => part && !/^:?L?\d[\d–-]*$/i.test(part))
  .map((text) => {
    const path = text.replace(LINE_SUFFIX, "");
    const real = onDisk(path);
    if (!path || (!real && /[\s:]/.test(path))) return { text };
    return { text, path, real, line: lineNumbers(text.slice(path.length)), file: projectFile(path) };
  });
const isOutside = (part) => part.path !== undefined && part.file === null;
// A finding is identified by its first location. Baselines can hold paths from before this rule, so
// one that can't be made relative stays as it is rather than losing its id. A file followed by a
// note ("src/a.ts:10 (the handler)") is still that file, or the id would change when the line moved.
const fileOf = (location) => {
  const [first] = locationParts(location);
  if (!first) return "";
  if (first.path !== undefined) return first.file ?? first.path;
  const leading = /^([^\s:#]+)(?::L?\d|#L\d)/.exec(first.text)?.[1];
  return leading ? projectFile(leading) ?? leading : first.text.replace(LINE_SUFFIX, "") || first.text;
};
// Two ways of writing one location are one finding.
const locationKey = (location) => locationParts(location).map((p) => (p.path === undefined ? p.text : `${p.file ?? p.path}:${p.line}`)).sort().join("|");
const titleKey = (title) => (title || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
// `other-*` covers many different problems, so the rule and location alone wouldn't identify one.
const titleIfOther = (f) => (String(f.rule).startsWith("other-") ? `|${titleKey(f.title)}` : "");

// ---------- Validate: a score built on a broken contract is worse than no score ----------
const problems = [];
const { mode, anchors = {}, findings = [], strengths = [] } = input;
const isFull = mode === "full";
if (!MODES.includes(mode)) problems.push(`mode must be one of ${MODES.join(", ")}`);
if (!summary.collectorVersion) problems.push("the evidence comes from an older collect.mjs: run it again");

// Evidence that can't be compared with HEAD may be stale, which is a different result from being current.
const head = spawnSync("git", ["rev-parse", "--verify", "-q", "HEAD"], { cwd: ROOT, encoding: "utf8" });
const headSha = head.status === 0 ? head.stdout.trim() : null;
if (summary.commit) {
  if (!headSha) problems.push(`the evidence is from ${summary.commit.slice(0, 8)} but score.mjs can't read HEAD in ${ROOT}, so it can't tell whether that's current: run it from the project`);
  else if (summary.commit !== headSha) problems.push(`the evidence is from ${summary.commit.slice(0, 8)} but HEAD is ${headSha.slice(0, 8)}: run collect.mjs again`);
} else if (summary.tools?.git?.status === "failed") {
  // No commit means no git only if git answered. Here it didn't, so nothing is known about the code's age.
  problems.push(`git failed when the evidence was collected (${summary.tools.git.reason}), so its commit is unknown: fix git and run collect.mjs again`);
} else if (headSha) {
  problems.push(`the evidence has no commit but HEAD is ${headSha.slice(0, 8)}, so it was collected before that: run collect.mjs again`);
} else if (summary.tools?.git?.status === "ok" && head.status !== 1) {
  // Collected in a repo with no commits. Exit 1 says that's still so; anything else says nothing.
  problems.push(`the evidence is from a repo with no commits, and score.mjs can't read HEAD in ${ROOT} to see if that's still true: run it from the project`);
}

for (const cat of Object.keys(anchors)) if (!CATEGORIES.includes(cat)) problems.push(`unknown category in anchors: ${cat}`);
for (const cat of CATEGORIES) {
  const a = anchors[cat];
  if (!a) { if (isFull) problems.push(`a full audit needs an anchor for ${cat}`); continue; }
  if (a.notApplicable !== undefined) {
    if (typeof a.notApplicable !== "string" || !a.notApplicable.trim()) problems.push(`${cat}: notApplicable needs a reason`);
  } else if (typeof a.score !== "number" || a.score < 0 || a.score > 10) problems.push(`${cat}: anchor score must be a number from 0 to 10`);
}
if (CATEGORIES.includes(mode) && !anchors[mode]) problems.push(`a ${mode} audit needs an anchor for ${mode}`);
if (CATEGORIES.every((c) => !anchors[c] || anchors[c].notApplicable !== undefined)) problems.push("no category has a score, so there is nothing to score");

if (!Array.isArray(findings)) problems.push("findings must be a list");
if (!Array.isArray(strengths)) problems.push("strengths must be a list");
const seen = new Set();
for (const f of Array.isArray(findings) ? findings : []) {
  const label = `${f?.rule} at ${f?.location}`;
  if (!CATEGORIES.includes(f?.category)) { problems.push(`${label}: unknown category "${f?.category}"`); continue; }
  // Own keys only: every object has `constructor`, and its "cap" would be a function (NaN/10).
  if (!Object.hasOwn(RULES[f.category], f.rule)) problems.push(`${label}: not a ${f.category} rule in rules.json (use other-${f.category} if nothing fits)`);
  if (!SEVERITIES.includes(f.severity)) problems.push(`${label}: unknown severity "${f.severity}"`);
  if (!CONFIDENCES.includes(f.confidence)) problems.push(`${label}: unknown confidence "${f.confidence}"`);
  if (typeof f.location !== "string" || !locationParts(f.location).length) problems.push(`${f.rule}: location is required`);
  else if (locationParts(f.location).some(isOutside)) problems.push(`${label}: location is outside the project (${ROOT}). Use a project-relative path, and for a route, its handler's file`);
  if (/^GOOD:/i.test(f.title || "")) problems.push(`${label}: "GOOD:" entries belong in strengths`);
  // "possible" is the verifier's verdict to give, so it doesn't excuse a finding from being verified.
  if (f.severity !== "low" && f.verified !== true) problems.push(`${label}: ${f.severity} findings must be verified before they can count`);
  if (anchors[f.category]?.notApplicable !== undefined && f.confidence !== "possible") problems.push(`${label}: ${f.category} is marked not applicable but has this finding`);
  const key = `${f.rule}|${typeof f.location === "string" ? locationKey(f.location) : ""}${titleIfOther(f)}`;
  if (seen.has(key)) problems.push(`${label}: duplicate, merge these first`);
  seen.add(key);
}
for (const s of Array.isArray(strengths) ? strengths : []) if (!CATEGORIES.includes(s?.category) || !s?.title) problems.push(`strength "${s?.title}": needs a category and a title`);

const allRules = CATEGORIES.flatMap((c) => Object.keys(RULES[c]));
const risks = loadRisks(ROOT, allRules);
for (const p of risks.problems) problems.push(`.audit-exceptions.json risks: ${p}`);
if (problems.length) refuse(problems);

// ---------- Finding ids: the same problem keeps its id between audits ----------
const identity = (f) => `${f.rule}|${fileOf(f.location || f.file || "")}${titleIfOther(f)}`;

// The appendix too: a finding the verifier only called possible keeps its id for when it counts again.
const previousEntries = [...(previous?.findings || []), ...(previous?.appendix || []), ...(previous?.closed || [])].filter((f) => f.id);
const unclaimed = new Map();
for (const f of previousEntries) {
  const k = identity(f);
  unclaimed.set(k, [...(unclaimed.get(k) || []), f]);
}
const lastNumber = {};
for (const { id } of previousEntries) {
  const m = /^([A-Z]+)-(\d+)$/.exec(id);
  if (m) lastNumber[m[1]] = Math.max(lastNumber[m[1]] || 0, +m[2]);
}
const nextId = (category) => {
  const p = PREFIX[category];
  lastNumber[p] = (lastNumber[p] || 0) + 1;
  return `${p}-${String(lastNumber[p]).padStart(3, "0")}`;
};

// Accepting a risk accepts it where it was looked at, so every location of a finding has to be a
// file the risk covers. A location that isn't really there can't be shown to be covered.
const riskFor = (f) => {
  if (f.severity === "critical") return null;
  const covering = locationParts(f.location).map(({ file, real }) => real && file && risks.active.find((r) => r.rule === f.rule && r.matches.test(file)));
  return covering.every(Boolean) ? covering[0] : null;
};

const counted = findings.filter((f) => f.confidence !== "possible");
const results = counted.map((f) => {
  const match = unclaimed.get(identity(f))?.shift();
  const risk = riskFor(f);
  return {
    ...f, id: match?.id || nextId(f.category), file: fileOf(f.location), status: risk ? "accepted" : "open",
    ...(risk ? { accepted: { reason: risk.reason, expires: risk.expires } } : {}),
    previous: match,
  };
});
// After the counted findings, which claim ids first. Matched to earlier findings but never given a
// new id: an unconfirmed problem shouldn't use up a number.
const appendix = findings.filter((f) => f.confidence === "possible").map((f) => {
  const match = unclaimed.get(identity(f))?.shift();
  return { ...f, ...(match ? { id: match.id } : {}), file: fileOf(f.location), status: "possible", previous: match };
});
const live = results.filter((f) => f.status === "open");

// ---------- Scores ----------
const metrics = summary.metrics || {};
const toolStatus = (name) => summary.tools?.[name]?.status;

function limitsFor(category) {
  const limits = [];
  const mine = live.filter((f) => f.category === category);
  const count = (severity) => mine.filter((f) => f.severity === severity).length;

  // The rubric's anchors, as ceilings: a project with criticals can't be anchored as exemplary.
  if (count("critical") >= 2) limits.push({ id: "multiple-criticals", max: 2, source: "severity", detail: `${count("critical")} criticals` });
  else if (count("critical") === 1) limits.push({ id: "one-critical", max: 4, source: "severity", detail: "1 critical" });
  if (count("high") > 2) limits.push({ id: "several-highs", max: 6, source: "severity", detail: `${count("high")} highs` });
  else if (count("high") > 0) limits.push({ id: "some-highs", max: 8, source: "severity", detail: `${count("high")} high(s)` });
  if (category === "security" && mine.some((f) => f.severity === "critical" && f.confidence === "confirmed")) {
    limits.push({ id: "confirmed-critical", max: 3, source: "severity", detail: "confirmed critical" });
  }

  // Lows aren't verified, so they inform the anchor and can't cap a score by themselves.
  for (const f of mine.filter((x) => x.severity !== "low")) {
    const max = RULES[category][f.rule];
    if (max != null) limits.push({ id: f.rule, max, source: "rule", detail: f.id });
  }

  for (const cap of METRIC_CAPS.filter((c) => c.category === category)) {
    const broken = cap.tools.find((t) => BROKEN.includes(toolStatus(t)));
    const fired = METRIC_CHECKS[cap.id](metrics);
    // A tool that broke can't rule this cap out, so it applies. A skipped tool is only reported as
    // a gap: skipping is often the right call, as with tests that aren't safe to run locally.
    if (fired?.unknown) limits.push({ id: cap.id, max: cap.max, source: "not-ruled-out", detail: fired.unknown });
    else if (fired) limits.push({ id: cap.id, max: cap.max, source: "metric", detail: fired });
    else if (broken) limits.push({ id: cap.id, max: cap.max, source: "not-ruled-out", detail: `${broken} didn't finish` });
  }
  return limits.sort((a, b) => a.max - b.max);
}

const gapsFor = (category) => Object.entries(summary.tools || {})
  .filter(([name, t]) => TOOL_CATEGORY[name] === category && t.status !== "ok" && !t.notApplicable)
  .map(([name, t]) => `${name}: ${t.status}${t.reason || t.skipped ? ` (${t.reason || t.skipped})` : ""}`);

const categories = {};
for (const cat of CATEGORIES) {
  const a = anchors[cat];
  if (!a) categories[cat] = { status: "not-assessed", score: null, gaps: gapsFor(cat) };
  else if (a.notApplicable !== undefined) categories[cat] = { status: "not-applicable", score: null, reason: a.notApplicable };
  else {
    const limits = limitsFor(cat);
    const score = Math.min(a.score, ...limits.map((l) => l.max));
    categories[cat] = { status: "scored", score, anchor: a.score, why: a.why || "", limitedBy: score < a.score ? limits.filter((l) => l.max === score).map((l) => l.id) : [], limits, gaps: gapsFor(cat) };
  }
}

const scored = CATEGORIES.filter((c) => categories[c].status === "scored");
const applicable = CATEGORIES.filter((c) => categories[c].status !== "not-applicable");
let overall = null, grade = null, overallCapped = false;
// A partial audit has no overall: the categories it skipped would silently stop counting.
if (isFull) {
  const totalWeight = scored.reduce((n, c) => n + WEIGHTS[c], 0);
  overall = Math.round(scored.reduce((n, c) => n + WEIGHTS[c] * categories[c].score, 0) / totalWeight * 10) / 10;
  if (overall > 5 && scored.some((c) => categories[c].score <= 3)) { overall = 5; overallCapped = true; }
  grade = overall >= 9 ? "A" : overall >= 8 ? "B" : overall >= 6.5 ? "C" : overall >= 5 ? "D" : "F";
}

const counts = Object.fromEntries(SEVERITIES.map((s) => [s, live.filter((f) => f.severity === s).length]));
// Skipped tools don't lower a score (ADR-009), so a high grade has to say what it didn't look at.
const gaps = scored.flatMap((c) => categories[c].gaps);

// ---------- Compared with the previous audit ----------
function compare() {
  if (!previous) return { previousDate: null, comparable: false, reason: "first audit" };
  const previousRubric = previous.rubricVersion ?? 1;
  if (previousRubric !== RUBRIC) {
    // Scores moved because the scale did, and old rule names don't match, so nothing here is a trend.
    return { previousDate: previous.date, comparable: false, reason: `the previous audit used rubric ${previousRubric}, this one ${RUBRIC}` };
  }
  // A finding now in the appendix is still there, only unconfirmed, so it isn't absent.
  const present = new Set([...results, ...appendix].map((f) => f.id));
  const before = previous.findings || [];
  const wasOpen = (f) => f.status !== "fixed" && f.status !== "gone";
  const wasCounted = (f) => f && f.status !== "possible";
  const absent = before.filter((f) => wasOpen(f) && !present.has(f.id)).map((f) => f.id);
  // fix-findings marks these with a test to prove it, so they're fixed whatever this run looked at.
  const markedFixed = before.filter((f) => f.status === "fixed" && !present.has(f.id)).map((f) => f.id);
  const rechecked = isFull || mode === "since-last"; // the other modes didn't look at everything
  const deltas = {};
  for (const c of scored) {
    const old = previous.scores?.[c]?.score;
    deltas[c] = typeof old === "number" ? +(categories[c].score - old).toFixed(1) : null;
  }
  return {
    previousDate: previous.date, comparable: true, deltas,
    overallDelta: overall != null && typeof previous.overall === "number" ? +(overall - previous.overall).toFixed(1) : null,
    new: results.filter((f) => !wasCounted(f.previous)).map((f) => f.id),
    stillOpen: results.filter((f) => wasCounted(f.previous) && wasOpen(f.previous)).map((f) => f.id),
    reopened: results.filter((f) => wasCounted(f.previous) && !wasOpen(f.previous)).map((f) => f.id),
    downgraded: appendix.filter((f) => wasCounted(f.previous) && wasOpen(f.previous)).map((f) => f.id),
    fixed: [...markedFixed, ...(rechecked ? absent : [])],
    notRechecked: rechecked ? [] : absent,
  };
}

const date = (summary.generatedAt || new Date().toISOString()).slice(0, 10);
const clean = ({ previous: _previous, ...f }) => f;
const output = {
  rubricVersion: RUBRIC, mode, baseline: isFull, date,
  commit: summary.commit ?? null, uncommittedFiles: metrics.git?.uncommittedFiles ?? null,
  overall, grade, overallCapped, coverageGaps: gaps.length, counts, categories,
  comparison: compare(),
  findings: results.map(clean).sort((a, b) => SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity)),
  strengths, appendix: appendix.map(clean),
  expiredRisks: risks.expired.map(({ rule, path, reason, expires }) => ({ rule, path, reason, expires })),
};

// ---------- Write ----------
const writeAtomic = (path, text) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(`${path}.tmp`, text);
  renameSync(`${path}.tmp`, path);
};

function historyWith(row) {
  const path = join(auditDir, "history.csv");
  if (!existsSync(path)) return `${HISTORY_HEADER}\n${row}\n`;
  let [header, ...rows] = readFileSync(path, "utf8").split("\n").filter(Boolean);
  if (header === HISTORY_OLD) rows = rows.map((r) => `${r},,`);
  else if (header !== HISTORY_HEADER) refuse([`${path} has a header this version doesn't know, so it was left alone: ${header}`]);
  // Scoring the same commit again on one day replaces its row, so a re-run can't double-count.
  const key = (r) => { const c = r.split(","); return `${c[0]}|${c[11]}`; };
  const commit = row.split(",")[11];
  if (commit) rows = rows.filter((r) => key(r) !== key(row));
  return `${[HISTORY_HEADER, ...rows, row].join("\n")}\n`;
}

const cell = (c) => categories[c].score ?? "";
const row = [date, overall, ...CATEGORIES.map(cell), ...SEVERITIES.map((s) => counts[s]), output.commit ?? "", RUBRIC].join(",");
const history = isFull ? historyWith(row) : null; // before any write: this can still refuse

writeAtomic(join(dirname(inputPath), "score.json"), `${JSON.stringify(output, null, 2)}\n`);
if (isFull) {
  const presentIds = new Set([...results, ...appendix].map((f) => f.id));
  // Kept so a problem that comes back gets its old id, and no id is ever given to something else.
  const closed = previousEntries
    .filter((f) => !presentIds.has(f.id))
    .map((f) => ({ id: f.id, rule: f.rule, file: f.file || fileOf(f.location || ""), title: f.title, status: f.status === "fixed" ? "fixed" : "gone" }));
  writeAtomic(join(auditDir, "latest.json"), `${JSON.stringify({
    date, commit: output.commit, uncommittedFiles: output.uncommittedFiles, rubricVersion: RUBRIC, mode,
    overall, grade, scores: categories, counts, findings: output.findings, appendix: output.appendix, strengths, closed,
  }, null, 2)}\n`);
  writeAtomic(join(auditDir, "history.csv"), history);
}

// ---------- Report ----------
console.log(`Mode ${mode}, rubric ${RUBRIC}${output.commit ? `, commit ${output.commit.slice(0, 8)}` : ""}`);
for (const c of CATEGORIES) {
  const r = categories[c];
  const limit = r.limitedBy?.length ? `  (limited by ${r.limitedBy.join(", ")})` : "";
  console.log(`  ${c.padEnd(16)} ${r.status === "scored" ? `${r.score}/10${limit}` : r.status}`);
}
const gapCount = gaps.length ? `${gaps.length} coverage gap${gaps.length === 1 ? "" : "s"}` : "";
console.log(isFull
  ? `Overall ${overall} (${grade})${overallCapped ? ", capped because a category is at 3 or below" : ""}${gapCount && `, ${gapCount}`}`
  : `Partial audit: no overall score${gapCount && `, ${gapCount}`}.`);
if (gaps.length) console.log(`Coverage gaps: ${gaps.join("; ")}`);
console.log(`Findings: ${SEVERITIES.map((s) => `${counts[s]} ${s}`).join(", ")}; ${results.length - live.length} accepted; ${appendix.length} in the appendix`);
if (output.comparison.downgraded?.length) console.log(`Downgraded to possible, so in the appendix and not fixed: ${output.comparison.downgraded.join(", ")}`);
if (applicable.length !== CATEGORIES.length) console.log(`Not applicable: ${CATEGORIES.filter((c) => !applicable.includes(c)).join(", ")}`);
console.log(isFull ? `Baseline written to ${auditDir}` : "Baseline not written: only a full audit replaces it.");
