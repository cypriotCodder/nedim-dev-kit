// Runs screenshot.mjs against a fake Playwright that records what it was asked to do.
// A real browser run is a manual check: see the PR's verification notes.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test, describe } from "node:test";
import { PLUGIN, project, write } from "./helpers.mjs";

const SCREENSHOT = join(PLUGIN, "skills", "ui-review", "screenshot.mjs");

const FAKE_PLAYWRIGHT = `
const fs = require("node:fs");
const config = JSON.parse(fs.readFileSync("fake-config.json", "utf8"));
const log = { contexts: [], shots: [], initScripts: [], darkClasses: [], initErrors: [], minTargets: [], axeLoaded: 0 };
const save = () => fs.writeFileSync("fake-log.json", JSON.stringify(log));
const page = (asked = { url: "" }) => ({
  on() {},
  async goto(url) { asked.url = url; },
  async waitForTimeout() {},
  async screenshot(o) { log.shots.push(o); save(); },
  keyboard: { async press() {} },
  locator: () => ({ first: () => ({ count: async () => 0 }) }),
  url: () => config.landedOn || asked.url,
  async evaluate(what, arg) {
    if (typeof what === "string") { log.axeLoaded++; save(); if (config.axeThrows) throw new Error("axe blew up"); return; }
    const src = what.toString();
    if (src.includes("axe.run")) return config.violations || [];
    if (src.includes("querySelectorAll")) { log.minTargets.push(arg); save(); return []; }
    return config.height || 500;
  },
});
exports.chromium = { launch: async () => ({
  newContext: async (o) => { const c = { ...o }; log.contexts.push(c); save(); return {
    addInitScript: async (fn, arg) => {
      log.initScripts.push(arg);
      // As in a real browser: there's no root element yet when an init script starts.
      const listeners = [];
      const root = { classList: { add: (c) => { log.darkClasses.push(c); } }, dataset: {} };
      globalThis.document = { documentElement: null, addEventListener: (_, cb) => listeners.push(cb) };
      try { fn(arg); } catch (e) { log.initErrors.push(String(e)); }
      globalThis.document.documentElement = root;
      for (const cb of listeners) cb();
      log.darkTheme = root.dataset.theme;
      save();
    }, newPage: async () => page(), close: async () => {},
  }; },
  close: async () => {},
}) };
`;

function shoot(args, config = {}, files = {}) {
  const root = project({
    "package.json": "{}", "fake-config.json": JSON.stringify(config),
    "node_modules/playwright/index.js": FAKE_PLAYWRIGHT, ...files,
  });
  const r = spawnSync(process.execPath, [SCREENSHOT, "http://localhost:3000/orders", ...args], { cwd: root, encoding: "utf8" });
  const logPath = join(root, "fake-log.json");
  return { code: r.status, output: r.stdout + r.stderr, log: existsSync(logPath) ? JSON.parse(readFileSync(logPath, "utf8")) : null };
}

describe("screenshot (item 20)", () => {
  describe("auth", () => {
    test("passes a storage state to every context", () => {
      const r = shoot(["--auth", "state.json"], {}, { "state.json": "{}" });
      assert.equal(r.code, 0, r.output);
      assert.equal(r.log.contexts.length, 2);
      for (const c of r.log.contexts) assert.equal(c.storageState, "state.json");
    });

    test("a missing state file stops the run instead of screenshotting the login page", () => {
      const r = shoot(["--auth", "nope.json"]);
      assert.equal(r.code, 1);
      assert.match(r.output, /not found/);
      assert.equal(r.log, null);
    });

    test("uses no state unless asked", () => {
      assert.equal(shoot([]).log.contexts[0].storageState, undefined);
    });
  });

  describe("redirects", () => {
    test("says so when the page isn't the one asked for, and suggests --auth", () => {
      const r = shoot([], { landedOn: "http://localhost:3000/login" });
      assert.match(r.output, /REDIRECTED to \/login/);
      assert.match(r.output, /--auth/);
    });

    test("stays quiet when the page loaded", () => {
      assert.doesNotMatch(shoot([]).output, /REDIRECTED/);
    });
  });

  describe("dark mode", () => {
    test("--dark only emulates the system preference", () => {
      const r = shoot(["--dark"]);
      assert.equal(r.log.contexts[0].colorScheme, "dark");
      assert.deepEqual(r.log.initScripts, []);
    });

    test("--dark-class sets the class as well, and names files .dark", () => {
      const r = shoot(["--dark-class", "theme-night"]);
      assert.equal(r.log.contexts[0].colorScheme, "dark");
      assert.deepEqual(r.log.initScripts, ["theme-night", "theme-night"]);
      assert.match(r.log.shots[0].path, /\.dark\.png$/);
    });

    test("--dark-class still applies when the page has no root element yet", () => {
      const r = shoot(["--only", "desktop", "--dark-class", "night"]);
      assert.deepEqual(r.log.initErrors, []);
      assert.ok(r.log.darkClasses.includes("night"));
      assert.equal(r.log.darkTheme, "dark");
    });

    test("is light by default", () => {
      assert.equal(shoot([]).log.contexts[0].colorScheme, "light");
    });
  });

  test("checks hit targets at 32px on desktop and 44px on touch", () => {
    assert.deepEqual(shoot([]).log.minTargets, [32, 44]);
  });

  describe("tall pages", () => {
    test("a normal page is one image", () => {
      const r = shoot(["--only", "desktop"], { height: 1800 });
      assert.match(r.log.shots[0].path, /desktop\.png$/);
      assert.equal(r.log.shots[0].clip, undefined);
    });

    test("a tall page is tiled, and the tiles cover all of it without overlap", () => {
      const height = 4000;
      const r = shoot(["--only", "desktop"], { height });
      const tiles = r.log.shots.filter((s) => /\.part\d+\.png$/.test(s.path));
      assert.equal(tiles.length, 3);
      let y = 0;
      for (const { clip } of tiles) {
        assert.equal(clip.y, y);
        y += clip.height;
      }
      assert.equal(y, height);
      assert.ok(!r.log.shots.some((s) => /desktop\.png$/.test(s.path)));
      assert.match(r.output, /part3\.png/);
    });
  });

  describe("accessibility", () => {
    const AXE = { "node_modules/axe-core/axe.min.js": "// axe", "node_modules/axe-core/package.json": `{"name":"axe-core"}` };

    test("without axe-core it says accessibility wasn't checked", () => {
      assert.match(shoot([]).output, /Accessibility not checked/);
    });

    test("reports violations when axe-core is installed", () => {
      const r = shoot(["--only", "desktop"], { violations: ["color-contrast (serious): 3 element(s)"] }, AXE);
      assert.match(r.output, /axe: color-contrast \(serious\): 3 element/);
      assert.doesNotMatch(r.output, /Accessibility not checked/);
    });

    test("reports a clean run", () => {
      assert.match(shoot(["--only", "desktop"], {}, AXE).output, /axe: no violations/);
    });

    test("an axe crash isn't reported as clean", () => {
      const r = shoot(["--only", "desktop"], { axeThrows: true }, AXE);
      assert.match(r.output, /axe FAILED/);
      assert.doesNotMatch(r.output, /no violations/);
    });
  });
});
