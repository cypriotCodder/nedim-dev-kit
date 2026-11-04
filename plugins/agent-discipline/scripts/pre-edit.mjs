// PreToolUse hook (Edit|Write|MultiEdit).
// Captures which problems already exist before the session first touches what a check covers, so
// Stop can tell them apart from new ones. This has to run before the edit: afterwards, Claude's
// own errors would be recorded as old. It never blocks the edit.
//
// A check that doesn't finish here gets an empty baseline, so Stop treats every problem as new.
// Opt out per project: create .claude/guards-off

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { checksFor, parseProblems, projectPath, runChecks } from "./checks.mjs";
import { openSession } from "./session.mjs";
import { warnUser } from "../skills/audit/lib/project.mjs";

const BUDGET_MS = 170000; // under the 180s timeout in hooks.json

const input = JSON.parse(readFileSync(0, "utf8") || "{}");
const root = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
const file = input.tool_input?.file_path;

if (!file || existsSync(join(root, ".claude", "guards-off"))) process.exit(0);
const rel = projectPath(root, file);
if (!rel) process.exit(0);

const session = openSession(root, input.session_id);
const pending = checksFor(root, [rel]).filter((check) => session.baseline(check.id) === undefined);

for (const { check, result } of runChecks(pending, BUDGET_MS)) {
  const keys = result.findings ? parseProblems(result.output).map((p) => p.key) : [];
  try {
    session.saveBaseline(check.id, keys);
  } catch (e) {
    warnUser(`agent-discipline: couldn't save the session baseline (${e.code || e.message}), so existing errors may be reported as new.`);
  }
}
process.exit(0);
