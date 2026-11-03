// PostToolUse hook (Edit|Write|MultiEdit).
// 1. Runs ESLint on the edited file if the project has ESLint installed.
// 2. If the project has a DESIGN.md, scans the NEW code for off-system styling
//    (raw colors, arbitrary Tailwind values, raw palette classes, emoji, generic "AI" patterns).
// Exit 2 = feedback goes to Claude so it fixes the problem itself. Exit 0 = all good / not applicable.
//
// Opt out per project: create .claude/guards-off
// Silence one line: add a comment containing "design-guard-ignore"

import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, relative, extname, basename, sep } from "node:path";

const input = JSON.parse(readFileSync(0, "utf8") || "{}");
const root = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
const ti = input.tool_input || {};
const file = ti.file_path;

if (!file || existsSync(join(root, ".claude", "guards-off"))) process.exit(0);

// Path rules use the project-relative path: where the project lives must not change the result.
const rel = relative(root, file).split(sep).join("/");
if (/(^|\/)(node_modules|dist|\.next)\//.test(rel)) process.exit(0);

const ext = extname(file).toLowerCase();
const problems = [];

// ---------- 1. ESLint ----------
const LINTABLE = [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte"];
const eslintBin = join(root, "node_modules", ".bin", process.platform === "win32" ? "eslint.cmd" : "eslint");
if (LINTABLE.includes(ext) && existsSync(eslintBin) && existsSync(file)) {
  const r = spawnSync(eslintBin, ["--format", "stylish", file], { cwd: root, encoding: "utf8", timeout: 45000 });
  if (r.status === 1) {
    problems.push(`ESLint errors in ${relative(root, file)}:\n${(r.stdout || r.stderr).trim().split("\n").slice(0, 40).join("\n")}`);
  }
}

// ---------- 2. Design guard ----------
const STYLE_FILES = [".tsx", ".jsx", ".vue", ".svelte", ".html", ".css", ".scss", ".astro"];
const hasDesign = existsSync(join(root, "DESIGN.md")) || existsSync(join(root, "docs", "DESIGN.md"));
// Token files define the raw values everything else must reference. Components that merely have
// "theme" or "token" in their name (ThemeToggle.tsx, token-input.tsx) are not token files.
const name = basename(rel).toLowerCase();
const isTokenFile =
  /^(tokens?|themes?)\.[^.]+$/.test(name) ||                    // tokens.ts, theme.tsx
  /(^|[-_.])(tokens?|themes?)[-_.](.*\.)?s?css$/.test(name) ||  // design-tokens.css, theme-dark.scss
  /^globals?\.s?css$/.test(name) ||
  /^tailwind\.config\./.test(name) ||
  /(^|\/)design-system\/tokens\//.test(rel);

if (hasDesign && STYLE_FILES.includes(ext) && !isTokenFile) {
  // Only inspect code that was just written, so old files don't nag forever.
  const chunks = [];
  if (typeof ti.new_string === "string") chunks.push(ti.new_string);
  if (typeof ti.content === "string") chunks.push(ti.content);
  if (Array.isArray(ti.edits)) for (const e of ti.edits) if (e?.new_string) chunks.push(e.new_string);
  const lines = chunks.join("\n").split("\n");

  const PALETTE = "slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose";
  const rules = [
    { re: /(?<![\w&])#[0-9a-fA-F]{3}(?:[0-9a-fA-F]{3})?(?:[0-9a-fA-F]{2})?\b/, why: "raw hex color — use a color token from DESIGN.md" },
    { re: /\b(?:rgba?|hsla?|oklch)\(\s*\d/, why: "raw color function — use a color token" },
    { re: /\b[a-z-]+-\[(?!var\(--)[^\]]+\]/, why: "arbitrary Tailwind value — use the spacing/type/radius scale (or add a token)" },
    { re: new RegExp(`\\b(?:bg|text|border|ring|from|via|to|fill|stroke|outline|divide|shadow)-(?:${PALETTE})-\\d{2,3}\\b`), why: "raw Tailwind palette color — use semantic tokens (bg-surface, text-muted, accent…)" },
    { re: /bg-gradient-to-|bg-linear-to-|linear-gradient\(/, why: "gradient — only allowed if DESIGN.md explicitly permits it" },
    { re: /\brounded-(?:2xl|3xl)\b.*\bshadow-(?:lg|xl|2xl)\b|\bshadow-(?:lg|xl|2xl)\b.*\brounded-(?:2xl|3xl)\b/, why: "the generic 'soft card' look (big radius + big shadow) — follow DESIGN.md elevation rules" },
    { re: /font-family:\s*["']?Inter\b|font-\['?Inter|["']Inter["']/, why: "Inter — DESIGN.md defines the typefaces" },
    { re: /\p{Extended_Pictographic}/u, why: "emoji in UI — use the icon set from DESIGN.md" },
    { re: /\banimate-(?:bounce|pulse|spin)\b(?!.*(?:skeleton|loading|spinner))/, why: "stock Tailwind animation — use motion tokens" },
    { re: /transition-all\b/, why: "transition-all — transition specific properties with motion tokens" },
  ];

  const hits = [];
  lines.forEach((line, i) => {
    if (line.includes("design-guard-ignore")) return;
    const whys = rules.filter(({ re }) => re.test(line)).map(({ why }) => why);
    if (whys.length) hits.push(`  • line: ${line.trim().slice(0, 140)}\n      - ${whys.join("\n      - ")}`);
  });

  if (hits.length) {
    problems.push(
      `Design guard: ${basename(file)} has ${hits.length} off-system style choice(s). ` +
      `Re-read DESIGN.md and fix them (or add "design-guard-ignore" with a reason if intentional):\n` +
      hits.slice(0, 15).join("\n") + (hits.length > 15 ? `\n  …and ${hits.length - 15} more` : "")
    );
  }
}

if (problems.length) {
  process.stderr.write(problems.join("\n\n") + "\n");
  process.exit(2);
}
process.exit(0);
