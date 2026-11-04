#!/usr/bin/env node
// Deterministic evidence collector for /agent-discipline:audit.
// Runs every check that a tool can do better than a model, and writes raw outputs + a summary.
// It never modifies source files. Optional tools are skipped if unavailable (offline etc.).
//
//   node collect.mjs [projectDir] [--out .audit/raw] [--src src] [--offline] [--tests] [--no-tests] [--gate]
//   --gate:  exit 1 on release blockers (type errors, high/critical vulnerable deps, leaked keys,
//            tracked .env files holding secrets, failing tests, or a required tool that didn't
//            finish). Use in CI. Accepted secret findings go in .audit-exceptions.json.
//   --tests: run the project's tests. They already run in CI and with --gate. Elsewhere they're
//            opt-in, because a local test run can touch a real dev database.
//
// Output: <out>/*.txt|json and <out>/summary.json (metrics the auditors and scorecard use).
// Every tool reports a status: ok, skipped, failed or timed-out. Everything written is redacted.

import { spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, extname, resolve } from "node:path";
import { EXCEPTIONS_FILE, applyExceptions, loadExceptions } from "./lib/exceptions.mjs";
import { countTypeErrors, detectPackageManager, findBoundaryConfig, readJsonc, runBoundaryCheck, runTool, runTypecheck, scanProject, sourceRoots, testCommand } from "./lib/project.mjs";
import { HARDCODED_SECRET, PROVIDER_KEY, envFileLeak, isEnvTemplate, redact } from "./lib/secrets.mjs";

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv.splice(i, 2)[1] : d; };
const has = (n) => { const i = argv.indexOf(n); if (i >= 0) { argv.splice(i, 1); return true; } return false; };
const offline = has("--offline");
const noTests = has("--no-tests");
const wantTests = has("--tests");
const gate = has("--gate");
const outArg = opt("--out");
const srcArg = opt("--src");
const root = resolve(argv[0] || ".");
const out = resolve(root, outArg || ".audit/raw");
mkdirSync(out, { recursive: true });

const summary = { generatedAt: new Date().toISOString(), root, tools: {}, metrics: {}, skipped: [] };
const bin = (n) => join(root, "node_modules", ".bin", n);
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { cwd: root, encoding: "utf8", timeout: 240000, maxBuffer: 64 * 1024 * 1024 });
  return { code: r.status, stdout: r.stdout || "" };
};
const save = (name, text) => {
  mkdirSync(dirname(join(out, name)), { recursive: true });
  writeFileSync(join(out, name), redact(text ?? ""));
};
const tool = (name, fn) => {
  const t0 = Date.now();
  try {
    const res = fn() || {};
    summary.tools[name] = { status: res.skipped ? "skipped" : "ok", ...res, ms: Date.now() - t0 };
  } catch (e) { summary.tools[name] = { status: "failed", reason: String(e).slice(0, 300) }; }
};
const didNotFinish = (r) => ({ status: r.status, reason: r.reason, code: r.code });
const unreadable = (what) => ({ status: "failed", reason: `unreadable ${what} output` });
const parseJson = (text) => { try { return JSON.parse(text); } catch { return undefined; } };

// Tools the gate decides on: if one of these breaks, the gate has no evidence to pass on.
const GATE_REQUIRED = ["git", "typecheck", "patterns", "exceptions", "vulnerabilities", "gitleaks", "tests"];
const onPath = (n) => spawnSync("sh", ["-c", `command -v ${n}`]).status === 0;

// Downloaded and run in the user's project, so each is pinned: scores shouldn't move because a tool
// released, and a compromised release shouldn't reach anyone automatically. Update them on purpose,
// because their output formats change between majors (knip 6 moved unused files, for one).
const NPX_TOOLS = { "dependency-cruiser": "18.7.2", knip: "6.44.1", jscpd: "5.4.2", madge: "8.0.0" };
// They also get what they need from the environment, not the API keys and tokens in it.
const NPX_ENV = /^(PATH|HOME|TMPDIR|TEMP|TMP|LANG|LC_\w+|TZ|NODE_EXTRA_CA_CERTS|NVM_\w+|npm_config_\w+|NPM_CONFIG_\w+|(HTTP|HTTPS|NO|ALL)_PROXY|(http|https|no|all)_proxy)$/;
const npxEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => NPX_ENV.test(k)));
const npx = (name, args, options) => runTool("npx", ["--yes", `${name}@${NPX_TOOLS[name]}`, ...args], {
  cwd: root, baseEnv: npxEnv, env: { CI: "1", npm_config_ignore_scripts: "true" }, ...options,
});

// ---------- Inventory ----------
let pkg = {}, pkgBroken = false;
if (existsSync(join(root, "package.json"))) {
  try { pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")); }
  catch { pkgBroken = true; } // not the same as having no scripts or dependencies
}
const BROKEN_PKG = { status: "failed", reason: "package.json isn't valid JSON" };
const pm = detectPackageManager(root, pkg);
const scan = scanProject(root);
const { files, tracked } = scan;
const isGit = scan.git.state === "ok";
tool("git", () => (scan.git.state === "failed" ? { status: "failed", reason: scan.git.reason } : isGit ? {} : { skipped: "not a git repo" }));
const SRC_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte", ".py", ".go", ".rs", ".java", ".cs", ".cpp", ".hpp", ".c", ".h"]);
const srcFiles = files.filter((f) => SRC_EXT.has(extname(f)) && !/\.d\.ts$|\.min\.js$|generated|\.gen\./.test(f));
const isTest = (f) => /(\.|_)(test|spec)\.|__tests__|(^|\/)tests?\//.test(f);
const srcDirs = srcArg ? [srcArg] : sourceRoots(files);

const envFilesTracked = tracked.filter((f) => /(^|\/)\.env[^/]*$|\.env$/.test(f) && !isEnvTemplate(f));
const envFindings = envFilesTracked.flatMap((file) => {
  let text;
  try { text = readFileSync(join(root, file), "utf8"); }
  catch { return [{ rule: "env-file", file, why: "couldn't be read" }]; } // can't call it clean
  const why = envFileLeak(file, text);
  return why ? [{ rule: "env-file", file, why }] : [];
});

const lineCounts = {};
let totalLines = 0;
for (const f of srcFiles) {
  try { const n = readFileSync(join(root, f), "utf8").split("\n").length; lineCounts[f] = n; totalLines += n; } catch {}
}
summary.metrics.inventory = {
  name: pkg.name, workspaces: pkg.workspaces || null, srcDirs,
  sourceFiles: srcFiles.length, testFiles: srcFiles.filter(isTest).length, sourceLines: totalLines,
  testToSourceRatio: +(srcFiles.filter(isTest).length / Math.max(1, srcFiles.filter((f) => !isTest(f)).length)).toFixed(2),
  frameworks: Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).filter((d) => /^(next|react|vue|svelte|express|fastify|@nestjs\/core|hono|koa|prisma|drizzle-orm|typeorm|mongoose|pg|expo|react-native|vite|vitest|jest|@playwright\/test|zod|socket\.io|bullmq|redis|ioredis|@supabase\/supabase-js|firebase)$/.test(d)),
  scripts: Object.keys(pkg.scripts || {}),
  hasCI: existsSync(join(root, ".github/workflows")) || existsSync(join(root, ".gitlab-ci.yml")),
  hasDocker: files.some((f) => /(^|\/)(Dockerfile|docker-compose\.ya?ml|compose\.ya?ml)$/.test(f)),
  envFilesTracked, envFilesWithSecrets: envFindings.map((f) => `${f.file} (${f.why})`),
  claudeSetup: files.filter((f) => /(^|\/)(CLAUDE\.md|AGENTS\.md|\.claude\/(agents|skills|commands)\/.+\.md|\.claude\/settings(\.local)?\.json|\.mcp\.json)$/.test(f)),
};
save("inventory.json", JSON.stringify(summary.metrics.inventory, null, 2));

// ---------- Type safety ----------
tool("typecheck", () => {
  if (!existsSync(join(root, "tsconfig.json"))) return { skipped: "no tsconfig" };
  const r = runTypecheck(root, { timeoutMs: 240000, env: { CI: "1" } });
  // Local audits can note this. A gate that was given a tsconfig can't pass without checking it.
  if (r.status === "skipped") return gate ? { status: "failed", reason: r.reason } : { skipped: r.reason };
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
  // An extra folder of a type this config doesn't lint shouldn't count as a crash.
  const r = runTool(bin("eslint"), [...srcDirs, "--no-error-on-unmatched-pattern", "-f", "json"], { cwd: root, env: { CI: "1" }, isFindings: ({ code }) => code === 1 });
  summary.metrics.lint = null;
  if (r.status !== "ok") { save("eslint.txt", r.output); return didNotFinish(r); }
  const report = parseJson(r.stdout);
  if (!Array.isArray(report)) { save("eslint.txt", r.output); return unreadable("ESLint"); }
  let errors = 0, warnings = 0, byRule = {};
  for (const f of report) { errors += f.errorCount; warnings += f.warningCount; for (const m of f.messages) byRule[m.ruleId || "parse"] = (byRule[m.ruleId || "parse"] || 0) + 1; }
  // Without `source`, the copy of each file with a problem that ESLint includes.
  save("eslint.json", JSON.stringify(report.map(({ source, ...f }) => f)));
  summary.metrics.lint = { errors, warnings, topRules: Object.entries(byRule).sort((a, b) => b[1] - a[1]).slice(0, 15) };
  return { status: "ok", errors, warnings };
});

// ---------- Architecture: boundaries + cycles ----------
tool("boundaries", () => {
  if (findBoundaryConfig(root)) {
    const runner = offline ? undefined : (args, options) => npx("dependency-cruiser", args, options);
    const r = runBoundaryCheck(root, { files, ...(srcArg ? { dirs: [srcArg] } : {}), timeoutMs: 240000, runner });
    if (r.status === "skipped") return { skipped: "offline" };
    save("depcruise.txt", r.output);
    if (r.status !== "ok") { summary.metrics.boundaryViolations = null; return { ...didNotFinish(r), mode: "depcruise" }; }
    summary.metrics.boundaryViolations = (r.output.match(/^\s*(error|warn)\s/gm) || []).length;
    return { code: r.code, mode: "depcruise" };
  }
  if (offline || !srcFiles.some((f) => /\.(t|j)sx?$/.test(f))) return { skipped: "no depcruise config" };
  const tsConfig = existsSync(join(root, "tsconfig.json")) ? ["--ts-config", "tsconfig.json"] : [];
  // madge exits 1 when it finds cycles.
  const r = npx("madge", ["--circular", "--extensions", "ts,tsx,js,jsx", ...tsConfig, ...srcDirs], { isFindings: ({ output }) => /Found \d+ circular/.test(output) });
  save("circular.txt", r.output);
  summary.metrics.circularDeps = null;
  if (r.status !== "ok") return { ...didNotFinish(r), mode: "madge" };
  const m = r.output.match(/Found (\d+) circular/);
  if (!m && !/No circular/.test(r.output)) return { ...unreadable("madge"), mode: "madge" };
  summary.metrics.circularDeps = m ? +m[1] : 0;
  return { mode: "madge", circular: summary.metrics.circularDeps };
});

// ---------- Dead code / unused deps & exports ----------
tool("knip", () => {
  if (offline || !existsSync(join(root, "package.json"))) return { skipped: offline ? "offline" : "no package.json" };
  const r = npx("knip", ["--reporter", "json", "--no-exit-code"], { timeout: 300000 });
  save("knip.json", r.stdout);
  if (r.status !== "ok") { save("knip.txt", r.output); return didNotFinish(r); }
  const issues = parseJson(r.stdout)?.issues;
  if (!Array.isArray(issues)) { save("knip.txt", r.output); return unreadable("knip"); }
  const count = (k) => issues.reduce((n, i) => n + (Array.isArray(i[k]) ? i[k].length : Object.keys(i[k] || {}).length), 0);
  summary.metrics.deadCode = { unusedFiles: count("files"), unusedExports: count("exports"), unusedTypes: count("types"), unusedDependencies: count("dependencies") + count("devDependencies"), unlistedDependencies: count("unlisted") };
  return { code: r.code };
});

// ---------- Duplication (reusability) ----------
const DUPLICATION_FORMATS = "javascript,typescript,jsx,tsx,vue,svelte,python,go,rust,java,csharp,cpp,c";
const DUPLICATION_IGNORE = "**/node_modules/**,**/dist/**,**/build/**,**/out/**,**/.next/**,**/coverage/**,**/.audit/**,**/vendor/**,**/*.test.*,**/*.spec.*,**/*.min.js,**/generated/**,**/migrations/**";
tool("duplication", () => {
  if (offline) return { skipped: "offline" };
  // A temp folder, because jscpd's report holds the duplicated code and it must pass through save().
  const reportDir = mkdtempSync(join(tmpdir(), "audit-jscpd-"));
  try {
    // From the root unless told otherwise: it names files relative to each scanned folder, so
    // scanning app/ and lib/ separately couldn't tell app/index.ts from lib/index.ts.
    const r = npx("jscpd", [srcArg || ".", "--silent", "--min-tokens", "60", "--format", DUPLICATION_FORMATS, "--reporters", "json", "--output", reportDir, "--ignore", DUPLICATION_IGNORE], { timeout: 300000 });
    if (r.status !== "ok") { save("jscpd.txt", r.output); return didNotFinish(r); }
    let report;
    try { report = readFileSync(join(reportDir, "jscpd-report.json"), "utf8"); } catch {}
    const j = parseJson(report);
    if (!j?.statistics?.total) { save("jscpd.txt", r.output); return unreadable("jscpd"); }
    const clones = (j.duplicates || []).map(({ fragment, ...d }) => d); // the copied code itself
    save("jscpd/jscpd-report.json", JSON.stringify({ ...j, duplicates: clones }));
    const path = (n) => (srcArg ? join(srcArg, n) : n);
    summary.metrics.duplication = { percentage: j.statistics.total.percentage, clones: clones.length,
      top: clones.sort((a, b) => b.lines - a.lines).slice(0, 15).map((d) => `${d.lines} lines: ${path(d.firstFile.name)}:${d.firstFile.start} ⇄ ${path(d.secondFile.name)}:${d.secondFile.start}`) };
    return { code: r.code };
  } finally {
    rmSync(reportDir, { recursive: true, force: true });
  }
});

// ---------- Dependency vulnerabilities & freshness ----------
// npm and pnpm report totals. Yarn 4 prints one JSON object per advisory, and nothing when clean.
// Yarn 1 prints one object per advisory and then an auditSummary line.
function auditCounts({ stdout, code }) {
  const totals = parseJson(stdout)?.metadata?.vulnerabilities;
  if (totals || pm.name !== "yarn") return totals;
  if (!stdout.trim()) return code === 0 ? {} : undefined;
  const lines = stdout.trim().split("\n").map(parseJson);
  const summaryLine = lines.find((line) => line?.type === "auditSummary");
  if (summaryLine) return summaryLine.data?.vulnerabilities;
  const advisories = lines.map((line) => line?.children?.Severity);
  if (advisories.includes(undefined)) return undefined;
  const counts = {};
  for (const severity of advisories) counts[severity.toLowerCase()] = (counts[severity.toLowerCase()] || 0) + 1;
  return counts;
}
tool("vulnerabilities", () => {
  if (offline) return { skipped: "offline" };
  if (pkgBroken) return BROKEN_PKG;
  const extra = {};
  if (onPath("osv-scanner")) {
    // Exits 1 when it finds vulnerabilities.
    const r = runTool("osv-scanner", ["scan", "source", "-r", ".", "--format", "json"], { cwd: root, isFindings: ({ code }) => code === 1 });
    save("osv.json", r.stdout);
    extra.osv = r.status === "ok" && parseJson(r.stdout) ? "ok" : "failed";
  }
  const lock = pm.lockfile;
  if (!lock) {
    const other = ["Cargo.lock", "go.sum", "poetry.lock", "uv.lock", "Pipfile.lock", "Gemfile.lock", "composer.lock", "gradle.lockfile", "packages.lock.json"].find((l) => existsSync(join(root, l)));
    if (other) return { skipped: `${other}: dependency audit not assessed (osv-scanner covers this ecosystem)`, ...extra };
    return { skipped: "no lockfile (audit impossible — that itself is a finding)", ...extra };
  }
  const yarnClassic = pm.name === "yarn" && /^1\./.test(runTool("yarn", ["--version"], { cwd: root }).stdout); // has no `yarn npm`
  const cmd = pm.name === "pnpm" ? ["pnpm", ["audit", "--json", "--prod"]] : yarnClassic ? ["yarn", ["audit", "--json", "--groups", "dependencies"]] : pm.name === "yarn" ? ["yarn", ["npm", "audit", "--json", "--environment", "production"]] : pm.name === "npm" ? ["npm", ["audit", "--json", "--omit=dev"]] : null;
  if (!cmd) return { skipped: `${lock}: dependency audit not assessed (osv-scanner covers bun lockfiles)`, ...extra };
  // These exit non-zero when they find vulnerabilities, so only readable output says it worked.
  const r = runTool(...cmd, { cwd: root, isFindings: () => true });
  save("dep-audit.json", r.stdout);
  if (r.status !== "ok") return { ...didNotFinish(r), lock, ...extra };
  const counts = auditCounts(r);
  if (!counts) { save("dep-audit.txt", r.output); return { ...unreadable(`${pm.name} audit`), lock, ...extra }; }
  summary.metrics.vulnerableDeps = counts;
  if (pm.name === "npm") {
    // Exits 1 when anything is outdated. This is context, so it doesn't decide the tool's status.
    const o = runTool("npm", ["outdated", "--json"], { cwd: root, isFindings: () => true });
    save("outdated.json", o.stdout);
    const j = parseJson(o.stdout || "{}");
    if (j) summary.metrics.outdated = { total: Object.keys(j).length, majorBehind: Object.values(j).filter((d) => d.current && d.latest && d.current.split(".")[0] !== d.latest.split(".")[0]).length };
    else extra.outdated = "failed";
  }
  return { lock, ...extra };
});

// ---------- Optional external scanners (used if installed) ----------
tool("semgrep", () => {
  if (offline || !onPath("semgrep")) return { skipped: "semgrep not installed (brew install semgrep for deeper SAST)" };
  // Not `--config auto`: semgrep refuses to combine it with `--metrics off`.
  const r = runTool("semgrep", ["scan", "--config", "p/default", "--json", "--quiet", "--metrics", "off"], { cwd: root, timeout: 420000, isFindings: ({ code }) => code === 1 });
  if (r.status !== "ok") { save("semgrep.txt", r.output); return didNotFinish(r); }
  const results = parseJson(r.stdout)?.results;
  if (!Array.isArray(results)) { save("semgrep.txt", r.output); return unreadable("semgrep"); }
  save("semgrep.json", r.stdout);
  summary.metrics.semgrepFindings = results.length;
  return { code: r.code };
});
tool("gitleaks", () => {
  if (!onPath("gitleaks")) return { skipped: "gitleaks not installed (brew install gitleaks to scan git history)" };
  if (!isGit) return { skipped: "not a git repo" };
  // It exits 0 after scanning nothing, so a clean result only counts if there was history to scan.
  const commits = +run("git", ["rev-list", "--count", "HEAD"]).stdout.trim() || 0;
  if (!commits) return { skipped: "no commits to scan" };
  const report = join(out, "gitleaks.json");
  rmSync(report, { force: true }); // a report left by an earlier run must not pass for this one
  // Exits 1 for leaks and for most crashes, so only a report it just wrote tells them apart.
  const r = runTool("gitleaks", ["detect", "--no-banner", "--redact", "--report-format", "json", "--report-path", report], { cwd: root, isFindings: () => existsSync(report) });
  if (r.status !== "ok") return didNotFinish(r);
  let leaks;
  try { leaks = parseJson(readFileSync(report, "utf8")); } catch {}
  if (!Array.isArray(leaks)) return unreadable("gitleaks");
  save("gitleaks.json", JSON.stringify(leaks, null, 1));
  if (r.findings && !leaks.length) return { status: "failed", reason: `exit code ${r.code} with an empty report` };
  if (/\b0 commits scanned|stderr is not empty/.test(r.output)) return { status: "failed", reason: `it scanned nothing, with ${commits} commits in the repo` };
  summary.metrics.secretsInHistory = leaks.length;
  return { code: r.code };
});

// ---------- Built-in pattern scan (no deps; always runs) ----------
const PATTERNS = [
  // security
  ["security", "hardcoded-secret", HARDCODED_SECRET],
  ["security", "provider-key", PROVIDER_KEY],
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
// Keys turn up in CI files and scripts as often as in source, so these two rules read every text file.
const NEVER_SCANNED = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|go\.sum|poetry\.lock|uv\.lock|Pipfile\.lock|Gemfile\.lock|composer\.lock)$|\.map$/;
const PROSE_OR_TEMPLATE = /\.(md|mdx|txt|rst|adoc|example|sample|template)$/i; // placeholders, not credentials
const WHOLE_FILE_BYTES = 2 * 1024 * 1024;
const secretFindings = [];

// For files too big to hold in memory for every rule. Returns false for a binary file.
function forEachLine(path, fn) {
  const fd = openSync(path, "r");
  try {
    const chunk = Buffer.alloc(1024 * 1024);
    let carry = "", lineNo = 0, n, first = true;
    while ((n = readSync(fd, chunk, 0, chunk.length, null)) > 0) {
      if (first && chunk.subarray(0, Math.min(n, 8000)).includes(0)) return false;
      first = false;
      const lines = (carry + chunk.toString("utf8", 0, n)).split("\n");
      carry = lines.pop();
      for (const line of lines) fn(line, lineNo++);
      // One enormous line, as in minified data: check what's here and keep enough to catch a key across the cut.
      if (carry.length > chunk.length) { fn(carry, lineNo); carry = carry.slice(-4096); }
    }
    if (carry) fn(carry, lineNo);
    return true;
  } finally { closeSync(fd); }
}

tool("patterns", () => {
  const hits = {}, examples = {}, category = {}, notRead = [...scan.unreadable];
  for (const [cat, id] of PATTERNS) category[id] = cat;
  category["hardcoded-secret-in-test"] = "security";
  const record = (id, f, i, line) => {
    hits[id] = (hits[id] || 0) + 1;
    const ex = (examples[id] ||= []);
    // Redact before cutting: a key cut in half no longer matches, and half a key is still a leak.
    if (ex.length < 12) ex.push(`${f}:${i + 1}  ${redact(line.trim()).slice(0, 160)}`);
  };
  const recordSecret = (id, f, i, l) => {
    // A key in a real provider's format is a key anywhere. A long string named `token` in a test
    // is usually a fixture, so it stays a lead for the auditors and doesn't block the gate.
    if (id === "hardcoded-secret" && isTest(f)) return record("hardcoded-secret-in-test", f, i, l);
    secretFindings.push({ rule: id, file: f, line: i + 1 });
    record(id, f, i, l);
  };
  const sources = new Set(srcFiles);
  for (const f of new Set([...files, ...tracked])) {
    const isSource = sources.has(f);
    if (!isSource && NEVER_SCANNED.test(f)) continue;
    let bytes;
    try {
      if (statSync(join(root, f)).size > WHOLE_FILE_BYTES) {
        const secretRules = [["provider-key", PROVIDER_KEY], ...(PROSE_OR_TEMPLATE.test(f) ? [] : [["hardcoded-secret", HARDCODED_SECRET]])];
        forEachLine(join(root, f), (l, i) => { for (const [id, re] of secretRules) if (re.test(l)) recordSecret(id, f, i, l); });
        continue;
      }
      bytes = readFileSync(join(root, f));
    } catch { notRead.push(f); continue; }
    if (bytes.subarray(0, 8000).includes(0)) continue; // binary
    const text = bytes.toString("utf8");
    const testFile = isTest(f);
    const lines = text.split("\n");
    for (const [cat, id, re] of PATTERNS) {
      const isSecretRule = id === "provider-key" || id === "hardcoded-secret";
      if (!isSource && !isSecretRule) continue;
      if (id === "hardcoded-secret" && !isSource && PROSE_OR_TEMPLATE.test(f)) continue;
      if (testFile && cat !== "security") continue;
      // multi-line patterns (await-in-loop) scan windows; others line by line
      if (id === "await-in-loop") {
        const m = text.match(new RegExp(re.source, "g")); if (!m) continue;
        hits[id] = (hits[id] || 0) + m.length; (examples[id] ||= []).length < 12 && examples[id].push(`${f}`);
        continue;
      }
      lines.forEach((l, i) => {
        if (!re.test(l)) return;
        if (isSecretRule) recordSecret(id, f, i, l);
        else record(id, f, i, l);
      });
    }
  }
  const byCat = {};
  for (const [id, n] of Object.entries(hits)) (byCat[category[id]] ||= {})[id] = n;
  summary.metrics.patterns = byCat;
  save("patterns.txt", Object.entries(examples).map(([id, ex]) => `## ${id} (${hits[id]} hits)\n${ex.join("\n")}`).join("\n\n"));
  if (notRead.length) return { status: "failed", reason: `couldn't read ${notRead.length} paths: ${notRead.slice(0, 5).join(", ")}` };
  return { categories: Object.keys(byCat).length };
});

// ---------- Accepted exceptions ----------
let openSecrets = secretFindings, openEnvFiles = envFindings;
tool("exceptions", () => {
  const loaded = loadExceptions(root);
  const { open, report } = applyExceptions([...secretFindings, ...envFindings], loaded);
  openSecrets = open.filter((f) => f.rule !== "env-file");
  openEnvFiles = open.filter((f) => f.rule === "env-file");
  summary.metrics.exceptions = report;
  if (loaded.problems.length) return { status: "failed", reason: `${EXCEPTIONS_FILE}: ${loaded.problems.join("; ")}` };
  return { applied: report.applied.length, expired: report.expired.length };
});

// ---------- Size & churn hotspots ----------
tool("hotspots", () => {
  const big = Object.entries(lineCounts).filter(([f]) => !isTest(f)).sort((a, b) => b[1] - a[1]);
  summary.metrics.largeFiles = { over400: big.filter(([, n]) => n > 400).length, over800: big.filter(([, n]) => n > 800).length, top: big.slice(0, 12).map(([f, n]) => `${n}  ${f}`) };
  if (!isGit) return { skipped: "not a git repo" };
  const log = run("git", ["log", "-z", "--since=6 months ago", "--name-only", "--format="]).stdout.split("\0").map((f) => f.trim()).filter(Boolean);
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
  if (pkgBroken) return BROKEN_PKG;
  if (!pkg.scripts?.test || /no test specified/.test(pkg.scripts.test)) { summary.metrics.tests = { configured: false }; return { skipped: "no test script" }; }
  if (noTests) return { skipped: "--no-tests" };
  if (!wantTests && !gate && !process.env.CI) { summary.metrics.tests = { configured: true, ran: false }; return { skipped: "not run locally: add --tests if they're safe to run here" }; }
  const r = runTool(...testCommand(pm.name, /vitest/.test(pkg.scripts.test) ? ["--run"] : []), { cwd: root, timeout: 420000, env: { CI: "1" }, isFindings: () => true });
  save("tests.txt", redact(r.output).slice(-20000)); // redact first: a cut key no longer matches
  const passed = r.output.match(/(\d+)\s+(?:passed|passing)/i), failed = r.output.match(/(\d+)\s+(?:failed|failing)/i);
  summary.metrics.tests = { configured: true, ran: true, exitCode: r.code, timedOut: r.status === "timed-out", passed: passed ? +passed[1] : null, failed: failed ? +failed[1] : null };
  return r.status === "ok" ? { code: r.code } : didNotFinish(r);
});

summary.skipped = Object.entries(summary.tools).filter(([, v]) => v.skipped).map(([k, v]) => `${k}: ${v.skipped}`);
save("summary.json", JSON.stringify(summary, null, 2));
console.log(`Audit evidence written to ${relative(root, out) || out}`);
console.log(redact(JSON.stringify(summary.metrics, null, 1)).slice(0, 6000));
if (summary.skipped.length) console.log("\nSkipped:\n  " + summary.skipped.join("\n  "));
const broken = Object.entries(summary.tools).filter(([, v]) => v.status === "failed" || v.status === "timed-out");
if (broken.length) console.log("\nDid not finish (not assessed):\n  " + broken.map(([k, v]) => `${k}: ${v.reason || v.status}`).join("\n  "));

if (gate) {
  const m = summary.metrics, blockers = [];
  for (const [name, v] of broken) if (GATE_REQUIRED.includes(name)) blockers.push(`${name} did not finish: ${v.reason || v.status}`);
  if (m.typeErrors > 0) blockers.push(`${m.typeErrors} type errors`);
  if ((m.vulnerableDeps?.high || 0) + (m.vulnerableDeps?.critical || 0) > 0) blockers.push(`high/critical vulnerable dependencies`);
  if (openSecrets.length) blockers.push(`possible hardcoded secrets: ${openSecrets.slice(0, 10).map((f) => `${f.file}:${f.line} (${f.rule})`).join(", ")}`);
  if (openEnvFiles.length) blockers.push(`.env files tracked in git: ${openEnvFiles.map((f) => `${f.file} (${f.why})`).join(", ")}`);
  if (m.tests?.exitCode > 0) blockers.push(`tests failing`);
  if (m.secretsInHistory > 0) blockers.push(`${m.secretsInHistory} secrets in git history`);
  if (m.exceptions?.expired.length) console.log(`\nExpired in ${EXCEPTIONS_FILE}, no longer applied:\n  ` + m.exceptions.expired.map((e) => `${e.rule} ${e.path} (${e.expires})`).join("\n  "));
  if (blockers.length) { console.error("\nGATE FAILED:\n  - " + blockers.join("\n  - ")); process.exit(1); }
  console.log("\nGATE PASSED");
}
