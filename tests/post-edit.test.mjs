import assert from "node:assert/strict";
import { test, describe } from "node:test";
import { edit, fakeLocalBin, project, write } from "./helpers.mjs";

const RAW_HEX = `export const C = () => <div style={{ color: "#ff0000" }} />;\n`;
const designProject = (opts) => project({ "DESIGN.md": "# Design\n" }, opts);

describe("post-edit: design guard", () => {
  test("flags off-system styles in new code", () => {
    const r = edit(designProject(), "src/C.tsx", RAW_HEX);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /raw hex color/);
  });

  test("does nothing without DESIGN.md", () => {
    assert.equal(edit(project(), "src/C.tsx", RAW_HEX).code, 0);
  });

  test("respects .claude/guards-off", () => {
    const root = designProject();
    write(root, ".claude/guards-off", "");
    assert.equal(edit(root, "src/C.tsx", RAW_HEX).code, 0);
  });

  test("respects design-guard-ignore", () => {
    const code = `const a = "#ff0000"; // design-guard-ignore: brand logo\n`;
    assert.equal(edit(designProject(), "src/C.tsx", code).code, 0);
  });

  test("allows a stock animation on a line marked as loading", () => {
    const code = `<div className="animate-pulse" data-skeleton />\n`;
    assert.equal(edit(designProject(), "src/C.tsx", code).code, 0);
  });
});

describe("post-edit: token file exemption (item 4)", () => {
  for (const name of ["tokenizer-app", "theme-park", "my-tokens"]) {
    test(`project folder "${name}" does not disable the guard`, () => {
      assert.equal(edit(designProject({ name }), "src/C.tsx", RAW_HEX).code, 2);
    });
  }

  for (const path of ["src/ThemeToggle.tsx", "src/theme-toggle.tsx", "src/token-input.tsx", "src/TokenList.tsx", "src/themes/Card.tsx", "src/tokens/page.tsx"]) {
    test(`component ${path} is still checked`, () => {
      assert.equal(edit(designProject(), path, RAW_HEX).code, 2);
    });
  }

  for (const path of ["src/styles/tokens.css", "src/styles/design-tokens.css", "src/styles/color.tokens.css", "src/styles/theme.css", "src/styles/theme-dark.css", "app/globals.css", "src/design-system/tokens/colors.tsx"]) {
    test(`token file ${path} is exempt`, () => {
      assert.equal(edit(designProject(), path, `a { color: #ff0000; }\n`).code, 0);
    });
  }

  for (const name of ["dist", "node_modules"]) {
    test(`project inside a folder named "${name}" is still checked`, () => {
      const parent = project({}, { name });
      write(parent, "site/DESIGN.md", "# Design\n");
      assert.equal(edit(`${parent}/site`, "src/C.tsx", RAW_HEX).code, 2);
    });
  }

  test("build output inside the project is skipped", () => {
    assert.equal(edit(designProject(), "dist/C.tsx", RAW_HEX).code, 0);
    assert.equal(edit(designProject(), "node_modules/pkg/C.tsx", RAW_HEX).code, 0);
  });
});

describe("post-edit: ESLint", () => {
  test("sends lint errors back to Claude", () => {
    const root = project();
    fakeLocalBin(root, "eslint", `echo "1:1 error no-undef"; exit 1`);
    const r = edit(root, "src/a.ts", "x\n");
    assert.equal(r.code, 2);
    assert.match(r.stderr, /no-undef/);
  });

  test("stays quiet when ESLint passes", () => {
    const root = project();
    fakeLocalBin(root, "eslint", "exit 0");
    assert.equal(edit(root, "src/a.ts", "x\n").code, 0);
  });

  test("reports a crashed ESLint instead of passing silently", () => {
    const root = project();
    fakeLocalBin(root, "eslint", `echo "Oops! Something went wrong!" >&2; exit 2`);
    assert.match(edit(root, "src/a.ts", "x\n").output, /eslint/i);
  });

  test("reports a killed or timed-out ESLint instead of passing silently", () => {
    const root = project();
    fakeLocalBin(root, "eslint", "kill -9 $$");
    assert.match(edit(root, "src/a.ts", "x\n").output, /eslint/i);
  });
});

describe("post-edit: guard accuracy", () => {
  const pr3 = { todo: "PR 3: tune design guard rules (items 17, 18)" };

  const allowed = {
    "Tailwind data variant": `<div className="data-[state=open]:bg-surface" />\n`,
    "anchor link that looks like hex": `<a href="#add">Add</a>\n`,
    "copyright sign": `<footer>© 2026 Acme</footer>\n`,
    "spinner with the keyword before the class": `<Spinner loading className="animate-spin" />\n`,
  };
  for (const [label, code] of Object.entries(allowed)) {
    test(`allows ${label}`, pr3, () => {
      assert.equal(edit(designProject(), "src/C.tsx", code).code, 0);
    });
  }

  test("flags bg-white", pr3, () => {
    assert.equal(edit(designProject(), "src/C.tsx", `<div className="bg-white" />\n`).code, 2);
  });

  test("flags raw classes in a cva() call in a .ts file", pr3, () => {
    const code = `export const button = cva("bg-blue-500 text-white");\n`;
    assert.equal(edit(designProject(), "src/button.ts", code).code, 2);
  });

  test("flags the soft-card look split across lines", pr3, () => {
    const code = `<div className="rounded-2xl\n  shadow-xl" />\n`;
    assert.equal(edit(designProject(), "src/C.tsx", code).code, 2);
  });
});
