#!/usr/bin/env node
// Deterministic evidence collector for /agent-discipline:audit.
// Runs every check that a tool can do better than a model, and writes raw outputs + a summary.
// It never modifies source files. Optional tools are skipped if unavailable (offline etc.).
//
//   node collect.mjs [projectDir] [--out .audit/raw] [--src src] [--offline] [--no-tests] [--gate]
//   --gate: exit 1 on release blockers (type errors, high/critical vulnerable deps, leaked keys,
//           tracked .env files, failing tests). Use in CI.
//
// Output: <out>/*.txt|json and <out>/summary.json (metrics the auditors and scorecard use)

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, extname, resolve } from "node:path";
import { countTypeErrors, detectPackageManager, readJsonc, runTool, runTypecheck, testCommand } from "./lib/project.mjs";

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv.splice(i, 2)[1] : d; };
const has = (n) => { const i = argv.indexOf(n); if (i >= 0) { argv.splice(i, 1); return true; } return false; };
const offline = has("--offline");
const noTests = has("--no-tests");
const gate = has("--gate");
const outArg = opt("--out");
const srcArg = opt("--src");
const root = resolve(argv[0] || ".");
const out = resolve(root, outArg || ".audit/raw");
mkdirSync(out, { recursive: true });

const summary = { generatedAt: new Date().toISOString(), root, tools: {}, metrics: {}, skipped: [] };
const bin = (n) => join(root, "node_modules", ".bin", n);
const run = (cmd, args, { timeout = 240000, cwd = root } = {}) => {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", timeout, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, FORCE_COLOR: "0", CI: "1" } });
  return { code: r.status, out: (r.stdout || "") + (r.stderr ? "\n" + r.stderr : ""), stdout: r.stdout || "", timedOut: r.error?.code === "ETIMEDOUT" };
};
const save = (name, text) => writeFileSync(join(out, name), text ?? "");
const tool = (name, fn) => {
  const t0 = Date.now();
  try {
    const res = fn() || {};
    summary.tools[name] = { ...res, ...(res.skipped ? { status: "skipped" } : {}), ms: Date.now() - t0 };
  } catch (e) { summary.tools[name] = { status: "failed", error: String(e).slice(0, 300) }; }
};
// Tools a gate can't pass without: if one of these breaks, the gate has no evidence to pass on.
const GATE_REQUIRED = ["typecheck"];
const onPath = (n) => spawnSync("sh", ["-c", `command -v ${n}`]).status === 0;
const npx = (pkg, args, o) => run("npx", ["--yes", pkg, ...args], o);

// ---------- Inventory ----------
let pkg = {};
try { pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")); } catch {}
const pm = detectPackageManager(root, pkg);
const isGit = run("git", ["rev-parse", "--is-inside-work-tree"]).code === 0;
const SRC_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte", ".py", ".go", ".rs", ".java", ".cs", ".cpp", ".hpp", ".c", ".h"]);
const IGNORE = /(^|\/)(node_modules|dist|build|out|\.next|\.nuxt|\.turbo|coverage|\.git|\.audit|vendor|target|bin|obj|\.expo|\.venv|venv|__pycache__)(\/|$)/;

let files = [];
if (isGit) {
  files = run("git", ["ls-files", "--cached", "--others", "--exclude-standard"]).stdout.split("\n").filter(Boolean);
} else {
  const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); const rel = relative(root, p); if (IGNORE.test(rel)) continue; const s = statSync(p); s.isDirectory() ? walk(p) : files.push(rel); } };
  walk(root);
}
files = files.filter((f) => !IGNORE.test(f) && existsSync(join(root, f)));
const srcFiles = files.filter((f) => SRC_EXT.has(extname(f)) && !/\.d\.ts$|\.min\.js$|generated|\.gen\./.test(f));
const isTest = (f) => /(\.|_)(test|spec)\.|__tests__|(^|\/)tests?\//.test(f);
const srcDir = srcArg || ["src", "app", "apps", "packages", "lib", "server"].find((d) => existsSync(join(root, d))) || ".";

const lineCounts = {};
let totalLines = 0;
for (const f of srcFiles) {
  try { const n = readFileSync(join(root, f), "utf8").split("\n").length; lineCounts[f] = n; totalLines += n; } catch {}
}
summary.metrics.inventory = {
  name: pkg.name, workspaces: pkg.workspaces || null, srcDir,
  sourceFiles: srcFiles.length, testFiles: srcFiles.filter(isTest).length, sourceLines: totalLines,
  testToSourceRatio: +(srcFiles.filter(isTest).length / Math.max(1, srcFiles.filter((f) => !isTest(f)).length)).toFixed(2),
  frameworks: Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter((d) => /^(next|react|vue|svelte|express|fastify|@nestjs\/core|hono|koa|prisma|drizzle-orm|typeorm|mongoose|pg|expo|react-native|vite|vitest|jest|@playwright\/test|zod|socket\.io|bullmq|redis|ioredis|@supabase\/supabase-js|firebase)$/.test(d)),
  scripts: Object.keys(pkg.scripts || {}),
  hasCI: existsSync(join(root, ".github/workflows")) || existsSync(join(root, ".gitlab-ci.yml")),
  hasDocker: files.some((f) => /(^|\/)(Dockerfile|docker-compose\.ya?ml|compose\.ya?ml)$/.test(f)),
  envFilesTracked: isGit ? run("git", ["ls-files", "*.env", ".env*", "**/.env*"]).stdout.split("\n").filter((f) => f && !/\.example$|\.sample$|\.template$/.test(f)) : [],
  claudeSetup: files.filter((f) => /(^|\/)(CLAUDE\.md|AGENTS\.md|\.claude\/(agents|skills|commands)\/.+\.md|\.claude\/settings(\.local)?\.json|\.mcp\.json)$/.test(f)),
};
save("inventory.json", JSON.stringify(summary.metrics.inventory, null, 2));

// ---------- Type safety ----------
tool("typecheck", () => {
  if (!existsSync(join(root, "tsconfig.json"))) return { skipped: "no tsconfig" };
  const r = runTypecheck(root, { timeoutMs: 240000, env: { CI: "1" } });
  if (r.status === "skipped") return { skipped: r.reason };
  save("typecheck.txt", r.output);
  const errors = countTypeErrors(r.output);
  // A non-zero script with no recognisable errors can't be scored as zero errors.
  const unreadable = r.findings && errors === 0;
  const status = unreadable ? "failed" : r.status;
  summary.metrics.typeErrors = errors > 0 ? errors : status === "ok" ? 0 : null;
  summary.metrics.tsStrict = readJsonc(join(root, "tsconfig.json"))?.compilerOptions?.strict === true;
  return { status, ...(status === "ok" ? {} : { reason: r.reason || "typecheck failed with no recognisable errors" }), code: r.code, errors };
});

// ---------- Lint ----------
tool("eslint", () => {
  if (!existsSync(bin("eslint"))) return { skipped: "eslint not installed" };
  // ESLint exits 1 for lint errors and 2 when it crashed or its config is broken.
  const r = runTool(bin("eslint"), [srcDir, "-f", "json"], { cwd: root, env: { CI: "1" }, isFindings: ({ code }) => code === 1 });
  save("eslint.json", r.stdout);
  if (r.status !== "ok") { save("eslint.txt", r.output); summary.metrics.lint = null; return { status: r.status, reason: r.reason }; }
  let errors = 0, warnings = 0, byRule = {};
  try { for (const f of JSON.parse(r.stdout)) { errors += f.errorCount; warnings += f.warningCount; for (const m of f.messages) byRule[m.ruleId || "parse"] = (byRule[m.ruleId || "parse"] || 0) + 1; } }
  catch { save("eslint.txt", r.output); summary.metrics.lint = null; return { status: "failed", reason: "unreadable ESLint output" }; }
  summary.metrics.lint = { errors, warnings, topRules: Object.entries(byRule).sort((a, b) => b[1] - a[1]).slice(0, 15) };
  return { status: "ok", errors, warnings };
});

// ---------- Architecture: boundaries + cycles ----------
tool("boundaries", () => {
  const cfg = [".dependency-cruiser.cjs", ".dependency-cruiser.js", ".dependency-cruiser.json"].find((c) => existsSync(join(root, c)));
  if (cfg) {
    const r = existsSync(bin("depcruise")) ? run(bin("depcruise"), [srcDir, "--config", cfg, "--output-type", "err"]) : offline ? null : npx("dependency-cruiser", [srcDir, "--config", cfg, "--output-type", "err"]);
    if (!r) return { skipped: "offline" };
    save("depcruise.txt", r.out);
    summary.metrics.boundaryViolations = (r.out.match(/^\s*(error|warn)\s/gm) || []).length;
    return { code: r.code, mode: "depcruise" };
  }
  if (offline || !srcFiles.some((f) => /\.(t|j)sx?$/.test(f))) return { skipped: "no depcruise config" };
  const r = npx("madge", ["--circular", "--extensions", "ts,tsx,js,jsx", "--ts-config", existsSync(join(root, "tsconfig.json")) ? "tsconfig.json" : "", srcDir].filter(Boolean));
  save("circular.txt", r.out);
  const m = r.out.match(/Found (\d+) circular/);
  summary.metrics.circularDeps = m ? +m[1] : /No circular/.test(r.out) ? 0 : null;
  return { mode: "madge", circular: summary.metrics.circularDeps };
});

// ---------- Dead code / unused deps & exports ----------
tool("knip", () => {
  if (offline || !existsSync(join(root, "package.json"))) return { skipped: offline ? "offline" : "no package.json" };
  const r = npx("knip", ["--reporter", "json", "--no-exit-code"], { timeout: 300000 });
  save("knip.json", r.stdout);
  try {
    const j = JSON.parse(r.stdout);
    const issues = j.issues || [];
    const count = (k) => issues.reduce((n, i) => n + (Array.isArray(i[k]) ? i[k].length : Object.keys(i[k] || {}).length), 0);
    summary.metrics.deadCode = { unusedFiles: (j.files || []).length, unusedExports: count("exports"), unusedTypes: count("types"), unusedDependencies: count("dependencies") + count("devDependencies"), unlistedDependencies: count("unlisted") };
  } catch { save("knip.txt", r.out); }
  return { code: r.code };
});

// ---------- Duplication (reusability) ----------
tool("duplication", () => {
  if (offline) return { skipped: "offline" };
  const dupDir = join(out, "jscpd");
  const r = npx("jscpd", [srcDir, "--silent", "--min-tokens", "60", "--reporters", "json", "--output", dupDir, "--ignore", "**/node_modules/**,**/dist/**,**/*.test.*,**/*.spec.*,**/generated/**,**/migrations/**"], { timeout: 300000 });
  try {
    const j = JSON.parse(readFileSync(join(dupDir, "jscpd-report.json"), "utf8"));
    const fix = (n) => (!existsSync(join(root, n)) && existsSync(join(root, srcDir, n)) ? join(srcDir, n) : n);
    summary.metrics.duplication = { percentage: j.statistics?.total?.percentage, clones: j.duplicates?.length,
      top: (j.duplicates || []).sort((a, b) => b.lines - a.lines).slice(0, 15).map((d) => `${d.lines} lines: ${fix(d.firstFile.name)}:${d.firstFile.start} ⇄ ${fix(d.secondFile.name)}:${d.secondFile.start}`) };
  } catch { save("jscpd.txt", r.out); }
  return { code: r.code };
});

// ---------- Dependency vulnerabilities & freshness ----------
tool("vulnerabilities", () => {
  if (offline) return { skipped: "offline" };
  if (onPath("osv-scanner")) {
    const r = run("osv-scanner", ["scan", "source", "-r", ".", "--format", "json"]);
    save("osv.json", r.stdout);
  }
  const lock = pm.lockfile;
  if (!lock) {
    const other = ["Cargo.lock", "go.sum", "poetry.lock", "uv.lock", "Pipfile.lock", "Gemfile.lock", "composer.lock", "gradle.lockfile", "packages.lock.json"].find((l) => existsSync(join(root, l)));
    if (other) return { skipped: `${other}: dependency audit not assessed (osv-scanner covers this ecosystem)` };
    return { skipped: "no lockfile (audit impossible — that itself is a finding)" };
  }
  const cmd = pm.name === "pnpm" ? ["pnpm", ["audit", "--json", "--prod"]] : pm.name === "yarn" ? ["yarn", ["npm", "audit", "--json", "--environment", "production"]] : pm.name === "npm" ? ["npm", ["audit", "--json", "--omit=dev"]] : null;
  if (!cmd) return { skipped: `${lock}: dependency audit not assessed (osv-scanner covers bun lockfiles)` };
  const r = run(...cmd);
  save("dep-audit.json", r.stdout);
  try { const v = JSON.parse(r.stdout).metadata?.vulnerabilities; if (v) summary.metrics.vulnerableDeps = v; } catch {}
  if (pm.name === "npm") {
    const o = run("npm", ["outdated", "--json"]);
    save("outdated.json", o.stdout);
    try { const j = JSON.parse(o.stdout || "{}"); summary.metrics.outdated = { total: Object.keys(j).length, majorBehind: Object.values(j).filter((d) => d.current && d.latest && d.current.split(".")[0] !== d.latest.split(".")[0]).length }; } catch {}
  }
  return { lock };
});

// ---------- Optional external scanners (used if installed) ----------
tool("semgrep", () => {
  if (offline || !onPath("semgrep")) return { skipped: "semgrep not installed (brew install semgrep for deeper SAST)" };
  // Not `--config auto`: semgrep refuses to combine it with `--metrics off`.
  const r = run("semgrep", ["scan", "--config", "p/default", "--json", "--quiet", "--metrics", "off"], { timeout: 420000 });
  save("semgrep.json", r.stdout);
  try { summary.metrics.semgrepFindings = JSON.parse(r.stdout).results.length; } catch {}
  return { code: r.code };
});
tool("gitleaks", () => {
  if (!onPath("gitleaks")) return { skipped: "gitleaks not installed (brew install gitleaks to scan git history)" };
  const r = run("gitleaks", ["detect", "--no-banner", "--redact", "--report-format", "json", "--report-path", join(out, "gitleaks.json")]);
  try { summary.metrics.secretsInHistory = JSON.parse(readFileSync(join(out, "gitleaks.json"), "utf8")).length; } catch {}
  return { code: r.code };
});

// ---------- Built-in pattern scan (no deps; always runs) ----------
const PATTERNS = [
  // security
  ["security", "hardcoded-secret", /(?:api[_-]?key|secret|token|passw(?:or)?d|private[_-]?key)\s*[:=]\s*["'`][A-Za-z0-9_\-\/+=.]{16,}["'`]/i],
  ["security", "provider-key", /\b(?:AKIA[0-9A-Z]{16}|sk_live_[0-9a-zA-Z]{20,}|ghp_[0-9A-Za-z]{30,}|xox[bap]-[0-9A-Za-z-]{20,}|AIza[0-9A-Za-z\-_]{35}|-----BEGIN (?:RSA |EC )?PRIVATE KEY-----)/],
  ["security", "sql-string-interpolation", /(?:query|execute|raw|unsafe|\$queryRawUnsafe|sql)\s*\(\s*`[^`]*\$\{/i],
  ["security", "eval", /\beval\s*\(|new Function\s*\(/],
  ["security", "dangerous-html", /dangerouslySetInnerHTML|\.innerHTML\s*=|v-html=/],
  ["security", "shell-exec", /\b(?:exec|execSync)\s*\(\s*[`'"][^`'"]*\$\{|\bexec\s*\(\s*[a-zA-Z_]+\s*\+/],
  ["security", "tls-disabled", /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED/],
  ["security", "cors-wildcard", /origin\s*:\s*(?:["']\*["']|true)\b|Access-Control-Allow-Origin["']?\s*[,:]\s*["']\*/],
  ["security", "weak-hash", /createHash\(\s*["'](?:md5|sha1)["']/],
  ["security", "insecure-random-token", /Math\.random\(\).*(?:token|secret|code|otp|password|id)|(?:token|secret|otp|code)\s*=.*Math\.random\(\)/i],
  ["security", "jwt-decode-without-verify", /jwt\.decode\s*\(/],
  ["security", "jwt-none-or-weak", /algorithms?\s*:\s*\[?\s*["']none["']/i],
  ["security", "client-exposed-secret", /(?:NEXT_PUBLIC|VITE|EXPO_PUBLIC|REACT_APP)_[A-Z_]*(?:SECRET|PRIVATE|SERVICE_ROLE|PASSWORD)/],
  ["security", "path-traversal-risk", /(?:readFile|createReadStream|sendFile|res\.download)\s*\([^)]*req\.(?:params|query|body)/],
  // reliability
  ["reliability", "empty-catch", /catch\s*(?:\([^)]*\))?\s*\{\s*\}/],
  ["reliability", "swallowed-error-log-only", /catch\s*\([^)]*\)\s*\{\s*console\.(?:log|error)\([^)]*\);?\s*\}/],
  ["reliability", "floating-promise-forEach", /\.forEach\(\s*async\b/],
  ["reliability", "fetch-call", /\bfetch\s*\(/],
  ["reliability", "abort-or-timeout", /AbortSignal\.timeout|AbortController|timeout\s*:/],
  ["reliability", "process-exit", /process\.exit\(/],
  ["reliability", "json-parse", /JSON\.parse\(/],
  // performance
  ["performance", "await-in-loop", /for\s*\([^)]*\)\s*\{[^}]*\bawait\b|for\s+(?:const|let)\s+\w+\s+of[^{]*\{[^}]*\bawait\b/],
  ["performance", "select-star", /SELECT\s+\*\s+FROM/i],
  ["performance", "sync-fs-in-server", /\b(?:readFileSync|writeFileSync|existsSync)\s*\(/],
  ["performance", "unbounded-findMany", /\.(?:findMany|find)\(\s*\)/],
  // maintainability
  ["maintainability", "any-type", /:\s*any\b|<any>|as any\b/],
  ["maintainability", "ts-suppression", /@ts-ignore|@ts-nocheck|@ts-expect-error/],
  ["maintainability", "lint-suppression", /eslint-disable/],
  ["maintainability", "design-guard-ignore", /design-guard-ignore/],
  ["maintainability", "console-log", /console\.log\(/],
  ["maintainability", "todo", /\b(?:TODO|FIXME|HACK|XXX)\b/],
];
tool("patterns", () => {
  const hits = {}; const examples = {};
  for (const f of srcFiles) {
    let text; try { text = readFileSync(join(root, f), "utf8"); } catch { continue; }
    const testFile = isTest(f);
    const lines = text.split("\n");
    for (const [cat, id, re] of PATTERNS) {
      if (testFile && cat !== "security") continue;
      // multi-line patterns (await-in-loop) scan windows; others line by line
      if (id === "await-in-loop") {
        const m = text.match(new RegExp(re.source, "g")); if (!m) continue;
        hits[id] = (hits[id] || 0) + m.length; (examples[id] ||= []).length < 12 && examples[id].push(`${f}`);
        continue;
      }
      lines.forEach((l, i) => {
        if (re.test(l)) { hits[id] = (hits[id] || 0) + 1; const ex = (examples[id] ||= []); if (ex.length < 12) ex.push(`${f}:${i + 1}  ${l.trim().slice(0, 160)}`); }
      });
    }
  }
  const byCat = {};
  for (const [cat, id] of PATTERNS) if (hits[id]) (byCat[cat] ||= {})[id] = hits[id];
  summary.metrics.patterns = byCat;
  save("patterns.txt", Object.entries(examples).map(([id, ex]) => `## ${id} (${hits[id]} hits)\n${ex.join("\n")}`).join("\n\n"));
  return { categories: Object.keys(byCat).length };
});

// ---------- Size & churn hotspots ----------
tool("hotspots", () => {
  const big = Object.entries(lineCounts).filter(([f]) => !isTest(f)).sort((a, b) => b[1] - a[1]);
  summary.metrics.largeFiles = { over400: big.filter(([, n]) => n > 400).length, over800: big.filter(([, n]) => n > 800).length, top: big.slice(0, 12).map(([f, n]) => `${n}  ${f}`) };
  if (!isGit) return { skipped: "not a git repo" };
  const log = run("git", ["log", "--since=6 months ago", "--name-only", "--format="]).stdout.split("\n").filter(Boolean);
  const churn = {}; for (const f of log) if (lineCounts[f]) churn[f] = (churn[f] || 0) + 1;
  const hot = Object.entries(churn).map(([f, c]) => [f, c, lineCounts[f], c * lineCounts[f]]).sort((a, b) => b[3] - a[3]).slice(0, 15);
  summary.metrics.hotspots = hot.map(([f, c, n]) => `${c} commits × ${n} lines  ${f}`);
  save("hotspots.txt", summary.metrics.hotspots.join("\n"));
  const commits = run("git", ["rev-list", "--count", "HEAD"]).stdout.trim();
  summary.metrics.git = { commits: +commits || 0, uncommittedFiles: run("git", ["status", "--porcelain"]).stdout.split("\n").filter(Boolean).length };
  return { hot: hot.length };
});

// ---------- Tests ----------
tool("tests", () => {
  if (!pkg.scripts?.test || /no test specified/.test(pkg.scripts.test)) { summary.metrics.tests = { configured: false }; return { skipped: "no test script" }; }
  if (noTests) return { skipped: "--no-tests" };
  const r = run(...testCommand(pm.name, /vitest/.test(pkg.scripts.test) ? ["--run"] : []), { timeout: 420000 });
  save("tests.txt", r.out.slice(-20000));
  const passed = r.out.match(/(\d+)\s+(?:passed|passing)/i), failed = r.out.match(/(\d+)\s+(?:failed|failing)/i);
  summary.metrics.tests = { configured: true, exitCode: r.code, timedOut: r.timedOut, passed: passed ? +passed[1] : null, failed: failed ? +failed[1] : null };
  return { code: r.code };
});

summary.skipped = Object.entries(summary.tools).filter(([, v]) => v.skipped).map(([k, v]) => `${k}: ${v.skipped}`);
save("summary.json", JSON.stringify(summary, null, 2));
console.log(`Audit evidence written to ${relative(root, out) || out}`);
console.log(JSON.stringify(summary.metrics, null, 1).slice(0, 6000));
if (summary.skipped.length) console.log("\nSkipped:\n  " + summary.skipped.join("\n  "));
const broken = Object.entries(summary.tools).filter(([, v]) => v.status === "failed" || v.status === "timed-out");
if (broken.length) console.log("\nDid not finish (not assessed):\n  " + broken.map(([k, v]) => `${k}: ${v.reason || v.error || v.status}`).join("\n  "));

if (gate) {
  const m = summary.metrics, blockers = [];
  for (const [name, v] of broken) if (GATE_REQUIRED.includes(name)) blockers.push(`${name} did not finish: ${v.reason || v.error || v.status}`);
  if (m.typeErrors > 0) blockers.push(`${m.typeErrors} type errors`);
  if ((m.vulnerableDeps?.high || 0) + (m.vulnerableDeps?.critical || 0) > 0) blockers.push(`high/critical vulnerable dependencies`);
  const sec = m.patterns?.security || {};
  if (sec["provider-key"] || sec["hardcoded-secret"]) blockers.push(`possible hardcoded secrets`);
  if (m.inventory.envFilesTracked.length) blockers.push(`.env files tracked in git: ${m.inventory.envFilesTracked.join(", ")}`);
  if (m.tests?.configured && m.tests.exitCode !== 0) blockers.push(`tests failing`);
  if (m.secretsInHistory > 0) blockers.push(`${m.secretsInHistory} secrets in git history`);
  if (blockers.length) { console.error("\nGATE FAILED:\n  - " + blockers.join("\n  - ")); process.exit(1); }
  console.log("\nGATE PASSED");
}
