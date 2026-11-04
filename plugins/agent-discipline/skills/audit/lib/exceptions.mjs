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

const validDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;

function problemWith(e) {
  if (!e || typeof e !== "object") return "not an object";
  if (!RULES.includes(e.rule)) return `rule must be one of ${RULES.join(", ")}`;
  if (typeof e.path !== "string" || !e.path) return "path is required";
  if (globToRegex(e.path).test("any/folder/file.ts")) return "path matches everything";
  if (typeof e.reason !== "string" || !e.reason.trim()) return "reason is required";
  if (!validDate(e.expires)) return "expires must be a date like 2027-01-31";
  return null;
}

// `problems` is non-empty when the file can't be fully trusted. A bad entry is never applied, and
// the gate fails on it: quietly dropping it would turn someone's exception into a surprise later.
export function loadExceptions(root, today = new Date().toISOString().slice(0, 10)) {
  const path = join(root, EXCEPTIONS_FILE);
  const none = (problems = []) => ({ problems, active: [], expired: [] });
  if (!existsSync(path)) return none();
  let entries;
  try { entries = JSON.parse(readFileSync(path, "utf8")).exceptions; }
  catch (e) { return none([`unreadable: ${e.message}`]); }
  if (!Array.isArray(entries)) return none([`needs an "exceptions" list`]);

  const result = none();
  entries.forEach((e, i) => {
    const problem = problemWith(e);
    if (problem) result.problems.push(`entry ${i + 1}: ${problem}`);
    else if (e.expires < today) result.expired.push(e);
    else result.active.push({ ...e, matches: globToRegex(e.path) });
  });
  return result;
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
