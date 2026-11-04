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
    assert.match(template, /gitleaks\/releases\/download\/v\d/);
  });

  test("limits the token's permissions", () => {
    assert.match(template, /^permissions:\n\s+contents: read/m);
  });
});
