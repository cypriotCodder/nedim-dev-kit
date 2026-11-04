// Shared project detection and tool running, used by the hooks and by collect.mjs.
// Lives next to collect.mjs because that script is copied into projects for the CI gate:
// copying skills/audit/collect.mjs and skills/audit/lib/ keeps this import working.
// Node built-ins only.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

export const readPackageJson = (dir) => {
  try { return JSON.parse(readFileSync(join(dir, "package.json"), "utf8")); } catch { return {}; }
};

// ---------- Running tools ----------
// status: "ok"        the tool ran to completion (it may have found problems: see `findings`)
//         "failed"    it crashed or could not start, so it says nothing about the code
//         "timed-out" it was stopped before finishing
// `isFindings(result)` tells a non-zero exit that means "found problems" from one that means "broke".
// `baseEnv` replaces the inherited environment, for tools that shouldn't see all of it.
export function runTool(cmd, args, { cwd, timeout = 240000, env, baseEnv = process.env, isFindings = () => false } = {}) {
  const r = spawnSync(cmd, args, {
    cwd, timeout, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
    env: { ...baseEnv, FORCE_COLOR: "0", ...env },
  });
  const stdout = r.stdout || "", stderr = r.stderr || "";
  const result = { code: r.status, stdout, stderr, output: [stdout, stderr].filter(Boolean).join("\n"), findings: false };
  if (r.error?.code === "ETIMEDOUT") return { ...result, status: "timed-out", reason: `no result after ${Math.round(timeout / 1000)}s` };
  if (r.error) return { ...result, status: "failed", reason: r.error.code || r.error.message };
  if (r.status === null) return { ...result, status: "failed", reason: `killed by ${r.signal}` };
  if (r.status === 0) return { ...result, status: "ok" };
  if (isFindings(result)) return { ...result, status: "ok", findings: true };
  return { ...result, status: "failed", reason: `exit code ${r.status}` };
}

// ---------- Project files ----------
const IGNORED_PATH = /(^|\/)(node_modules|dist|build|out|\.next|\.nuxt|\.turbo|coverage|\.git|\.audit|vendor|target|bin|obj|\.expo|\.venv|venv|__pycache__)(\/|$)/;
const JS_FILE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|vue|svelte)$/;
const TS_FILE = /\.(ts|tsx|mts|cts)$/;

function walk(root, unreadable, dir = "") {
  let entries;
  try { entries = readdirSync(join(root, dir), { withFileTypes: true }); }
  catch { unreadable.push(dir || "."); return []; }
  return entries.flatMap((entry) => {
    const rel = dir ? `${dir}/${entry.name}` : entry.name;
    if (IGNORED_PATH.test(rel)) return [];
    return entry.isDirectory() ? walk(root, unreadable, rel) : entry.isFile() ? [rel] : [];
  });
}

// "Not a repo" is a fact about the project. "Git failed" (dubious ownership in a CI container, say)
// means nothing is known about what's tracked, and must not look the same.
function gitState(root) {
  const r = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: root, encoding: "utf8" });
  if (r.status === 0) return { state: "ok" };
  if (r.status === 128 && /not a git repository/i.test(r.stderr)) return { state: "none" };
  if (r.error?.code === "ENOENT" && !existsSync(join(root, ".git"))) return { state: "none" };
  return { state: "failed", reason: (r.stderr || r.error?.message || `exit code ${r.status}`).trim().split("\n")[0] };
}

// files:      project-relative paths of the project's own regular files, for scoping code metrics
// tracked:    every regular file in git, wherever it is: a key in a tracked bin/ or vendor/ is a leak
// unreadable: paths that exist but couldn't be checked, so nobody can call them clean
// `-z` matters: without it git quotes non-ASCII names, which then don't exist on disk.
export function scanProject(root) {
  let git = gitState(root);
  const unreadable = [];
  if (git.state === "ok") {
    const ls = (...args) => spawnSync("git", ["ls-files", "-z", ...args], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const cached = ls("--cached"), others = ls("--others", "--exclude-standard");
    if (cached.status === 0 && others.status === 0) {
      const regular = (f) => {
        try { return statSync(join(root, f)).isFile(); } // false for submodules, which git lists
        catch (e) {
          if (e.code !== "ENOENT" && e.code !== "ENOTDIR") unreadable.push(f); // deleted is fine, blocked isn't
          return false;
        }
      };
      const tracked = [...new Set(cached.stdout.split("\0"))].filter((f) => f && regular(f));
      const untracked = [...new Set(others.stdout.split("\0"))].filter((f) => f && !IGNORED_PATH.test(f) && regular(f));
      return { git, tracked, unreadable, files: [...new Set([...tracked.filter((f) => !IGNORED_PATH.test(f)), ...untracked])] };
    }
    git = { state: "failed", reason: "git ls-files failed" };
  }
  return { git, tracked: [], files: walk(root, unreadable), unreadable };
}

// What to point a JS tool at: each top-level folder holding code, and code files at the top level.
// Not a fixed list of folder names, which misses `components/` beside `app/`.
// Not `.`, which would send the tools through build output and other ignored folders.
export function sourceRoots(files) {
  const roots = new Set();
  for (const file of files) {
    if (!JS_FILE.test(file) || /(^|\/)\./.test(file)) continue;
    roots.add(file.split("/")[0]);
  }
  return roots.size ? [...roots] : ["."];
}

// The same, without top-level files if there are any folders. A vite.config.js beside src/ would
// otherwise give dependency-cruiser one module to count, hiding that it read nothing in src/.
function boundaryRoots(files) {
  const roots = sourceRoots(files);
  const folders = roots.filter((r) => files.some((f) => f.startsWith(`${r}/`)));
  return folders.length ? folders : roots;
}

// ---------- Package manager ----------
const LOCKFILES = [
  ["pnpm-lock.yaml", "pnpm"],
  ["yarn.lock", "yarn"],
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["package-lock.json", "npm"],
  ["npm-shrinkwrap.json", "npm"],
];

// The package.json "packageManager" field wins, then the lockfile, then npm.
export function detectPackageManager(root, pkg = readPackageJson(root)) {
  const lockfile = LOCKFILES.find(([file]) => existsSync(join(root, file)));
  const declared = /^(npm|pnpm|yarn|bun)@/.exec(pkg.packageManager || "")?.[1];
  return { name: declared || lockfile?.[1] || "npm", lockfile: lockfile?.[0] || null };
}

export function scriptCommand(pm, script) {
  if (pm === "pnpm") return ["pnpm", ["--silent", "run", script]];
  if (pm === "yarn") return ["yarn", ["run", script]];
  if (pm === "bun") return ["bun", ["run", "--silent", script]];
  return ["npm", ["run", "-s", script]];
}

export function testCommand(pm, extraArgs = []) {
  if (pm === "npm") return ["npm", ["test", "--silent", ...(extraArgs.length ? ["--", ...extraArgs] : [])]];
  if (pm === "bun") return ["bun", ["run", "test", ...extraArgs]]; // plain `bun test` skips the script
  return [pm, ["test", ...extraArgs]];
}

// ---------- Local binaries ----------
// Nearest node_modules/.bin/<name> from `start` up to `root`, so packages in a monorepo use their own.
export function findLocalBin(name, start, root) {
  const top = resolve(root);
  let dir = resolve(start);
  if (relative(top, dir).startsWith("..")) dir = top;
  for (;;) {
    const bin = join(dir, "node_modules", ".bin", name);
    if (existsSync(bin)) return { bin, dir };
    if (dir === top) return null;
    dir = dirname(dir);
  }
}

// ---------- tsconfig ----------
// tsconfig files are JSON with comments and trailing commas. Returns null if unreadable.
export function readJsonc(path) {
  let text;
  try { text = readFileSync(path, "utf8"); } catch { return null; }
  const stripped = text.replace(/"(?:[^"\\]|\\.)*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m) => (m[0] === '"' ? m : ""));
  const noTrailingCommas = stripped.replace(/"(?:[^"\\]|\\.)*"|,(\s*[}\]])/g, (m, close) => (m[0] === '"' ? m : close));
  try { return JSON.parse(noTrailingCommas); } catch { return null; }
}

const resolveReference = (fromConfig, refPath) => {
  const target = resolve(dirname(fromConfig), refPath);
  try { if (statSync(target).isDirectory()) return join(target, "tsconfig.json"); } catch {}
  return target.endsWith(".json") || existsSync(target) ? target : `${target}.json`;
};

// Every config a project-references setup is made of. Returns null when `tsconfig.json`
// doesn't use references, in which case plain `tsc --noEmit` is correct.
export function referencedConfigs(root) {
  const start = join(root, "tsconfig.json");
  if (!readJsonc(start)?.references?.length) return null;
  const configs = new Set(), seen = new Set();
  const visit = (path) => {
    if (seen.has(path)) return;
    seen.add(path);
    const config = readJsonc(path);
    if (!config) { configs.add(path); return; } // let tsc report the broken file
    const isSolutionOnly = Array.isArray(config.files) && config.files.length === 0 && !config.include;
    if (!isSolutionOnly) configs.add(path);
    for (const ref of config.references || []) visit(resolveReference(path, ref.path));
  };
  visit(start);
  return [...configs];
}

// ---------- Typecheck ----------
const hasTypeErrors = (r) => /error TS\d+/.test(r.output);
const WORST_FIRST = ["timed-out", "failed", "ok"];

// A script that is exactly this adds nothing, and it checks nothing on a references setup.
const isPlainTscScript = (script) => /^\s*tsc\s+--noEmit\s*$/.test(script || "");

// Typechecks without writing anything to the project.
//
// On a references setup, plain `tsc --noEmit` checks nothing, `tsc -p x --noEmit` reports TS6305
// until references are built, `tsc -b --noEmit` is rejected or reports TS6310 depending on the
// version, and `tsc -b` writes build output. So each config is checked through a temporary one
// that drops `references` and resolves imports to source.
//
// `top` is the project root when `root` is a package inside a monorepo: tsc is usually hoisted there.
export function runTypecheck(root, { top = root, timeoutMs = 170000, env } = {}) {
  const pkg = readPackageJson(root);
  const script = pkg.scripts?.typecheck;
  const refs = referencedConfigs(root);

  if (script && !(isPlainTscScript(script) && refs)) {
    const [cmd, args] = scriptCommand(detectPackageManager(root, pkg).name, "typecheck");
    return runTool(cmd, args, { cwd: root, timeout: timeoutMs, env, isFindings: () => true });
  }

  const local = findLocalBin("tsc", root, top);
  if (!local) return { status: "skipped", reason: "typescript not installed", output: "", findings: false };

  const tool = (args, timeout) => runTool(local.bin, ["--noEmit", "--pretty", "false", ...args], { cwd: root, timeout, env, isFindings: hasTypeErrors });
  if (!refs) return tool([], timeoutMs);

  // Inside node_modules: ignored by git, and @types are still found by walking up from here.
  const tmp = join(local.dir, "node_modules", ".cache", "agent-discipline", `tsc-${process.pid}`);
  const deadline = Date.now() + timeoutMs;
  const results = [];
  try {
    mkdirSync(tmp, { recursive: true });
    for (const [i, config] of refs.entries()) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) { results.push({ status: "timed-out", reason: `no result after ${Math.round(timeoutMs / 1000)}s`, output: "", findings: false }); break; }
      const flat = join(tmp, `tsconfig.${i}.json`);
      writeFileSync(flat, JSON.stringify({
        extends: config,
        references: [],
        compilerOptions: {
          rootDir: resolve(top), // sources from referenced projects are now part of this program
          composite: false, incremental: false, tsBuildInfoFile: null,
          emitDeclarationOnly: false, declarationMap: false,
        },
      }));
      results.push(tool(["-p", flat], remaining));
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  const worst = WORST_FIRST.find((s) => results.some((r) => r.status === s));
  const unique = [...new Set(results.flatMap((r) => r.output.split("\n")).filter(Boolean))];
  const bad = results.find((r) => r.status === worst);
  return { status: worst, reason: bad.reason, code: bad.code, output: unique.join("\n"), findings: results.some((r) => r.findings) };
}

export const countTypeErrors = (output) => (output.match(/error TS\d+/g) || []).length;

// The folders to typecheck for a set of project-relative files. A root `typecheck` script or a
// references setup already covers everything; otherwise each file's nearest tsconfig decides.
export function typecheckDirs(root, files) {
  if (!files.length) return [];
  if (readPackageJson(root).scripts?.typecheck || referencedConfigs(root)) return [resolve(root)];
  const top = resolve(root);
  const dirs = new Set();
  for (const file of files) {
    let dir = dirname(resolve(top, file));
    if (relative(top, dir).startsWith("..")) continue;
    for (;;) {
      if (existsSync(join(dir, "tsconfig.json"))) { dirs.add(dir); break; }
      if (dir === top) break;
      dir = dirname(dir);
    }
  }
  return [...dirs];
}

// ---------- Boundary rules ----------
const BOUNDARY_CONFIGS = [".dependency-cruiser.cjs", ".dependency-cruiser.mjs", ".dependency-cruiser.js", ".dependency-cruiser.json"];
export const findBoundaryConfig = (root) => BOUNDARY_CONFIGS.find((c) => existsSync(join(root, c))) || null;

// dependency-cruiser exits 1 for violations and for a broken config, so only the output tells them
// apart: violations print as `  error rule: a → b`, crashes as `  ERROR: message`.
// It also exits 0 after checking nothing, for example on .ts files when it can't load TypeScript.
// `runner` runs dependency-cruiser some other way when it isn't installed in the project.
// Without TypeScript beside it, it drops .ts files and reports success, with nothing in its output to
// show that. A copy run through npx never finds the project's TypeScript, so both cases stop here.
export function runBoundaryCheck(root, { timeoutMs = 120000, files = scanProject(root).files, dirs = boundaryRoots(files), runner } = {}) {
  const local = findLocalBin("depcruise", root, root);
  const run = local ? (args, options) => runTool(local.bin, args, options) : runner;
  if (!run) return { status: "skipped", reason: "dependency-cruiser not installed", output: "", findings: false };
  const inScope = (f) => dirs.some((d) => d === "." || f === d || f.startsWith(`${d}/`));
  if ((!local || !findLocalBin("tsc", root, root)) && files.some((f) => TS_FILE.test(f) && inScope(f))) {
    return { status: "failed", reason: "it can't read .ts files without dependency-cruiser and typescript installed in the project", output: "", findings: false };
  }
  const r = run([...dirs, "--config", findBoundaryConfig(root), "--output-type", "err"], {
    cwd: root, timeout: timeoutMs, isFindings: ({ output }) => /^\s*error \S+:/m.test(output),
  });
  if (r.status === "ok" && /\b0 modules\b/.test(r.output)) return { ...r, status: "failed", reason: `it checked 0 modules in ${dirs.join(", ")}` };
  return r;
}

// ---------- Reporting from a hook ----------
// Shown to the user without blocking Claude: a broken tool isn't something Claude caused or should chase.
export function warnUser(message) {
  process.stdout.write(JSON.stringify({ systemMessage: message }) + "\n");
}
