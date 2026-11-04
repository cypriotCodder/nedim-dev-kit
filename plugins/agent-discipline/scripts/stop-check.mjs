// Stop hook: before Claude says "done", run the whole-project checks for what this session edited.
// - New problems send Claude back. Fixes are re-checked, up to MAX_BLOCKS times in a row.
// - Problems that were there before the session's first edit don't block, and are reported to the user.
// - A check that breaks or times out warns the user: that is not a pass.
// Opt out per project: create .claude/guards-off

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checksFor, newProblems, parseProblems, runChecks } from "./checks.mjs";
import { openSession } from "./session.mjs";
import { warnUser } from "../skills/audit/lib/project.mjs";

const MAX_BLOCKS = 3;
const BUDGET_MS = 170000; // under the 180s timeout in hooks.json
const MAX_LINES = 40;

const input = JSON.parse(readFileSync(0, "utf8") || "{}");
const root = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();

if (existsSync(join(root, ".claude", "guards-off"))) process.exit(0);

const session = openSession(root, input.session_id);
const edits = session.edits();
if (!edits.length) process.exit(0);

const reports = [];
const warnings = [];
let older = 0;

for (const { check, result } of runChecks(checksFor(root, edits), BUDGET_MS)) {
  // Not exclusive: with a references setup, one config can report errors while another crashes.
  if (result.status !== "ok") {
    warnings.push(`agent-discipline: the ${check.label} didn't finish (${result.reason}), so problems may be unreported.`);
  }
  if (!result.findings) continue;
  const problems = parseProblems(result.output);
  if (!problems.length) {
    warnings.push(`agent-discipline: the ${check.label} failed without reporting any problems, so its result is unknown.`);
    continue;
  }
  const fresh = newProblems(problems, session.baseline(check.id));
  older += problems.length - fresh.length;
  if (fresh.length) reports.push({ label: check.label, problems: fresh });
}
if (older) warnings.push(`agent-discipline: ${older} problem(s) from before this session's edits were left alone.`);

const finish = (messages) => {
  session.clearEdits();
  session.setBlocks(0);
  if (messages.length) warnUser(messages.join("\n"));
  process.exit(0);
};

const describe = ({ label, problems }) => {
  const lines = problems.flatMap((p) => p.text.split("\n"));
  const extra = lines.length > MAX_LINES ? `\n…${lines.length - MAX_LINES} more lines` : "";
  return `${label}: ${problems.length} new problem(s):\n${lines.slice(0, MAX_LINES).join("\n")}${extra}`;
};

if (!reports.length) finish(warnings);

// A new turn starts a new count. Only a continuation caused by this hook adds to it.
const blocks = input.stop_hook_active ? session.blocks() : 0;
if (blocks >= MAX_BLOCKS) {
  finish([`agent-discipline: giving up after ${MAX_BLOCKS} attempts. These problems are still there:\n${reports.map(describe).join("\n\n")}`, ...warnings]);
}

session.setBlocks(blocks + 1);
process.stderr.write(`Fix these before finishing:\n\n${[...reports.map(describe), ...warnings].join("\n\n")}\n`);
process.exit(2);
