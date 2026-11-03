// Stop hook: before Claude says "done", typecheck the project if TypeScript files changed.
// On errors, Claude is sent back to fix them (once — stop_hook_active prevents loops).
// If the typecheck itself breaks or times out, the user is warned: that is not a pass.
// Opt out per project: create .claude/guards-off

import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { runTypecheck, warnUser } from "../skills/audit/lib/project.mjs";

const input = JSON.parse(readFileSync(0, "utf8") || "{}");
const root = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();

if (input.stop_hook_active) process.exit(0);
if (existsSync(join(root, ".claude", "guards-off"))) process.exit(0);
if (!existsSync(join(root, "tsconfig.json"))) process.exit(0);

// Only run when TS/TSX files actually changed (if this is a git repo).
const git = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
if (git.status === 0 && !/\.(ts|tsx|mts|cts)\s*$/m.test(git.stdout)) process.exit(0);

const r = runTypecheck(root);

if (r.findings) {
  const out = r.output.trim().split("\n").filter(Boolean);
  process.stderr.write(
    `Typecheck failed (${out.length} lines). Fix these before finishing, ` +
    `or state clearly that they were pre-existing and out of scope:\n` +
    out.slice(0, 40).join("\n") + (out.length > 40 ? `\n…${out.length - 40} more lines` : "") + "\n"
  );
  process.exit(2);
}
if (r.status === "failed" || r.status === "timed-out") {
  warnUser(`agent-discipline: the typecheck didn't finish (${r.reason}), so type errors may be unreported.`);
}
process.exit(0);
