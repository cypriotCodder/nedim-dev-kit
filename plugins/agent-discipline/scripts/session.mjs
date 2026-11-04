// State shared by the hooks during one Claude Code session: what was edited, which problems already
// existed, and how many times Stop has sent Claude back. It lives in the temp folder, so it never
// shows up in the project, and each root and session pair gets its own folder.

import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const hash = (text) => createHash("sha256").update(text).digest("hex").slice(0, 32);

const readJson = (path) => {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; }
};

export function openSession(root, sessionId = "no-session") {
  const dir = join(tmpdir(), `agent-discipline-${process.getuid()}`, hash(`${resolve(root)}\0${sessionId}`));
  const path = (name) => join(dir, name);
  const prepare = () => mkdirSync(dir, { recursive: true, mode: 0o700 });

  return {
    // Appended a line at a time, because hooks for parallel edits can run at the same moment.
    recordEdit(file) {
      prepare();
      appendFileSync(path("edits"), JSON.stringify(file) + "\n");
    },
    edits() {
      let text;
      try { text = readFileSync(path("edits"), "utf8"); } catch { return []; }
      return [...new Set(text.split("\n").filter(Boolean).map((line) => JSON.parse(line)))];
    },
    clearEdits() {
      rmSync(path("edits"), { force: true });
    },

    // undefined until captured. It's empty, not missing, if the check didn't finish during capture.
    baseline: (checkId) => readJson(path(`baseline-${hash(checkId)}`))?.keys,
    saveBaseline(checkId, keys) {
      prepare();
      writeFileSync(path(`baseline-${hash(checkId)}`), JSON.stringify({ keys }));
    },

    blocks: () => readJson(path("blocks")) ?? 0,
    setBlocks(count) {
      prepare();
      writeFileSync(path("blocks"), JSON.stringify(count));
    },

    // True the first time a key is seen. If the state can't be written, it stays true: an extra
    // warning is better than a lost one.
    firstTime(key) {
      try {
        prepare();
        writeFileSync(path(`once-${hash(key)}`), "", { flag: "wx" });
        return true;
      } catch (e) {
        return e.code !== "EEXIST";
      }
    },
  };
}
