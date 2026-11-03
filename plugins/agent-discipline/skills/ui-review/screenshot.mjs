#!/usr/bin/env node
// Screenshot one or more URLs at desktop + mobile widths, plus an interaction pass.
// Uses the PROJECT's Playwright (resolved from the current directory).
//
//   node screenshot.mjs <url> [url...] [--out .ui-review] [--dark] [--only desktop|mobile]
//
// Setup once per project: npm i -D playwright && npx playwright install chromium

import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const bool = (name) => { const i = args.indexOf(name); if (i >= 0) { args.splice(i, 1); return true; } return false; };

const out = resolve(flag("--out") || ".ui-review");
const only = flag("--only");
const dark = bool("--dark");
const urls = args;
if (!urls.length) { console.error("usage: screenshot.mjs <url> [url...] [--out dir] [--dark] [--only desktop|mobile]"); process.exit(1); }

let chromium;
try {
  ({ chromium } = createRequire(join(process.cwd(), "package.json"))("playwright"));
} catch {
  try { ({ chromium } = await import("playwright")); }
  catch { console.error("Playwright not found. Run: npm i -D playwright && npx playwright install chromium"); process.exit(1); }
}

const viewports = [
  { name: "desktop", width: 1440, height: 900, deviceScaleFactor: 1 },
  { name: "mobile", width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
].filter((v) => !only || v.name === only);

mkdirSync(out, { recursive: true });
const browser = await chromium.launch();
const files = [];

for (const url of urls) {
  const slug = url.replace(/^\w+:\/\//, "").replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 60) || "page";
  for (const vp of viewports) {
    const { name, ...opts } = vp;
    const ctx = await browser.newContext({ viewport: { width: opts.width, height: opts.height }, ...opts, colorScheme: dark ? "dark" : "light" });
    const page = await ctx.newPage();
    const consoleErrors = [];
    page.on("console", (m) => m.type() === "error" && consoleErrors.push(m.text()));
    page.on("pageerror", (e) => consoleErrors.push(String(e)));

    await page.goto(url, { waitUntil: "networkidle", timeout: 30000 }).catch(() => page.goto(url, { waitUntil: "load" }));
    await page.waitForTimeout(400); // let entrance animations settle

    const base = join(out, `${slug}.${name}${dark ? ".dark" : ""}`);
    await page.screenshot({ path: `${base}.png`, fullPage: true });
    files.push(`${base}.png`);

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
    const issues = await page.evaluate(() => {
      const r = [];
      if (document.documentElement.scrollWidth > window.innerWidth + 1) r.push(`horizontal overflow: ${document.documentElement.scrollWidth}px > ${window.innerWidth}px`);
      const small = [...document.querySelectorAll("button, a[href], input, [role=button]")].filter((el) => {
        const b = el.getBoundingClientRect(); return b.width > 0 && (b.height < 32 || b.width < 32);
      }).length;
      if (small) r.push(`${small} interactive element(s) smaller than 32px`);
      const fonts = new Set([...document.querySelectorAll("body *")].slice(0, 400).map((el) => getComputedStyle(el).fontFamily.split(",")[0].trim()));
      r.push(`font families in use: ${[...fonts].join(" | ")}`);
      return r;
    });
    if (consoleErrors.length) issues.push(`console errors: ${consoleErrors.slice(0, 5).join(" || ")}`);
    console.log(`\n[${name}] ${url}\n  ${issues.join("\n  ")}`);
    await ctx.close();
  }
}
await browser.close();
console.log(`\nScreenshots:\n${files.map((f) => "  " + f).join("\n")}`);
