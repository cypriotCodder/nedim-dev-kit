// The committed list of secret findings a project has accepted. Every entry needs a reason and an
// expiry date, so an accepted risk gets looked at again. See ADR-007.
// Node built-ins only: this folder is copied into projects with collect.mjs.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const EXCEPTIONS_FILE = ".audit-exceptions.json";
const RULES = ["provider-key", "hardcoded-secret", "env-file"];

// `*` stays inside a folder, `**` crosses folders.
const globToRegex = (glob) => new RegExp(`^${glob
  .replace(/[.+^${}()|[\]\\?]/g, "\\$&")
  .replace(/\*\*\/|\*\*|\*/g, (m) => (m === "**/" ? "(?:.*/)?" : m === "**" ? ".*" : "[^/]*"))}$`);

// `2999-13-01` is an Invalid Date, whose toISOString() throws.
const validDate = (s) => {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};
// An acceptance has to be looked at again, so 9999-12-31 isn't an expiry.
const MAX_DAYS = 366;
const daysFrom = (today, date) => (new Date(`${date}T00:00:00Z`) - new Date(`${today}T00:00:00Z`)) / 864e5;

// Folder and file names no project uses, with the extensions projects do use. A glob that matches
// one of these matches every such file wherever it is, so it names nothing in particular.
const EXTENSIONS = ["ts", "tsx", "js", "jsx", "mjs", "py", "go", "rs", "java", "json", "yml", "md", "env", "txt"];
const ANYWHERE = EXTENSIONS.flatMap((ext) => [`zq7x.${ext}`, `zq7x/kv3w.${ext}`, `zq7x/kv3w/pj9m.${ext}`]);
const normalize = (path) => path.replace(/^(?:\.\/)+/, "");

function problemWith(e, rules = RULES, today) {
  if (!e || typeof e !== "object") return "not an object";
  if (!rules.includes(e.rule)) return rules === RULES ? `rule must be one of ${RULES.join(", ")}` : `unknown rule "${e.rule}"`;
  if (typeof e.path !== "string" || !normalize(e.path)) return "path is required";
  if (/^\/|^[A-Za-z]:[\\/]|(^|\/)\.\.(\/|$)/.test(e.path)) return "path must be relative to the project, without ..";
  const glob = globToRegex(normalize(e.path));
  const sample = ANYWHERE.find((p) => glob.test(p));
  if (sample) return `path matches files anywhere (such as ${sample}): name the folder or file`;
  if (typeof e.reason !== "string" || !e.reason.trim()) return "reason is required";
  if (!validDate(e.expires)) return "expires must be a date like 2027-01-31";
  if (daysFrom(today, e.expires) > MAX_DAYS) return `expires is more than a year ahead (${e.expires}): pick a date within a year, and look at it again then`;
  return null;
}

// `problems` is non-empty when the file can't be fully trusted. A bad entry is never applied, and
// the gate fails on it: quietly dropping it would turn someone's exception into a surprise later.
export function loadExceptions(root, today = new Date().toISOString().slice(0, 10)) {
  const path = join(root, EXCEPTIONS_FILE);
  const none = (problems = []) => ({ problems, active: [], expired: [] });
  if (!existsSync(path)) return none();
  let entries;
  try {
    const json = JSON.parse(readFileSync(path, "utf8"));
    entries = json.exceptions ?? (Array.isArray(json.risks) ? [] : undefined); // a file may hold only risks
  } catch (e) { return none([`unreadable: ${e.message}`]); }
  if (!Array.isArray(entries)) return none([`needs an "exceptions" list`]);
  return sortEntries(entries, today);
}

function sortEntries(entries, today, rules) {
  const result = { problems: [], active: [], expired: [] };
  entries.forEach((e, i) => {
    const problem = problemWith(e, rules, today);
    if (problem) result.problems.push(`entry ${i + 1}: ${problem}`);
    else if (e.expires < today) result.expired.push(e);
    else result.active.push({ ...e, matches: globToRegex(normalize(e.path)) });
  });
  return result;
}

// Audit findings a project has accepted, from the `risks` list in the same file. Same entry shape and
// same rules as secret exceptions, with `rule` taken from rules.json. Read by score.mjs, not the gate.
export function loadRisks(root, rules, today = new Date().toISOString().slice(0, 10)) {
  const path = join(root, EXCEPTIONS_FILE);
  if (!existsSync(path)) return { problems: [], active: [], expired: [] };
  let entries;
  try { entries = JSON.parse(readFileSync(path, "utf8")).risks ?? []; }
  catch (e) { return { problems: [`unreadable: ${e.message}`], active: [], expired: [] }; }
  if (!Array.isArray(entries)) return { problems: [`"risks" must be a list`], active: [], expired: [] };
  return sortEntries(entries, today, rules);
}

const label = ({ rule, path, reason, expires }) => ({ rule, path, reason, expires });

// Splits findings ({ rule, file }) into the ones still open and a report of what was accepted.
export function applyExceptions(findings, { active, expired }) {
  const used = new Set();
  const open = findings.filter((f) => {
    const hit = active.find((e) => e.rule === f.rule && e.matches.test(f.file));
    if (hit) used.add(hit);
    return !hit;
  });
  return {
    open,
    report: {
      applied: active.filter((e) => used.has(e)).map(label),
      unused: active.filter((e) => !used.has(e)).map(label),
      expired: expired.map(label),
    },
  };
}
