// How the hooks work together across one session: PreToolUse captures a baseline, PostToolUse
// records edits, and Stop compares and decides.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test, describe } from "node:test";
import { edit, fakeBin, fakeLocalBin, gitCommitAll, gitInit, preEdit, project, stop, write } from "./helpers.mjs";

const ERROR_A = "src/a.ts(1,7): error TS2322: bad a";
const ERROR_B = "src/b.ts(2,3): error TS2345: bad b";

// A fake tsc that prints whatever `errors` holds, and logs each run. Tests change its answer between hooks.
function tsProject(files = {}) {
  const root = gitInit(project({ "tsconfig.json": "{}\n", "src/keep.ts": "export {};\n", ...files }));
  fakeLocalBin(root, "tsc", `echo run >> runs; [ -s errors ] || exit 0; cat errors; exit 2`);
  write(root, ".gitignore", "node_modules\nerrors\nruns\n");
  gitCommitAll(root);
  return root;
}
const setErrors = (root, ...errors) => write(root, "errors", errors.map((e) => `${e}\n`).join(""));
const runs = (root) => (existsSync(join(root, "runs")) ? readFileSync(join(root, "runs"), "utf8").split("\n").filter(Boolean).length : 0);
const warning = (r) => JSON.parse(r.stdout).systemMessage;

describe("baseline", () => {
  test("errors from before the first edit don't block, and the user is told", () => {
    const root = tsProject();
    setErrors(root, ERROR_B);
    preEdit(root, "src/a.ts");
    edit(root, "src/a.ts", "export {};\n");
    const r = stop(root);
    assert.equal(r.code, 0);
    assert.match(warning(r), /1 problem\(s\) from before/);
  });

  test("a new error blocks, and only the new one is listed", () => {
    const root = tsProject();
    setErrors(root, ERROR_B);
    preEdit(root, "src/a.ts");
    edit(root, "src/a.ts", "export {};\n");
    setErrors(root, ERROR_B, ERROR_A);
    const r = stop(root);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /bad a/);
    assert.doesNotMatch(r.stderr, /bad b/);
  });

  test("an old error that moved to another line is still old", () => {
    const root = tsProject();
    setErrors(root, "src/b.ts(2,3): error TS2345: bad b");
    preEdit(root, "src/b.ts");
    edit(root, "src/b.ts", "// new first line\n");
    setErrors(root, "src/b.ts(3,3): error TS2345: bad b");
    assert.equal(stop(root).code, 0);
  });

  test("a second identical error counts as new", () => {
    const root = tsProject();
    setErrors(root, "src/b.ts(2,3): error TS2345: bad b");
    preEdit(root, "src/b.ts");
    edit(root, "src/b.ts", "x\n");
    setErrors(root, "src/b.ts(2,3): error TS2345: bad b", "src/b.ts(9,3): error TS2345: bad b");
    assert.equal(stop(root).code, 2);
  });

  test("is captured once, before the first edit, so later edits can't add to it", () => {
    const root = tsProject();
    preEdit(root, "src/a.ts");
    edit(root, "src/a.ts", "x\n");
    setErrors(root, ERROR_A);
    preEdit(root, "src/b.ts");
    edit(root, "src/b.ts", "x\n");
    assert.equal(runs(root), 1);
    assert.equal(stop(root).code, 2);
  });

  test("a typecheck that crashes during capture means every error counts as new", () => {
    const root = tsProject();
    fakeLocalBin(root, "tsc", `[ -f fixed ] || { echo "Cannot find module" >&2; exit 1; }; echo "${ERROR_B}"; exit 2`);
    preEdit(root, "src/a.ts");
    write(root, "fixed", "");
    edit(root, "src/a.ts", "x\n");
    assert.equal(stop(root).code, 2);
  });

  test("never blocks the edit, even when the typecheck is broken", () => {
    const root = tsProject();
    fakeLocalBin(root, "tsc", "kill -9 $$");
    assert.equal(preEdit(root, "src/a.ts").code, 0);
  });

  test("isn't captured for edits no check covers", () => {
    const root = tsProject();
    preEdit(root, "README.md");
    assert.equal(runs(root), 0);
  });

  test("isn't shared between sessions", () => {
    const root = tsProject();
    setErrors(root, ERROR_A);
    preEdit(root, "src/a.ts", { session: "other" });
    edit(root, "src/a.ts", "x\n", { session: "mine" });
    assert.equal(stop(root, { session: "mine" }).code, 2);
  });
});

describe("when Stop runs", () => {
  test("a passing check isn't repeated on the next idle turn", () => {
    const root = tsProject();
    edit(root, "src/a.ts", "x\n");
    assert.equal(stop(root).code, 0);
    assert.equal(runs(root), 1);
    assert.equal(stop(root).code, 0);
    assert.equal(runs(root), 1);
  });

  test("edits to other kinds of file don't run the typecheck", () => {
    const root = tsProject();
    edit(root, "README.md", "x\n");
    assert.equal(stop(root).code, 0);
    assert.equal(runs(root), 0);
  });

  test("editing tsconfig.json runs the typecheck", () => {
    const root = tsProject();
    setErrors(root, ERROR_A);
    edit(root, "tsconfig.json", "{}\n");
    assert.equal(stop(root).code, 2);
  });

  test("edits in another session don't count", () => {
    const root = tsProject();
    setErrors(root, ERROR_A);
    edit(root, "src/a.ts", "x\n", { session: "other" });
    assert.equal(stop(root, { session: "mine" }).code, 0);
  });

  test("works outside a git repo", () => {
    const root = project({ "tsconfig.json": "{}\n" });
    fakeLocalBin(root, "tsc", `echo "${ERROR_A}"; exit 2`);
    edit(root, "src/a.ts", "x\n");
    assert.equal(stop(root).code, 2);
  });

  test("warns when TypeScript isn't installed instead of passing silently", () => {
    const root = project({ "tsconfig.json": "{}\n" });
    edit(root, "src/a.ts", "x\n");
    const r = stop(root);
    assert.equal(r.code, 0);
    assert.match(warning(r), /typecheck didn't finish \(typescript not installed\)/);
  });
});

describe("retry limit", () => {
  const failing = () => {
    const root = tsProject();
    setErrors(root, ERROR_A);
    edit(root, "src/a.ts", "x\n");
    return root;
  };

  test("gives up after three attempts, and tells the user what's still broken", () => {
    const root = failing();
    assert.equal(stop(root).code, 2);
    assert.equal(stop(root, { active: true }).code, 2);
    assert.equal(stop(root, { active: true }).code, 2);
    const r = stop(root, { active: true });
    assert.equal(r.code, 0);
    assert.match(warning(r), /giving up after 3 attempts/);
    assert.match(warning(r), /bad a/);
  });

  test("a new turn starts a new count", () => {
    const root = failing();
    assert.equal(stop(root).code, 2);
    assert.equal(stop(root, { active: true }).code, 2);
    assert.equal(stop(root).code, 2);
    assert.equal(stop(root, { active: true }).code, 2);
    assert.equal(stop(root, { active: true }).code, 2);
  });

  test("a successful fix ends it", () => {
    const root = failing();
    assert.equal(stop(root).code, 2);
    setErrors(root);
    const r = stop(root, { active: true });
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
  });
});

describe("boundary check", () => {
  const VIOLATION = `echo "  error no-feature-internals: a -> b"; echo; echo "x 1 dependency violations"; exit 1`;
  const withConfig = () => project({ ".dependency-cruiser.cjs": "module.exports = {};\n", "src/keep.js": "\n" });

  test("runs on JavaScript edits in a project without TypeScript", () => {
    const root = withConfig();
    fakeLocalBin(root, "depcruise", VIOLATION);
    edit(root, "src/a.js", "x\n");
    assert.match(stop(root).stderr, /no-feature-internals/);
  });

  test("uses the same baseline as the typecheck", () => {
    const root = withConfig();
    fakeLocalBin(root, "depcruise", VIOLATION);
    preEdit(root, "src/a.js");
    edit(root, "src/a.js", "x\n");
    assert.equal(stop(root).code, 0);
  });

  // dependency-cruiser exits 1 in both cases. This output is copied from the real tool.
  test("a broken config warns the user instead of sending Claude after it", () => {
    const root = withConfig();
    fakeLocalBin(root, "depcruise", `echo "  ERROR: Unexpected token '{'"; exit 1`);
    edit(root, "src/a.js", "x\n");
    const r = stop(root);
    assert.equal(r.code, 0);
    assert.match(warning(r), /boundary check didn't finish/);
  });

  // The real tool does this on .ts files when it can't load TypeScript. Output copied from it.
  test("a run that checked nothing warns the user instead of passing", () => {
    const root = withConfig();
    fakeLocalBin(root, "depcruise", `echo "✔ no dependency violations found (0 modules, 0 dependencies cruised)"; exit 0`);
    edit(root, "src/a.js", "x\n");
    assert.match(warning(stop(root)), /boundary check didn't finish \(it checked 0 modules in src\)/);
  });

  test("a clean run stays quiet", () => {
    const root = withConfig();
    fakeLocalBin(root, "depcruise", `echo "✔ no dependency violations found (10 modules, 20 dependencies cruised)"; exit 0`);
    edit(root, "src/a.js", "x\n");
    const r = stop(root);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
  });

  test("warns when the project has a config but the tool isn't installed", () => {
    const root = withConfig();
    edit(root, "src/a.js", "x\n");
    assert.match(warning(stop(root)), /dependency-cruiser not installed/);
  });

  test("does nothing without a config", () => {
    const root = project();
    fakeLocalBin(root, "depcruise", VIOLATION);
    edit(root, "src/a.js", "x\n");
    assert.equal(stop(root).code, 0);
  });
});

describe("monorepos", () => {
  test("finds a tsc hoisted to the project root", () => {
    const root = project({ "apps/web/tsconfig.json": "{}\n" });
    fakeLocalBin(root, "tsc", `pwd; echo "a.ts(1,1): error TS2322: bad"; exit 2`);
    edit(root, "apps/web/src/a.ts", "x\n");
    const r = stop(root);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /typecheck in apps\/web/);
  });

  test("checks each edited package once", () => {
    const root = project({ "apps/web/tsconfig.json": "{}\n", "apps/api/tsconfig.json": "{}\n" });
    fakeLocalBin(root, "tsc", `pwd; echo "a.ts(1,1): error TS2322: bad"; exit 2`);
    edit(root, "apps/web/src/a.ts", "x\n");
    edit(root, "apps/web/src/b.ts", "x\n");
    edit(root, "apps/api/src/c.ts", "x\n");
    const { stderr } = stop(root);
    assert.match(stderr, /typecheck in apps\/web/);
    assert.match(stderr, /typecheck in apps\/api/);
    assert.equal(stderr.match(/new problem/g).length, 2);
  });

  test("a root typecheck script covers the whole repo", () => {
    const root = project({ "package.json": `{"scripts":{"typecheck":"x"}}\n`, "apps/web/tsconfig.json": "{}\n" });
    const binDir = join(root, "fake-path");
    fakeBin(binDir, "npm", `echo "from-root-script error"; exit 1`);
    edit(root, "apps/web/src/a.ts", "x\n");
    const r = stop(root, { env: { PATH: `${binDir}:${process.env.PATH}` } });
    assert.match(r.stderr, /from-root-script/);
    assert.doesNotMatch(r.stderr, /typecheck in apps/);
  });
});

describe("warnings", () => {
  test("a typecheck script that fails without output warns instead of passing silently", () => {
    const root = tsProject({ "package.json": `{"scripts":{"typecheck":"x"}}\n` });
    const binDir = `${root}/fake-path`;
    fakeBin(binDir, "npm", "exit 1");
    edit(root, "src/a.ts", "x\n");
    const r = stop(root, { env: { PATH: `${binDir}:${process.env.PATH}` } });
    assert.equal(r.code, 0);
    assert.match(warning(r), /typecheck failed without reporting any problems/);
  });

  test("one config crashing is still reported when another config found old errors", () => {
    const root = tsProject({
      "tsconfig.json": `{"files":[],"references":[{"path":"./tsconfig.app.json"},{"path":"./tsconfig.lib.json"}]}\n`,
      "tsconfig.app.json": "{}\n",
      "tsconfig.lib.json": "{}\n",
    });
    fakeLocalBin(root, "tsc", `case "$*" in *tsconfig.0.json*) echo "${ERROR_A}"; exit 2;; esac; [ -f crash ] && kill -9 $$; exit 0`);
    preEdit(root, "src/a.ts");
    write(root, "crash", "");
    edit(root, "src/a.ts", "x\n");
    const r = stop(root);
    assert.equal(r.code, 0);
    assert.match(warning(r), /typecheck didn't finish \(killed by SIGKILL\)/);
    assert.match(warning(r), /1 problem\(s\) from before/);
  });

  test("a broken ESLint warns once per session, not on every edit", () => {
    const root = project();
    fakeLocalBin(root, "eslint", `echo "bad config" >&2; exit 2`);
    assert.match(warning(edit(root, "src/a.ts", "x\n")), /ESLint didn't finish/);
    assert.equal(edit(root, "src/b.ts", "x\n").stdout, "");
    assert.match(warning(edit(root, "src/c.ts", "x\n", { session: "next" })), /ESLint didn't finish/);
  });

  test("a session folder that can't be written warns instead of losing the edit silently", () => {
    const root = project();
    const r = edit(root, "src/a.ts", "x\n", { env: { TMPDIR: join(root, "src", "a.ts") } });
    assert.match(warning(r), /couldn't record the edit/);
  });
});
