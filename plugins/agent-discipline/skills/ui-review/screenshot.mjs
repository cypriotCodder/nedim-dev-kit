#!/usr/bin/env node
// Screenshot one or more URLs at desktop + mobile widths, plus an interaction pass.
// Uses the PROJECT's Playwright (resolved from the current directory).
//
//   node screenshot.mjs <url> [url...] [--out .ui-review] [--dark] [--dark-class dark] [--auth state.json] [--only desktop|mobile]
//
//   --dark:       emulate the system dark preference, for themes using prefers-color-scheme
//   --dark-class: also set this class on <html> and data-theme="dark", for class-based themes (implies --dark)
//   --auth:       a Playwright storage state file, so protected routes render instead of the login page
//
// Tall pages are saved as tiles (.part1.png, ...), because a very tall image is too small to judge once scaled.
// Contrast and accessibility checks run if the project has axe-core installed.
//
// Setup once per project: npm i -D playwright && npx playwright install chromium

import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const bool = (name) => { const i = args.indexOf(name); if (i >= 0) { args.splice(i, 1); return true; } return false; };

const out = resolve(flag("--out") || ".ui-review");
const only = flag("--only");
const darkClass = flag("--dark-class");
const auth = flag("--auth");
const dark = bool("--dark") || Boolean(darkClass);
const urls = args;
if (!urls.length) { console.error("usage: screenshot.mjs <url> [url...] [--out dir] [--dark] [--dark-class name] [--auth state.json] [--only desktop|mobile]"); process.exit(1); }
if (auth && !existsSync(auth)) { console.error(`Auth state file not found: ${auth}`); process.exit(1); }

const projectRequire = createRequire(join(process.cwd(), "package.json"));
let chromium;
try {
  ({ chromium } = projectRequire("playwright"));
} catch {
  try { ({ chromium } = await import("playwright")); }
  catch { console.error("Playwright not found. Run: npm i -D playwright && npx playwright install chromium"); process.exit(1); }
}

// Optional. Without it the run says so, because no contrast report isn't the same as good contrast.
let axeSource = null;
try { axeSource = readFileSync(projectRequire.resolve("axe-core/axe.min.js"), "utf8"); } catch {}

const viewports = [
  { name: "desktop", width: 1440, height: 900, deviceScaleFactor: 1, minTarget: 32 }, // pointer
  { name: "mobile", width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true, minTarget: 44 }, // touch, as in DESIGN.md
].filter((v) => !only || v.name === only);
const TILE_VIEWPORTS = 2; // a page over this many screens gets tiled

mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const files = [];
let sawRedirect = false;

for (const url of urls) {
  const slug = url.replace(/^\w+:\/\//, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 60) || "page";
  for (const vp of viewports) {
    const { name, minTarget, ...opts } = vp;
    const ctx = await browser.newContext({ viewport: { width: opts.width, height: opts.height }, ...opts, colorScheme: dark ? "dark" : "light", ...(auth ? { storageState: auth } : {}) });
    if (darkClass) {
      await ctx.addInitScript((cls) => {
        const apply = () => {
          const el = document.documentElement;
          if (!el) return; // an init script can start before the root element exists
          el.classList.add(cls);
          el.dataset.theme = "dark";
        };
        apply();
        document.addEventListener("DOMContentLoaded", apply);
      }, darkClass);
    }
    const page = await ctx.newPage();
    const consoleErrors = [];
    page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
    page.on("pageerror", (e) => consoleErrors.push(String(e)));

    await page.goto(url, { waitUntil: "networkidle", timeout: 30000 }).catch(() => page.goto(url, { waitUntil: "load" }));
    // Again after loading, because a framework can reset <html> while it hydrates.
    if (darkClass) await page.evaluate((cls) => { document.documentElement.classList.add(cls); document.documentElement.dataset.theme = "dark"; }, darkClass);
    await page.waitForTimeout(400); // let entrance animations settle

    const base = join(out, `${slug}.${name}${dark ? ".dark" : ""}`);
    const fullHeight = await page.evaluate(() => document.documentElement.scrollHeight);
    if (fullHeight > opts.height * TILE_VIEWPORTS) {
      const parts = Math.ceil(fullHeight / (opts.height * TILE_VIEWPORTS));
      for (let i = 0; i < parts; i++) {
        const y = i * opts.height * TILE_VIEWPORTS;
        const path = `${base}.part${i + 1}.png`;
        await page.screenshot({ path, fullPage: true, clip: { x: 0, y, width: opts.width, height: Math.min(opts.height * TILE_VIEWPORTS, fullHeight - y) } });
        files.push(path);
      }
    } else {
      await page.screenshot({ path: `${base}.png`, fullPage: true });
      files.push(`${base}.png`);
    }

    // Interaction pass: focus the first interactive element to reveal focus styles; hover first button.
    try {
      await page.keyboard.press("Tab");
      await page.waitForTimeout(150);
      await page.screenshot({ path: `${base}.focus.png` });
      files.push(`${base}.focus.png`);
      if (name === "desktop") {
        const btn = page.locator("button, a[href], [role=button]").first();
        if (await btn.count()) { await btn.hover(); await page.waitForTimeout(200); await page.screenshot({ path: `${base}.hover.png` }); files.push(`${base}.hover.png`); }
      }
    } catch {}

    // Cheap layout sanity checks
    const issues = await page.evaluate((min) => {
      const r = [];
      if (document.documentElement.scrollWidth > window.innerWidth + 1) r.push(`horizontal overflow: ${document.documentElement.scrollWidth}px > ${window.innerWidth}px`);
      const small = [...document.querySelectorAll("button, a[href], input, [role=button]")].filter((el) => {
        const b = el.getBoundingClientRect(); return b.width > 0 && (b.height < min || b.width < min);
      }).length;
      if (small) r.push(`${small} interactive element(s) smaller than ${min}px`);
      const fonts = new Set([...document.querySelectorAll("body *")].slice(0, 400).map((el) => getComputedStyle(el).fontFamily.split(",")[0].trim()));
      r.push(`font families in use: ${[...fonts].join(" | ")}`);
      return r;
    }, minTarget);

    // A redirect usually means this is a screenshot of the login page, not the page asked for.
    const landed = new URL(page.url()), asked = new URL(url);
    if (landed.pathname !== asked.pathname) {
      sawRedirect = true;
      issues.unshift(`REDIRECTED to ${landed.pathname}: these screenshots don't show ${asked.pathname}`);
    }

    if (axeSource) {
      try {
        await page.evaluate(axeSource);
        const violations = await page.evaluate(async () => (await window.axe.run(document, { resultTypes: ["violations"] })).violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.length} element(s)`));
        issues.push(violations.length ? `axe: ${violations.join("; ")}` : "axe: no violations");
      } catch (e) { issues.push(`axe FAILED, so accessibility wasn't checked: ${String(e).slice(0, 200)}`); }
    }

    if (consoleErrors.length) issues.push(`console errors: ${consoleErrors.slice(0, 5).join(" || ")}`);
    console.log(`\n[${name}] ${url}\n  ${issues.join("\n  ")}`);
    await ctx.close();
  }
}
await browser.close();
console.log(`\nScreenshots:\n${files.map((f) => "  " + f).join("\n")}`);
if (!axeSource) console.log("\nAccessibility not checked: axe-core isn't installed in this project (npm i -D axe-core).");
if (sawRedirect && !auth) console.log("\nA page redirected. If it's behind a login, save a session and pass it with --auth state.json.");
