import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { test, describe } from "node:test";
import { PLUGIN, collect, fakeBin, gitCommitAll, gitInit, project, write } from "./helpers.mjs";

const SCORE = join(PLUGIN, "skills", "audit", "score.mjs");
const tool = (status, extra = {}) => ({ status, ...extra });
const CLEAN_TOOLS = Object.fromEntries(["typecheck", "eslint", "boundaries", "knip", "duplication", "vulnerabilities", "semgrep", "gitleaks", "patterns", "exceptions", "hotspots", "tests"].map((t) => [t, tool("ok")]));
CLEAN_TOOLS.git = tool("skipped", { skipped: "not a git repo", notApplicable: true });
const CLEAN_METRICS = {
  inventory: { hasCI: true, claudeSetup: ["CLAUDE.md"] }, lockfile: { hasDependencies: true, name: "package-lock.json" },
  secrets: { open: 0, accepted: 0 }, envFilesOpen: [], typeErrors: 0, tsStrict: true, tests: { exitCode: 0 },
  duplication: { percentage: 1 }, largeFiles: { over800: 0 }, circularDeps: 0, git: { uncommittedFiles: 0 },
};
const summaryOf = ({ tools = {}, metrics = {}, ...rest } = {}) => ({
  generatedAt: "2026-11-04T10:00:00.000Z", collectorVersion: "1.4.0", commit: null,
  tools: { ...CLEAN_TOOLS, ...tools }, metrics: { ...CLEAN_METRICS, ...metrics }, ...rest,
});
const anchors = (score = 9, over = {}) => ({ security: { score }, reliability: { score }, performance: { score }, maintainability: { score }, tooling: { score }, ...over });
const finding = (over = {}) => ({ category: "security", severity: "high", confidence: "confirmed", verified: true, rule: "xss", location: "src/a.ts:1", title: "t", ...over });

function score(root, { summary = summaryOf(), input = {} } = {}) {
  write(root, ".audit/raw/summary.json", JSON.stringify(summary));
  write(root, ".audit/scoring.json", JSON.stringify({ mode: "full", anchors: anchors(), findings: [], strengths: [], ...input }));
  const r = spawnSync(process.execPath, [SCORE, "--input", ".audit/scoring.json"], { cwd: root, encoding: "utf8" });
  const path = join(root, ".audit", "score.json");
  return { code: r.status, output: r.stdout + r.stderr, score: r.status === 0 ? JSON.parse(readFileSync(path, "utf8")) : null };
}
const latest = (root) => JSON.parse(readFileSync(join(root, "docs/audits/latest.json"), "utf8"));
const history = (root) => readFileSync(join(root, "docs/audits/history.csv"), "utf8").trim().split("\n");

describe("score: arithmetic", () => {
  test("weights the categories and rounds to one decimal", () => {
    const r = score(project(), { input: { anchors: { security: { score: 8 }, reliability: { score: 7 }, performance: { score: 9 }, maintainability: { score: 6 }, tooling: { score: 10 } } } });
    assert.equal(r.code, 0, r.output);
    assert.equal(r.score.overall, 7.7); // 2.4 + 1.75 + 1.35 + 1.2 + 1.0
  });

  test("gives the grade for the overall score", () => {
    assert.equal(score(project(), { input: { anchors: anchors(9) } }).score.grade, "A");
    assert.equal(score(project(), { input: { anchors: anchors(8) } }).score.grade, "B");
    assert.equal(score(project(), { input: { anchors: anchors(6.5) } }).score.grade, "C");
    assert.equal(score(project(), { input: { anchors: anchors(5) } }).score.grade, "D");
    assert.equal(score(project(), { input: { anchors: anchors(4) } }).score.grade, "F");
  });

  test("a category at 3 or below caps the overall at 5", () => {
    const r = score(project(), { input: { anchors: anchors(10, { tooling: { score: 3 } }) } });
    assert.equal(r.score.overall, 5);
    assert.equal(r.score.overallCapped, true);
  });

  test("a not-applicable category shares out its weight and has no score", () => {
    const r = score(project(), { input: { anchors: anchors(8, { performance: { notApplicable: "a small library" } }) } });
    assert.equal(r.score.overall, 8);
    assert.equal(r.score.categories.performance.status, "not-applicable");
    assert.equal(r.score.categories.performance.score, null);
  });
});

describe("score: caps", () => {
  const cat = (r, c) => r.score.categories[c];

  test("a capped rule limits its category and names the cap", () => {
    const r = score(project(), { input: { findings: [finding({ rule: "no-auth-rate-limit", severity: "medium" })] } });
    assert.equal(cat(r, "security").score, 7);
    assert.deepEqual(cat(r, "security").limitedBy, ["no-auth-rate-limit"]);
  });

  test("an anchor below the cap isn't raised, and no cap is named", () => {
    const r = score(project(), { input: { anchors: anchors(5), findings: [finding({ rule: "no-auth-rate-limit", severity: "medium" })] } });
    assert.equal(cat(r, "security").score, 5);
    assert.deepEqual(cat(r, "security").limitedBy, []);
  });

  for (const [name, severity, n, max] of [["two criticals", "critical", 2, 2], ["one critical", "critical", 1, 4], ["three highs", "high", 3, 6], ["two highs", "high", 2, 8]]) {
    test(`${name} limit a category to ${max}, whatever the anchor says`, () => {
      const findings = Array.from({ length: n }, (_, i) => finding({ category: "reliability", rule: "race-condition", severity, location: `src/${i}.ts:1`, confidence: "likely" }));
      assert.equal(cat(score(project(), { input: { anchors: anchors(10), findings } }), "reliability").score, max);
    });
  }

  test("a confirmed critical limits security to 3", () => {
    assert.equal(cat(score(project(), { input: { findings: [finding({ severity: "critical" })] } }), "security").score, 3);
  });

  test("'possible' findings go to the appendix and don't count", () => {
    const r = score(project(), { input: { anchors: anchors(10), findings: [finding({ severity: "critical", confidence: "possible" })] } });
    assert.equal(cat(r, "security").score, 10);
    assert.equal(r.score.appendix.length, 1);
    assert.equal(r.score.counts.critical, 0);
  });

  test("a low finding is listed but fires no rule cap", () => {
    const r = score(project(), { input: { anchors: anchors(10), findings: [finding({ rule: "missing-authz-on-mutation", severity: "low", verified: undefined })] } });
    assert.equal(r.code, 0, r.output);
    assert.equal(cat(r, "security").score, 10);
    assert.equal(r.score.counts.low, 1);
  });

  test("a finding the verifier downgraded to low stops capping", () => {
    const r = score(project(), { input: { anchors: anchors(10), findings: [finding({ rule: "missing-authz-on-mutation", severity: "low", verified: true })] } });
    assert.equal(cat(r, "security").score, 10);
  });

  const METRICS = [
    ["secret-in-repo", "security", 5, { secrets: { open: 1, accepted: 0 } }],
    ["secret-in-history", "security", 5, { secretsInHistory: 2 }],
    ["tests-failing", "reliability", 5, { tests: { exitCode: 1 } }],
    ["type-errors", "maintainability", 6, { typeErrors: 3 }],
    ["strict-off", "maintainability", 7, { tsStrict: false }],
    ["many-cycles-or-violations", "maintainability", 6, { circularDeps: 6 }],
    ["duplication-over-8", "maintainability", 6, { duplication: { percentage: 9 } }],
    ["duplication-over-4", "maintainability", 8, { duplication: { percentage: 5 } }],
    ["many-huge-files", "maintainability", 6, { largeFiles: { over800: 4 } }],
    ["no-lockfile", "tooling", 4, { lockfile: { hasDependencies: true, name: null } }],
    ["env-file-with-secrets", "tooling", 4, { envFilesOpen: [".env"] }],
    ["no-ci", "tooling", 6, { inventory: { hasCI: false, claudeSetup: ["CLAUDE.md"] } }],
    ["no-claude-md", "tooling", 7, { inventory: { hasCI: true, claudeSetup: [] } }],
  ];
  for (const [id, category, max, metrics] of METRICS) {
    test(`${id} limits ${category} to ${max}`, () => {
      const r = score(project(), { summary: summaryOf({ metrics }), input: { anchors: anchors(10) } });
      assert.equal(cat(r, category).score, max);
      assert.ok(cat(r, category).limitedBy.includes(id), r.output);
    });
  }

  test("clean evidence fires no caps", () => {
    const r = score(project(), { input: { anchors: anchors(10) } });
    assert.equal(r.score.overall, 10);
  });

  test("no lockfile isn't a problem with no dependencies to lock", () => {
    const r = score(project(), { summary: summaryOf({ metrics: { lockfile: { hasDependencies: false, name: null } } }), input: { anchors: anchors(10) } });
    assert.equal(cat(r, "tooling").score, 10);
  });

  test("unknown strictness isn't treated as strict being off", () => {
    const r = score(project(), { summary: summaryOf({ metrics: { tsStrict: null } }), input: { anchors: anchors(10) } });
    assert.equal(cat(r, "maintainability").score, 10);
  });
});

describe("score: broken tools can't raise a score", () => {
  for (const status of ["failed", "timed-out"]) {
    test(`a typecheck that ${status} limits maintainability as if it had found errors`, () => {
      const r = score(project(), { summary: summaryOf({ tools: { typecheck: tool(status, { reason: "crash" }) }, metrics: { typeErrors: null, tsStrict: null } }), input: { anchors: anchors(10) } });
      const m = r.score.categories.maintainability;
      assert.equal(m.score, 6);
      assert.equal(m.limits.find((l) => l.id === "type-errors").source, "not-ruled-out");
      assert.match(m.gaps.join(), /typecheck: .*crash/);
    });
  }

  test("a broken secret scan limits security", () => {
    const r = score(project(), { summary: summaryOf({ tools: { gitleaks: tool("failed", { reason: "x" }) }, metrics: { secretsInHistory: undefined } }), input: { anchors: anchors(10) } });
    assert.equal(r.score.categories.security.score, 5);
  });

  test("a skipped tool is a coverage gap and doesn't limit the score", () => {
    const r = score(project(), { summary: summaryOf({ tools: { tests: tool("skipped", { skipped: "not run locally" }) }, metrics: { tests: { configured: true, ran: false } } }), input: { anchors: anchors(10) } });
    assert.equal(r.score.categories.reliability.score, 10);
    assert.match(r.score.categories.reliability.gaps.join(), /not run locally/);
  });
});

describe("score: refuses a broken contract", () => {
  const refuses = (input, pattern, summary) => {
    const root = project();
    const r = score(root, { input, summary });
    assert.equal(r.code, 2, r.output);
    assert.match(r.output, pattern);
    assert.ok(!existsSync(join(root, "docs/audits/latest.json")), "wrote a baseline");
    assert.ok(!existsSync(join(root, ".audit/score.json")), "wrote a score");
  };

  test("an invented rule", () => refuses({ findings: [finding({ rule: "made-up" })] }, /made-up.*rules\.json/));
  test("a rule from another category", () => refuses({ findings: [finding({ rule: "n-plus-one" })] }, /not a security rule/));
  test("an unverified high", () => refuses({ findings: [finding({ verified: false })] }, /must be verified/));
  test("an unverified medium", () => refuses({ findings: [finding({ severity: "medium", verified: undefined })] }, /must be verified/));
  for (const severity of ["critical", "high", "medium"]) {
    test(`an unverified ${severity} the auditor called possible`, () => refuses({ findings: [finding({ severity, confidence: "possible", verified: false })] }, /must be verified/));
  }
  test("an unverified low the auditor called possible is allowed, in the appendix", () => {
    const r = score(project(), { input: { findings: [finding({ severity: "low", confidence: "possible", verified: undefined })] } });
    assert.equal(r.code, 0, r.output);
    assert.equal(r.score.appendix.length, 1);
  });
  test("a location outside the project", () => refuses({ findings: [finding({ location: "/etc/app/a.ts:1" })] }, /outside the project/));
  test("a route written as a path, with advice on what to write instead", () => refuses({ findings: [finding({ location: "/api/login" })] }, /handler's file/));
  test("one problem written two ways", () => refuses({ findings: [finding(), finding({ location: "./src/a.ts:1" })] }, /duplicate/));
  for (const other of ["src/a.ts:L1", "src/a.ts#L1", "src/a.ts (line 1)", "`src/a.ts:1`"]) {
    test(`one problem written two ways: src/a.ts:1 and ${other}`, () => refuses({ findings: [finding(), finding({ location: other })] }, /duplicate/));
  }
  test("one merged location written in another order", () => refuses({ findings: [finding({ location: "src/a.ts:1, lib/b.ts:2" }), finding({ location: "lib/b.ts:2, src/a.ts:1" })] }, /duplicate/));
  test("a relative location that climbs out of the project", () => refuses({ findings: [finding({ location: "../other/a.ts:1" })] }, /outside the project/));
  test("a brace list that climbs out of the project", () => refuses({ findings: [finding({ location: "src/{a,../../lib/pay}.ts" })] }, /outside the project/));
  test("a merged finding with one location outside the project", () => refuses({ findings: [finding({ location: "src/a.ts:1, /etc/app/a.ts:1" })] }, /outside the project/));
  describe("a partial audit that scores nothing", () => {
    test("no anchors at all", () => refuses({ mode: "security", anchors: {}, findings: [finding()] }, /nothing to score/));
    test("quick with no anchors", () => refuses({ mode: "quick", anchors: {} }, /nothing to score/));
    test("since-last with no anchors", () => refuses({ mode: "since-last", anchors: {} }, /nothing to score/));
    test("a category audit without that category", () => refuses({ mode: "security", anchors: { tooling: { score: 8 } } }, /security audit needs an anchor for security/));
    test("a category audit marking its own category not applicable", () => refuses({ mode: "security", anchors: { security: { notApplicable: "x" } } }, /nothing to score/));
  });
  test("two findings with one title under an other-* rule are still one problem", () => {
    const f = finding({ rule: "other-security", title: "Same" });
    refuses({ findings: [f, { ...f }] }, /duplicate/);
  });
  test("a GOOD: note as a finding", () => refuses({ findings: [finding({ severity: "low", title: "GOOD: nice" })] }, /strengths/));
  test("duplicate findings", () => refuses({ findings: [finding(), finding()] }, /duplicate/));
  test("a full audit missing a category", () => {
    const { tooling, ...some } = anchors();
    refuses({ anchors: some }, /needs an anchor for tooling/);
  });
  test("an anchor out of range", () => refuses({ anchors: anchors(11) }, /0 to 10/));
  test("not applicable with no reason", () => refuses({ anchors: anchors(8, { tooling: { notApplicable: " " } }) }, /needs a reason/));
  test("not applicable with findings in it", () => refuses({ anchors: anchors(8, { security: { notApplicable: "x" } }), findings: [finding()] }, /not applicable but/));
  test("nothing applicable", () => {
    const na = { notApplicable: "x" };
    refuses({ anchors: { security: na, reliability: na, performance: na, maintainability: na, tooling: na } }, /nothing to score/);
  });
  test("an unknown mode", () => refuses({ mode: "fast" }, /mode must be/));
  test("evidence from an older collector", () => refuses({}, /older collect/, summaryOf({ collectorVersion: undefined })));

  test("evidence from another commit", () => {
    const root = gitInit(project({ "a.ts": "1\n" }));
    gitCommitAll(root);
    const r = score(root, { summary: summaryOf({ commit: "0".repeat(40) }) });
    assert.equal(r.code, 2);
    assert.match(r.output, /run collect\.mjs again/);
  });

  describe("evidence that can't be checked against HEAD", () => {
    const fromElsewhere = (root, cwd = project()) => spawnSync(process.execPath, [SCORE, "--input", join(root, ".audit/scoring.json"), "--summary", join(root, ".audit/raw/summary.json"), "--dir", join(root, "docs/audits")], { cwd, encoding: "utf8" });
    const prepare = (root, summary) => {
      write(root, ".audit/raw/summary.json", JSON.stringify(summary));
      write(root, ".audit/scoring.json", JSON.stringify({ mode: "full", anchors: anchors(), findings: [] }));
    };

    test("a recorded commit with no git repo to compare it to is refused", () => {
      const root = project();
      const r = score(root, { summary: summaryOf({ commit: "0".repeat(40) }) });
      assert.equal(r.code, 2);
      assert.match(r.output, /can't read HEAD/);
      assert.ok(!existsSync(join(root, "docs/audits/latest.json")));
    });

    test("stale evidence is refused when scoring from another folder", () => {
      const root = gitInit(project({ "a.ts": "1\n" }));
      gitCommitAll(root);
      prepare(root, summaryOf({ commit: "0".repeat(40), root }));
      const r = fromElsewhere(root);
      assert.equal(r.status, 2, r.stdout + r.stderr);
      assert.match(r.stderr, /run collect\.mjs again/);
    });

    test("current evidence still scores from another folder", () => {
      const root = gitInit(project({ "a.ts": "1\n" }));
      gitCommitAll(root);
      const commit = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
      prepare(root, summaryOf({ commit, root }));
      const r = fromElsewhere(root);
      assert.equal(r.status, 0, r.stdout + r.stderr);
    });

    describe("evidence from a repo with no commits, and HEAD can't be read now", () => {
      const fakeGit = (body) => {
        const binDir = project();
        fakeBin(binDir, "git", body);
        return binDir;
      };
      const scoreWith = (root, binDir) => {
        write(root, ".audit/scoring.json", JSON.stringify({ mode: "full", anchors: anchors(), findings: [] }));
        return spawnSync(process.execPath, [SCORE, "--input", ".audit/scoring.json"], { cwd: root, encoding: "utf8", env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` } });
      };
      const collectedThenCommitted = () => {
        const root = gitInit(project({ ".gitignore": ".audit/\n", "src/a.js": "export const a = 1;\n" }));
        collect(root);
        gitCommitAll(root);
        return root;
      };

      test("a git that fails is refused", () => {
        const r = scoreWith(collectedThenCommitted(), fakeGit(`echo "fatal: detected dubious ownership" >&2; exit 128`));
        assert.equal(r.status, 2, r.stdout + r.stderr);
        assert.match(r.stderr, /no commits.*can't read HEAD/);
      });

      test("git being missing is refused", () => {
        const binDir = project();
        symlinkSync(process.execPath, join(binDir, "node"));
        const root = collectedThenCommitted();
        write(root, ".audit/scoring.json", JSON.stringify({ mode: "full", anchors: anchors(), findings: [] }));
        const r = spawnSync(process.execPath, [SCORE, "--input", ".audit/scoring.json"], { cwd: root, encoding: "utf8", env: { ...process.env, PATH: binDir } });
        assert.equal(r.status, 2, r.stdout + r.stderr);
      });

      test("a repo that still has no commits scores", () => {
        const root = gitInit(project({ ".gitignore": ".audit/\n", "src/a.js": "export const a = 1;\n" }));
        collect(root);
        assert.equal(scoreWith(root, "").status, 0);
      });
    });

    test("a relative --dir is read against the project, not the current folder", () => {
      const root = project();
      prepare(root, summaryOf({ root }));
      const cwd = project();
      const r = spawnSync(process.execPath, [SCORE, "--input", join(root, ".audit/scoring.json"), "--summary", join(root, ".audit/raw/summary.json"), "--dir", "docs/audits/web"], { cwd, encoding: "utf8" });
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.ok(existsSync(join(root, "docs/audits/web/latest.json")));
      assert.ok(!existsSync(join(cwd, "docs")));
    });

    test("no recorded commit in a project without git still scores", () => {
      assert.equal(score(project()).code, 0);
    });

    test("no recorded commit because git failed is refused", () => {
      const r = score(project(), { summary: summaryOf({ tools: { git: tool("failed", { reason: "dubious ownership" }) } }) });
      assert.equal(r.code, 2);
      assert.match(r.output, /git failed.*dubious ownership/);
    });

    test("no recorded commit in a project that now has one is refused", () => {
      const root = gitInit(project({ "a.ts": "1\n" }));
      gitCommitAll(root);
      const r = score(root);
      assert.equal(r.code, 2);
      assert.match(r.output, /run collect\.mjs again/);
    });

    test("without --dir, the baseline goes in the project, not the current folder", () => {
      const root = project();
      prepare(root, summaryOf({ root }));
      const cwd = project();
      const r = spawnSync(process.execPath, [SCORE, "--input", join(root, ".audit/scoring.json"), "--summary", join(root, ".audit/raw/summary.json")], { cwd, encoding: "utf8" });
      assert.equal(r.status, 0, r.stdout + r.stderr);
      assert.ok(existsSync(join(root, "docs/audits/latest.json")));
      assert.ok(!existsSync(join(cwd, "docs")));
    });
  });

  describe("with a real summary from collect.mjs", () => {
    const FILES = { ".gitignore": ".audit/\n", "src/a.js": "export const a = 1;\n" };
    const scoreCollected = (root) => {
      write(root, ".audit/scoring.json", JSON.stringify({ mode: "full", anchors: anchors(), findings: [] }));
      return spawnSync(process.execPath, [SCORE, "--input", ".audit/scoring.json"], { cwd: root, encoding: "utf8" });
    };

    test("it scores, in the project it was collected from", () => {
      const root = gitInit(project(FILES));
      gitCommitAll(root);
      assert.equal(collect(root).summary.root.length > 0, true);
      const r = scoreCollected(root);
      assert.equal(r.status, 0, r.stdout + r.stderr);
    });

    test("every rule it reports on is one the score can read", () => {
      const root = gitInit(project(FILES));
      gitCommitAll(root);
      const { summary } = collect(root);
      assert.equal(scoreCollected(root).status, 0);
      const { categories } = JSON.parse(readFileSync(join(root, ".audit/score.json"), "utf8"));
      assert.ok(Object.values(categories).flatMap((c) => c.gaps).every((g) => summary.tools[g.split(":")[0]]));
    });

    test("a commit made after collecting in a folder with no git is refused", () => {
      const root = project(FILES);
      collect(root);
      gitInit(root);
      gitCommitAll(root);
      const r = scoreCollected(root);
      assert.equal(r.status, 2, r.stdout + r.stderr);
    });

    test("a commit made after collecting in a repo with no commits is refused", () => {
      const root = gitInit(project(FILES));
      collect(root);
      gitCommitAll(root);
      assert.equal(scoreCollected(root).status, 2);
    });

    test("what doesn't apply to a project isn't counted as a gap", () => {
      const root = project({ "README.md": "x\n" }); // no git, no TypeScript, no package.json
      collect(root);
      scoreCollected(root);
      const { categories } = JSON.parse(readFileSync(join(root, ".audit/score.json"), "utf8"));
      const gaps = Object.values(categories).flatMap((c) => c.gaps).join("\n");
      for (const tool of ["git", "typecheck", "gitleaks", "hotspots", "knip", "boundaries"]) assert.doesNotMatch(gaps, new RegExp(`^${tool}:`, "m"));
    });
  });

  describe("real gaps stay gaps, with a real summary", () => {
    const FILES = { ".gitignore": ".audit/\n" };
    const gapsIn = (root, options = {}) => {
      collect(root, ["--offline", "--no-tests"], options);
      write(root, ".audit/scoring.json", JSON.stringify({ mode: "full", anchors: anchors(), findings: [] }));
      const r = spawnSync(process.execPath, [SCORE, "--input", ".audit/scoring.json"], { cwd: root, encoding: "utf8" });
      assert.equal(r.status, 0, r.stdout + r.stderr);
      return Object.values(JSON.parse(readFileSync(join(root, ".audit/score.json"), "utf8")).categories).flatMap((c) => c.gaps).join("\n");
    };
    const committed = (files) => {
      const root = gitInit(project({ ...FILES, ...files }));
      gitCommitAll(root);
      return root;
    };

    test("TypeScript with no tsconfig", () => assert.match(gapsIn(committed({ "src/a.ts": "export const a: number = 'x';\n" })), /^typecheck: skipped \(TypeScript files, but no tsconfig\)/m));
    test("a tsconfig only in a package", () => assert.match(gapsIn(committed({ "packages/a/tsconfig.json": "{}", "packages/a/a.ts": "export {};\n" })), /^typecheck: skipped \(no tsconfig at the root\)/m));
    test("a tsconfig in a tracked folder the scan leaves out", () => assert.match(gapsIn(committed({ "bin/tsconfig.json": "{}", "bin/cli.ts": "export {};\n" })), /^typecheck: skipped/m));
    test("TypeScript in a tracked folder the scan leaves out", () => assert.match(gapsIn(committed({ "bin/cli.ts": "export {};\n" })), /^typecheck: skipped/m));
    test("packages with no package.json at the root", () => assert.match(gapsIn(committed({ "frontend/package.json": "{}", "backend/package.json": "{}" })), /^knip: skipped \(no package\.json at the root\)/m));
    test("knip while offline", () => assert.match(gapsIn(committed({ "package.json": "{}" })), /^knip: skipped \(offline\)/m));
    test("JavaScript with no boundary config while offline", () => assert.match(gapsIn(committed({ "src/a.js": "export {};\n" })), /^boundaries: skipped/m));
    for (const file of ["src/a.mjs", "src/a.cjs", "src/App.vue", "src/App.svelte"]) {
      test(`${file} is out of madge's reach, which isn't "nothing to check"`, () => assert.match(gapsIn(committed({ [file]: "x\n" })), /^boundaries: skipped .*can't read/m));
    }
    test("gitleaks not being installed", () => {
      const binDir = project();
      const dirs = process.env.PATH.split(":").filter((d) => !existsSync(join(d, "gitleaks")));
      assert.match(gapsIn(committed({ "a.txt": "x\n" }), { binDir, env: { PATH: [binDir, ...dirs].join(":") } }), /^gitleaks: skipped/m);
    });
    test("a repo with no commits has no history for gitleaks to scan", () => {
      const binDir = project();
      fakeBin(binDir, "gitleaks", "exit 0");
      assert.doesNotMatch(gapsIn(gitInit(project(FILES)), { binDir }), /^gitleaks:/m);
    });
  });

  test("a bad risk entry", () => {
    const root = project({ ".audit-exceptions.json": JSON.stringify({ risks: [{ rule: "xss", path: "src/a.ts", expires: "2999-01-01" }] }) });
    const r = score(root);
    assert.equal(r.code, 2);
    assert.match(r.output, /reason is required/);
  });

  test("a history.csv it doesn't recognise is left alone", () => {
    const root = project({ "docs/audits/history.csv": "something,else\n" });
    assert.equal(score(root).code, 2);
    assert.equal(readFileSync(join(root, "docs/audits/history.csv"), "utf8"), "something,else\n");
    assert.ok(!existsSync(join(root, "docs/audits/latest.json")));
  });

  test("an unreadable previous baseline isn't overwritten", () => {
    const root = project({ "docs/audits/latest.json": "{nope" });
    assert.equal(score(root).code, 2);
    assert.equal(readFileSync(join(root, "docs/audits/latest.json"), "utf8"), "{nope");
  });
});

describe("score: the baseline (item 13)", () => {
  test("a full audit writes latest.json and history.csv with commit and rubric", () => {
    const root = gitInit(project({ "a.ts": "1\n" }));
    gitCommitAll(root);
    const sha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
    assert.equal(score(root, { summary: summaryOf({ commit: sha }) }).code, 0);
    assert.equal(latest(root).commit, sha);
    assert.equal(latest(root).rubricVersion, 2);
    assert.match(history(root)[0], /,commit,rubricVersion$/);
    assert.ok(history(root)[1].endsWith(`,${sha},2`), history(root)[1]);
  });

  for (const [mode, given] of [["quick", ["security", "reliability"]], ["security", ["security"]], ["since-last", ["security", "tooling"]]]) {
    test(`${mode} leaves an existing baseline untouched and has no overall`, () => {
      const root = project();
      score(root);
      const before = [readFileSync(join(root, "docs/audits/latest.json"), "utf8"), readFileSync(join(root, "docs/audits/history.csv"), "utf8")];
      const r = score(root, { input: { mode, anchors: Object.fromEntries(given.map((c) => [c, { score: 2 }])) } });
      assert.equal(r.code, 0, r.output);
      assert.equal(r.score.overall, null);
      assert.equal(r.score.baseline, false);
      assert.equal(r.score.categories.performance.status, "not-assessed");
      assert.deepEqual([readFileSync(join(root, "docs/audits/latest.json"), "utf8"), readFileSync(join(root, "docs/audits/history.csv"), "utf8")], before);
    });

    test(`${mode} doesn't create a baseline when there is none`, () => {
      const root = project();
      score(root, { input: { mode, anchors: Object.fromEntries(given.map((c) => [c, { score: 8 }])) } });
      assert.ok(!existsSync(join(root, "docs/audits/latest.json")));
      assert.ok(!existsSync(join(root, "docs/audits/history.csv")));
    });
  }

  test("scoring one commit twice replaces its history row", () => {
    const root = gitInit(project({ "a.ts": "1\n" }));
    gitCommitAll(root);
    const sha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
    score(root, { summary: summaryOf({ commit: sha }), input: { anchors: anchors(9) } });
    score(root, { summary: summaryOf({ commit: sha }), input: { anchors: anchors(8) } });
    assert.equal(history(root).length, 2);
    assert.match(history(root)[1], /^2026-11-04,8,/);
  });

  test("a version 1 history.csv keeps its rows under the new header", () => {
    const old = "date,overall,security,reliability,performance,maintainability,tooling,critical,high,medium,low";
    const root = project({ "docs/audits/history.csv": `${old}\n2026-01-01,7,7,7,7,7,7,0,0,0,0\n` });
    score(root);
    const rows = history(root);
    assert.equal(rows[0], `${old},commit,rubricVersion`);
    assert.equal(rows[1], "2026-01-01,7,7,7,7,7,7,0,0,0,0,,");
    assert.equal(rows.length, 3);
    for (const r of rows) assert.equal(r.split(",").length, 13);
  });
});

describe("score: finding ids and the trend", () => {
  test("numbers findings by category", () => {
    const r = score(project(), { input: { findings: [finding(), finding({ location: "src/b.ts:1" }), finding({ category: "tooling", rule: "docker-hygiene", severity: "low" })] } });
    assert.deepEqual(r.score.findings.map((f) => f.id).sort(), ["SEC-001", "SEC-002", "TOOL-001"]);
  });

  for (const location of ["src/a.ts", "src/a.ts:5", "project-wide"]) {
    test(`two different other-* findings at ${location} aren't duplicates`, () => {
      const f = (title) => finding({ rule: "other-security", title, location });
      const r = score(project(), { input: { findings: [f("One"), f("Two")] } });
      assert.equal(r.code, 0, r.output);
      assert.equal(new Set(r.score.findings.map((x) => x.id)).size, 2);
    });
  }

  test("the same rule and file keeps its id, even when the line moves", () => {
    const root = project();
    const id = score(root, { input: { findings: [finding({ location: "src/z.ts:10" })] } }).score.findings[0].id;
    const next = score(root, { input: { findings: [finding({ location: "src/new.ts:1" }), finding({ location: "src/z.ts:99" })] } });
    assert.equal(next.score.findings.find((f) => f.file === "src/z.ts").id, id);
    assert.equal(next.score.findings.find((f) => f.file === "src/new.ts").id, "SEC-002");
  });

  test("other-* findings in one file are told apart by title", () => {
    const root = project();
    const f = (title, line) => finding({ rule: "other-security", title, location: `src/a.ts:${line}` });
    const first = score(root, { input: { findings: [f("First problem", 1), f("Second problem", 2)] } }).score.findings;
    const again = score(root, { input: { findings: [f("Second problem", 2)] } }).score.findings;
    assert.equal(again[0].id, first.find((x) => x.title === "Second problem").id);
  });

  test("reports new, still open and fixed", () => {
    const root = project();
    score(root, { input: { findings: [finding({ location: "src/old.ts:1" }), finding({ location: "src/stay.ts:1" })] } });
    const { comparison: c } = score(root, { input: { findings: [finding({ location: "src/stay.ts:1" }), finding({ location: "src/new.ts:1" })] } }).score;
    assert.equal(c.comparable, true);
    assert.deepEqual(c.fixed, ["SEC-001"]);
    assert.deepEqual(c.stillOpen, ["SEC-002"]);
    assert.deepEqual(c.new, ["SEC-003"]);
  });

  test("a partial audit doesn't call what it skipped fixed", () => {
    const root = project();
    score(root, { input: { findings: [finding({ category: "tooling", rule: "docker-hygiene", severity: "low" })] } });
    const { comparison: c } = score(root, { input: { mode: "security", anchors: { security: { score: 8 } } } }).score;
    assert.deepEqual(c.fixed, []);
    assert.deepEqual(c.notRechecked, ["TOOL-001"]);
  });

  test("a fixed problem that returns is reopened with its old id", () => {
    const root = project();
    score(root, { input: { findings: [finding()] } });
    score(root); // gone
    const { findings, comparison: c } = score(root, { input: { findings: [finding()] } }).score;
    assert.equal(findings[0].id, "SEC-001");
    assert.deepEqual(c.reopened, ["SEC-001"]);
    assert.deepEqual(c.new, []);
  });

  test("a finding fix-findings marked fixed that returns is reopened", () => {
    const root = project();
    write(root, "docs/audits/latest.json", JSON.stringify({ rubricVersion: 2, date: "2026-10-01", findings: [{ id: "SEC-007", rule: "xss", location: "src/a.ts:1", status: "fixed" }] }));
    const { findings, comparison: c } = score(root, { input: { findings: [finding()] } }).score;
    assert.equal(findings[0].id, "SEC-007");
    assert.deepEqual(c.reopened, ["SEC-007"]);
  });

  describe("findings fix-findings marked fixed", () => {
    const baseline = (root) => write(root, "docs/audits/latest.json", JSON.stringify({ rubricVersion: 2, date: "2026-10-01", findings: [
      { id: "SEC-007", rule: "xss", location: "src/a.ts:1", status: "fixed" },
      { id: "TOOL-002", rule: "docker-hygiene", location: "Dockerfile:1", status: "open" },
    ] }));

    test("a full audit reports them as fixed", () => {
      const root = project();
      baseline(root);
      const { comparison: c } = score(root).score;
      assert.deepEqual([...c.fixed].sort(), ["SEC-007", "TOOL-002"]);
      assert.deepEqual(c.reopened, []);
    });

    for (const [mode, given] of [["since-last", "security"], ["security", "security"], ["quick", "security"]]) {
      test(`${mode} reports them as fixed too`, () => {
        const root = project();
        baseline(root);
        const { comparison: c } = score(root, { input: { mode, anchors: { [given]: { score: 8 } }, findings: [] } }).score;
        assert.ok(c.fixed.includes("SEC-007"), JSON.stringify(c));
        assert.ok(!c.notRechecked.includes("SEC-007"), JSON.stringify(c));
      });
    }

    test("a partial audit doesn't also call unmarked findings fixed", () => {
      const root = project();
      baseline(root);
      const { comparison: c } = score(root, { input: { mode: "security", anchors: { security: { score: 8 } } } }).score;
      assert.deepEqual(c.fixed, ["SEC-007"]);
      assert.deepEqual(c.notRechecked, ["TOOL-002"]);
    });

    test("they aren't reported again after the next full audit closes them", () => {
      const root = project();
      baseline(root);
      score(root);
      assert.deepEqual(score(root).score.comparison.fixed, []);
    });
  });

  describe("locations are project-relative", () => {
    for (const [name, location] of [["absolute", (root) => join(root, "src/a.ts:1")], ["dot-relative", () => "./src/a.ts:1"]]) {
      test(`a ${name} location keeps the id of the relative one`, () => {
        const root = project();
        score(root, { input: { findings: [finding()] } });
        const { findings, comparison: c } = score(root, { input: { findings: [finding({ location: location(root) })] } }).score;
        assert.equal(findings[0].id, "SEC-001");
        assert.equal(findings[0].file, "src/a.ts");
        assert.deepEqual(c.fixed, []);
        assert.deepEqual(c.new, []);
      });
    }

    for (const form of [
      "src/a.ts:99", "src/a.ts:L99", "src/a.ts#L99", "src/a.ts (line 99)", "`src/a.ts:99`", "src/a.ts:99 (the handler)",
      "src/a.ts:L1-L5", "src/a.ts:12–40", "src/a.ts line 12", "src/a.ts lines 12-14", "src/a.ts (L12)", "src/a.ts#L12 (handler)",
      "src/a.ts (line 9) (handler)", "src/a.ts (lines 1, 3)", "`src/a.ts`:12",
    ]) {
      test(`${form} keeps the id of src/a.ts:1`, () => {
        const root = project();
        score(root, { input: { findings: [finding()] } });
        const { findings, comparison: c } = score(root, { input: { findings: [finding({ location: form })] } }).score;
        assert.equal(findings[0].id, "SEC-001");
        assert.deepEqual(c.new, []);
      });
    }

    test("only the line moving keeps the id of a file with a space in its name, even once it's gone", () => {
      const root = project();
      score(root, { input: { findings: [finding({ location: "src/my file.ts:1" })] } });
      const r = score(root, { input: { findings: [finding({ location: "src/my file.ts:2" })] } });
      assert.equal(r.score.findings[0].id, "SEC-001");
      assert.equal(r.score.findings[0].file, "src/my file.ts");
    });

    for (const [first, next] of [["app/(auth)/page.tsx:9", "app/(auth)/page.tsx:10"], ["app/(auth)/page.tsx (line 9)", "app/(auth)/page.tsx (line 10)"], ["app/(auth)/page.tsx#L9", "app/(auth)/page.tsx#L10"]]) {
      test(`a route group keeps its id when only the line moves: ${first}`, () => {
        const root = project();
        score(root, { input: { findings: [finding({ location: first })] } });
        const r = score(root, { input: { findings: [finding({ location: next })] } });
        assert.equal(r.score.findings[0].id, "SEC-001");
        assert.equal(r.score.findings[0].file, "app/(auth)/page.tsx");
      });
    }

    for (const location of ["https://example.com/a", "http://localhost:3000/api/login", "package.json#scripts", "project-wide", "POST /api/login", "#L9"]) {
      test(`${location} isn't a file, and is accepted as it is`, () => {
        const r = score(project(), { input: { findings: [finding({ location })] } });
        assert.equal(r.code, 0, r.output);
        assert.equal(r.score.findings[0].file, location);
      });
    }

    test("the project's folder name doesn't affect the id", () => {
      const a = project({}, { name: "first" }), b = project({}, { name: "second" });
      const id = (root) => score(root, { input: { findings: [finding({ location: join(root, "src/a.ts:1") })] } }).score.findings[0];
      assert.equal(id(a).file, id(b).file);
    });
  });

  test("ids are never given to something else", () => {
    const root = project();
    score(root, { input: { findings: [finding()] } });
    score(root);
    const r = score(root, { input: { findings: [finding({ location: "src/other.ts:1" })] } });
    assert.equal(r.score.findings[0].id, "SEC-002");
  });

  test("shows the score change per category", () => {
    const root = project();
    score(root, { input: { anchors: anchors(6) } });
    const { comparison: c } = score(root, { input: { anchors: anchors(8) } }).score;
    assert.equal(c.deltas.security, 2);
    assert.equal(c.overallDelta, 2);
  });

  test("a baseline from an older rubric is not compared, but its ids carry over", () => {
    const root = project({ "docs/audits/latest.json": JSON.stringify({ date: "2026-01-01", scores: { security: 9 }, findings: [{ id: "SEC-004", rule: "xss", location: "src/a.ts:3" }, { id: "SEC-009", rule: "invented-rule", location: "src/b.ts:1" }] }) });
    const r = score(root, { input: { findings: [finding()] } }).score;
    assert.equal(r.comparison.comparable, false);
    assert.match(r.comparison.reason, /rubric 1/);
    assert.equal(r.comparison.fixed, undefined);
    assert.equal(r.findings[0].id, "SEC-004");
  });
});

describe("score: strengths and accepted risks (item 15)", () => {
  test("strengths are stored apart from findings and don't change counts", () => {
    const root = project();
    const r = score(root, { input: { strengths: [{ category: "security", title: "Auth middleware everywhere", location: "src/mw.ts" }] } });
    assert.equal(r.score.counts.low, 0);
    assert.equal(r.score.findings.length, 0);
    assert.equal(latest(root).strengths[0].title, "Auth middleware everywhere");
  });

  const SOURCE = { "src/a.ts": "1\n", "src/b.ts": "1\n", "lib/pay.ts": "1\n" };
  const risks = (entry) => ({ ...SOURCE, ".audit-exceptions.json": JSON.stringify({ risks: [{ rule: "no-auth-rate-limit", path: "src/**", reason: "Behind a WAF", expires: "2999-01-01", ...entry }] }) });
  const capped = finding({ rule: "no-auth-rate-limit", severity: "high" });

  test("an accepted risk stays listed and stops counting", () => {
    const r = score(project(risks()), { input: { anchors: anchors(10), findings: [capped] } });
    assert.equal(r.score.categories.security.score, 10);
    assert.equal(r.score.counts.high, 0);
    assert.equal(r.score.findings[0].status, "accepted");
    assert.equal(r.score.findings[0].accepted.reason, "Behind a WAF");
  });

  test("an expired acceptance counts again, and is reported", () => {
    const r = score(project(risks({ expires: "2020-01-01" })), { input: { anchors: anchors(10), findings: [capped] } });
    assert.equal(r.score.categories.security.score, 7);
    assert.equal(r.score.expiredRisks.length, 1);
  });

  test("a critical can't be accepted", () => {
    const r = score(project(risks()), { input: { anchors: anchors(10), findings: [finding({ rule: "no-auth-rate-limit", severity: "critical" })] } });
    assert.equal(r.score.findings[0].status, "open");
    assert.equal(r.score.categories.security.score, 3);
  });

  test("a path that doesn't match isn't accepted", () => {
    const r = score(project(risks({ path: "lib/**" })), { input: { anchors: anchors(10), findings: [capped] } });
    assert.equal(r.score.findings[0].status, "open");
  });

  describe("a finding that lists several locations", () => {
    const at = (location) => ({ ...capped, location });
    const status = (files, location) => score(project(files), { input: { anchors: anchors(10), findings: [at(location)] } }).score;

    for (const location of [
      "src/a.ts:1 lib/pay.ts:9", "src/a.ts:1 & lib/pay.ts:9", "src/a.ts:12 (also lib/pay.ts:9)", "src/a.ts:1 AND lib/pay.ts:9",
      "src/a.ts:1 / lib/pay.ts", "src/a.ts & lib/pay.ts", "src/a.ts lib/pay.ts", "src/a.ts or lib/pay.ts",
      "src/a.ts:1→lib/pay.ts:9", "src/a.ts->lib/pay.ts", "src/a.ts:1+lib/pay.ts:9", "src/a.ts:1/lib/pay.ts:9", "src/a.ts:1:lib/pay.ts:9",
      "src/a.ts (line 12 also lib/pay.ts:9)", "src/a.ts (lines 3 to 9 plus lib/pay.ts)", "src/a.ts (line 12 and lib/pay.ts:9)", "src/a.ts (lines 1, lib/pay.ts)",
      "src/a.ts:1, 9 lib/pay.ts", "src/a.ts:1，lib/pay.ts:9", "src/a.ts:1、lib/pay.ts:9", "`src/a.ts:1` `lib/pay.ts:9`", "src/a.ts:1\tlib/pay.ts:9",
      "src/a.ts:1 or lib/pay.ts:9", "src/*.ts,lib/*.ts", "src/../lib/pay.ts:9", "src/a.ts#L1,lib/pay.ts#L9", "src/a.ts#L1-L5 lib/pay.ts",
      // With no space, so these only stay open because no such file exists.
      "src/a.ts&lib/pay.ts", "src/a.ts|lib/pay.ts", "src/a.ts/lib/pay.ts", "src/a.ts-lib/pay.ts", "src/a.ts+lib/pay.ts", "src/a.ts#lib/pay.ts", "src/(a.ts)lib/pay.ts",
    ]) {
      test(`stays open when it can't be read as files: ${location}`, () => {
        const r = status(risks(), location);
        assert.equal(r.findings[0].status, "open");
        assert.equal(r.categories.security.score, 7);
      });
    }

    for (const separator of [", ", "; ", " and ", "\n"]) {
      test(`isn't accepted when a location separated by ${JSON.stringify(separator)} is outside the risk`, () => {
        const r = status(risks(), `src/a.ts:1${separator}lib/pay.ts:9`);
        assert.equal(r.findings[0].status, "open");
        assert.equal(r.categories.security.score, 7);
      });
    }

    test("is accepted when the risk covers every location", () => {
      assert.equal(status(risks(), "src/a.ts:1, src/b.ts:9").findings[0].status, "accepted");
    });

    for (const location of ["src/a.ts:12,40", "src/a.ts:12-14, 20", "src/a.ts:12, line 40", "src/a.ts:12, L40", "src/a.ts:12 and 40", "src/a.ts:12:5"]) {
      test(`extra line numbers aren't mistaken for files: ${location}`, () => {
        assert.equal(status(risks(), location).findings[0].status, "accepted");
      });
    }

    for (const location of ["src/a.ts:12–40", "src/a.ts:L1-L5", "src/a.ts lines 12-40", "src/a.ts (lines 1, 3)", "`src/a.ts`:12", "src/a.ts (L12)", "src/a.ts#L12"]) {
      test(`every way of writing a line number is still that file: ${location}`, () => {
        assert.equal(status(risks(), location).findings[0].status, "accepted");
      });
    }

    for (const [file, path] of [
      ["app/(auth)/login/page.tsx", "app/**"], ["src/routes/(app)/+page.svelte", "src/**"], ["app/api/users/[id]/route.ts", "app/**"],
      ["pages/[...slug].tsx", "pages/**"], ["app/(.)photo/page.tsx", "app/**"], ["src/my file.ts", "src/**"],
    ]) {
      for (const suffix of ["", ":12"]) {
        test(`a real file is accepted whatever its name looks like: ${file}${suffix}`, () => {
          assert.equal(status({ ...risks({ path }), [file]: "1\n" }, `${file}${suffix}`).findings[0].status, "accepted");
        });
      }
    }

    test("a file that doesn't exist isn't accepted, even inside the risk's path", () => {
      assert.equal(status(risks(), "src/never-existed.ts:1").findings[0].status, "open");
    });

    test("is accepted when two risks cover its locations between them", () => {
      const both = { ...SOURCE, ".audit-exceptions.json": JSON.stringify({ risks: ["src/**", "lib/**"].map((path) => ({ rule: "no-auth-rate-limit", path, reason: "Behind a WAF", expires: "2999-01-01" })) }) };
      assert.equal(status(both, "src/a.ts:1, lib/pay.ts:9").findings[0].status, "accepted");
    });
  });

  for (const [name, location] of [["absolute", (root) => join(root, "src/a.ts:1")], ["dot-relative", () => "./src/a.ts:1"]]) {
    test(`a risk matches a ${name} location`, () => {
      const root = project(risks());
      const r = score(root, { input: { anchors: anchors(10), findings: [{ ...capped, location: location(root) }] } });
      assert.equal(r.score.findings[0].status, "accepted");
    });
  }
});

describe("score: coverage gaps beside the grade", () => {
  const skipped = { tests: tool("skipped", { skipped: "not run locally" }), gitleaks: tool("skipped", { skipped: "not installed" }) };

  test("the overall line counts them and the next line names them", () => {
    const r = score(project(), { summary: summaryOf({ tools: skipped }), input: { anchors: anchors(10) } });
    assert.match(r.output, /Overall 10 \(A\), 2 coverage gaps/);
    assert.match(r.output, /Coverage gaps:.*gitleaks: skipped \(not installed\)/s);
    assert.equal(r.score.coverageGaps, 2);
    assert.equal(r.score.overall, 10, "gaps are reported, and don't change the score");
  });

  test("a skip that doesn't apply to the project isn't a gap", () => {
    const r = score(project(), { summary: summaryOf({ tools: { git: tool("skipped", { skipped: "not a git repo", notApplicable: true }) } }), input: { anchors: anchors(10) } });
    assert.equal(r.score.coverageGaps, 0);
    assert.doesNotMatch(r.output, /coverage gap/i);
  });

  test("one gap reads as one", () => {
    const r = score(project(), { summary: summaryOf({ tools: { tests: skipped.tests } }), input: { anchors: anchors(10) } });
    assert.match(r.output, /1 coverage gap\b/);
  });

  test("no gaps, no mention", () => {
    const r = score(project(), { input: { anchors: anchors(10) } });
    assert.doesNotMatch(r.output, /coverage gap/i);
    assert.equal(r.score.coverageGaps, 0);
  });

  test("a partial audit counts only the categories it looked at", () => {
    const r = score(project(), { summary: summaryOf({ tools: skipped }), input: { mode: "reliability", anchors: { reliability: { score: 8 } } } });
    assert.equal(r.score.coverageGaps, 1);
    assert.match(r.output, /1 coverage gap\b/);
  });
});
