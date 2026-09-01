import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { TestCase } from "../lib/contracts.ts";
import {
  beginDirtySourceSession,
  dockStructureFingerprint,
  endDirtySourceSession,
  terminalProcessOutput,
} from "../lib/runtime.ts";

function source(relativePath: string): string {
  return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

function row(status: TestCase["status"] = "unknown"): TestCase {
  return {
    id: "fake:case",
    nativeId: "case",
    label: "case",
    adapterId: "fake",
    suite: ["suite"],
    source: { path: "/repo/tests.ts", line: 1 },
    status,
  };
}

test("dirty source invalidation runs once per edit session and resets on save", () => {
  const dirty = new Set<string>();

  assert.equal(beginDirtySourceSession(dirty, "/repo/tests.ts", false), false);
  assert.equal(beginDirtySourceSession(dirty, "/repo/tests.ts", true), true);
  assert.equal(beginDirtySourceSession(dirty, "/repo/tests.ts", true), false);
  assert.equal(endDirtySourceSession(dirty, "/repo/tests.ts"), true);
  assert.equal(beginDirtySourceSession(dirty, "/repo/tests.ts", true), true);
});

test("Fresh edit wiring uses batched lines_changed and repaints only the saved buffer", () => {
  const entry = source("fresh-test-observatory.ts");

  assert.match(entry, /editor\.on\("lines_changed",/);
  assert.match(entry, /editor\.isBufferModified\(bufferId\)/);
  assert.doesNotMatch(entry, /editor\.on\("after_(?:insert|delete)",/);
  assert.match(entry, /paintTestState\(new Set\(\[event\.buffer_id\]\)\)/);
  assert.doesNotMatch(entry, /function invalidateDecorations[\s\S]*?void paintTestState\(\)/);
});

test("dock structure fingerprint ignores message-only updates but detects tree changes", () => {
  const base = {
    tests: [row()],
    busy: true,
    showOutput: false,
    coverageVisible: false,
    filter: "",
    failedOnly: false,
    sortMode: "name",
  };
  const original = dockStructureFingerprint(base);
  const messageOnly = dockStructureFingerprint({
    ...base,
    tests: [{ ...row(), message: "progress changed" }],
  });
  const statusChanged = dockStructureFingerprint({ ...base, tests: [row("passed")] });

  assert.equal(messageOnly, original);
  assert.notEqual(statusChanged, original);
  assert.notEqual(dockStructureFingerprint({ ...base, busy: false }), original);

  const entry = source("fresh-test-observatory.ts");
  assert.match(entry, /kind: "setRawEntries"/);
  assert.match(entry, /kind: "setItems"/);
  assert.match(entry, /if \(!mutateDock\(snapshot\)\) renderDock\(\)/);
});

test("terminal capture prefers the complete terminal buffer and has a last-line fallback", () => {
  assert.deepEqual(
    terminalProcessOutput(
      "first result\nsecond result\n\u001b[32msummary\u001b[0m\n",
      ["progress 10%", "progress 90%", "summary"],
      0,
    ),
    {
      stdout: "first result\nsecond result\nsummary",
      stderr: "",
      exitCode: 0,
    },
  );
  assert.deepEqual(terminalProcessOutput(undefined, ["failure", "summary"], null), {
    stdout: "failure\nsummary",
    stderr: "",
    exitCode: 0,
  });
  assert.equal(terminalProcessOutput("failed", [], 7).exitCode, 7);

  const entry = source("fresh-test-observatory.ts");
  assert.match(entry, /getBufferText\(waiter\.bufferId\)/);
  assert.match(entry, /terminalProcessOutput\(transcript, waiter\.fallbackLines, exitCode\)/);
});

test("README names every public command, dock key, setting, and status token", () => {
  const readme = source("README.md");
  const commands = [
    "Open",
    "Close",
    "Refresh",
    "Run All",
    "Run Selected",
    "Run Nearest",
    "Run Test at Cursor",
    "Run Current File",
    "Rerun Failed",
    "Run Selected in Terminal",
    "Run Nearest in Terminal",
    "Toggle Coverage",
    "Stop",
    "Go to Test or Failure",
    "Expand All",
    "Collapse All",
    "Filter",
    "Toggle Failed Only",
    "Toggle Name or Duration Sort",
    "Toggle Watch",
    "Next Failure",
    "Show Output",
    "Import Report",
    "Show Adapters",
  ];
  const keys = ["`r`", "`a`", "`n`", "`f`", "`x`", "`c`", "`]`", "`o`", "`w`", "`q`"];
  const settings = [
    "runOnSave",
    "coverageOnSave",
    "preferNextest",
    "noBuild",
    "noRestore",
    "reportDir",
    "dockWidth",
    "autoOpenOnFailure",
    "terminalRuns",
    "enabledAdapters",
    "coverageGoodThreshold",
    "coverageWarningThreshold",
    "dotnetVerbosity",
  ];

  for (const command of commands) assert.ok(readme.includes(command), command);
  for (const key of keys) assert.ok(readme.includes(key), key);
  for (const setting of settings) assert.ok(readme.includes(`\`${setting}\``), setting);
  assert.match(readme, /fresh-test-observatory:test-summary/);
  assert.match(readme, /Settings, Status Bar/);
  assert.match(readme, /name are intentionally the same/);
});

test("package metadata uses live canonical URLs", () => {
  const manifest = JSON.parse(source("package.json")) as {
    $schema: string;
    homepage: string;
  };

  assert.equal(
    manifest.$schema,
    "https://raw.githubusercontent.com/sinelaw/fresh/main/crates/fresh-editor/plugins/schemas/package.schema.json",
  );
  assert.equal(manifest.homepage, "https://github.com/willibrandon/fresh-test-observatory");
});

test("all controller and presentation translation keys exist in the locale file", () => {
  const locale = JSON.parse(source("fresh-test-observatory.i18n.json")) as {
    en: Record<string, string>;
  };
  const production = source("lib/controller.ts") + source("lib/model.ts");
  const keys = new Set(
    [...production.matchAll(/"((?:controller|run|coverage)\.[a-z_]+)"/g)].map((match) => match[1]!),
  );

  assert.ok(keys.size > 20);
  assert.deepEqual(
    [...keys].filter((key) => !(key in locale.en)),
    [],
  );
});
