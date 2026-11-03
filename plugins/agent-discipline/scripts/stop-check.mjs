// Stop hook: before Claude says "done", typecheck the project if TypeScript files changed.
// On errors, Claude is sent back to fix them (once — stop_hook_active prevents loops).
// Prefers `npm run typecheck` if the project defines it, else `tsc --noEmit`.
// Opt out per project: create .claude/guards-off

import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const input = JSON.parse(readFileSync(0, "utf8") || "{}");
const root = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();

if (input.stop_hook_active) process.exit(0);
if (existsSync(join(root, ".claude", "guards-off"))) process.exit(0);
if (!existsSync(join(root, "tsconfig.json"))) process.exit(0);

// Only run when TS/TSX files actually changed (if this is a git repo).
const git = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8" });
if (git.status === 0 && !/\.(ts|tsx|mts|cts)\s*$/m.test(git.stdout)) process.exit(0);

let pkg = {};
try { pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")); } catch {}

let cmd, args;
if (pkg.scripts?.typecheck) {
  cmd = process.platform === "win32" ? "npm.cmd" : "npm";
  args = ["run", "-s", "typecheck"];
} else {
  const tsc = join(root, "node_modules", ".bin", process.platform === "win32" ? "tsc.cmd" : "tsc");
  if (!existsSync(tsc)) process.exit(0);
  cmd = tsc;
  args = ["--noEmit", "--pretty", "false"];
}

const r = spawnSync(cmd, args, { cwd: root, encoding: "utf8", timeout: 170000 });
if (r.status !== 0 && r.status !== null) {
  const out = (r.stdout + "\n" + r.stderr).trim().split("\n").filter(Boolean);
  process.stderr.write(
    `Typecheck failed (${out.length} lines). Fix these before finishing, ` +
    `or state clearly that they were pre-existing and out of scope:\n` +
    out.slice(0, 40).join("\n") + (out.length > 40 ? `\n…${out.length - 40} more lines` : "") + "\n"
  );
  process.exit(2);
}
process.exit(0);
