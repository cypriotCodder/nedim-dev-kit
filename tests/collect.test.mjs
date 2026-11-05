import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { test, describe } from "node:test";
import { FAKE_AWS_KEY, PLUGIN as PLUGIN_DIR, collect, fakeBin, fakeLocalBin, gitCommitAll, gitInit, project, write } from "./helpers.mjs";

const repo = (files) => {
  const root = gitInit(project(files));
  gitCommitAll(root);
  return root;
};
const GATE = ["--offline", "--no-tests", "--gate"];
const today = () => new Date().toISOString().slice(0, 10);
const daysAhead = (n) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

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
  test("a crashing ESLint is failed, not clean", () => {
    const root = repo({ "src/a.ts": "export {};\n" });
    fakeLocalBin(root, "eslint", `echo "Oops! Something went wrong!" >&2; exit 2`);
    assert.equal(collect(root).summary.tools.eslint.status, "failed");
  });

  test("a crashing typecheck is failed, not clean", () => {
    const root = repo({ "tsconfig.json": "{}\n", "src/a.ts": "export {};\n" });
    fakeLocalBin(root, "tsc", `echo "Cannot find module" >&2; exit 1`);
    assert.equal(collect(root).summary.tools.typecheck.status, "failed");
  });

  test("gate fails when a required tool crashed", () => {
    const root = repo({ "tsconfig.json": "{}\n", "src/a.ts": "export {};\n" });
    fakeLocalBin(root, "tsc", `echo "Cannot find module" >&2; exit 1`);
    assert.equal(collect(root, GATE).code, 1);
  });

  test("checks solution-style tsconfigs", () => {
    const root = repo({ "tsconfig.json": `{"files":[],"references":[{"path":"./tsconfig.app.json"}]}\n`, "tsconfig.app.json": "{}\n", "src/a.ts": "export {};\n" });
    fakeLocalBin(root, "tsc", `case " $* " in *" -b "*|*" --build "*|*" -p "*|*" --project "*) echo "src/a.ts(1,1): error TS2322: bad"; exit 2;; esac; exit 0`);
    assert.equal(collect(root).summary.metrics.typeErrors, 1);
  });

  test("recognises bun.lock as a lockfile", () => {
    const root = repo({ "bun.lock": "{}\n", "src/a.ts": "export {};\n" });
    const binDir = `${root}/fake-path`;
    for (const name of ["npx", "npm", "bun"]) fakeBin(binDir, name, "exit 0");
    assert.doesNotMatch(collect(root, ["--no-tests"], { binDir }).summary.skipped.join("\n"), /no lockfile/);
  });
});

describe("collect: evidence coverage", () => {
  test("lints every source folder, not just the first one found", () => {
    const root = repo({ "app/a.ts": "export {};\n", "lib/b.ts": "export {};\n" });
    fakeLocalBin(root, "eslint", `echo "$*" > "${root}/eslint-args"; echo "[]"`);
    collect(root);
    assert.match(readFileSync(`${root}/eslint-args`, "utf8"), /(^|\s)(lib|\.)(\s|$)/);
  });

  test("scans files with non-ASCII names", () => {
    const r = collect(repo({ "src/café.ts": "eval(input);\n" }));
    assert.equal(r.summary.metrics.patterns?.security?.eval, 1);
  });

  for (const file of ["config/ci.yml", "config/app.json", "scripts/deploy.sh", "config/.env.example"]) {
    test(`finds provider keys in ${file}`, () => {
      const r = collect(repo({ [file]: `key: ${FAKE_AWS_KEY}\n` }));
      assert.ok(r.summary.metrics.patterns?.security?.["provider-key"]);
    });
  }

  test("redacts secrets from saved evidence", () => {
    const r = collect(repo({ "src/a.ts": `export const k = "${FAKE_AWS_KEY}";\n` }));
    assert.doesNotMatch(r.raw("patterns.txt"), new RegExp(FAKE_AWS_KEY));
  });

  test("gate ignores token-like strings in test files", () => {
    const code = `const csrfToken = "abcdefghijklmnop1234";\n`;
    assert.equal(collect(repo({ "src/a.test.ts": code }), GATE).code, 0);
  });

  test("gate does not treat a secret-free .env.development as a leak", () => {
    const r = collect(repo({ ".env.development": "PUBLIC_URL=http://localhost:3000\n", "src/a.ts": "export {};\n" }), GATE);
    assert.equal(r.code, 0);
  });

  test("pins the version of every tool run through npx", () => {
    const root = repo({ "package.json": "{}\n", "src/a.ts": "export {};\n" });
    const binDir = `${root}/fake-path`;
    fakeBin(binDir, "npx", `echo "$*" >> "${root}/npx-calls"`);
    collect(root, ["--no-tests"], { binDir });
    for (const call of readFileSync(`${root}/npx-calls`, "utf8").trim().split("\n")) {
      assert.match(call, /^--yes (@?[\w-]+)@\d/, call);
    }
  });

  test("does not run project tests locally unless asked", () => {
    const root = repo({ "package.json": `{"scripts":{"test":"x"}}\n`, "src/a.ts": "export {};\n" });
    const binDir = `${root}/fake-path`;
    fakeBin(binDir, "npm", `echo "$*" >> "${root}/npm-calls"`);
    collect(root, ["--offline"], { binDir });
    assert.throws(() => readFileSync(`${root}/npm-calls`, "utf8"), { code: "ENOENT" });
  });
});

// Every tool has to tell "found nothing" from "didn't work", and fakes can't all be right by luck:
// the outputs here are copied from the real tools at the versions pinned in collect.mjs.
describe("collect: tool status for the remaining tools", () => {
  const online = (files, npxBody = "exit 0") => {
    const root = repo({ "package.json": "{}\n", "src/a.ts": "export {};\n", ...files });
    const binDir = `${root}/fake-path`;
    fakeBin(binDir, "npx", npxBody);
    return { root, binDir };
  };
  const dispatch = (cases) => `case "$2" in\n${Object.entries(cases).map(([k, v]) => `  ${k}*) ${v};;`).join("\n")}\n  *) exit 0;;\nesac`;

  test("a fake that prints nothing leaves every npx tool failed, not clean", () => {
    const { root, binDir } = online();
    const { tools, metrics } = collect(root, ["--no-tests"], { binDir }).summary;
    for (const name of ["boundaries", "knip", "duplication"]) assert.equal(tools[name].status, "failed", name);
    assert.equal(metrics.circularDeps, null);
    assert.equal(metrics.deadCode, undefined);
  });

  test("reads madge when it finds cycles, which it reports with exit 1", () => {
    const { root, binDir } = online({}, dispatch({ madge: `echo "✖ Found 2 circular dependencies!"; exit 1` }));
    const { tools, metrics } = collect(root, ["--no-tests"], { binDir }).summary;
    assert.equal(tools.boundaries.status, "ok");
    assert.equal(metrics.circularDeps, 2);
  });

  test("gives madge a source folder even without a tsconfig", () => {
    const { root, binDir } = online({}, dispatch({ madge: `echo "$*" > "$PWD/madge-args"; echo "No circular dependency found!"` }));
    collect(root, ["--no-tests"], { binDir });
    assert.doesNotMatch(readFileSync(`${root}/madge-args`, "utf8"), /--ts-config/);
  });

  test("counts unused files from knip's issues list", () => {
    const report = JSON.stringify({ issues: [{ file: "lib/x.js", files: [{ name: "lib/x.js" }], exports: [], dependencies: [{ name: "left-pad" }] }] });
    const { root, binDir } = online({}, dispatch({ knip: `echo '${report}'` }));
    const { deadCode } = collect(root, ["--no-tests"], { binDir }).summary.metrics;
    assert.equal(deadCode.unusedFiles, 1);
    assert.equal(deadCode.unusedDependencies, 1);
  });

  for (const [what, body] of [["crashes", `echo boom >&2; exit 2`], ["prints nothing readable", `echo "not json"`]]) {
    test(`semgrep that ${what} is failed`, () => {
      const { root, binDir } = online();
      fakeBin(binDir, "semgrep", body);
      assert.equal(collect(root, ["--no-tests"], { binDir }).summary.tools.semgrep.status, "failed");
    });
  }

  test("npm audit with unreadable output is failed and blocks the gate", () => {
    const { root, binDir } = online({ "package-lock.json": "{}\n" });
    fakeBin(binDir, "npm", `echo "npm error network" >&2; exit 1`);
    const r = collect(root, ["--no-tests", "--gate"], { binDir });
    assert.equal(r.summary.tools.vulnerabilities.status, "failed");
    assert.equal(r.code, 1);
    assert.match(r.output, /vulnerabilities did not finish/);
  });

  test("npm audit reporting vulnerabilities through exit 1 is read, and blocks the gate", () => {
    const { root, binDir } = online({ "package-lock.json": "{}\n" });
    fakeBin(binDir, "npm", `case "$1" in audit) echo '{"metadata":{"vulnerabilities":{"high":1,"critical":0}}}'; exit 1;; *) echo '{}';; esac`);
    const r = collect(root, ["--no-tests", "--gate"], { binDir });
    assert.equal(r.summary.tools.vulnerabilities.status, "ok");
    assert.equal(r.code, 1);
    assert.match(r.output, /high\/critical vulnerable/);
  });

  test("gitleaks that crashes without a report blocks the gate", () => {
    const { root, binDir } = online();
    fakeBin(binDir, "gitleaks", `exit 1`);
    const r = collect(root, ["--offline", "--no-tests", "--gate"], { binDir });
    assert.equal(r.summary.tools.gitleaks.status, "failed");
    assert.equal(r.code, 1);
  });

  test("gitleaks reporting a leak through exit 1 is counted", () => {
    const { root, binDir } = online();
    fakeBin(binDir, "gitleaks", `while [ "$1" != "--report-path" ]; do shift; done; echo '[{"RuleID":"x"}]' > "$2"; exit 1`);
    const r = collect(root, ["--offline", "--no-tests", "--gate"], { binDir });
    assert.equal(r.summary.metrics.secretsInHistory, 1);
    assert.match(r.output, /1 secrets in git history/);
  });

  test("a gitleaks report from an earlier run doesn't count for this one", () => {
    const { root, binDir } = online();
    fakeBin(binDir, "gitleaks", `while [ "$1" != "--report-path" ]; do shift; done; echo '[]' > "$2"; exit 0`);
    assert.equal(collect(root, ["--offline", "--no-tests", "--gate"], { binDir }).code, 0);
    fakeBin(binDir, "gitleaks", `exit 1`);
    assert.equal(collect(root, ["--offline", "--no-tests", "--gate"], { binDir }).code, 1);
  });

  test("a local boundary check with a broken config is failed, not zero violations", () => {
    const root = repo({ ".dependency-cruiser.mjs": "export default {};\n", "src/a.ts": "export {};\n" });
    fakeLocalBin(root, "depcruise", `echo "  ERROR: Unexpected token"; exit 1`);
    const { tools, metrics } = collect(root).summary;
    assert.equal(tools.boundaries.status, "failed");
    assert.equal(metrics.boundaryViolations, null);
  });

  test("every tool ends with a status", () => {
    const { tools } = collect(repo({ "src/a.ts": "export {};\n" })).summary;
    for (const [name, t] of Object.entries(tools)) assert.ok(["ok", "skipped", "failed", "timed-out"].includes(t.status), name);
  });
});

describe("collect: which folders the tools see", () => {
  test("includes folders outside any fixed list, and skips build output and dot folders", () => {
    const root = repo({ "app/a.ts": "export {};\n", "components/b.tsx": "export {};\n", "dist/c.js": "x\n", ".storybook/d.js": "x\n", "docs/e.md": "x\n" });
    fakeLocalBin(root, "eslint", `echo "$*" > "${root}/eslint-args"; echo "[]"`);
    const args = (collect(root), readFileSync(`${root}/eslint-args`, "utf8"));
    assert.match(args, /^app components --no-error/);
  });

  test("--src still narrows the run to one folder", () => {
    const root = repo({ "app/a.ts": "export {};\n", "lib/b.ts": "export {};\n" });
    fakeLocalBin(root, "eslint", `echo "$*" > "${root}/eslint-args"; echo "[]"`);
    collect(root, ["--offline", "--no-tests", "--src", "lib"]);
    assert.match(readFileSync(`${root}/eslint-args`, "utf8"), /^lib --no-error/);
  });

  test("the boundary check covers every source folder, and finds an .mjs config", () => {
    const root = repo({ ".dependency-cruiser.mjs": "export default {};\n", "src/a.ts": "export {};\n", "server/b.ts": "export {};\n" });
    fakeLocalBin(root, "tsc", "exit 0");
    fakeLocalBin(root, "depcruise", `echo "$*" > "${root}/cruise-args"; echo "10 modules"`);
    collect(root);
    assert.match(readFileSync(`${root}/cruise-args`, "utf8"), /^server src |^src server /);
  });

  test("churn hotspots keep non-ASCII names", () => {
    const { metrics } = collect(repo({ "src/café.ts": "export {};\n" })).summary;
    assert.match(metrics.hotspots.join("\n"), /caf/);
  });

  test("a folder of an unreadable or linked kind doesn't stop the scan", () => {
    const root = repo({ "src/a.ts": `export const k = "${FAKE_AWS_KEY}";\n` });
    symlinkSync(`${root}/src`, `${root}/linked`);
    const r = collect(root);
    assert.equal(r.summary.tools.patterns.status, "ok");
    assert.ok(r.summary.metrics.patterns.security["provider-key"]);
  });
});

describe("collect: secret scanning", () => {
  test("skips binary files and lockfiles", () => {
    const root = repo({ "package-lock.json": `{"k":"${FAKE_AWS_KEY}"}\n`, "logo.png": `\0\0${FAKE_AWS_KEY}\n`, "src/a.ts": "export {};\n" });
    assert.equal(collect(root).summary.metrics.patterns?.security?.["provider-key"], undefined);
  });

  test("finds an assigned secret in config, including JSON keys", () => {
    const code = `"apiKey": "abcdefghijklmnop1234"\n`;
    assert.equal(collect(repo({ "config/app.json": code }), GATE).code, 1);
  });

  test("placeholders in docs and templates aren't secrets, but a real key format still is", () => {
    const placeholder = `api_key: "your-api-key-goes-here"\n`;
    assert.equal(collect(repo({ "README.md": placeholder, "config.yml.example": placeholder }), GATE).code, 0);
    assert.equal(collect(repo({ "README.md": `key: ${FAKE_AWS_KEY}\n` }), GATE).code, 1);
  });

  test("a real key format blocks the gate even in a test file", () => {
    assert.equal(collect(repo({ "src/a.test.ts": `const k = "${FAKE_AWS_KEY}";\n` }), GATE).code, 1);
  });

  test("a token-like string in a test stays visible as a lead", () => {
    const r = collect(repo({ "src/a.test.ts": `const csrfToken = "abcdefghijklmnop1234";\n` }));
    assert.equal(r.summary.metrics.patterns.security["hardcoded-secret-in-test"], 1);
  });

  test("names the file and line of a secret, never its value", () => {
    const r = collect(repo({ "src/a.ts": `export const k = "${FAKE_AWS_KEY}";\n` }), GATE);
    assert.match(r.output, /src\/a\.ts:1 \(provider-key\)/);
    assert.doesNotMatch(r.output, new RegExp(FAKE_AWS_KEY));
  });
});

describe("collect: redaction", () => {
  const PASSWORD = "abcdefghijklmnop1234";

  test("removes assigned secrets from evidence too, not only provider keys", () => {
    const r = collect(repo({ "src/a.ts": `const password = "${PASSWORD}";\n` }));
    assert.doesNotMatch(r.raw("patterns.txt"), new RegExp(PASSWORD));
    assert.match(r.raw("patterns.txt"), /src\/a\.ts:1/);
  });

  test("redacts a secret that another rule's example would have shown", () => {
    const r = collect(repo({ "src/a.ts": `console.log("${FAKE_AWS_KEY}");\n` }));
    assert.doesNotMatch(r.raw("patterns.txt"), new RegExp(FAKE_AWS_KEY));
    assert.match(r.raw("patterns.txt"), /console-log/);
  });

  test("redacts tool output, which can quote source code", () => {
    const root = repo({ "tsconfig.json": "{}\n", "src/a.ts": "export {};\n" });
    fakeLocalBin(root, "tsc", `echo "src/a.ts(1,1): error TS2322: Type '${FAKE_AWS_KEY}' is not assignable"; exit 2`);
    assert.doesNotMatch(collect(root).raw("typecheck.txt"), new RegExp(FAKE_AWS_KEY));
  });

  test("drops ESLint's copy of each file from its report", () => {
    const root = repo({ "src/a.ts": "export {};\n" });
    const report = JSON.stringify([{ filePath: "a.ts", errorCount: 1, warningCount: 0, messages: [{ ruleId: "x" }], source: `const password = "${PASSWORD}";` }]);
    fakeLocalBin(root, "eslint", `echo '${report}'; exit 1`);
    const r = collect(root);
    assert.equal(r.summary.metrics.lint.errors, 1);
    assert.doesNotMatch(r.raw("eslint.json"), /"source"/);
  });

  test("keeps jscpd's report but not the duplicated code in it", () => {
    const root = repo({ "package.json": "{}\n", "src/a.ts": "export {};\n" });
    const binDir = `${root}/fake-path`;
    const report = JSON.stringify({ statistics: { total: { percentage: 12 } }, duplicates: [{ lines: 9, fragment: "SECRET_CODE", firstFile: { name: "src/a.ts", start: 1 }, secondFile: { name: "src/b.ts", start: 2 } }] });
    fakeBin(binDir, "npx", `case "$2" in jscpd*) while [ "$1" != "--output" ]; do shift; done; echo '${report}' > "$2/jscpd-report.json";; esac; exit 0`);
    const r = collect(root, ["--no-tests"], { binDir });
    assert.equal(r.summary.metrics.duplication.percentage, 12);
    assert.deepEqual(r.summary.metrics.duplication.top, ["9 lines: src/a.ts:1 ⇄ src/b.ts:2"]);
    assert.doesNotMatch(r.raw("jscpd/jscpd-report.json"), /SECRET_CODE/);
  });
});

describe("collect: tracked env files", () => {
  const gateOn = (files) => collect(repo({ "src/a.ts": "export {};\n", ...files }), GATE);

  for (const file of [".env", ".env.local", ".env.production.local", "api/.env"]) {
    test(`${file} blocks the gate even with nothing secret in it`, () => {
      assert.equal(gateOn({ [file]: "PUBLIC_URL=http://localhost\n" }).code, 1);
    });
  }

  for (const [what, line] of [["a password", "DB_PASSWORD=hunter2"], ["a password in a URL", "DATABASE_URL=postgres://me:hunter2@db/app"], ["a client-exposed secret", "NEXT_PUBLIC_SECRET_KEY=abc"]]) {
    test(`.env.production holding ${what} blocks the gate, without printing it`, () => {
      const r = gateOn({ ".env.production": `${line}\n` });
      assert.equal(r.code, 1);
      assert.doesNotMatch(r.output, /hunter2/);
    });
  }

  for (const [what, line] of [["an empty secret", "API_KEY="], ["a reference", "API_KEY=${API_KEY}"], ["a public key", "NEXT_PUBLIC_API_KEY=abc"], ["a placeholder", "API_KEY=changeme"]]) {
    test(`.env.production holding ${what} passes`, () => {
      assert.equal(gateOn({ ".env.production": `${line}\n` }).code, 0);
    });
  }

  test("templates pass", () => {
    assert.equal(gateOn({ ".env.example": "DB_PASSWORD=hunter2\n" }).code, 0);
  });
});

describe("collect: exceptions file", () => {
  const SECRET = `export const k = "${FAKE_AWS_KEY}";\n`;
  const FUTURE = daysAhead(100), PAST = "2000-01-01";
  const list = (...exceptions) => JSON.stringify({ exceptions });
  const entry = (over = {}) => ({ rule: "provider-key", path: "fixtures/*.ts", reason: "Fake key from the AWS docs", expires: FUTURE, ...over });
  const gateOn = (exceptionsFile, file = "fixtures/a.ts") => collect(repo({ [file]: SECRET, ".audit-exceptions.json": exceptionsFile }), GATE);

  test("an entry with a reason and a future date accepts the finding", () => {
    const r = gateOn(list(entry()));
    assert.equal(r.code, 0);
    assert.equal(r.summary.metrics.exceptions.applied[0].reason, "Fake key from the AWS docs");
  });

  test("an accepted finding still shows in the metrics", () => {
    assert.ok(gateOn(list(entry())).summary.metrics.patterns.security["provider-key"]);
  });

  test("covers an env file through the env-file rule", () => {
    const root = repo({ ".env": "X=1\n", "src/a.ts": "export {};\n", ".audit-exceptions.json": list(entry({ rule: "env-file", path: ".env" })) });
    assert.equal(collect(root, GATE).code, 0);
  });

  test("doesn't cover another path", () => {
    assert.equal(gateOn(list(entry()), "src/a.ts").code, 1);
  });

  test("doesn't cover another rule", () => {
    assert.equal(gateOn(list(entry({ rule: "hardcoded-secret" }))).code, 1);
  });

  test("** crosses folders and * doesn't", () => {
    assert.equal(gateOn(list(entry({ path: "fixtures/**/*.ts" })), "fixtures/deep/down/a.ts").code, 0);
    assert.equal(gateOn(list(entry()), "fixtures/deep/a.ts").code, 1);
  });

  test("an expired entry stops applying and says so", () => {
    const r = gateOn(list(entry({ expires: PAST })));
    assert.equal(r.code, 1);
    assert.match(r.output, /Expired in \.audit-exceptions\.json/);
  });

  test("an entry nothing matches is reported as unused", () => {
    assert.equal(gateOn(list(entry(), entry({ path: "other/*.ts" }))).summary.metrics.exceptions.unused.length, 1);
  });

  for (const [what, bad] of [
    ["no reason", { reason: "" }],
    ["no expiry", { expires: undefined }],
    ["an impossible date", { expires: "2999-02-31" }],
    ["an unknown rule", { rule: "eval" }],
    ["a path that matches everything", { path: "**" }],
  ]) {
    test(`an entry with ${what} fails the gate and isn't applied`, () => {
      const r = gateOn(list(entry(bad)));
      assert.equal(r.code, 1);
      assert.equal(r.summary.tools.exceptions.status, "failed");
      assert.match(r.output, /exceptions did not finish/);
    });
  }

  test("a bad entry fails the gate even when everything else is clean", () => {
    assert.equal(gateOn(list(entry({ reason: "" })), "fixtures/a.ts").code, 1);
    const root = repo({ "src/a.ts": "export {};\n", ".audit-exceptions.json": list(entry({ reason: "" })) });
    assert.equal(collect(root, GATE).code, 1);
  });

  test("an unparseable file fails the gate", () => {
    const root = repo({ "src/a.ts": "export {};\n", ".audit-exceptions.json": "{ nope" });
    assert.equal(collect(root, GATE).code, 1);
  });

  test("a missing file is fine", () => {
    assert.equal(collect(repo({ "src/a.ts": "export {};\n" }), GATE).summary.tools.exceptions.status, "ok");
  });
});

describe("collect: running tools safely", () => {
  const withTests = () => {
    const root = repo({ "package.json": `{"scripts":{"test":"x"}}\n`, "src/a.ts": "export {};\n" });
    const binDir = `${root}/fake-path`;
    fakeBin(binDir, "npm", `echo "$*" >> "${root}/npm-calls"; exit 0`);
    return { root, binDir };
  };
  const ranTests = (root) => existsSync(`${root}/npm-calls`);

  test("says when it didn't run the tests, and how to", () => {
    const { root, binDir } = withTests();
    const r = collect(root, ["--offline"], { binDir });
    assert.match(r.summary.skipped.join("\n"), /tests: not run locally: add --tests/);
    assert.equal(r.summary.metrics.tests.ran, false);
  });

  for (const [what, args, env] of [["--tests", ["--offline", "--tests"]], ["--gate", ["--offline", "--gate"]], ["CI", ["--offline"], { CI: "1" }]]) {
    test(`runs the tests with ${what}`, () => {
      const { root, binDir } = withTests();
      collect(root, args, { binDir, env });
      assert.ok(ranTests(root));
    });
  }

  test("--no-tests wins over CI", () => {
    const { root, binDir } = withTests();
    collect(root, ["--offline", "--no-tests"], { binDir, env: { CI: "1" } });
    assert.ok(!ranTests(root));
  });

  test("a test runner that won't start blocks the gate", () => {
    const root = repo({ "package.json": `{"packageManager":"pnpm@9.0.0","scripts":{"test":"x"}}\n`, "src/a.ts": "export {};\n" });
    const r = collect(root, ["--offline", "--gate"], { env: { PATH: `${root}/empty:${dirname(process.execPath)}:/usr/bin:/bin` } });
    assert.equal(r.code, 1);
    assert.match(r.output, /tests did not finish/);
  });

  test("failing tests block the gate", () => {
    const { root, binDir } = withTests();
    fakeBin(binDir, "npm", `exit 1`);
    const r = collect(root, ["--offline", "--gate"], { binDir });
    assert.equal(r.code, 1);
    assert.match(r.output, /tests failing/);
  });

  test("downloaded tools don't see the user's secrets", () => {
    const root = repo({ "package.json": "{}\n", "src/a.ts": "export {};\n" });
    const binDir = `${root}/fake-path`;
    fakeBin(binDir, "npx", `env >> "${root}/npx-env"`);
    collect(root, ["--no-tests"], { binDir, env: { MY_API_TOKEN: "s3cret", npm_config_registry: "https://r.example" } });
    const env = readFileSync(`${root}/npx-env`, "utf8");
    assert.doesNotMatch(env, /MY_API_TOKEN/);
    assert.match(env, /npm_config_registry=/);
    assert.match(env, /npm_config_ignore_scripts=true/);
  });
});

// Output copied from real Yarn 4.9.2.
describe("collect: yarn audit", () => {
  const yarnProject = (body) => {
    const root = repo({ "package.json": `{"packageManager":"yarn@4.9.2"}\n`, "yarn.lock": "", "src/a.ts": "export {};\n" });
    const binDir = `${root}/fake-path`;
    fakeBin(binDir, "npx", "exit 0");
    fakeBin(binDir, "yarn", body);
    return collect(root, ["--no-tests", "--gate"], { binDir });
  };
  const advisory = (severity) => `{"value":"x","children":{"ID":"x","Severity":"${severity}"}}`;

  test("no output and exit 0 means clean", () => {
    const r = yarnProject("exit 0");
    assert.equal(r.summary.tools.vulnerabilities.status, "ok");
    assert.equal(r.code, 0);
  });

  test("counts advisories by severity, and a high one blocks the gate", () => {
    const r = yarnProject(`echo '${advisory("high")}'; echo '${advisory("moderate")}'; exit 1`);
    assert.deepEqual(r.summary.metrics.vulnerableDeps, { high: 1, moderate: 1 });
    assert.equal(r.code, 1);
  });

  test("reads a single advisory, which on its own is valid JSON", () => {
    assert.deepEqual(yarnProject(`echo '${advisory("moderate")}'; exit 1`).summary.metrics.vulnerableDeps, { moderate: 1 });
  });

  test("no output and a non-zero exit isn't clean", () => {
    assert.equal(yarnProject("exit 1").summary.tools.vulnerabilities.status, "failed");
  });

  test("an unrecognised line isn't clean", () => {
    assert.equal(yarnProject(`echo '${advisory("low")}'; echo 'Internal Error'; exit 1`).summary.tools.vulnerabilities.status, "failed");
  });
});

// One test per must-fix finding from the independent review of this PR. Each reproduced as a gate pass
// or a crash before the fix.
describe("collect: review findings", () => {
  const PEM = ["-----BEGIN", "RSA PRIVATE KEY-----"].join(" ");
  const SECRET = `key: ${FAKE_AWS_KEY}\n`;

  for (const [what, file, text] of [
    ["at the start of a line", "config/key.pem", `${PEM}\nabc\n`],
    ["right after a quote", "src/a.ts", `const k = "${PEM}";\n`],
    ["of the OPENSSH kind", "config/id", `${["-----BEGIN", "OPENSSH PRIVATE KEY-----"].join(" ")}\nabc\n`],
  ]) {
    test(`finds a private key ${what}`, () => {
      const r = collect(repo({ [file]: text, "src/b.ts": "export {};\n" }), GATE);
      assert.equal(r.code, 1);
      assert.ok(r.summary.metrics.patterns.security["provider-key"]);
    });
  }

  for (const file of ["bin/deploy.sh", "build/ci.yml", "vendor/x.js", "dist/app.js"]) {
    test(`a tracked ${file} is scanned for secrets, though not for code metrics`, () => {
      const r = collect(repo({ [file]: SECRET, "src/a.ts": "export {};\n" }), GATE);
      assert.equal(r.code, 1);
      assert.equal(r.summary.metrics.inventory.sourceFiles, 1);
    });
  }

  test("reads a Windows line-ending env file like any other", () => {
    assert.equal(collect(repo({ ".env.production": "DB_PASSWORD=hunter2\r\n", "src/a.ts": "export {};\n" }), GATE).code, 1);
  });

  test("broken git fails the gate, not the same as no repo", () => {
    const root = repo({ ".env": "DB_PASSWORD=hunter2\n", "src/a.ts": "export {};\n" });
    const binDir = `${root}/fake-path`;
    fakeBin(binDir, "git", `echo "fatal: detected dubious ownership in repository" >&2; exit 128`);
    const r = collect(root, GATE, { binDir });
    assert.equal(r.summary.tools.git.status, "failed");
    assert.equal(r.code, 1);
    assert.match(r.output, /git did not finish: fatal: detected dubious ownership/);
  });

  describe("git failing partway", () => {
    test("a failed commit count fails the gate, and isn't 'no commits'", () => {
      const root = repo({ "src/a.ts": "export {};\n" });
      const binDir = `${root}/fake-path`;
      const real = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
      fakeBin(binDir, "git", `[ "$1" = "rev-list" ] && { echo "fatal: bad object HEAD" >&2; exit 128; }; exec "${real}" "$@"`);
      fakeBin(binDir, "gitleaks", "exit 0");
      const r = collect(root, GATE, { binDir });
      assert.equal(r.summary.tools.gitleaks.status, "failed");
      assert.ok(!r.summary.tools.gitleaks.notApplicable);
      assert.equal(r.code, 1);
      assert.match(r.output, /gitleaks did not finish/);
    });

    test("a HEAD that can't be read fails git and gitleaks, and isn't 'no commits'", () => {
      const root = repo({ "src/a.ts": "export {};\n" });
      const binDir = `${root}/fake-path`;
      // scanProject needs rev-parse too, so only --verify fails here.
      const real = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
      fakeBin(binDir, "git", `[ "$2" = "--verify" ] && exit 128; exec "${real}" "$@"`);
      fakeBin(binDir, "gitleaks", "exit 0");
      const r = collect(root, GATE, { binDir });
      assert.equal(r.summary.tools.git.status, "failed");
      assert.equal(r.summary.tools.gitleaks.status, "failed");
      assert.equal(r.code, 1);
    });

    test("a repo with no commits has nothing to scan, and doesn't fail the gate", () => {
      const root = gitInit(project({ "src/a.ts": "export {};\n" }));
      const binDir = `${root}/fake-path`;
      fakeBin(binDir, "gitleaks", "exit 0");
      const r = collect(root, GATE, { binDir });
      assert.equal(r.summary.tools.git.status, "ok");
      assert.equal(r.summary.tools.gitleaks.status, "skipped");
      assert.equal(r.summary.tools.gitleaks.notApplicable, true);
      assert.equal(r.code, 0);
    });
  });

  test("with git missing, a subfolder of a real repo isn't called 'not a repo'", () => {
    const root = repo({ "apps/web/src/a.ts": "export {};\n" });
    const web = join(root, "apps/web");
    const binDir = project();
    fakeBin(binDir, "sh", `exec /bin/sh "$@"`);
    const r = collect(web, GATE, { env: { PATH: binDir } });
    assert.equal(r.summary.tools.git.status, "failed");
    assert.equal(r.code, 1);
  });

  test("with git missing, a folder in no repo is still 'not a repo'", () => {
    const binDir = project();
    fakeBin(binDir, "sh", `exec /bin/sh "$@"`);
    const r = collect(project({ "src/a.ts": "export {};\n" }), GATE, { env: { PATH: binDir } });
    assert.equal(r.summary.tools.git.status, "skipped");
    assert.equal(r.summary.tools.git.notApplicable, true);
  });

  test("a folder that isn't a repo is skipped, and says so", () => {
    const r = collect(project({ "src/a.ts": "export {};\n" }), GATE);
    assert.equal(r.summary.tools.git.status, "skipped");
    assert.equal(r.code, 0);
  });

  test("gitleaks scanning nothing in a repo with history isn't clean", () => {
    const root = repo({ "src/a.ts": "export {};\n" });
    const binDir = `${root}/fake-path`;
    fakeBin(binDir, "gitleaks", `while [ "$1" != "--report-path" ]; do shift; done; echo '[]' > "$2"; echo "INF 0 commits scanned." >&2; exit 0`);
    const r = collect(root, GATE, { binDir });
    assert.equal(r.summary.tools.gitleaks.status, "failed");
    assert.equal(r.code, 1);
  });

  test("gitleaks is skipped with no history to scan", () => {
    const root = gitInit(project({ "src/a.ts": "export {};\n" }));
    const binDir = `${root}/fake-path`;
    fakeBin(binDir, "gitleaks", "exit 1");
    const r = collect(root, GATE, { binDir });
    assert.equal(r.summary.tools.gitleaks.status, "skipped");
    assert.equal(r.code, 0);
  });

  test("gitleaks exiting 1 with an empty report is failed", () => {
    const root = repo({ "src/a.ts": "export {};\n" });
    const binDir = `${root}/fake-path`;
    fakeBin(binDir, "gitleaks", `while [ "$1" != "--report-path" ]; do shift; done; echo '[]' > "$2"; exit 1`);
    assert.equal(collect(root, GATE, { binDir }).code, 1);
  });

  test("a gitleaks report goes through redaction too", () => {
    const root = repo({ "src/a.ts": "export {};\n" });
    const binDir = `${root}/fake-path`;
    fakeBin(binDir, "gitleaks", `while [ "$1" != "--report-path" ]; do shift; done; echo '[{"Match":"${FAKE_AWS_KEY}"}]' > "$2"; exit 1`);
    const r = collect(root, ["--offline", "--no-tests"], { binDir });
    assert.equal(r.summary.metrics.secretsInHistory, 1);
    assert.doesNotMatch(r.raw("gitleaks.json"), new RegExp(FAKE_AWS_KEY));
    assert.equal(JSON.parse(r.raw("gitleaks.json")).length, 1);
  });

  test("finds a key in a file too big to read whole, with the right line", () => {
    const filler = "x".repeat(99) + "\n";
    const r = collect(repo({ "data/dump.sql": filler.repeat(22000) + SECRET, "src/a.ts": "export {};\n" }), GATE);
    assert.equal(r.code, 1);
    assert.match(r.output, /data\/dump\.sql:22001 \(provider-key\)/);
  });

  test("finds a key in one enormous line", () => {
    assert.equal(collect(repo({ "data/blob.txt": "x ".repeat(1500000) + SECRET, "src/a.ts": "export {};\n" }), GATE).code, 1);
  });

  test("finds a key in the middle of one enormous line", () => {
    const line = `${"x ".repeat(100000)}${FAKE_AWS_KEY}${" x".repeat(2000000)}\n`;
    assert.equal(collect(repo({ "data/blob.txt": line, "src/a.ts": "export {};\n" }), GATE).code, 1);
  });

  test("skips a big binary file", () => {
    const r = collect(repo({ "data/video.bin": `\0${"x".repeat(3 * 1024 * 1024)}\n${SECRET}`, "src/a.ts": "export {};\n" }), GATE);
    assert.equal(r.code, 0);
  });

  test("a TypeScript project's boundary check fails without TypeScript beside it, despite a root JS file", () => {
    const root = repo({ ".dependency-cruiser.cjs": "module.exports = {};\n", "src/a.ts": "export {};\n", "vite.config.js": "export default {};\n" });
    fakeLocalBin(root, "depcruise", `echo "✔ no dependency violations found (1 modules, 0 dependencies cruised)"`);
    const { tools, metrics } = collect(root).summary;
    assert.equal(tools.boundaries.status, "failed");
    assert.match(tools.boundaries.reason, /can't read \.ts files/);
    assert.equal(metrics.boundaryViolations, null);
  });

  test("a TypeScript project's boundary check fails through npx, which can't read it", () => {
    const root = repo({ ".dependency-cruiser.cjs": "module.exports = {};\n", "package.json": "{}\n", "src/a.ts": "export {};\n" });
    const binDir = `${root}/fake-path`;
    fakeBin(binDir, "npx", `echo "✔ no dependency violations found (9 modules, 0 dependencies cruised)"`);
    assert.equal(collect(root, ["--no-tests"], { binDir }).summary.tools.boundaries.status, "failed");
  });

  test("a JavaScript project's boundary check runs through npx and leaves top-level files out", () => {
    const root = repo({ ".dependency-cruiser.cjs": "module.exports = {};\n", "package.json": "{}\n", "src/a.js": "export {};\n", "vite.config.js": "export default {};\n" });
    const binDir = `${root}/fake-path`;
    fakeBin(binDir, "npx", `case "$2" in dependency-cruiser*) shift 2; echo "$*" > "${root}/cruise-args"; echo "  error rule: a -> b"; echo "1 modules"; exit 1;; esac; exit 0`);
    const r = collect(root, ["--no-tests"], { binDir });
    assert.equal(r.summary.metrics.boundaryViolations, 1);
    assert.match(readFileSync(`${root}/cruise-args`, "utf8"), /^src --config/);
  });

  test("a folder it can't enter fails the scan and still leaves a summary", { skip: process.getuid?.() === 0 }, () => {
    const root = project({ "src/a.ts": "export {};\n", "locked/b.ts": "export {};\n" });
    chmodSync(`${root}/locked`, 0o000);
    try {
      const r = collect(root, GATE);
      assert.equal(r.summary.tools.patterns.status, "failed");
      assert.equal(r.code, 1);
    } finally { chmodSync(`${root}/locked`, 0o755); }
  });

  test("a tracked file behind a blocked folder fails the scan", { skip: process.getuid?.() === 0 }, () => {
    const root = repo({ "src/a.ts": "export {};\n", "locked/b.ts": `export const k = "${FAKE_AWS_KEY}";\n` });
    chmodSync(`${root}/locked`, 0o000);
    try { assert.equal(collect(root, GATE).code, 1); }
    finally { chmodSync(`${root}/locked`, 0o755); }
  });

  test("malformed package.json fails the tests and audit checks, not skips them", () => {
    const root = repo({ "package.json": `{"scripts":{"test":"x"},}`, "src/a.ts": "export {};\n" });
    const r = collect(root, GATE);
    assert.equal(r.summary.tools.tests.status, "failed");
    assert.equal(r.code, 1);
  });

  test("the gate fails on a tsconfig with no TypeScript to check it", () => {
    assert.equal(collect(repo({ "tsconfig.json": "{}\n", "src/a.ts": "export {};\n" }), GATE).code, 1);
  });

  test("a local audit only notes a tsconfig with no TypeScript", () => {
    assert.equal(collect(repo({ "tsconfig.json": "{}\n", "src/a.ts": "export {};\n" })).summary.tools.typecheck.status, "skipped");
  });

  // Output copied from real Yarn 1.22.22, which has no `yarn npm` command.
  const yarn1 = (auditBody) => {
    const root = repo({ "package.json": "{}\n", "yarn.lock": "", "src/a.ts": "export {};\n" });
    const binDir = `${root}/fake-path`;
    fakeBin(binDir, "npx", "exit 0");
    fakeBin(binDir, "yarn", `case "$1" in --version) echo 1.22.22;; audit) ${auditBody};; *) echo 'error Command "npm" not found.'; exit 1;; esac`);
    return collect(root, ["--no-tests", "--gate"], { binDir });
  };
  const summaryLine = (critical) => `{"type":"auditSummary","data":{"vulnerabilities":{"info":0,"low":0,"moderate":0,"high":0,"critical":${critical}}}}`;

  test("reads Yarn 1's audit on a clean project", () => {
    assert.equal(yarn1(`echo '${summaryLine(0)}'; exit 0`).code, 0);
  });

  test("reads Yarn 1's audit reporting vulnerabilities through its exit code", () => {
    const r = yarn1(`echo '{"type":"auditAdvisory","data":{}}'; echo '${summaryLine(1)}'; exit 16`);
    assert.equal(r.summary.metrics.vulnerableDeps.critical, 1);
    assert.equal(r.code, 1);
  });

  test("redacts a key before cutting a long line, so no half key survives", () => {
    const r = collect(repo({ "src/a.ts": `console.log("${"x ".repeat(70)}${FAKE_AWS_KEY}");\n` }));
    assert.doesNotMatch(r.raw("patterns.txt"), /AKIA/);
  });

  test("a private key marker doesn't take the rest of the summary with it", () => {
    const reason = `Sample starting ${PEM}`;
    const root = repo({ "src/a.ts": "export {};\n", ".audit-exceptions.json": JSON.stringify({ exceptions: [{ rule: "provider-key", path: "src/*.ts", reason, expires: daysAhead(100) }] }) });
    const r = collect(root);
    assert.ok(r.summary.tools.patterns);
    assert.doesNotMatch(r.raw("summary.json"), /PRIVATE KEY/);
  });

  test("redacts a whole private key, including one escaped inside JSON", () => {
    const body = "MIIEabc123";
    const key = `${PEM}\\n${body}\\n${["-----END", "RSA PRIVATE KEY-----"].join(" ")}`;
    const root = repo({ "tsconfig.json": "{}\n", "src/a.ts": "export {};\n" });
    fakeLocalBin(root, "tsc", `echo "src/a.ts(1,1): error TS1: '${key}'"; exit 2`);
    assert.doesNotMatch(collect(root).raw("typecheck.txt"), new RegExp(body));
  });
});

describe("collect: evidence for scoring", () => {
  test("records the collector version and commit", () => {
    const root = repo({ "src/a.ts": "export {};\n" });
    const { summary } = collect(root);
    assert.match(summary.collectorVersion, /^\d+\.\d+\.\d+$/);
    assert.match(summary.commit, /^[0-9a-f]{40}$/);
  });

  test("outside git, the commit is null", () => {
    assert.equal(collect(project({ "src/a.ts": "export {};\n" })).summary.commit, null);
  });

  test("captures the history the auditors can no longer ask git for", () => {
    const r = collect(repo({ "src/a.ts": "export {};\n" }));
    assert.match(r.raw("git-log.txt"), /fixture/);
    assert.match(r.raw("git-log.txt"), /1 file changed/);
  });

  test("redacts secrets in commit messages", () => {
    const root = repo({ "src/a.ts": "export {};\n" });
    write(root, "src/b.ts", "export {};\n");
    spawnSync("git", ["add", "-A"], { cwd: root });
    spawnSync("git", ["commit", "-q", "-m", `oops ${FAKE_AWS_KEY}`], { cwd: root });
    assert.doesNotMatch(collect(root).raw("git-log.txt"), new RegExp(FAKE_AWS_KEY));
  });

  test("counts open and accepted secrets", () => {
    const root = repo({ "src/a.ts": `export const k = "${FAKE_AWS_KEY}";\n`, "src/b.ts": `export const k = "${FAKE_AWS_KEY}";\n`,
      ".audit-exceptions.json": JSON.stringify({ exceptions: [{ rule: "provider-key", path: "src/b.ts", reason: "docs key", expires: daysAhead(100) }] }) });
    assert.deepEqual(collect(root).summary.metrics.secrets, { open: 1, accepted: 1 });
  });

  test("a risks-only exceptions file doesn't fail the gate", () => {
    const root = repo({ "src/a.ts": "export {};\n", ".audit-exceptions.json": JSON.stringify({ risks: [] }) });
    assert.equal(collect(root, GATE).code, 0);
  });

  test("an exceptions file with neither list still fails the gate", () => {
    const root = repo({ "src/a.ts": "export {};\n", ".audit-exceptions.json": "{}" });
    assert.equal(collect(root, GATE).code, 1);
  });

  test("names the lockfile, from any ecosystem", () => {
    assert.equal(collect(repo({ "package.json": "{}", "package-lock.json": "{}" })).summary.metrics.lockfile.name, "package-lock.json");
    assert.equal(collect(repo({ "go.sum": "" })).summary.metrics.lockfile.name, "go.sum");
    assert.deepEqual(collect(repo({ "package.json": `{"devDependencies":{"x":"1"}}` })).summary.metrics.lockfile, { hasDependencies: true, name: null });
    assert.deepEqual(collect(repo({ "package.json": `{"name":"x"}` })).summary.metrics.lockfile, { hasDependencies: false, name: null });
  });

  describe("strict", () => {
    const tsc = (config) => {
      const root = repo({ "tsconfig.json": config, "src/a.ts": "export {};\n" });
      fakeLocalBin(root, "tsc", "exit 0");
      return collect(root).summary.metrics.tsStrict;
    };
    test("on", () => assert.equal(tsc(`{"compilerOptions":{"strict":true}}`), true));
    test("off", () => assert.equal(tsc(`{"compilerOptions":{"strict":false}}`), false));
    test("not set and nothing inherited", () => assert.equal(tsc(`{}`), false));
    test("not set here but inherited is unknown", () => assert.equal(tsc(`{"extends":"./base.json"}`), null));
    test("set here wins over inherited", () => assert.equal(tsc(`{"extends":"./base.json","compilerOptions":{"strict":true}}`), true));
  });

  describe("changes since the last audit (item 14)", () => {
    const head = (root) => spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
    const withBaseline = (commit) => {
      const root = repo({ "src/a.ts": "export {};\n", "src/gone.ts": "export {};\n" });
      write(root, "docs/audits/latest.json", JSON.stringify({ commit: commit ?? head(root) }));
      gitCommitAll(root);
      return root;
    };

    test("lists committed, uncommitted and new files, each once", () => {
      const root = withBaseline();
      write(root, "src/committed.ts", "export {};\n");
      gitCommitAll(root);
      write(root, "src/a.ts", "export const a = 1;\n");
      write(root, "src/new file.ts", "export {};\n");
      const r = collect(root);
      assert.equal(r.summary.tools.sinceLast.status, "ok");
      const changed = r.raw("changed-since-last.txt").split("\n");
      for (const f of ["src/committed.ts", "src/a.ts", "src/new file.ts"]) assert.ok(changed.includes(f), f);
      assert.equal(changed.length, new Set(changed).size);
    });

    test("no baseline is skipped", () => {
      assert.equal(collect(repo({ "src/a.ts": "" })).summary.tools.sinceLast.status, "skipped");
    });

    test("an old baseline with no commit is skipped and says so", () => {
      const root = repo({ "docs/audits/latest.json": "{}" });
      assert.match(collect(root).summary.tools.sinceLast.skipped, /no commit/);
    });

    test("a commit missing from history has failed, not found nothing", () => {
      const t = collect(withBaseline("a".repeat(40))).summary.tools.sinceLast;
      assert.equal(t.status, "failed");
      assert.match(t.reason, /history/);
    });

    test("a commit that isn't a SHA never reaches git", () => {
      const root = withBaseline("--output=pwned");
      const t = collect(root).summary.tools.sinceLast;
      assert.equal(t.status, "failed");
      assert.ok(!existsSync(`${root}/pwned`));
    });

    test("unreadable JSON has failed", () => {
      assert.equal(collect(repo({ "docs/audits/latest.json": "{nope" })).summary.tools.sinceLast.status, "failed");
    });

    test("--baseline points at another app's audit", () => {
      const root = repo({ "src/a.ts": "" });
      write(root, "docs/audits/web/latest.json", JSON.stringify({ commit: head(root) }));
      const r = collect(root, ["--offline", "--no-tests", "--baseline", "docs/audits/web/latest.json"]);
      assert.equal(r.summary.tools.sinceLast.status, "ok");
    });

    test("doesn't affect the gate", () => {
      assert.equal(collect(withBaseline("a".repeat(40)), GATE).code, 0);
    });
  });
});

// ---------- PR 6: wrong scores, and the leftovers from PR 4 ----------
// Built at runtime so secret scanners don't flag this repo's own tests.
const LONG_SECRET = ["wJalrXUtnFEMI", "K7MDENGbPxRfiCY"].join("");
// A PATH with only the commands collect.mjs needs, so a gitleaks installed on this machine can't leak in.
function isolatedPath(root) {
  const dir = join(root, "isolated-bin");
  for (const cmd of ["sh", "git"]) {
    const found = spawnSync("sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" }).stdout.trim();
    fakeBin(dir, cmd, `exec ${found} "$@"`);
  }
  return dir;
}
const eslintReport = (root, files) => {
  const path = write(root, "eslint-report.json", JSON.stringify(files));
  fakeLocalBin(root, "eslint", `cat "${path}"; exit 0`);
};

describe("collect: PR 6", () => {
  const pr6 = {};

  describe("CI that isn't on GitHub or GitLab", () => {
    for (const file of [".circleci/config.yml", "Jenkinsfile", "azure-pipelines.yml", "bitbucket-pipelines.yml"]) {
      test(`${file} counts as CI`, pr6, () => {
        const { inventory } = collect(repo({ [file]: "x: 1\n", "src/a.js": "export {};\n" })).summary.metrics;
        assert.equal(inventory.hasCI, true);
      });
    }
    test("no CI file is still no CI", () => {
      assert.equal(collect(repo({ "src/a.js": "export {};\n" })).summary.metrics.inventory.hasCI, false);
    });
  });

  describe("strict, through extends", () => {
    const strictOf = (files) => collect(repo({ "src/a.ts": "export {};\n", ...files })).summary;
    test("off in the config it extends", pr6, () => {
      assert.equal(strictOf({ "tsconfig.json": `{"extends":"./tsconfig.base.json"}`, "tsconfig.base.json": `{"compilerOptions":{"strict":false}}` }).metrics.tsStrict, false);
    });
    test("on in the config it extends", pr6, () => {
      assert.equal(strictOf({ "tsconfig.json": `{"extends":"./tsconfig.base.json"}`, "tsconfig.base.json": `{"compilerOptions":{"strict":true}}` }).metrics.tsStrict, true);
    });
    test("not set anywhere in the chain is off", pr6, () => {
      assert.equal(strictOf({ "tsconfig.json": `{"extends":"./a.json"}`, "a.json": `{"extends":"./b"}`, "b.json": `{}` }).metrics.tsStrict, false);
    });
    test("from an installed package", pr6, () => {
      const files = { "tsconfig.json": `{"extends":"@tsconfig/strictest/tsconfig.json"}`, "node_modules/@tsconfig/strictest/tsconfig.json": `{"compilerOptions":{"strict":true}}` };
      assert.equal(strictOf(files).metrics.tsStrict, true);
    });
    test("from an installed package named by its folder", pr6, () => {
      const files = { "tsconfig.json": `{"extends":"@tsconfig/node22"}`, "node_modules/@tsconfig/node22/tsconfig.json": `{"compilerOptions":{"strict":true}}` };
      assert.equal(strictOf(files).metrics.tsStrict, true);
    });
    test("the last of several extends wins", pr6, () => {
      const files = { "tsconfig.json": `{"extends":["./on.json","./off.json"]}`, "on.json": `{"compilerOptions":{"strict":true}}`, "off.json": `{"compilerOptions":{"strict":false}}` };
      assert.equal(strictOf(files).metrics.tsStrict, false);
    });
    test("a referenced project with strict off is off", pr6, () => {
      const files = { "tsconfig.json": `{"files":[],"references":[{"path":"./tsconfig.app.json"},{"path":"./tsconfig.node.json"}]}`, "tsconfig.app.json": `{"compilerOptions":{"strict":true}}`, "tsconfig.node.json": `{"compilerOptions":{"strict":false}}` };
      assert.equal(strictOf(files).metrics.tsStrict, false);
    });
    test("is read without TypeScript installed", pr6, () => {
      assert.equal(strictOf({ "tsconfig.json": `{"compilerOptions":{"strict":false}}` }).metrics.tsStrict, false);
    });
    test("a package that isn't installed is unknown, and says why", pr6, () => {
      const s = strictOf({ "tsconfig.json": `{"extends":"@tsconfig/strictest/tsconfig.json"}` });
      assert.equal(s.metrics.tsStrict, null);
      assert.equal(s.tools.strict.status, "skipped");
      assert.match(s.tools.strict.skipped, /@tsconfig\/strictest/);
    });
    test("a tsconfig that can't be parsed has failed", pr6, () => {
      assert.equal(strictOf({ "tsconfig.json": `{ nope` }).tools.strict.status, "failed");
    });
  });

  test("a broken package.json doesn't read as having no dependencies", pr6, () => {
    assert.equal(collect(repo({ "package.json": "{ nope" })).summary.metrics.lockfile.hasDependencies, null);
  });

  describe("secrets the scan missed", () => {
    for (const [what, line] of [
      ["a name with more after the secret word", `AWS_SECRET_ACCESS_KEY="${LONG_SECRET}"`],
      ["a camelCase name", `const secretKey = "${LONG_SECRET}";`],
      ["a value with symbols", `password: "p@ss!w0rd#Zx9$Qm2&Lk7"`],
      ["a GitHub fine-grained token", `const t = "${["github", "pat", "11ABCDEFG0abcdefghijklmnopqrstuvwxyz0123456789"].join("_")}";`],
      ["an OpenAI project key", `const t = "${["sk", "proj", "abcdefghijklmnopqrstuvwxyz012345"].join("-")}";`],
    ]) {
      test(`${what} blocks the gate`, pr6, () => {
        assert.equal(collect(repo({ "src/config.ts": `${line}\n` }), GATE).code, 1);
      });
    }
    for (const [what, encode] of [["with a BOM", (s) => Buffer.from(`﻿${s}`, "utf16le")], ["without a BOM", (s) => Buffer.from(s, "utf16le")]]) {
      test(`a key in a UTF-16 file ${what} is found`, pr6, () => {
        assert.equal(collect(repo({ "config/app.ps1": encode(`$k = "${FAKE_AWS_KEY}"\r\n`) }), GATE).code, 1);
      });
    }
    test("a binary file is still skipped", () => {
      assert.equal(collect(repo({ "logo.png": Buffer.from([0x89, 0x50, 0, 0, 0, 1, 2, 3]) }), GATE).code, 0);
    });
  });

  describe("redaction of more secret formats", () => {
    for (const [what, text, secret] of [
      ["a password in a URL", "postgres://admin:Xk9mQ2pLw7@db.internal/app", "Xk9mQ2pLw7"],
      ["a Bearer token", "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9abcdef", "eyJhbGciOiJIUzI1NiJ9abcdef"],
      ["a GitHub fine-grained token", ["github", "pat", "11ABCDEFG0abcdefghijklmnop"].join("_"), "11ABCDEFG0abcdefghijklmnop"],
      ["an OpenAI project key", ["sk", "proj", "abcdefghijklmnopqrstuvwxyz"].join("-"), "abcdefghijklmnopqrstuvwxyz"],
      ["an unquoted PASSWORD=", "DB_PASSWORD=Xk9mQ2pLw7", "Xk9mQ2pLw7"],
    ]) {
      test(`removes ${what} from tool output`, pr6, () => {
        const root = repo({ "src/a.js": "export {};\n" });
        eslintReport(root, [{ filePath: "src/a.js", errorCount: 1, warningCount: 0, messages: [{ ruleId: "x", severity: 2, message: text }] }]);
        assert.doesNotMatch(collect(root).raw("eslint.json"), new RegExp(secret));
      });
    }
    test("redacts a secret that arrives JSON-escaped", () => {
      const root = repo({ "src/a.js": "export {};\n" });
      eslintReport(root, [{ filePath: "src/a.js", errorCount: 1, warningCount: 0, messages: [{ ruleId: "x", severity: 2, message: `apiKey: "${LONG_SECRET}"` }] }]);
      assert.doesNotMatch(collect(root).raw("eslint.json"), new RegExp(LONG_SECRET));
    });
    test("console output is redacted too", pr6, () => {
      const root = repo({ "src/a.js": "export {};\n" });
      const binDir = join(root, "fake-path");
      const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
      fakeBin(binDir, "git", `case "$1" in rev-parse) echo "fatal: ${FAKE_AWS_KEY}" >&2; exit 2;; esac; exec ${realGit} "$@"`);
      assert.doesNotMatch(collect(root, ["--offline", "--no-tests"], { binDir }).output, new RegExp(FAKE_AWS_KEY));
    });
  });

  describe("false gate failures", () => {
    test(".env.development holding settings named like secrets passes", pr6, () => {
      const r = collect(repo({ "src/a.ts": "export {};\n", ".env.development": "ACCESS_TOKEN_EXPIRES_IN=15m\nPASSWORD_MIN_LENGTH=8\nREFRESH_TOKEN_TTL=604800\nAUTH_TOKEN_ENABLED=true\n" }), GATE);
      assert.equal(r.code, 0, r.output);
    });
    test(".env.development holding a real password still blocks", () => {
      assert.equal(collect(repo({ "src/a.ts": "export {};\n", ".env.development": "DB_PASSWORD=Xk9mQ2pLw7\n" }), GATE).code, 1);
    });
    for (const [what, line] of [
      ["a dotted message key", `{"token": "errors.token_invalid_message"}`],
      ["an environment variable reference", `password: "process.env.DB_PASSWORD"`],
      ["a file path", `privateKey: "./certs/server-private-key.pem"`],
      ["a snake_case identifier", `const tokenName = "refresh_token_cookie_name";`],
    ]) {
      test(`${what} isn't a secret`, pr6, () => {
        const r = collect(repo({ "src/a.ts": `${line}\n` }), GATE);
        assert.equal(r.code, 0, r.output);
      });
    }
  });

  describe("the gate says what it didn't assess", () => {
    const binWith = (root, extra = {}) => {
      const binDir = join(root, "fake-path");
      fakeBin(binDir, "npx", "exit 1");
      for (const [name, body] of Object.entries(extra)) fakeBin(binDir, name, body);
      return binDir;
    };
    const ONLINE_GATE = ["--no-tests", "--gate"];
    for (const [what, files] of [
      ["dependencies with no lockfile", { "package.json": `{"dependencies":{"x":"1"}}` }],
      ["a bun lockfile", { "package.json": `{"dependencies":{"x":"1"}}`, "bun.lock": "{}" }],
      ["a Cargo.lock", { "Cargo.toml": "[package]\n", "Cargo.lock": "" }],
    ]) {
      test(`${what}, with no dependency audit, fails the gate`, pr6, () => {
        const root = repo({ "src/a.js": "export {};\n", ...files });
        const r = collect(root, ONLINE_GATE, { binDir: binWith(root) });
        assert.equal(r.code, 1, r.output);
        assert.match(r.output, /vulnerabilities/);
      });
    }
    test("osv-scanner's high findings fail the gate", pr6, () => {
      const root = repo({ "src/a.js": "export {};\n", "Cargo.toml": "[package]\n", "Cargo.lock": "" });
      const osv = JSON.stringify({ results: [{ packages: [{ package: { name: "x" }, groups: [{ ids: ["GHSA-1"], max_severity: "8.1" }] }] }] });
      const r = collect(root, ONLINE_GATE, { binDir: binWith(root, { "osv-scanner": `echo '${osv}'; exit 1` }) });
      assert.equal(r.code, 1, r.output);
      assert.equal(r.summary.metrics.vulnerableDeps.high, 1);
    });
    test("a clean osv-scanner passes a Cargo project", pr6, () => {
      const root = repo({ "src/a.js": "export {};\n", "Cargo.toml": "[package]\n", "Cargo.lock": "" });
      const r = collect(root, ONLINE_GATE, { binDir: binWith(root, { "osv-scanner": `echo '{"results":[]}'; exit 0` }) });
      assert.equal(r.code, 0, r.output);
    });
    test("no dependencies at all doesn't need an audit", () => {
      const root = repo({ "src/a.js": "export {};\n", "package.json": `{"name":"x"}` });
      assert.equal(collect(root, ONLINE_GATE, { binDir: binWith(root) }).code, 0);
    });
    test("gitleaks missing in CI fails the gate", pr6, () => {
      const root = repo({ "src/a.js": "export {};\n" });
      const r = collect(root, GATE, { env: { CI: "1", PATH: isolatedPath(root) } });
      assert.equal(r.code, 1, r.output);
      assert.match(r.output, /gitleaks/);
    });
    test("a gate that passes lists what it didn't assess", pr6, () => {
      const root = repo({ "src/a.js": "export {};\n" });
      const r = collect(root, GATE, { env: { PATH: isolatedPath(root) } });
      assert.equal(r.code, 0, r.output);
      assert.match(r.output, /GATE PASSED[^\n]*\n[^\n]*not assessed[^\n]*gitleaks/i);
    });
  });

  describe("results that read as clean when nothing ran", () => {
    test("--src naming a missing folder stops with an error", pr6, () => {
      const root = repo({ "src/a.js": "export {};\n" });
      const r = spawnSync(process.execPath, [join(PLUGIN_DIR, "skills/audit/collect.mjs"), ".", "--offline", "--no-tests", "--src", "scr"], { cwd: root, encoding: "utf8" });
      assert.equal(r.status, 2, r.stdout + r.stderr);
      assert.match(r.stderr, /scr/);
    });
    test("ESLint linting no files has failed", pr6, () => {
      const root = repo({ "src/a.js": "export {};\n" });
      eslintReport(root, []);
      assert.equal(collect(root).summary.tools.eslint.status, "failed");
    });
    test("ESLint's 'File ignored' notices aren't warnings", pr6, () => {
      const root = repo({ "src/a.js": "export {};\n", "vite.config.js": "export default {};\n" });
      eslintReport(root, [
        { filePath: "vite.config.js", errorCount: 0, warningCount: 1, messages: [{ ruleId: null, severity: 1, message: 'File ignored because of a matching ignore pattern. Use "--no-ignore" to override.' }] },
        { filePath: "src/a.js", errorCount: 0, warningCount: 1, messages: [{ ruleId: "no-unused-vars", severity: 1, message: "x" }] },
      ]);
      assert.equal(collect(root).summary.metrics.lint.warnings, 1);
    });
    const npmProject = (outdated) => {
      const root = repo({ "src/a.js": "export {};\n", "package.json": `{"dependencies":{"x":"1"}}`, "package-lock.json": "{}" });
      const binDir = join(root, "fake-path");
      fakeBin(binDir, "npx", "exit 1");
      fakeBin(binDir, "npm", `case "$1" in audit) echo '{"metadata":{"vulnerabilities":{"high":0}}}'; exit 0;; outdated) ${outdated};; esac`);
      return collect(root, ["--no-tests"], { binDir }).summary;
    };
    for (const [what, body] of [["with no output", `echo "npm ERR! crash" >&2; exit 1`], ["with an error report", `echo '{"error":{"code":"E404"}}'; exit 1`]]) {
      test(`a crashed npm outdated ${what} records no counts`, pr6, () => {
        const s = npmProject(body);
        assert.equal(s.metrics.outdated, undefined);
        assert.equal(s.tools.vulnerabilities.outdated, "failed");
      });
    }
    test("npm outdated with nothing outdated counts zero", () => {
      assert.deepEqual(npmProject("exit 0").metrics.outdated, { total: 0, majorBehind: 0 });
    });
    test("evidence from an earlier run is removed", pr6, () => {
      const root = repo({ "src/a.js": "export {};\n" });
      write(root, ".audit/raw/outdated.json", `{"stale":{}}`);
      write(root, ".audit/raw/notes.md", "mine");
      collect(root);
      assert.ok(!existsSync(join(root, ".audit/raw/outdated.json")));
      assert.ok(existsSync(join(root, ".audit/raw/notes.md")), "removed a file it didn't write");
    });
    test("jscpd ignores the same folders as the rest of the audit", pr6, () => {
      const root = repo({ "package.json": "{}\n", "src/a.ts": "export {};\n" });
      const binDir = join(root, "fake-path");
      const args = join(root, "jscpd-args.txt");
      fakeBin(binDir, "npx", `case "$2" in jscpd*) echo "$@" > "${args}";; esac; exit 1`);
      collect(root, ["--no-tests"], { binDir });
      const ignore = readFileSync(args, "utf8");
      for (const dir of ["target", ".venv", "venv", "bin", "obj", "__pycache__", ".turbo"]) assert.match(ignore, new RegExp(`\\*\\*/${dir.replace(".", "\\.")}/\\*\\*`), dir);
    });
  });

  describe("exceptions", () => {
    const SECRET = `export const k = "${FAKE_AWS_KEY}";\n`;
    const gateOn = (entry, file = "fixtures/a.ts") => collect(repo({ [file]: SECRET, ".audit-exceptions.json": JSON.stringify({ exceptions: [{ rule: "provider-key", reason: "Docs key", expires: daysAhead(30), ...entry }] }) }), GATE);
    test("a folder named any/ can be excepted", pr6, () => assert.equal(gateOn({ path: "any/**" }, "any/a.ts").code, 0));
    for (const path of ["**/*.ts", "*.ts", "**/*"]) {
      test(`${path} matches every file of a kind, and is refused`, pr6, () => {
        const r = gateOn({ path });
        assert.equal(r.summary.tools.exceptions.status, "failed");
        assert.match(r.output, /matches/);
      });
    }
    test("a month that doesn't exist is refused, without crashing", pr6, () => {
      const r = gateOn({ path: "fixtures/*.ts", expires: "2999-13-01" });
      assert.equal(r.summary.tools.exceptions.status, "failed");
      assert.doesNotMatch(r.output, /RangeError/);
    });
    test("an expiry more than a year ahead is refused", pr6, () => {
      const r = gateOn({ path: "fixtures/*.ts", expires: "9999-12-31" });
      assert.equal(r.summary.tools.exceptions.status, "failed");
      assert.match(r.output, /year/);
    });
    test("an expiry today still applies", () => assert.equal(gateOn({ path: "fixtures/*.ts", expires: today() }).code, 0));
    test("a path starting with ./ matches", pr6, () => assert.equal(gateOn({ path: "./fixtures/a.ts" }).code, 0));
    test("an entry nothing matches is printed", pr6, () => {
      const root = repo({ "src/a.ts": "export {};\n", ".audit-exceptions.json": JSON.stringify({ exceptions: [{ rule: "provider-key", path: "old/key.ts", reason: "Docs key", expires: daysAhead(30) }] }) });
      assert.match(collect(root).output, /old\/key\.ts/);
    });
  });

  describe("test gaps from the PR 4 mutation run", () => {
    test("gitleaks is asked to redact what it reports", () => {
      const root = repo({ "src/a.js": "export {};\n" });
      const binDir = join(root, "fake-path");
      fakeBin(binDir, "gitleaks", `case " $* " in *" --redact "*) S=REDACTED;; *) S=plaintextvalue;; esac; while [ "$1" != "--report-path" ]; do shift; done; echo "[{\\"Secret\\":\\"$S\\"}]" > "$2"; exit 1`);
      const r = collect(root, ["--offline", "--no-tests"], { binDir });
      assert.equal(r.summary.metrics.secretsInHistory, 1);
      assert.doesNotMatch(r.raw("gitleaks.json"), /plaintextvalue/);
    });
    test("a tracked env file that can't be read isn't clean", { skip: process.getuid?.() === 0 && "root reads anything" }, () => {
      const root = repo({ "src/a.ts": "export {};\n", ".env.development": "X=1\n" });
      chmodSync(join(root, ".env.development"), 0o000);
      try {
        const r = collect(root, GATE);
        assert.equal(r.code, 1);
        assert.match(r.output, /\.env\.development \(couldn't be read\)/);
      } finally { chmodSync(join(root, ".env.development"), 0o644); }
    });
    test("every top-level source folder is passed to the tools", () => {
      const names = Array.from({ length: 14 }, (_, i) => `pkg${i}`);
      const r = collect(repo(Object.fromEntries(names.map((n) => [`${n}/a.js`, "export {};\n"]))));
      assert.deepEqual([...r.summary.metrics.inventory.srcDirs].sort(), [...names].sort());
    });
    test("a tool that runs out of time is timed-out, and blocks the gate", pr6, () => {
      const root = repo({ "tsconfig.json": "{}\n", "src/a.ts": "export {};\n" });
      fakeLocalBin(root, "tsc", "sleep 5");
      const r = collect(root, GATE, { env: { AGENT_DISCIPLINE_TOOL_TIMEOUT_MS: "300" } });
      assert.equal(r.summary.tools.typecheck.status, "timed-out");
      assert.equal(r.code, 1);
      assert.match(r.output, /typecheck did not finish/);
    });
  });
});
