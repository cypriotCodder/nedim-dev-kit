import assert from "node:assert/strict";
import { cpSync, existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, describe, after } from "node:test";
import { PLUGIN, REPO, collect, edit, fakeBin, fakeLocalBin, gitCommitAll, gitInit, project, stop, write } from "./helpers.mjs";

// src/keep.ts is committed so that later writes show up in `git status` as src/<file>.ts, not `src/`.
const repo = (files) => { const root = gitInit(project({ "src/keep.ts": "export {};\n", ...files })); gitCommitAll(root); return root; };
const SOLUTION = `{
  // comments and trailing commas are normal in tsconfig files
  "files": [],
  "references": [{ "path": "./tsconfig.app.json" }],
}
`;
const TSC_ONLY_FAILS_WITH_P = `case " $* " in *" -p "*) echo "src/a.ts(1,7): error TS2322: bad"; exit 2;; esac; exit 0`;

describe("broken tools warn the user without blocking Claude", () => {
  test("a crashed ESLint exits 0 with a systemMessage", () => {
    const root = project();
    fakeLocalBin(root, "eslint", `echo "bad config" >&2; exit 2`);
    const r = edit(root, "src/a.ts", "x\n");
    assert.equal(r.code, 0);
    assert.match(JSON.parse(r.stdout).systemMessage, /ESLint didn't finish/);
  });

  test("a crashed typecheck exits 0 with a systemMessage", () => {
    const root = repo({ "tsconfig.json": "{}\n", "src/keep.ts": "export {};\n" });
    fakeLocalBin(root, "tsc", `echo "Cannot find module" >&2; exit 1`);
    write(root, "src/a.ts", "export {};\n");
    const r = stop(root);
    assert.equal(r.code, 0);
    assert.match(JSON.parse(r.stdout).systemMessage, /typecheck didn't finish/);
  });

  test("a warning still reaches Claude alongside real problems", () => {
    const root = project({ "DESIGN.md": "# Design\n" });
    fakeLocalBin(root, "eslint", "kill -9 $$");
    const r = edit(root, "src/C.tsx", `const a = "#ff0000";\n`);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /raw hex color/);
    assert.match(r.stderr, /ESLint didn't finish/);
  });
});

describe("monorepos", () => {
  test("uses the ESLint nearest to the edited file", () => {
    const root = project();
    fakeLocalBin(root, "eslint", "exit 0");
    fakeLocalBin(join(root, "apps/web"), "eslint", `echo "from-nested"; exit 1`);
    const r = edit(root, "apps/web/src/a.ts", "x\n");
    assert.equal(r.code, 2);
    assert.match(r.stderr, /from-nested/);
  });

  test("runs ESLint from its own package, where the flat config lives", () => {
    const root = project();
    fakeLocalBin(join(root, "apps/web"), "eslint", `pwd; exit 1`);
    assert.match(edit(root, "apps/web/src/a.ts", "x\n").stderr, /apps\/web/);
  });

  test("typechecks the package with the edited file when the root has no tsconfig", { todo: "PR 3: stop hook needs the edited files from session markers" }, () => {
    const root = gitInit(project({ "apps/web/tsconfig.json": "{}\n" }));
    fakeLocalBin(join(root, "apps/web"), "tsc", `echo "a.ts(1,1): error TS2322: bad"; exit 2`);
    edit(root, "apps/web/src/a.ts", "x\n");
    assert.equal(stop(root).code, 2);
  });

  test("notices new TypeScript files in a new, untracked folder", { todo: "PR 3: `git status` shows only `?? src/` here, so the filter skips them (item 2)" }, () => {
    const root = gitInit(project({ "tsconfig.json": "{}\n", "README.md": "x\n" }));
    gitCommitAll(root);
    fakeLocalBin(root, "tsc", `echo "src/a.ts(1,1): error TS2322: bad"; exit 2`);
    edit(root, "src/a.ts", "export {};\n");
    assert.equal(stop(root).code, 2);
  });
});

describe("typecheck command", () => {
  test("ignores a plain `tsc --noEmit` script on a references setup, where it checks nothing", () => {
    const root = repo({ "tsconfig.json": SOLUTION, "tsconfig.app.json": "{}\n", "package.json": `{"scripts":{"typecheck":"tsc --noEmit"}}\n` });
    fakeLocalBin(root, "tsc", TSC_ONLY_FAILS_WITH_P);
    write(root, "src/a.ts", "export {};\n");
    assert.equal(stop(root).code, 2);
  });

  test("keeps a custom typecheck script on a references setup", () => {
    const root = repo({ "tsconfig.json": SOLUTION, "tsconfig.app.json": "{}\n", "package.json": `{"scripts":{"typecheck":"tsc -b"}}\n` });
    fakeLocalBin(root, "tsc", TSC_ONLY_FAILS_WITH_P);
    write(root, "src/a.ts", "export {};\n");
    const binDir = join(root, "fake-path");
    fakeBin(binDir, "npm", "exit 0");
    assert.equal(stop(root, { env: { PATH: `${binDir}:${process.env.PATH}` } }).code, 0);
  });

  test("leaves nothing behind in the project", () => {
    const root = repo({ "tsconfig.json": SOLUTION, "tsconfig.app.json": "{}\n" });
    fakeLocalBin(root, "tsc", TSC_ONLY_FAILS_WITH_P);
    write(root, "src/a.ts", "export {};\n");
    stop(root);
    assert.deepEqual(readdirSync(join(root, "node_modules", ".cache", "agent-discipline")), []);
  });
});

describe("collect", () => {
  test("a typecheck script failing with no recognisable errors is failed, not zero errors", () => {
    const root = repo({ "tsconfig.json": "{}\n", "package.json": `{"scripts":{"typecheck":"x"}}\n` });
    const binDir = join(root, "fake-path");
    fakeBin(binDir, "npm", `echo "something else broke"; exit 1`);
    const r = collect(root, ["--offline", "--no-tests", "--gate"], { binDir });
    assert.equal(r.summary.tools.typecheck.status, "failed");
    assert.equal(r.summary.metrics.typeErrors, null);
    assert.equal(r.code, 1);
  });

  test("real type errors are ok status with a count", () => {
    const root = repo({ "tsconfig.json": "{}\n" });
    fakeLocalBin(root, "tsc", `echo "a.ts(1,1): error TS2322: bad"; exit 2`);
    const r = collect(root);
    assert.equal(r.summary.tools.typecheck.status, "ok");
    assert.equal(r.summary.metrics.typeErrors, 1);
  });

  test("reads `strict` from a tsconfig with comments", () => {
    const root = repo({ "tsconfig.json": `{ /* note */ "compilerOptions": { "strict": true, } }\n` });
    fakeLocalBin(root, "tsc", "exit 0");
    assert.equal(collect(root).summary.metrics.tsStrict, true);
  });

  test("names other ecosystems' lockfiles instead of claiming there is none", () => {
    const root = repo({ "Cargo.lock": "", "src/a.rs": "fn main() {}\n" });
    const binDir = join(root, "fake-path");
    fakeBin(binDir, "npx", "exit 0");
    const skipped = collect(root, ["--no-tests"], { binDir }).summary.skipped.join("\n");
    assert.match(skipped, /Cargo\.lock: dependency audit not assessed/);
    assert.doesNotMatch(skipped, /no lockfile/);
  });

  test("runs tests with the project's package manager", () => {
    const root = repo({ "package.json": `{"scripts":{"test":"x"}}\n`, "pnpm-lock.yaml": "" });
    const binDir = join(root, "fake-path");
    fakeBin(binDir, "pnpm", `echo "$*" > "${root}/pnpm-args"; exit 0`);
    fakeBin(binDir, "npm", "exit 1");
    assert.equal(collect(root, ["--offline"], { binDir }).summary.metrics.tests.exitCode, 0);
    assert.ok(existsSync(join(root, "pnpm-args")));
  });

  test("still works when copied into a project the way the audit skill says", () => {
    const root = repo({ "src/a.ts": "export {};\n" });
    cpSync(join(PLUGIN, "skills/audit/collect.mjs"), join(root, "scripts/audit/collect.mjs"), { recursive: true });
    cpSync(join(PLUGIN, "skills/audit/lib"), join(root, "scripts/audit/lib"), { recursive: true });
    const r = spawnSync(process.execPath, ["scripts/audit/collect.mjs", ".", "--offline", "--no-tests", "--gate"], { cwd: root, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /GATE PASSED/);
  });
});

// Fakes can't show that the temporary-config approach really works, so this uses real compilers.
// CI installs them as aliases: ts55, ts59, ts70 (see .github/workflows/test.yml).
describe("real TypeScript", () => {
  const compilers = ["ts55", "ts59", "ts70"].filter((c) => existsSync(join(REPO, "node_modules", c, "package.json")));
  const skip = compilers.length ? false : "needs the compilers CI installs: npm run test:install-ts";
  const base = mkdtempSync(join(tmpdir(), "adk-real-"));
  after(() => rmSync(base, { recursive: true, force: true }));

  // A composite setup where app imports lib. This is the case that defeats every plain tsc command.
  const composite = (appCode) => {
    const root = repo({
      "tsconfig.json": SOLUTION.replace(`{ "path": "./tsconfig.app.json" }`, `{ "path": "./tsconfig.lib.json" }, { "path": "./tsconfig.app.json" }`),
      "tsconfig.lib.json": `{"compilerOptions":{"composite":true,"outDir":"out/lib","declaration":true,"strict":true,"types":[]},"include":["lib"]}\n`,
      "tsconfig.app.json": `{"compilerOptions":{"composite":true,"outDir":"out/app","strict":true,"types":[]},"include":["src"],"references":[{"path":"./tsconfig.lib.json"}]}\n`,
      "lib/l.ts": "export const n: number = 1;\n",
    });
    write(root, "src/a.ts", appCode);
    return root;
  };
  const useCompiler = (root, c) => fakeLocalBin(root, "tsc", `exec "${join(REPO, "node_modules", c, "bin", "tsc")}" "$@"`);

  for (const c of compilers.length ? compilers : ["(none installed)"]) {
    test(`${c}: finds a type error across a project reference`, { skip }, () => {
      const root = composite(`import { n } from "../lib/l";\nexport const s: string = n;\n`);
      useCompiler(root, c);
      const r = stop(root);
      assert.equal(r.code, 2, r.output);
      assert.match(r.stderr, /TS2322/);
    });

    test(`${c}: passes correct code without false errors or build output`, { skip }, () => {
      const root = composite(`import { n } from "../lib/l";\nexport const m: number = n;\n`);
      useCompiler(root, c);
      const r = stop(root);
      assert.equal(r.code, 0, r.output);
      assert.equal(r.stdout, "", "should not warn");
      assert.equal(existsSync(join(root, "out")), false, "wrote build output");
    });
  }
});
