#!/usr/bin/env node
// Shows which guards really work in this project, by running them rather than looking for config.
//
//   node doctor.mjs [projectDir] [--json]
//
// Each guard is one of:
//   active   it runs and works
//   off      it doesn't apply here, and the reason says why
//   broken   it should run but can't, so it isn't protecting anything
//   outdated a different version from this plugin, or nothing uses it yet
// Exit codes: 0 nothing broken, 1 at least one guard broken.
//
// Guards are found the way the hooks find them, per file, so a monorepo's packages count.

import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadExceptions, loadRisks } from "../audit/lib/exceptions.mjs";
import { ESLINT_FILE, TS_FILE, countTypeErrors, findBoundaryConfig, findLocalBin, readPackageJson, runBoundaryCheck, runTool, scanProject } from "../audit/lib/project.mjs";
import { KIT_VERSION } from "../audit/lib/version.mjs";
import { checksFor } from "../../scripts/checks.mjs";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const root = resolve(args.find((a) => !a.startsWith("--")) || ".");
const plugin = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const rules = JSON.parse(readFileSync(join(plugin, "skills", "audit", "rules.json"), "utf8"));

const active = (detail) => ({ state: "active", detail });
const off = (detail) => ({ state: "off", detail });
const broken = (detail) => ({ state: "broken", detail });
const outdated = (detail) => ({ state: "outdated", detail });
const onPath = (name) => spawnSync("sh", ["-c", `command -v ${name}`]).status === 0;

const guardsOff = existsSync(join(root, ".claude", "guards-off"));
const hook = (fn) => () => (guardsOff ? off(".claude/guards-off is set") : fn());

function hookFiles() {
  const { hooks } = JSON.parse(readFileSync(join(plugin, "hooks", "hooks.json"), "utf8"));
  const scripts = new Set(), unreadable = [];
  for (const [event, groups] of Object.entries(hooks || {})) {
    for (const hook of groups.flatMap((g) => g.hooks || [])) {
      const found = [...String(hook.command).matchAll(/\$\{?CLAUDE_PLUGIN_ROOT\}?"?\/([\w./-]+)/g)].map((m) => m[1]);
      if (!found.some((s) => !s.endsWith("run-node.sh"))) unreadable.push(event); // the launcher alone runs nothing
      for (const script of found) scripts.add(script);
    }
  }
  // Finding nothing means this check stopped understanding hooks.json. It proves nothing about them.
  if (unreadable.length) return broken(`no plugin script found in the ${[...new Set(unreadable)].join(", ")} hook command`);
  if (!scripts.size) return broken("hooks.json declares no hooks");
  const missing = [...scripts].filter((s) => !existsSync(join(plugin, s)));
  if (missing.length) return broken(`missing: ${missing.join(", ")}`);
  accessSync(join(plugin, "scripts", "run-node.sh"), constants.X_OK);
  return active(`${scripts.size} scripts present; run /hooks to confirm Claude Code loaded them`);
}

function sessionState() {
  // Stop checks rely on edits recorded here. If this can't be written, they never run.
  const dir = mkdtempSync(join(tmpdir(), "agent-discipline-doctor-"));
  rmSync(dir, { recursive: true, force: true });
  return active(`temp folder is writable (${tmpdir()})`);
}

// Fixtures and templates often hold configs with nothing installed on purpose, which isn't a broken guard.
const NOT_PACKAGES = /(^|\/)(__fixtures__|fixtures|templates|examples)\//;
const LEFT_OUT = "fixtures, templates and examples aren't checked";

// What the project declares as a package is one, whatever its folder is called.
function workspaceGlobs() {
  const { workspaces } = readPackageJson(root);
  const globs = Array.isArray(workspaces) ? [...workspaces] : [...(workspaces?.packages ?? [])];
  let inList = false;
  let yaml = "";
  try { yaml = readFileSync(join(root, "pnpm-workspace.yaml"), "utf8"); } catch {}
  for (const line of yaml.split("\n")) {
    if (/^packages:\s*$/.test(line)) { inList = true; continue; }
    if (!inList || /^\s*(#.*)?$/.test(line)) continue;
    const item = /^\s*-\s*["']?([^"'#\s]+)/.exec(line);
    if (!item) break;
    globs.push(item[1]);
  }
  return globs.filter((g) => typeof g === "string" && !g.startsWith("!")).map((glob) => new RegExp(`^(${glob
    .replace(/^\.\//, "").replace(/\/+$/, "")
    .replace(/[.+^${}()|[\]\\?]/g, "\\$&")
    .replace(/\*\*|\*/g, (m) => (m === "**" ? ".*" : "[^/]+"))})(?:/|$)`));
}

const scope = (() => {
  let cached;
  return () => {
    if (cached) return cached;
    const all = scanProject(root).files, globs = workspaceGlobs();
    // A workspace package's own fixtures are still fixtures, so only the path inside the package counts.
    const declared = (f) => globs.some((g) => {
      const m = g.exec(f);
      return m && !NOT_PACKAGES.test(f.slice(m[1].length + 1));
    });
    const isLeftOut = (f) => NOT_PACKAGES.test(f) && !declared(f);
    return (cached = { files: all.filter((f) => !isLeftOut(f)), leftOut: all.filter(isLeftOut) });
  };
})();
const projectFiles = () => scope().files;

// Named on every line, because a working package would otherwise hide one that was never run.
function leftOutNote(relevant) {
  const folders = [...new Set(scope().leftOut.filter((f) => relevant.test(f)).map((f) => /^(?:.*?\/)?(?:__fixtures__|fixtures|templates|examples)(?=\/)/.exec(f)[0]))];
  if (!folders.length) return "";
  return `; left out: ${folders.slice(0, 5).join(", ")}${folders.length > 5 ? ` and ${folders.length - 5} more` : ""}`;
}
const TS_RELEVANT = new RegExp(`${TS_FILE.source}|(^|/)tsconfig[^/]*\\.json$`);

function typecheck() {
  // The same checks Stop would run if every file had been edited, one per package.
  const checks = checksFor(root, projectFiles()).filter((c) => c.id.startsWith("typecheck:"));
  const note = leftOutNote(TS_RELEVANT);
  if (!checks.length) return off(`no tsconfig.json covers this project's files (${LEFT_OUT})${note}`);
  const outcomes = checks.map((check) => {
    const where = check.id.slice("typecheck:".length);
    const at = where ? `${where}: ` : "";
    const r = check.run(170000);
    if (r.status !== "ok") return { problem: `${at}${r.reason || r.status}` };
    if (!r.findings) return { detail: `${at}runs, no type errors` };
    // A failing script with no recognisable errors crashed. It didn't find anything.
    return countTypeErrors(r.output) ? { detail: `${at}runs, and reports type errors right now` } : { problem: `${at}the typecheck failed with no recognisable errors` };
  });
  const problems = outcomes.filter((o) => o.problem);
  return problems.length ? broken(problems.map((o) => o.problem).join("; ") + note) : active(outcomes.map((o) => o.detail).join("; ") + note);
}

const ESLINT_CONFIG = /(^|\/)(eslint\.config\.[cm]?[jt]s|\.eslintrc(\.\w+)?)$/;
const declaresEslint = (dir) => {
  const { dependencies, devDependencies } = readPackageJson(dir);
  return Boolean(dependencies?.eslint || devDependencies?.eslint);
};

function eslint() {
  const files = projectFiles();
  const lintable = files.filter((f) => ESLINT_FILE.test(f));
  const note = leftOutNote(new RegExp(`${ESLINT_FILE.source}|${ESLINT_CONFIG.source}`, "i"));
  if (!lintable.length) return off(`no JavaScript or TypeScript files to lint${note}`);
  const binFor = (file) => findLocalBin("eslint", dirname(join(root, file)), root);

  // Asked for but not installed means edits go unlinted, which is broken and not "doesn't apply".
  const asking = files.filter((f) => ESLINT_CONFIG.test(f) || (basename(f) === "package.json" && declaresEslint(dirname(join(root, f)))));
  const uninstalled = asking.filter((f) => !binFor(f));
  if (uninstalled.length) return broken(`${uninstalled.join(", ")} asks for ESLint, but it isn't installed`);

  // One file per ESLint and config, since one hoisted ESLint can load a different config per package.
  const configDirs = new Set(files.filter((f) => ESLINT_CONFIG.test(f)).map((f) => dirname(f)));
  const configDirFor = (file) => {
    for (let dir = dirname(file); ; dir = dirname(dir)) {
      if (configDirs.has(dir)) return dir;
      if (dir === ".") return "";
    }
  };
  const samples = new Map();
  for (const file of lintable) {
    const local = binFor(file);
    const key = local && `${local.bin}|${configDirFor(file)}`;
    if (local && !samples.has(key)) samples.set(key, { ...local, file });
  }
  if (!samples.size) return off(`eslint not installed in this project (${LEFT_OUT})${note}`);
  const checked = [...samples.values()];
  // Fails on a broken config, which is the failure that used to pass silently.
  const problems = checked.flatMap(({ bin, dir, file }) => {
    const r = runTool(bin, ["--print-config", join(root, file)], { cwd: dir, timeout: 60000 });
    return r.status === "ok" ? [] : [`${file}: ${r.reason || r.status}`];
  });
  return problems.length ? broken(problems.join("; ") + note) : active(`config loads (checked with ${checked.map((s) => s.file).join(", ")})${note}`);
}

function boundaries() {
  const config = findBoundaryConfig(root);
  if (!config) return off("no .dependency-cruiser config");
  const r = runBoundaryCheck(root);
  if (r.status === "ok") return active(r.findings ? "runs, and reports violations right now" : "runs, no violations");
  // The config asks for this check, so a missing tool is broken here, not "doesn't apply".
  return broken(`${config} exists, but: ${r.reason || r.status}`);
}

function designGuard() {
  const path = join(root, "DESIGN.md");
  if (!existsSync(path)) return off("no DESIGN.md");
  const allowed = [...readFileSync(path, "utf8").matchAll(/<!--\s*design-guard:\s*allow\s+([^>]*?)\s*-->/gi)].flatMap((m) => m[1].split(/[\s,]+/).filter(Boolean));
  return active(allowed.length ? `allows: ${allowed.join(", ")}` : "all rules on");
}

function ciGate() {
  const collector = join(root, "scripts", "audit", "collect.mjs");
  const workflow = join(root, ".github", "workflows", "audit.yml");
  if (!existsSync(collector)) return existsSync(workflow) ? broken("audit.yml exists but scripts/audit/collect.mjs doesn't") : off("not installed");
  const dest = join(root, "scripts", "audit");
  const lib = join(dest, "lib");
  if (!existsSync(join(lib, "project.mjs"))) return broken("scripts/audit/collect.mjs has no lib/ beside it");
  const AGAIN = "copy collect.mjs and lib/ again";

  // Everything here is read, not imported: it's code from the project, and a diagnostic mustn't run it.
  const unresolved = [...readFileSync(collector, "utf8").matchAll(/from "\.\/(lib\/[^"]+)"/g)].map((m) => m[1]).filter((f) => !existsSync(join(dest, f)));
  if (unresolved.length) return broken(`collect.mjs imports ${unresolved.join(", ")}, which is missing: ${AGAIN}`);

  let copy = null;
  try { copy = /KIT_VERSION = "([^"]+)"/.exec(readFileSync(join(lib, "version.mjs"), "utf8"))?.[1] ?? null; } catch {}
  if (copy && isNewer(copy, KIT_VERSION)) return outdated(`copy is ${copy}, newer than this plugin's ${KIT_VERSION}: update the plugin`);
  if (copy !== KIT_VERSION) return outdated(`copy is ${copy || "older than 1.4.0"}, plugin is ${KIT_VERSION}: ${AGAIN}`);

  // The stamp only says what was copied. The same version has to mean the same files.
  const source = join(plugin, "skills", "audit");
  const expected = ["collect.mjs", ...readdirSync(join(source, "lib")).filter((f) => f.endsWith(".mjs")).map((f) => `lib/${f}`)];
  const missing = expected.filter((f) => !existsSync(join(dest, f)));
  if (missing.length) return broken(`missing ${missing.join(", ")}: ${AGAIN}`);
  const text = (path) => readFileSync(path, "utf8").replace(/\r\n/g, "\n"); // git may have changed line endings
  const changed = expected.filter((f) => text(join(dest, f)) !== text(join(source, f)));
  if (changed.length) return broken(`${changed.join(", ")} differs from version ${copy} of the plugin, so the gate can't be trusted to run: ${AGAIN}`);

  if (!existsSync(workflow)) return outdated("the collector is copied, but .github/workflows/audit.yml is missing, so nothing runs it");
  return active(`version ${copy}`);
}

function isNewer(a, b) {
  const [x, y] = [a, b].map((v) => v.split(".").map(Number));
  const i = x.findIndex((n, j) => n !== y[j]);
  return i >= 0 && x[i] > y[i];
}

function exceptionsFile() {
  if (!existsSync(join(root, ".audit-exceptions.json"))) return off("no .audit-exceptions.json");
  const allRules = Object.values(rules.rules).flatMap((r) => Object.keys(r));
  const secrets = loadExceptions(root), risks = loadRisks(root, allRules);
  const problems = [...secrets.problems, ...risks.problems];
  if (problems.length) return broken(problems.join("; "));
  const expired = [...secrets.expired, ...risks.expired];
  return active(`${secrets.active.length + risks.active.length} active${expired.length ? `, ${expired.length} expired and no longer applied` : ""}`);
}

function baseline() {
  const path = join(root, "docs", "audits", "latest.json");
  if (!existsSync(path)) return off("no audit yet");
  let base;
  try { base = JSON.parse(readFileSync(path, "utf8")); } catch { return broken("docs/audits/latest.json isn't valid JSON"); }
  if (!base.commit) return outdated("no commit recorded, so --since-last needs a full audit first");
  if (base.rubricVersion !== rules.rubricVersion) return outdated(`rubric ${base.rubricVersion ?? 1}, plugin is on ${rules.rubricVersion}: the next score won't be comparable`);
  return active(`${base.date}, commit ${String(base.commit).slice(0, 8)}`);
}

const scanner = (name, why) => () => (onPath(name) ? active("installed") : off(`not installed (${why})`));

const CHECKS = [
  ["Hook scripts", hookFiles],
  ["Session state", hook(sessionState)],
  ["Typecheck", hook(typecheck)],
  ["ESLint on edit", hook(eslint)],
  ["Boundary check", hook(boundaries)],
  ["Design guard", hook(designGuard)],
  ["CI gate copy", ciGate],
  ["Accepted exceptions", exceptionsFile],
  ["Audit baseline", baseline],
  ["gitleaks", scanner("gitleaks", "audits can't scan git history")],
  ["semgrep", scanner("semgrep", "audits have no deeper code scan")],
  ["osv-scanner", scanner("osv-scanner", "audits can't check bun or non-JS lockfiles")],
];

// Every guard would read as "off" in a folder that isn't there, which looks like a healthy project.
const isFolder = () => { try { return statSync(root).isDirectory(); } catch { return false; } };

const results = !isFolder()
  ? [{ name: "Project folder", ...broken(`${root} isn't a folder`) }]
  : CHECKS.map(([name, check]) => {
    try { return { name, ...check() }; }
    catch (e) { return { name, ...broken(String(e.message || e).slice(0, 200)) }; } // a check that crashed proves nothing
  });

if (asJson) console.log(JSON.stringify({ version: KIT_VERSION, root, results }, null, 2));
else {
  console.log(`agent-discipline ${KIT_VERSION} in ${root}\n`);
  for (const r of results) console.log(`${r.state.padEnd(9)} ${r.name.padEnd(20)} ${r.detail}`);
}
process.exit(results.some((r) => r.state === "broken") ? 1 : 0);
