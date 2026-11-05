// Contracts between the plugin's files that nothing else checks.

import assert from "node:assert/strict";
import { accessSync, constants, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test, describe } from "node:test";
import { PLUGIN, REPO } from "./helpers.mjs";

const read = (...p) => readFileSync(join(...p), "utf8");
const json = (...p) => JSON.parse(read(...p));

describe("manifests", () => {
  test("marketplace points at an existing plugin with a matching name", () => {
    const market = json(REPO, ".claude-plugin", "marketplace.json");
    for (const p of market.plugins) {
      assert.equal(json(REPO, p.source, ".claude-plugin", "plugin.json").name, p.name);
    }
  });

  test("the license named in plugin.json exists", () => {
    const { license } = json(PLUGIN, ".claude-plugin", "plugin.json");
    assert.match(read(REPO, "LICENSE"), new RegExp(`${license} License`));
  });

  test("every script a hook runs exists, and the launcher is executable", () => {
    const hooks = read(PLUGIN, "hooks", "hooks.json");
    const paths = [...hooks.matchAll(/CLAUDE_PLUGIN_ROOT\}\\"\/([\w./-]+)/g)].map((m) => m[1]);
    assert.ok(paths.length >= 4);
    for (const p of paths) assert.ok(existsSync(join(PLUGIN, p)), p);
    accessSync(join(PLUGIN, "scripts", "run-node.sh"), constants.X_OK);
  });

  test("every agent and skill has a name matching its file", () => {
    for (const f of readdirSync(join(PLUGIN, "agents"))) {
      assert.match(read(PLUGIN, "agents", f), new RegExp(`^---\\nname: ${f.replace(/\.md$/, "")}\\n`), f);
    }
    for (const d of readdirSync(join(PLUGIN, "skills"))) {
      assert.match(read(PLUGIN, "skills", d, "SKILL.md"), new RegExp(`^---\\nname: ${d}\\n`), d);
    }
  });
});

describe("spec status (item 7)", () => {
  const STATUS = /status `([a-z ]+)`/g;
  const statusesIn = (text) => [...text.matchAll(STATUS)].map((m) => m[1]);

  test("the status the code reviewer looks for is one the spec skill sets", () => {
    const wanted = statusesIn(read(PLUGIN, "agents", "code-reviewer.md"));
    assert.ok(wanted.length > 0);
    const set = statusesIn(read(PLUGIN, "skills", "spec", "SKILL.md"));
    for (const s of wanted) assert.ok(set.includes(s), `spec skill never sets "${s}"`);
  });

  test("every status the spec skill sets is allowed by the template", () => {
    const template = read(PLUGIN, "skills", "bootstrap", "templates", "spec-template.md");
    const allowed = template.match(/^Status: (.+)$/m)[1].split("|").map((s) => s.trim());
    for (const s of statusesIn(read(PLUGIN, "skills", "spec", "SKILL.md"))) assert.ok(allowed.includes(s), s);
  });
});

describe("documentation", () => {
  test("the install commands name this repo's real GitHub owner", () => {
    const readme = read(REPO, "README.md");
    assert.match(readme, /marketplace add cypriotCodder\/nedim-dev-kit/);
    assert.doesNotMatch(readme, /nedimhuray\//);
  });

  test("the root and plugin READMEs are not copies of each other", () => {
    assert.notEqual(read(REPO, "README.md"), read(PLUGIN, "README.md"));
  });

  test("the plugin README lists every skill", () => {
    const readme = read(PLUGIN, "README.md");
    for (const d of readdirSync(join(PLUGIN, "skills"))) assert.match(readme, new RegExp(`skills/${d}/`), d);
  });
});

describe("audit CI template", () => {
  const template = readFileSync(join(PLUGIN, "skills/audit/templates/audit-ci.yml"), "utf8");

  test("uploads only the summary, because raw evidence quotes source code", () => {
    const paths = [...template.matchAll(/^\s*path:\s*(\S+)/gm)].map((m) => m[1]);
    assert.deepEqual(paths, [".audit/raw/summary.json"]);
  });

  test("installs a pinned gitleaks, so history gets scanned", () => {
    assert.match(template, /gitleaks\/releases\/download\/v\$\{GITLEAKS_VERSION\}/);
    assert.match(template, /GITLEAKS_VERSION: \d+\.\d+\.\d+/);
  });

  test("checks the gitleaks download against a pinned checksum before running it", () => {
    assert.match(template, /GITLEAKS_SHA256: [0-9a-f]{64}\n/);
    const run = template.slice(template.indexOf("Install gitleaks"));
    assert.ok(run.indexOf("sha256sum --check") < run.indexOf("tar -xzf"), "unpacks before checking");
  });

  test("limits the token's permissions", () => {
    assert.match(template, /^permissions:\n\s+contents: read/m);
  });
});

const frontmatter = (text) => text.match(/^---\n([\s\S]*?)\n---/)[1];
const rulesFile = json(PLUGIN, "skills", "audit", "rules.json");

describe("version stamp", () => {
  test("KIT_VERSION matches plugin.json", () => {
    const { version } = json(PLUGIN, ".claude-plugin", "plugin.json");
    assert.match(read(PLUGIN, "skills", "audit", "lib", "version.mjs"), new RegExp(`KIT_VERSION = "${version}"`));
  });
});

describe("rubric and rules.json stay in step", () => {
  const rubric = read(PLUGIN, "skills", "audit", "rubric.md");

  test("the rubric names the version in rules.json", () => {
    assert.match(rubric, new RegExp(`\\(version ${rulesFile.rubricVersion}\\)`));
  });

  test("every capped rule appears in the rubric with its number", () => {
    for (const rules of Object.values(rulesFile.rules)) {
      for (const [id, max] of Object.entries(rules)) {
        if (max !== null) assert.ok(rubric.includes(`\`${id}\` → max ${max}`), id);
      }
    }
  });

  test("every metric cap appears in the rubric with its number", () => {
    for (const { id, max } of rulesFile.metricCaps) assert.ok(rubric.includes(`\`${id}\` → max ${max}`), id);
  });

  test("the rubric has no cap that rules.json doesn't", () => {
    const known = new Map([...Object.values(rulesFile.rules).flatMap((r) => Object.entries(r)), ...rulesFile.metricCaps.map((c) => [c.id, c.max])]);
    for (const [, id, max] of rubric.matchAll(/`([a-z0-9-]+)` → max (\d+)/g)) assert.equal(known.get(id), +max, id);
  });

  test("every category has an other- rule for what fits nothing else", () => {
    for (const [category, rules] of Object.entries(rulesFile.rules)) assert.ok(`other-${category}` in rules, category);
  });

  test("the weights add up to 100", () => {
    assert.equal(Object.values(rulesFile.weights).reduce((a, b) => a + b), 100);
  });
});

describe("read-only agents (item 16)", () => {
  const AGENTS = ["audit-verifier", "maintainability-auditor", "performance-auditor", "reliability-auditor", "security-auditor", "tooling-auditor"];

  test("auditors have no shell, because they read untrusted repo content", () => {
    for (const a of AGENTS) assert.match(frontmatter(read(PLUGIN, "agents", `${a}.md`)), /^tools: Read, Grep, Glob$/m, a);
  });

  test("nothing tells an auditor to use a shell it no longer has", () => {
    for (const a of AGENTS) assert.doesNotMatch(read(PLUGIN, "agents", `${a}.md`), /\bBash\b|`git log|read-only commands/, a);
  });

  test("auditors report strengths separately", () => {
    for (const a of AGENTS.filter((x) => x !== "audit-verifier")) {
      const text = read(PLUGIN, "agents", `${a}.md`);
      assert.match(text, /"strengths"/, a);
      assert.doesNotMatch(text, /GOOD:/, a);
    }
  });
});

describe("skill triggers (item 23)", () => {
  const skill = (name) => read(PLUGIN, "skills", name, "SKILL.md");

  test("audit and bootstrap run only when asked for", () => {
    for (const name of ["audit", "bootstrap"]) assert.match(frontmatter(skill(name)), /^disable-model-invocation: true$/m, name);
  });

  test("checkpoint stays callable, because spec and fix-findings call it", () => {
    assert.doesNotMatch(frontmatter(skill("checkpoint")), /disable-model-invocation/);
  });

  test("checkpoint doesn't fire on everyday phrases", () => {
    const description = frontmatter(skill("checkpoint"));
    assert.doesNotMatch(description, /wrap up|commit this/i);
  });

  test("design skills don't claim generic complaints about a UI", () => {
    for (const name of ["design-system", "ui-review"]) assert.doesNotMatch(frontmatter(skill(name)), /(?<!non-)generic|vibe-coded|AI-made|feels off|not smooth/i, name);
  });
});

describe("checkpoint order (item 21)", () => {
  const text = read(PLUGIN, "skills", "checkpoint", "SKILL.md");

  test("UI fixes happen before the checks and the review see the code", () => {
    assert.ok(text.indexOf("ui-review") < text.indexOf("**Checks.**"));
    assert.ok(text.indexOf("**Checks.**") < text.indexOf("code-reviewer"));
  });

  test("the scope check sees staged and new files, including those in new folders", () => {
    assert.match(text, /git status --porcelain --untracked-files=all/);
    assert.match(text, /git diff HEAD/);
    assert.doesNotMatch(text, /`git diff --stat`/);
  });
});

describe("audit skill contract", () => {
  const text = read(PLUGIN, "skills", "audit", "SKILL.md");

  test("verifies every medium, not a random sample (item 15)", () => {
    assert.match(text, /every \*\*critical, high and medium\*\*/);
    assert.doesNotMatch(text, /random/);
  });

  test("doesn't commit without asking, and commits .gitignore with the reports (item 24)", () => {
    assert.match(text, /Don't commit anything yet/);
    assert.match(text, /together with the `\.gitignore` change/);
  });
});
