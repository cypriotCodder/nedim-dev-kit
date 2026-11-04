// Shared fixtures. Tests run the real scripts as subprocesses and observe only exit codes,
// output and written files, so they survive internal rewrites of the scripts.

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { after } from "node:test";

export const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const PLUGIN = join(REPO, "plugins", "agent-discipline");
const PRE_EDIT = join(PLUGIN, "scripts", "pre-edit.mjs");
const POST_EDIT = join(PLUGIN, "scripts", "post-edit.mjs");
const STOP_CHECK = join(PLUGIN, "scripts", "stop-check.mjs");
const COLLECT = join(PLUGIN, "skills", "audit", "collect.mjs");

const tempDirs = [];
after(() => { for (const d of tempDirs) rmSync(d, { recursive: true, force: true }); });

// Creates a temp project from a { relativePath: content } map.
// `name` becomes the project folder name, for tests where the path itself matters.
export function project(files = {}, { name = "app" } = {}) {
  const base = mkdtempSync(join(tmpdir(), "adk-"));
  tempDirs.push(base);
  const root = join(base, name);
  mkdirSync(root, { recursive: true });
  for (const [path, content] of Object.entries(files)) write(root, path, content);
  return root;
}

export function write(root, path, content) {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
  return full;
}

// Installs a fake executable. `body` is POSIX shell.
export function fakeBin(dir, name, body) {
  const full = join(dir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(full, `#!/bin/sh\n${body}\n`);
  chmodSync(full, 0o755);
  return full;
}

export const fakeLocalBin = (root, name, body) => fakeBin(join(root, "node_modules", ".bin"), name, body);

const git = (root, ...args) => {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
};

export function gitInit(root) {
  git(root, "init", "-q");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test");
  git(root, "config", "commit.gpgsign", "false");
  return root;
}

export function gitCommitAll(root) {
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "fixture");
}

// Strip variables from the surrounding session or CI so they can't change script behaviour.
function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of ["CLAUDE_PROJECT_DIR", "CI", "GITHUB_ACTIONS"]) delete env[k];
  return { ...env, ...extra };
}

// Session state goes to the temp folder, so point that somewhere this run cleans up.
const sessionTmp = mkdtempSync(join(tmpdir(), "adk-sessions-"));
tempDirs.push(sessionTmp);

function runHook(script, root, input, env) {
  const r = spawnSync(process.execPath, [script], {
    cwd: root,
    input: JSON.stringify({ cwd: root, ...input }),
    encoding: "utf8",
    env: cleanEnv({ CLAUDE_PROJECT_DIR: root, TMPDIR: sessionTmp, ...env }),
  });
  return { code: r.status, stderr: r.stderr, stdout: r.stdout, output: r.stdout + r.stderr };
}

// The PreToolUse hook for an edit that hasn't happened yet.
export const preEdit = (root, path, { session = "s1", env } = {}) =>
  runHook(PRE_EDIT, root, { session_id: session, tool_name: "Write", tool_input: { file_path: join(root, path) } }, env);

// Simulates an Edit: the file is written to disk, then the PostToolUse hook runs.
export function edit(root, path, content, { session = "s1", env } = {}) {
  const file = write(root, path, content);
  return runHook(POST_EDIT, root, { session_id: session, tool_name: "Write", tool_input: { file_path: file, content } }, env);
}

export const stop = (root, { session = "s1", active = false, env } = {}) =>
  runHook(STOP_CHECK, root, { session_id: session, stop_hook_active: active }, env);

export function collect(root, args = ["--offline", "--no-tests"], { binDir, env } = {}) {
  const path = binDir ? `${binDir}:${process.env.PATH}` : process.env.PATH;
  const r = spawnSync(process.execPath, [COLLECT, ".", ...args], {
    cwd: root,
    encoding: "utf8",
    env: cleanEnv({ PATH: path, ...env }),
  });
  const raw = join(root, ".audit", "raw");
  return {
    code: r.status,
    output: r.stdout + r.stderr,
    summary: JSON.parse(readFileSync(join(raw, "summary.json"), "utf8")),
    raw: (name) => readFileSync(join(raw, name), "utf8"),
  };
}

// Built at runtime so secret scanners don't flag this repo's own tests.
export const FAKE_AWS_KEY = ["AKIA", "ABCDEFGHIJKLMNOP"].join("");
