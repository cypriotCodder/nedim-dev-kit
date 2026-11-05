import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, describe } from "node:test";
import { PLUGIN, fakeBin, fakeLocalBin, gitCommitAll, gitInit, project, write } from "./helpers.mjs";

const DOCTOR = join(PLUGIN, "skills", "doctor", "doctor.mjs");
const VERSION = JSON.parse(readFileSync(join(PLUGIN, ".claude-plugin", "plugin.json"), "utf8")).version;

function doctor(root, { script = DOCTOR, cwd = root } = {}) {
  const env = { ...process.env };
  for (const k of ["CLAUDE_PROJECT_DIR", "CI", "GITHUB_ACTIONS"]) delete env[k];
  const r = spawnSync(process.execPath, [script, root, "--json"], { cwd, encoding: "utf8", env });
  const { results } = JSON.parse(r.stdout);
  return { code: r.status, results, get: (name) => results.find((x) => x.name === name) };
}

describe("doctor", () => {
  test("a project folder that doesn't exist is broken, not all off", () => {
    const missing = join(project(), "nope");
    const r = doctor(missing, { cwd: process.cwd() });
    assert.equal(r.code, 1);
    assert.equal(r.results.length, 1);
    assert.equal(r.results[0].state, "broken");
    assert.match(r.results[0].detail, /nope/);
  });

  test("a project path that is a file is broken", () => {
    const root = project({ "file.txt": "x" });
    const r = doctor(join(root, "file.txt"), { cwd: root });
    assert.equal(r.code, 1);
    assert.equal(r.results[0].state, "broken");
  });

  describe("hook scripts", () => {
    // A private copy of the plugin, since these tests break it on purpose.
    const plugin = () => {
      const dir = join(project(), "plugin");
      cpSync(PLUGIN, dir, { recursive: true });
      return dir;
    };
    const check = (dir) => doctor(project(), { script: join(dir, "skills", "doctor", "doctor.mjs") });
    const hooksJson = (dir) => join(dir, "hooks", "hooks.json");

    test("an untouched plugin is active and counts its scripts", () => {
      const g = check(plugin()).get("Hook scripts");
      assert.equal(g.state, "active");
      assert.match(g.detail, /^4 scripts/); // the three hooks and run-node.sh
    });

    test("a deleted script is broken", () => {
      const dir = plugin();
      rmSync(join(dir, "scripts", "stop-check.mjs"));
      const r = check(dir);
      assert.equal(r.code, 1);
      assert.match(r.get("Hook scripts").detail, /stop-check\.mjs/);
    });

    test("no declared scripts at all is broken, not active", () => {
      const dir = plugin();
      writeFileSync(hooksJson(dir), JSON.stringify({ hooks: {} }));
      assert.equal(check(dir).get("Hook scripts").state, "broken");
    });

    test("a command it can't read a script from is broken, not skipped", () => {
      const dir = plugin();
      const hooks = JSON.parse(readFileSync(hooksJson(dir), "utf8"));
      hooks.hooks.Stop[0].hooks[0].command = "some-tool --check";
      writeFileSync(hooksJson(dir), JSON.stringify(hooks));
      const r = check(dir);
      assert.equal(r.get("Hook scripts").state, "broken");
      assert.match(r.get("Hook scripts").detail, /Stop/);
    });

    test("a script named in the other variable form is still checked", () => {
      const dir = plugin();
      const hooks = JSON.parse(readFileSync(hooksJson(dir), "utf8"));
      hooks.hooks.Stop[0].hooks[0].command = `"\${CLAUDE_PLUGIN_ROOT}"/scripts/run-node.sh $CLAUDE_PLUGIN_ROOT/scripts/gone.mjs`;
      writeFileSync(hooksJson(dir), JSON.stringify(hooks));
      const g = check(dir).get("Hook scripts");
      assert.equal(g.state, "broken");
      assert.match(g.detail, /gone\.mjs/);
    });

    test("a command that runs the launcher with no script is broken", () => {
      const dir = plugin();
      const hooks = JSON.parse(readFileSync(hooksJson(dir), "utf8"));
      hooks.hooks.Stop[0].hooks[0].command = `"\${CLAUDE_PLUGIN_ROOT}"/scripts/run-node.sh`;
      writeFileSync(hooksJson(dir), JSON.stringify(hooks));
      assert.equal(check(dir).get("Hook scripts").state, "broken");
    });

    test("a stray file in the plugin's lib/ isn't demanded of a gate copy", () => {
      const dir = plugin();
      write(dir, "skills/audit/lib/.DS_Store", "x");
      const root = project({ ".github/workflows/audit.yml": "name: audit\n" });
      cpSync(join(PLUGIN, "skills/audit/lib"), join(root, "scripts/audit/lib"), { recursive: true });
      cpSync(join(PLUGIN, "skills/audit/collect.mjs"), join(root, "scripts/audit/collect.mjs"));
      assert.equal(doctor(root, { script: join(dir, "skills", "doctor", "doctor.mjs") }).get("CI gate copy").state, "active");
    });

    test("a hooks.json that isn't JSON is broken", () => {
      const dir = plugin();
      writeFileSync(hooksJson(dir), "{nope");
      assert.equal(check(dir).get("Hook scripts").state, "broken");
    });
  });

  test("an empty project is off, not broken", () => {
    const r = doctor(project());
    assert.equal(r.code, 0);
    for (const name of ["Typecheck", "ESLint on edit", "Boundary check", "Design guard", "CI gate copy", "Accepted exceptions", "Audit baseline"]) assert.equal(r.get(name).state, "off", name);
    assert.equal(r.get("Hook scripts").state, "active");
  });

  test("guards-off turns the hooks off and says why", () => {
    const root = project({ ".claude/guards-off": "", "tsconfig.json": "{}", "DESIGN.md": "x" });
    const r = doctor(root);
    assert.equal(r.get("Typecheck").state, "off");
    assert.match(r.get("Design guard").detail, /guards-off/);
  });

  describe("typecheck", () => {
    test("a tsconfig with no TypeScript is broken", () => {
      const r = doctor(project({ "tsconfig.json": "{}" }));
      assert.equal(r.code, 1);
      assert.equal(r.get("Typecheck").state, "broken");
    });

    test("type errors mean the guard works", () => {
      const root = project({ "tsconfig.json": "{}" });
      fakeLocalBin(root, "tsc", `echo "a.ts(1,1): error TS2322: bad"; exit 2`);
      const r = doctor(root);
      assert.equal(r.code, 0);
      assert.equal(r.get("Typecheck").state, "active");
      assert.match(r.get("Typecheck").detail, /type errors/);
    });

    test("a typecheck script that crashes isn't reported as finding errors", () => {
      const root = project({ "tsconfig.json": "{}", "package.json": JSON.stringify({ scripts: { typecheck: "exit 3" } }), "package-lock.json": "{}" });
      const r = doctor(root);
      assert.equal(r.get("Typecheck").state, "broken");
    });

    describe("in a monorepo, where the hooks resolve per file", () => {
      const pkg = (name) => ({ [`apps/${name}/tsconfig.json`]: "{}", [`apps/${name}/src/a.ts`]: "export {};\n" });
      const fakeTsc = (root, name, body) => fakeBin(join(root, "apps", name, "node_modules", ".bin"), "tsc", body);

      test("a package's tsconfig is checked, not reported as missing", () => {
        const root = project(pkg("web"));
        fakeTsc(root, "web", "exit 0");
        const g = doctor(root).get("Typecheck");
        assert.equal(g.state, "active");
        assert.match(g.detail, /apps\/web/);
      });

      test("a package with no TypeScript is broken", () => {
        const r = doctor(project(pkg("web")));
        assert.equal(r.code, 1);
        assert.equal(r.get("Typecheck").state, "broken");
        assert.match(r.get("Typecheck").detail, /apps\/web/);
      });

      test("one broken package isn't hidden by a working one", () => {
        const root = project({ ...pkg("web"), ...pkg("api") });
        fakeTsc(root, "web", "exit 0");
        fakeTsc(root, "api", "exit 7");
        const g = doctor(root).get("Typecheck");
        assert.equal(g.state, "broken");
        assert.match(g.detail, /apps\/api/);
      });

      test("type errors in a package mean the guard works there", () => {
        const root = project(pkg("web"));
        fakeTsc(root, "web", `echo "a.ts(1,1): error TS2322: bad"; exit 2`);
        const g = doctor(root).get("Typecheck");
        assert.equal(g.state, "active");
        assert.match(g.detail, /apps\/web.*type errors/);
      });

      test("TypeScript files with no tsconfig anywhere are off", () => {
        assert.equal(doctor(project({ "apps/web/src/a.ts": "export {};\n" })).get("Typecheck").state, "off");
      });

      test("a compiler fixture isn't a package that needs TypeScript", () => {
        const r = doctor(project({ "tests/fixtures/x/tsconfig.json": "{}", "tests/fixtures/x/a.ts": "export {};\n" }));
        assert.equal(r.code, 0);
        assert.equal(r.get("Typecheck").state, "off");
        assert.match(r.get("Typecheck").detail, /fixtures/);
      });

      describe("folders named like fixtures", () => {
        const TSC_OK = "exit 0", TSC_CRASH = "exit 7";

        for (const folder of ["fixtures", "__fixtures__", "templates", "examples"]) {
          test(`${folder} is left out, and an active line names it`, () => {
            const root = project({ ...pkg("web"), [`${folder}/x/tsconfig.json`]: "{}", [`${folder}/x/a.ts`]: "export {};\n" });
            fakeTsc(root, "web", TSC_OK);
            const r = doctor(root);
            assert.equal(r.code, 0);
            assert.equal(r.get("Typecheck").state, "active");
            assert.match(r.get("Typecheck").detail, new RegExp(`left out: ${folder}`));
          });
        }

        const sibling = (extra = {}) => {
          const root = project({ "packages/lib/tsconfig.json": "{}", "packages/lib/a.ts": "export {};\n", "packages/templates/tsconfig.json": "{}", "packages/templates/a.ts": "export {};\n", ...extra });
          fakeLocalBin(join(root, "packages/lib"), "tsc", TSC_OK);
          fakeLocalBin(join(root, "packages/templates"), "tsc", TSC_CRASH);
          return root;
        };

        test("with no workspaces declared, a crashing package is at least named", () => {
          const g = doctor(sibling()).get("Typecheck");
          assert.equal(g.state, "active");
          assert.match(g.detail, /left out: packages\/templates/);
        });

        test("a package declared in workspaces is checked, whatever its folder is called", () => {
          const r = doctor(sibling({ "package.json": JSON.stringify({ workspaces: ["packages/*"] }) }));
          assert.equal(r.code, 1);
          assert.equal(r.get("Typecheck").state, "broken");
          assert.match(r.get("Typecheck").detail, /packages\/templates: exit code 7/);
        });

        test("yarn's object form of workspaces counts too", () => {
          assert.equal(doctor(sibling({ "package.json": JSON.stringify({ workspaces: { packages: ["packages/*"] } }) })).get("Typecheck").state, "broken");
        });

        test("pnpm-workspace.yaml counts too", () => {
          const r = doctor(sibling({ "pnpm-workspace.yaml": "# all of them\npackages:\n  # code\n  - 'packages/*'\n  - \"!packages/none\"\nother: 1\n" }));
          assert.equal(r.get("Typecheck").state, "broken");
        });

        test("examples declared as workspaces with no TypeScript available are broken", () => {
          const root = project({ "package.json": JSON.stringify({ workspaces: ["packages/*", "examples/*"] }), "packages/lib/tsconfig.json": "{}", "packages/lib/a.ts": "export {};\n", "examples/demo/tsconfig.json": "{}", "examples/demo/a.ts": "export {};\n" });
          fakeLocalBin(join(root, "packages/lib"), "tsc", TSC_OK);
          assert.equal(doctor(root).get("Typecheck").state, "broken");
        });

        test("a workspace package's own fixtures are still fixtures", () => {
          const root = project({ "package.json": JSON.stringify({ workspaces: ["packages/*"] }), "packages/lib/tsconfig.json": "{}", "packages/lib/a.ts": "export {};\n", "packages/lib/fixtures/x/tsconfig.json": "{}", "packages/lib/fixtures/x/a.ts": "export {};\n" });
          fakeLocalBin(join(root, "packages/lib"), "tsc", TSC_OK);
          const g = doctor(root).get("Typecheck");
          assert.equal(g.state, "active");
          assert.match(g.detail, /left out: packages\/lib\/fixtures/);
        });

        test("a long list of left out folders is shortened", () => {
          const files = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`p${i}/fixtures/a.ts`, "export {};\n"]));
          const root = project({ ...pkg("web"), ...files });
          fakeTsc(root, "web", TSC_OK);
          const { detail } = doctor(root).get("Typecheck");
          assert.match(detail, /and 2 more/);
          assert.equal(detail.match(/p\d\/fixtures/g).length, 5);
        });

        test("ESLint's active line names what it left out", () => {
          const root = project({ "src/a.js": "1;\n", "eslint.config.js": "export default [];\n", "templates/x/a.js": "1;\n" });
          fakeLocalBin(root, "eslint", `echo '{}'`);
          const g = doctor(root).get("ESLint on edit");
          assert.equal(g.state, "active");
          assert.match(g.detail, /left out: templates/);
        });
      });

      test("in a real repo, an ignored package is left out and a tracked one is checked", () => {
        const root = gitInit(project({ ".gitignore": "gen/\n", ...pkg("web"), "gen/tsconfig.json": "{}" }));
        fakeTsc(root, "web", "exit 0");
        gitCommitAll(root);
        const g = doctor(root).get("Typecheck");
        assert.equal(g.state, "active");
        assert.doesNotMatch(g.detail, /gen/);
      });
    });
  });

  describe("eslint", () => {
    const withFile = () => project({ "src/a.js": "1;\n" });

    test("a config that loads is active", () => {
      const root = withFile();
      fakeLocalBin(root, "eslint", `echo '{}'`);
      assert.equal(doctor(root).get("ESLint on edit").state, "active");
    });

    test("a broken config is broken", () => {
      const root = withFile();
      fakeLocalBin(root, "eslint", `echo "Oops: config" >&2; exit 2`);
      const r = doctor(root);
      assert.equal(r.code, 1);
      assert.equal(r.get("ESLint on edit").state, "broken");
    });

    test("no eslint anywhere is off", () => {
      assert.equal(doctor(withFile()).get("ESLint on edit").state, "off");
    });

    for (const [name, files] of [
      ["a config", { "eslint.config.js": "export default [];\n" }],
      ["a legacy config", { ".eslintrc.json": "{}" }],
      ["a devDependency", { "package.json": JSON.stringify({ devDependencies: { eslint: "^9.0.0" } }) }],
      ["a dependency", { "package.json": JSON.stringify({ dependencies: { eslint: "^9.0.0" } }) }],
    ]) {
      test(`${name} with nothing installed is broken, not off`, () => {
        const r = doctor(project({ "src/a.js": "1;\n", ...files }));
        assert.equal(r.code, 1);
        assert.equal(r.get("ESLint on edit").state, "broken");
        assert.match(r.get("ESLint on edit").detail, /isn't installed/);
      });
    }

    describe("in a monorepo", () => {
      const fakeEslint = (root, name, body) => fakeBin(join(root, "apps", name, "node_modules", ".bin"), "eslint", body);

      test("a package's own eslint is checked", () => {
        const root = project({ "apps/web/src/a.js": "1;\n" });
        fakeEslint(root, "web", `echo '{}'`);
        const g = doctor(root).get("ESLint on edit");
        assert.equal(g.state, "active");
        assert.match(g.detail, /apps\/web\/src\/a\.js/);
      });

      test("a broken package isn't hidden by a working one", () => {
        const root = project({ "apps/web/src/a.js": "1;\n", "apps/api/src/a.js": "1;\n" });
        fakeEslint(root, "web", `echo '{}'`);
        fakeEslint(root, "api", `echo "Oops" >&2; exit 2`);
        const g = doctor(root).get("ESLint on edit");
        assert.equal(g.state, "broken");
        assert.match(g.detail, /apps\/api/);
      });

      test("a package that asks for eslint is broken even if another has it", () => {
        const root = project({ "apps/web/src/a.js": "1;\n", "apps/api/src/a.js": "1;\n", "apps/api/eslint.config.js": "export default [];\n" });
        fakeEslint(root, "web", `echo '{}'`);
        const g = doctor(root).get("ESLint on edit");
        assert.equal(g.state, "broken");
        assert.match(g.detail, /apps\/api/);
      });

      test("a project template that asks for eslint isn't broken", () => {
        const r = doctor(project({ "src/a.js": "1;\n", "templates/react/package.json": JSON.stringify({ devDependencies: { eslint: "^9.0.0" } }), "templates/react/eslint.config.js": "export default [];\n" }));
        assert.equal(r.code, 0);
        assert.equal(r.get("ESLint on edit").state, "off");
        assert.match(r.get("ESLint on edit").detail, /templates/);
      });

      // A single hoisted ESLint, and each package's own config: only the file decides which one loads.
      const onlyWebBroken = `case "$2" in *apps/web/*) echo "Oops" >&2; exit 2;; esac; echo '{}'`;

      test("a hoisted eslint checks each package's own config", () => {
        const root = project({ "apps/api/.eslintrc.json": "{}", "apps/api/src/a.js": "1;\n", "apps/web/.eslintrc.json": "{", "apps/web/src/a.js": "1;\n" });
        fakeLocalBin(root, "eslint", onlyWebBroken);
        const r = doctor(root);
        assert.equal(r.code, 1);
        assert.equal(r.get("ESLint on edit").state, "broken");
        assert.match(r.get("ESLint on edit").detail, /apps\/web/);
      });

      // ESLint 9 finds a flat config from the working folder, so only the root's can load here.
      const flatConfigFromCwd = `grep -q boom eslint.config.js && { echo "boom" >&2; exit 2; }; echo '{}'`;

      test("a hoisted flat config that's broken at the root is broken", () => {
        const root = project({ "eslint.config.js": "throw new Error('boom');\n", "apps/web/a.js": "1;\n" });
        fakeLocalBin(root, "eslint", flatConfigFromCwd);
        assert.equal(doctor(root).get("ESLint on edit").state, "broken");
      });

      test("a broken flat config in a package below a hoisted eslint can't be seen, as the skill says", () => {
        const root = project({ "eslint.config.js": "export default [];\n", "a.js": "1;\n", "apps/web/eslint.config.js": "throw new Error('boom');\n", "apps/web/a.js": "1;\n" });
        fakeLocalBin(root, "eslint", flatConfigFromCwd);
        assert.equal(doctor(root).get("ESLint on edit").state, "active");
        assert.match(readFileSync(join(PLUGIN, "skills/doctor/SKILL.md"), "utf8"), /flat config is found from the working folder/);
      });

      test("a file at the root with a config only in a package is checked as the root's", () => {
        const root = project({ "a.js": "1;\n", "apps/web/eslint.config.js": "export default [];\n", "apps/web/a.js": "1;\n" });
        fakeLocalBin(root, "eslint", `echo '{}'`);
        assert.match(doctor(root).get("ESLint on edit").detail, /a\.js, apps\/web\/a\.js|apps\/web\/a\.js, a\.js/);
      });

      test("files in different folders with no config at all are only checked once", () => {
        const root = project({ "apps/api/a.js": "1;\n", "apps/web/a.js": "1;\n" });
        fakeLocalBin(root, "eslint", `echo '{}'`);
        const g = doctor(root).get("ESLint on edit");
        assert.equal(g.state, "active");
        assert.equal(g.detail.split(",").length, 1, g.detail);
      });

      test("files sharing one config are only checked once", () => {
        const root = project({ "eslint.config.js": "export default [];\n", "apps/api/a.js": "1;\n", "apps/web/a.js": "1;\n" });
        fakeLocalBin(root, "eslint", `echo '{}'`);
        const g = doctor(root).get("ESLint on edit");
        assert.equal(g.state, "active");
        assert.equal(g.detail.split(",").length, 1, g.detail);
      });

      test("a package using a hoisted eslint isn't called missing", () => {
        const root = project({ "apps/web/src/a.js": "1;\n", "apps/web/eslint.config.js": "export default [];\n" });
        fakeLocalBin(root, "eslint", `echo '{}'`);
        assert.equal(doctor(root).get("ESLint on edit").state, "active");
      });
    });
  });

  test("a boundary config with no dependency-cruiser is broken", () => {
    const r = doctor(project({ ".dependency-cruiser.cjs": "module.exports = {};", "src/a.js": "1;\n" }));
    assert.equal(r.get("Boundary check").state, "broken");
  });

  test("the design guard lists what DESIGN.md allows", () => {
    const r = doctor(project({ "DESIGN.md": "<!-- design-guard: allow gradient, inter -->" }));
    assert.equal(r.get("Design guard").state, "active");
    assert.match(r.get("Design guard").detail, /gradient, inter/);
  });

  describe("CI gate copy", () => {
    const WORKFLOW = { ".github/workflows/audit.yml": "name: audit\n" };
    const copy = (version) => ({ "scripts/audit/collect.mjs": "", "scripts/audit/lib/project.mjs": "", ...(version ? { "scripts/audit/lib/version.mjs": `export const KIT_VERSION = "${version}";\n` } : {}) });
    // What the audit skill tells people to install: collect.mjs and lib/, exactly as shipped.
    const AUDIT = join(PLUGIN, "skills", "audit");
    const exactCopy = () => {
      const files = { "scripts/audit/collect.mjs": readFileSync(join(AUDIT, "collect.mjs"), "utf8") };
      for (const f of readdirSync(join(AUDIT, "lib"))) files[`scripts/audit/lib/${f}`] = readFileSync(join(AUDIT, "lib", f), "utf8");
      return files;
    };

    test("a current copy with a workflow is active", () => {
      const g = doctor(project({ ...exactCopy(), ...WORKFLOW })).get("CI gate copy");
      assert.equal(g.state, "active", g.detail);
    });
    test("line endings alone don't count as a change", () => {
      const crlf = Object.fromEntries(Object.entries(exactCopy()).map(([p, text]) => [p, text.replace(/\n/g, "\r\n")]));
      assert.equal(doctor(project({ ...crlf, ...WORKFLOW })).get("CI gate copy").state, "active");
    });
    test("a collector that can't even parse is broken, though its version stamp is right", () => {
      const r = doctor(project({ ...exactCopy(), "scripts/audit/collect.mjs": "garbage(", ...WORKFLOW }));
      assert.equal(r.code, 1);
      assert.equal(r.get("CI gate copy").state, "broken");
      assert.match(r.get("CI gate copy").detail, /collect\.mjs/);
    });
    for (const file of ["secrets.mjs", "exceptions.mjs"]) {
      test(`a current copy missing lib/${file} is broken`, () => {
        const { [`scripts/audit/lib/${file}`]: _gone, ...rest } = exactCopy();
        const r = doctor(project({ ...rest, ...WORKFLOW }));
        assert.equal(r.code, 1);
        assert.match(r.get("CI gate copy").detail, new RegExp(file));
      });
    }
    test("an edited lib file is broken, because the stamp no longer describes it", () => {
      const files = exactCopy();
      files["scripts/audit/lib/secrets.mjs"] += "\n// edited\n";
      const g = doctor(project({ ...files, ...WORKFLOW })).get("CI gate copy");
      assert.equal(g.state, "broken");
      assert.match(g.detail, /secrets\.mjs/);
    });
    test("an older copy whose collector imports a missing file is broken", () => {
      const r = doctor(project({ ...copy("1.3.9"), "scripts/audit/collect.mjs": `import { x } from "./lib/gone.mjs";\n`, ...WORKFLOW }));
      assert.equal(r.get("CI gate copy").state, "broken");
      assert.match(r.get("CI gate copy").detail, /gone\.mjs/);
    });
    test("a copy newer than the plugin says to update the plugin", () => {
      const g = doctor(project({ ...copy("99.0.0"), ...WORKFLOW })).get("CI gate copy");
      assert.equal(g.state, "outdated");
      assert.match(g.detail, /newer/);
      assert.match(g.detail, /update the plugin/);
    });
    test("an older copy is outdated", () => {
      const g = doctor(project({ ...copy("1.3.9"), ...WORKFLOW })).get("CI gate copy");
      assert.equal(g.state, "outdated");
      assert.match(g.detail, /1\.3\.9/);
    });
    test("a copy from before the stamp is outdated", () => {
      assert.equal(doctor(project({ ...copy(), ...WORKFLOW })).get("CI gate copy").state, "outdated");
    });
    test("a collector with no lib/ is broken", () => {
      assert.equal(doctor(project({ "scripts/audit/collect.mjs": "", ...WORKFLOW })).get("CI gate copy").state, "broken");
    });
    test("a workflow with no collector is broken", () => {
      assert.equal(doctor(project(WORKFLOW)).get("CI gate copy").state, "broken");
    });
    test("a copy nothing runs is flagged", () => {
      assert.equal(doctor(project(exactCopy())).get("CI gate copy").state, "outdated");
    });
    test("the project's copy is read, not run", () => {
      const root = project({ ...copy("1.0.0"), ...WORKFLOW });
      write(root, "scripts/audit/lib/version.mjs", `import { writeFileSync } from "node:fs"; writeFileSync("ran", "x"); export const KIT_VERSION = "1.0.0";\n`);
      doctor(root);
      assert.throws(() => readFileSync(join(root, "ran")));
    });
  });

  test("a bad exceptions file is broken", () => {
    const r = doctor(project({ ".audit-exceptions.json": "{nope" }));
    assert.equal(r.code, 1);
    assert.equal(r.get("Accepted exceptions").state, "broken");
  });

  describe("audit baseline", () => {
    test("no commit is outdated", () => {
      assert.equal(doctor(project({ "docs/audits/latest.json": JSON.stringify({ date: "2026-01-01" }) })).get("Audit baseline").state, "outdated");
    });
    test("an older rubric is outdated", () => {
      assert.equal(doctor(project({ "docs/audits/latest.json": JSON.stringify({ commit: "abc1234", rubricVersion: 1 }) })).get("Audit baseline").state, "outdated");
    });
    test("a current baseline is active", () => {
      assert.equal(doctor(project({ "docs/audits/latest.json": JSON.stringify({ date: "2026-01-01", commit: "abc1234", rubricVersion: 2 }) })).get("Audit baseline").state, "active");
    });
    test("an unreadable one is broken", () => {
      assert.equal(doctor(project({ "docs/audits/latest.json": "{nope" })).get("Audit baseline").state, "broken");
    });
  });
});
