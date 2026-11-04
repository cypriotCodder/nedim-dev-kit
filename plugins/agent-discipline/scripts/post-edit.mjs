// PostToolUse hook (Edit|Write|MultiEdit).
// 1. Records the edit for the session, so the Stop hook knows what to check.
// 2. Runs ESLint on the edited file if the project has ESLint installed.
// 3. If the project has a DESIGN.md, scans the NEW code for off-system styling
//    (raw colors, arbitrary Tailwind values, raw palette classes, emoji, generic "AI" patterns).
// Exit 2 = feedback goes to Claude so it fixes the problem itself. Exit 0 = all good / not applicable.
//
// Opt out per project: create .claude/guards-off
// Silence one line: add a comment containing "design-guard-ignore"
// Allow a rule for the whole project: add <!-- design-guard: allow gradient, inter --> to DESIGN.md

import { existsSync, readFileSync } from "node:fs";
import { join, extname, basename, dirname } from "node:path";
import { projectPath } from "./checks.mjs";
import { openSession } from "./session.mjs";
import { findLocalBin, runTool, warnUser } from "../skills/audit/lib/project.mjs";

const input = JSON.parse(readFileSync(0, "utf8") || "{}");
const root = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
const ti = input.tool_input || {};
const file = ti.file_path;

if (!file || existsSync(join(root, ".claude", "guards-off"))) process.exit(0);

const rel = projectPath(root, file);
if (!rel) process.exit(0);

const ext = extname(file).toLowerCase();
const problems = [];
const warnings = [];
const session = openSession(root, input.session_id);

// ---------- 1. Session marker ----------
try {
  session.recordEdit(rel);
} catch (e) {
  warnings.push(`agent-discipline: couldn't record the edit to ${rel} (${e.code || e.message}), so the Stop checks may not run.`);
}

// ---------- 2. ESLint ----------
const LINTABLE = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte"];
const eslint = LINTABLE.includes(ext) && existsSync(file) ? findLocalBin("eslint", dirname(file), root) : null;
if (eslint) {
  // ESLint exits 1 for lint errors and 2 when it crashed or its config is broken.
  const r = runTool(eslint.bin, ["--format", "stylish", file], { cwd: eslint.dir, timeout: 45000, isFindings: ({ code }) => code === 1 });
  if (r.findings) {
    problems.push(`ESLint errors in ${rel}:\n${(r.stdout || r.stderr).trim().split("\n").slice(0, 40).join("\n")}`);
  } else if (r.status !== "ok") {
    // A broken config fails the same way on every file, so once per session is enough.
    if (session.firstTime("eslint")) warnings.push(`agent-discipline: ESLint didn't finish on ${rel} (${r.reason}), so lint errors may be unreported.`);
  }
}

// ---------- 3. Design guard ----------
const STYLE_FILES = [".tsx", ".jsx", ".vue", ".svelte", ".html", ".css", ".scss", ".astro"];
// Plain scripts hold no markup, so only the arguments of class helpers are scanned in them.
const SCRIPT_FILES = [".ts", ".js", ".mjs", ".cjs", ".mts", ".cts"];
const designFile = [join(root, "DESIGN.md"), join(root, "docs", "DESIGN.md")].find((p) => existsSync(p));
// Token files define the raw values everything else must reference. Components that merely have
// "theme" or "token" in their name (ThemeToggle.tsx, token-input.tsx) are not token files.
const name = basename(rel).toLowerCase();
const isTokenFile =
  /^(tokens?|themes?)\.[^.]+$/.test(name) ||                    // tokens.ts, theme.tsx
  /(^|[-_.])(tokens?|themes?)[-_.](.*\.)?s?css$/.test(name) ||  // design-tokens.css, theme-dark.scss
  /^globals?\.s?css$/.test(name) ||
  /^tailwind\.config\./.test(name) ||
  /(^|\/)design-system\/tokens\//.test(rel);

// The text of each class helper call, such as cva("bg-blue-500"), found by counting parentheses.
function classHelperCalls(text) {
  const calls = [];
  for (const m of text.matchAll(/\b(?:cva|cn|clsx|twMerge|tv)\(/g)) {
    let depth = 0;
    let i = m.index + m[0].length - 1;
    for (; i < text.length; i++) {
      if (text[i] === "(") depth++;
      else if (text[i] === ")" && --depth === 0) break;
    }
    calls.push(text.slice(m.index, i + 1));
  }
  return calls.join("\n");
}

const scansMarkup = STYLE_FILES.includes(ext);
if (designFile && (scansMarkup || SCRIPT_FILES.includes(ext)) && !isTokenFile) {
  // Only inspect code that was just written, so old files don't nag forever.
  const chunks = [];
  if (typeof ti.new_string === "string") chunks.push(ti.new_string);
  if (typeof ti.content === "string") chunks.push(ti.content);
  if (Array.isArray(ti.edits)) for (const e of ti.edits) if (e?.new_string) chunks.push(e.new_string);
  const written = chunks.join("\n");
  const text = scansMarkup ? written : classHelperCalls(written);

  const PALETTE = "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";
  const SOFT_CARD = "the generic 'soft card' look (big radius + big shadow) — follow DESIGN.md elevation rules";
  const rules = [
    // Not an anchor link or an SVG url(#id), whose names can look like hex: href="#add".
    { id: "hex", re: /(?<![\w&]|href=["']|to=["']|url\()#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?(?:[0-9a-fA-F]{2})?\b/, why: "raw hex color — use a color token from DESIGN.md" },
    { id: "color-function", re: /\b(?:rgba?|hsla?|oklch)\(\s*\d/, why: "raw color function — use a color token" },
    // A trailing ":" makes it a variant such as data-[state=open]:, which chooses when a style applies and sets no value.
    { id: "arbitrary-value", re: /\b[a-z-]+-\[(?!var\(--)[^\]]+\](?!:)/, why: "arbitrary Tailwind value — use the spacing/type/radius scale (or add a token)" },
    { id: "palette", re: new RegExp(`\\b(?:bg|text|border|ring|from|via|to|fill|stroke|outline|divide|shadow)-(?:(?:${PALETTE})-\\d{2,3}|white|black)\\b`), why: "raw Tailwind palette color — use semantic tokens (bg-surface, text-muted, accent…)" },
    { id: "gradient", re: /bg-gradient-to-|bg-linear-to-|linear-gradient\(/, why: "gradient — add it to the allow list in DESIGN.md if the design calls for it" },
    { id: "soft-card", re: /\brounded-(?:2xl|3xl)\b.*\bshadow-(?:lg|xl|2xl)\b|\bshadow-(?:lg|xl|2xl)\b.*\brounded-(?:2xl|3xl)\b/, why: SOFT_CARD },
    { id: "inter", re: /font-family:\s*["']?Inter\b|font-\['?Inter|["']Inter["']/, why: "Inter — add it to the allow list in DESIGN.md if the design calls for it" },
    // Symbols like © and ™ count as pictographic too, but they display as text unless asked to be emoji.
    { id: "emoji", re: /\p{Emoji_Presentation}|\p{Extended_Pictographic}️/u, why: "emoji in UI — use the icon set from DESIGN.md" },
    { id: "animation", re: /\banimate-(?:bounce|pulse|spin)\b/, unless: /skeleton|loading|spinner/i, why: "stock Tailwind animation — use motion tokens" },
    { id: "transition-all", re: /transition-all\b/, why: "transition-all — transition specific properties with motion tokens" },
  ];

  const ALLOW = /<!--\s*design-guard:\s*allow\s+([^>]*?)\s*-->/gi;
  const allowed = [...readFileSync(designFile, "utf8").matchAll(ALLOW)].flatMap((m) => m[1].split(/[\s,]+/).filter(Boolean));
  const ruleIds = rules.map((r) => r.id);
  const unknown = allowed.filter((id) => !ruleIds.includes(id));
  if (unknown.length && session.firstTime("design-guard-allow")) {
    warnings.push(`agent-discipline: DESIGN.md allows unknown design guard rule(s): ${unknown.join(", ")}. Valid rules: ${ruleIds.join(", ")}.`);
  }
  const active = rules.filter((r) => !allowed.includes(r.id));

  const hits = [];
  const hit = (line, whys) => hits.push(`  • line: ${line.trim().slice(0, 140)}\n      - ${whys.join("\n      - ")}`);
  text.split("\n").forEach((line) => {
    if (line.includes("design-guard-ignore")) return;
    const whys = active.filter(({ re, unless }) => re.test(line) && !unless?.test(line)).map(({ why }) => why);
    if (whys.length) hit(line, whys);
  });

  // Long class lists often wrap. The per-line rule above can't see both halves, so this looks for them across lines of one string.
  if (active.some((r) => r.id === "soft-card")) {
    const RADIUS = "\\brounded-(?:2xl|3xl)\\b", SHADOW = "\\bshadow-(?:lg|xl|2xl)\\b", GAP = "[^\"'`]*\\n[^\"'`]*";
    for (const [match] of text.matchAll(new RegExp(`${RADIUS}${GAP}${SHADOW}|${SHADOW}${GAP}${RADIUS}`, "g"))) {
      if (!match.includes("design-guard-ignore")) hit(match.split("\n")[0], [SOFT_CARD]);
    }
  }

  if (hits.length) {
    problems.push(
      `Design guard: ${basename(file)} has ${hits.length} off-system style choice(s). ` +
      `Re-read DESIGN.md and fix them (or add "design-guard-ignore" with a reason if intentional):\n` +
      hits.slice(0, 15).join("\n") + (hits.length > 15 ? `\n  …and ${hits.length - 15} more` : "")
    );
  }
}

if (problems.length) {
  process.stderr.write([...problems, ...warnings].join("\n\n") + "\n");
  process.exit(2);
}
if (warnings.length) warnUser(warnings.join("\n"));
process.exit(0);
