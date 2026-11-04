// The whole-project checks that Stop runs on edited files, and how their problems are compared with
// the baseline captured before the session's first edit.

import { relative, resolve, sep } from "node:path";
import { findBoundaryConfig, runBoundaryCheck, runTypecheck, typecheckDirs } from "../skills/audit/lib/project.mjs";

const SKIPPED_PATH = /(^|\/)(node_modules|dist|\.next)\//;
const TYPECHECKED = /\.(ts|tsx|mts|cts)$|(^|\/)tsconfig[^/]*\.json$/;
const BOUNDARY_CHECKED = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|vue|svelte)$/;

// Project-relative path of an edited file, or null if the hooks should ignore it. Path rules use
// this path, because the folder a project lives in must not change a result.
export function projectPath(root, file) {
  const rel = relative(resolve(root), resolve(root, file)).split(sep).join("/");
  return rel.startsWith("../") || SKIPPED_PATH.test(rel) ? null : rel;
}

export function checksFor(root, files) {
  const checks = typecheckDirs(root, files.filter((f) => TYPECHECKED.test(f))).map((dir) => {
    const where = relative(resolve(root), dir).split(sep).join("/");
    return {
      id: `typecheck:${where}`,
      label: where ? `typecheck in ${where}` : "typecheck",
      run: (timeoutMs) => runTypecheck(dir, { top: root, timeoutMs }),
    };
  });
  if (findBoundaryConfig(root) && files.some((f) => BOUNDARY_CHECKED.test(f))) {
    checks.push({ id: "boundary", label: "boundary check", run: (timeoutMs) => runBoundaryCheck(root, { timeoutMs }) });
  }
  return checks;
}

// Runs checks one after another inside a shared time budget, so together they finish before the hook's own timeout.
export function runChecks(checks, budgetMs) {
  const deadline = Date.now() + budgetMs;
  return checks.map((check) => {
    const remaining = deadline - Date.now();
    const result = remaining > 0
      ? check.run(remaining)
      : { status: "timed-out", reason: `no time left after ${Math.round(budgetMs / 1000)}s`, output: "", findings: false };
    return { check, result };
  });
}

// Splits tool output into separate problems. A key leaves out the line and column, so unrelated edits
// that move an old error don't make it look new. Output in an unknown format, such as from a custom
// script, is compared line by line: if it changes, the problem counts as new.
export function parseProblems(output) {
  const lines = output.split("\n").filter((line) => line.trim());
  const isProblem = (line) => /\berror TS\d+|^\s*error \S+:/.test(line);
  if (!lines.some(isProblem)) return lines.map((line) => ({ key: line.trim(), text: line }));
  const problems = [];
  for (const line of lines) {
    if (isProblem(line)) problems.push({ key: line.replace(/[(:]\d+[,:]\d+\)?/, "").trim(), text: line });
    else if (problems.length && /^\s/.test(line)) problems.at(-1).text += `\n${line}`;
  }
  return problems;
}

// Problems beyond those in the baseline. Keys are counted, because a second identical error in a
// file is a new error even though the first one already existed.
export function newProblems(problems, baselineKeys) {
  const remaining = new Map();
  for (const key of baselineKeys || []) remaining.set(key, (remaining.get(key) || 0) + 1);
  return problems.filter(({ key }) => {
    const count = remaining.get(key) || 0;
    if (count) remaining.set(key, count - 1);
    return !count;
  });
}
