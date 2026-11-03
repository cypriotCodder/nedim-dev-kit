import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test, describe } from "node:test";
import { FAKE_AWS_KEY, collect, fakeBin, fakeLocalBin, gitCommitAll, gitInit, project } from "./helpers.mjs";

const repo = (files) => {
  const root = gitInit(project(files));
  gitCommitAll(root);
  return root;
};
const GATE = ["--offline", "--no-tests", "--gate"];

describe("collect: current behaviour to keep", () => {
  test("gate passes on a clean project", () => {
    const r = collect(repo({ "src/a.ts": "export const a = 1;\n" }), GATE);
    assert.equal(r.code, 0);
    assert.match(r.output, /GATE PASSED/);
  });

  test("gate fails on a provider key in source", () => {
    const r = collect(repo({ "src/a.ts": `export const k = "${FAKE_AWS_KEY}";\n` }), GATE);
    assert.equal(r.code, 1);
    assert.match(r.output, /hardcoded secrets/);
  });

  test("gate fails on a tracked .env file", () => {
    const r = collect(repo({ ".env": "DB_PASSWORD=hunter2\n", "src/a.ts": "export {};\n" }), GATE);
    assert.equal(r.code, 1);
    assert.match(r.output, /\.env files tracked/);
  });

  test("gate fails on type errors", () => {
    const root = repo({ "tsconfig.json": "{}\n", "src/a.ts": "export {};\n" });
    fakeLocalBin(root, "tsc", `echo "src/a.ts(1,1): error TS2322: bad"; exit 2`);
    const r = collect(root, GATE);
    assert.equal(r.code, 1);
    assert.equal(r.summary.metrics.typeErrors, 1);
  });

  test("records a missing tool as skipped", () => {
    const r = collect(repo({ "src/a.ts": "export {};\n" }));
    assert.match(r.summary.skipped.join("\n"), /eslint: eslint not installed/);
  });
});

describe("collect: semgrep (item 12)", () => {
  // Reproduces semgrep's refusal to combine `--config auto` with `--metrics off`.
  test("does not ask for a config that conflicts with --metrics off", () => {
    const root = repo({ "src/a.ts": "export {};\n" });
    const binDir = `${root}/fake-path`;
    fakeBin(binDir, "npx", "exit 0");
    fakeBin(binDir, "semgrep", `
case " $* " in
  *" --config auto "*) echo "Cannot create auto config when metrics are off" >&2; exit 2;;
esac
echo '{"results":[{"check_id":"x"}]}'`);
    const r = collect(root, ["--no-tests"], { binDir });
    assert.equal(r.summary.metrics.semgrepFindings, 1);
  });
});

describe("collect: tool status", () => {
  const pr2 = { todo: "PR 2/4: ok|skipped|failed|timed-out for every tool (items 1, 8)" };

  test("a crashing ESLint is failed, not clean", pr2, () => {
    const root = repo({ "src/a.ts": "export {};\n" });
    fakeLocalBin(root, "eslint", `echo "Oops! Something went wrong!" >&2; exit 2`);
    assert.equal(collect(root).summary.tools.eslint.status, "failed");
  });

  test("a crashing typecheck is failed, not clean", pr2, () => {
    const root = repo({ "tsconfig.json": "{}\n", "src/a.ts": "export {};\n" });
    fakeLocalBin(root, "tsc", `echo "Cannot find module" >&2; exit 1`);
    assert.equal(collect(root).summary.tools.typecheck.status, "failed");
  });

  test("gate fails when a required tool crashed", pr2, () => {
    const root = repo({ "tsconfig.json": "{}\n", "src/a.ts": "export {};\n" });
    fakeLocalBin(root, "tsc", `echo "Cannot find module" >&2; exit 1`);
    assert.equal(collect(root, GATE).code, 1);
  });

  test("checks solution-style tsconfigs", pr2, () => {
    const root = repo({ "tsconfig.json": `{"files":[],"references":[{"path":"./tsconfig.app.json"}]}\n`, "tsconfig.app.json": "{}\n", "src/a.ts": "export {};\n" });
    fakeLocalBin(root, "tsc", `case " $* " in *" -b "*|*" --build "*|*" -p "*|*" --project "*) echo "src/a.ts(1,1): error TS2322: bad"; exit 2;; esac; exit 0`);
    assert.equal(collect(root).summary.metrics.typeErrors, 1);
  });

  test("recognises bun.lock as a lockfile", pr2, () => {
    const root = repo({ "bun.lock": "{}\n", "src/a.ts": "export {};\n" });
    const binDir = `${root}/fake-path`;
    for (const name of ["npx", "npm", "bun"]) fakeBin(binDir, name, "exit 0");
    assert.doesNotMatch(collect(root, ["--no-tests"], { binDir }).summary.skipped.join("\n"), /no lockfile/);
  });
});

describe("collect: evidence coverage", () => {
  const pr4 = { todo: "PR 4: collector and gate (items 9, 10, 11, 16)" };

  test("lints every source folder, not just the first one found", pr4, () => {
    const root = repo({ "app/a.ts": "export {};\n", "lib/b.ts": "export {};\n" });
    fakeLocalBin(root, "eslint", `echo "$*" > "${root}/eslint-args"; echo "[]"`);
    collect(root);
    assert.match(readFileSync(`${root}/eslint-args`, "utf8"), /(^|\s)(lib|\.)(\s|$)/);
  });

  test("scans files with non-ASCII names", pr4, () => {
    const r = collect(repo({ "src/café.ts": "eval(input);\n" }));
    assert.equal(r.summary.metrics.patterns?.security?.eval, 1);
  });

  for (const file of ["config/ci.yml", "config/app.json", "scripts/deploy.sh", "config/.env.example"]) {
    test(`finds provider keys in ${file}`, pr4, () => {
      const r = collect(repo({ [file]: `key: ${FAKE_AWS_KEY}\n` }));
      assert.ok(r.summary.metrics.patterns?.security?.["provider-key"]);
    });
  }

  test("redacts secrets from saved evidence", pr4, () => {
    const r = collect(repo({ "src/a.ts": `export const k = "${FAKE_AWS_KEY}";\n` }));
    assert.doesNotMatch(r.raw("patterns.txt"), new RegExp(FAKE_AWS_KEY));
  });

  test("gate ignores token-like strings in test files", pr4, () => {
    const code = `const csrfToken = "abcdefghijklmnop1234";\n`;
    assert.equal(collect(repo({ "src/a.test.ts": code }), GATE).code, 0);
  });

  test("gate does not treat a secret-free .env.development as a leak", pr4, () => {
    const r = collect(repo({ ".env.development": "PUBLIC_URL=http://localhost:3000\n", "src/a.ts": "export {};\n" }), GATE);
    assert.equal(r.code, 0);
  });

  test("pins the version of every tool run through npx", pr4, () => {
    const root = repo({ "package.json": "{}\n", "src/a.ts": "export {};\n" });
    const binDir = `${root}/fake-path`;
    fakeBin(binDir, "npx", `echo "$*" >> "${root}/npx-calls"`);
    collect(root, ["--no-tests"], { binDir });
    for (const call of readFileSync(`${root}/npx-calls`, "utf8").trim().split("\n")) {
      assert.match(call, /^--yes (@?[\w-]+)@\d/, call);
    }
  });

  test("does not run project tests locally unless asked", pr4, () => {
    const root = repo({ "package.json": `{"scripts":{"test":"x"}}\n`, "src/a.ts": "export {};\n" });
    const binDir = `${root}/fake-path`;
    fakeBin(binDir, "npm", `echo "$*" >> "${root}/npm-calls"`);
    collect(root, ["--offline"], { binDir });
    assert.throws(() => readFileSync(`${root}/npm-calls`, "utf8"), { code: "ENOENT" });
  });
});
