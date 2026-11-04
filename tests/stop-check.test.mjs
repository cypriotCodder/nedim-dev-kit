import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { edit, fakeBin, fakeLocalBin, gitCommitAll, gitInit, project, stop, write } from "./helpers.mjs";

const TSC_FAILS = `echo "src/a.ts(1,7): error TS2322: bad"; exit 2`;

function tsProject({ tsc = TSC_FAILS, files = {} } = {}) {
  const root = gitInit(project({ "tsconfig.json": "{}\n", "src/keep.ts": "export {};\n", ...files }));
  gitCommitAll(root);
  fakeLocalBin(root, "tsc", tsc);
  write(root, ".gitignore", "node_modules\n");
  return root;
}

describe("stop-check: current behaviour to keep", () => {
  test("sends type errors back to Claude", () => {
    const root = tsProject();
    write(root, "src/a.ts", "export const a: number = 'x';\n");
    const r = stop(root);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /TS2322/);
  });

  test("passes when the typecheck passes", () => {
    const root = tsProject({ tsc: "exit 0" });
    write(root, "src/a.ts", "export {};\n");
    assert.equal(stop(root).code, 0);
  });

  test("does nothing without a tsconfig", () => {
    assert.equal(stop(project()).code, 0);
  });

  test("respects .claude/guards-off", () => {
    const root = tsProject();
    write(root, "src/a.ts", "export {};\n");
    write(root, ".claude/guards-off", "");
    assert.equal(stop(root).code, 0);
  });

  test("prefers the project's typecheck script", () => {
    const root = tsProject({ tsc: "exit 0", files: { "package.json": `{"scripts":{"typecheck":"x"}}\n` } });
    write(root, "src/a.ts", "export {};\n");
    const binDir = `${root}/fake-path`;
    fakeBin(binDir, "npm", `echo "from-npm-script error"; exit 1`);
    const r = stop(root, { env: { PATH: `${binDir}:${process.env.PATH}` } });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /from-npm-script/);
  });
});

describe("stop-check: project detection", () => {
  test("checks solution-style tsconfigs instead of passing as a no-op", () => {
    // Real tsc with `files: []` plus `references` checks nothing unless -b or -p is used.
    const root = tsProject({
      tsc: `case " $* " in *" -b "*|*" --build "*|*" -p "*|*" --project "*) ${TSC_FAILS};; esac; exit 0`,
      files: { "tsconfig.json": `{"files":[],"references":[{"path":"./tsconfig.app.json"}]}\n`, "tsconfig.app.json": "{}\n" },
    });
    write(root, "src/a.ts", "export {};\n");
    assert.equal(stop(root).code, 2);
  });

  test("uses the project's package manager for the typecheck script", () => {
    const root = tsProject({ tsc: "exit 0", files: { "package.json": `{"scripts":{"typecheck":"x"}}\n`, "pnpm-lock.yaml": "" } });
    write(root, "src/a.ts", "export {};\n");
    const binDir = `${root}/fake-path`;
    fakeBin(binDir, "npm", "exit 0");
    fakeBin(binDir, "pnpm", `echo "from-pnpm error"; exit 1`);
    const r = stop(root, { env: { PATH: `${binDir}:${process.env.PATH}` } });
    assert.match(r.stderr, /from-pnpm/);
  });

  test("reports a killed or timed-out typecheck instead of passing silently", () => {
    const root = tsProject({ tsc: "kill -9 $$" });
    write(root, "src/a.ts", "export {};\n");
    assert.match(stop(root).output, /typecheck|tsc/i);
  });
});

describe("stop-check: session awareness", () => {
  const pr3 = { todo: "PR 3: session edit markers and error baseline (items 2, 3, 6)" };

  test("catches broken TypeScript committed during the session", pr3, () => {
    const root = tsProject();
    edit(root, "src/a.ts", "export const a: number = 'x';\n");
    gitCommitAll(root);
    assert.equal(stop(root).code, 2);
  });

  test("does not bounce an idle turn because of someone else's dirty files", pr3, () => {
    const root = tsProject();
    write(root, "src/dirty.ts", "export const a: number = 'x';\n");
    assert.equal(stop(root, { session: "idle-session" }).code, 0);
  });

  test("checks changed files whose names contain spaces", pr3, () => {
    const root = tsProject();
    edit(root, "src/my file.ts", "export const a: number = 'x';\n");
    assert.equal(stop(root).code, 2);
  });

  test("re-checks after the first fix attempt instead of trusting it", pr3, () => {
    const root = tsProject();
    edit(root, "src/a.ts", "export const a: number = 'x';\n");
    assert.equal(stop(root, { active: true }).code, 2);
  });

  test("does not offer 'pre-existing' as a way out of new errors", pr3, () => {
    const root = tsProject();
    edit(root, "src/a.ts", "export const a: number = 'x';\n");
    assert.doesNotMatch(stop(root).stderr, /pre-existing/);
  });

  test("runs the boundary check when the project has one", pr3, () => {
    const root = tsProject({ tsc: "exit 0", files: { ".dependency-cruiser.cjs": "module.exports = {};\n" } });
    fakeLocalBin(root, "depcruise", `echo "error no-feature-internals: a -> b"; exit 1`);
    edit(root, "src/a.ts", "export {};\n");
    const r = stop(root);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /no-feature-internals/);
  });
});
