import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import type { TestCase } from "../lib/contracts.ts";
import {
  beginDirtySourceSession,
  captureTerminalProcessOutput,
  dockStructureFingerprint,
  endDirtySourceSession,
  mergeProcessExitCode,
  mutateDockContent,
  registerSourceLifecycleEvents,
  sourceSaveAction,
  terminalProcessOutput,
  updateDock,
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

test("source lifecycle wiring maps batched edits, saves, and reverts", () => {
  const registered: string[] = [];
  const calls: string[] = [];

  registerSourceLifecycleEvents(
    (eventName, handler) => {
      registered.push(eventName);
      const event = { path: "/repo/tests.ts", buffer_id: 17 };
      handler(event);
    },
    {
      linesChanged: (bufferId) => calls.push(`changed:${bufferId}`),
      fileSaved: (path, bufferId) => calls.push(`saved:${path}:${bufferId}`),
      fileReverted: (path, bufferId) => calls.push(`reverted:${path}:${bufferId}`),
    },
  );

  assert.deepEqual(registered, ["lines_changed", "after_file_save", "after_file_revert"]);
  assert.deepEqual(calls, ["changed:17", "saved:/repo/tests.ts:17", "reverted:/repo/tests.ts:17"]);
});

test("source save action runs watched saves and otherwise repaints only a dirty buffer", () => {
  const dirty = new Set<string>();

  assert.deepEqual(sourceSaveAction(dirty, "/repo/tests.ts", 17, false), { kind: "none" });
  dirty.add("/repo/tests.ts");
  assert.deepEqual(sourceSaveAction(dirty, "/repo/tests.ts", 17, false), {
    kind: "repaint",
    bufferId: 17,
  });
  assert.equal(dirty.has("/repo/tests.ts"), false);
  assert.deepEqual(sourceSaveAction(dirty, "/repo/tests.ts", 17, true), { kind: "run" });
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
});

test("dock content mutates in place and rebuilds only when mutation is unavailable", () => {
  const outputMutations: unknown[] = [];
  assert.equal(
    mutateDockContent(
      (mutation) => {
        outputMutations.push(mutation);
        return true;
      },
      {
        showOutput: true,
        outputWidgetKey: "output",
        outputEntries: [{ text: "first" }, { text: "second" }],
        titleWidgetKey: "title",
        titleEntries: [{ text: "title" }],
        detailsWidgetKey: "details",
        detailEntries: [{ text: "details" }],
      },
    ),
    true,
  );
  assert.deepEqual(outputMutations, [
    {
      kind: "setItems",
      widgetKey: "output",
      items: [{ text: "first" }, { text: "second" }],
      itemKeys: ["output:0", "output:1"],
    },
  ]);

  const dockMutations: unknown[] = [];
  const mutated = mutateDockContent(
    (mutation) => {
      dockMutations.push(mutation);
      return mutation.widgetKey !== "details";
    },
    {
      showOutput: false,
      outputWidgetKey: "output",
      outputEntries: [],
      titleWidgetKey: "title",
      titleEntries: [{ text: "title" }],
      detailsWidgetKey: "details",
      detailEntries: [{ text: "details" }],
    },
  );
  assert.equal(mutated, false);
  assert.deepEqual(
    dockMutations.map((mutation) => (mutation as { widgetKey: string }).widgetKey),
    ["title", "details"],
  );

  let rebuilds = 0;
  updateDock(
    () => true,
    () => {
      rebuilds += 1;
    },
  );
  updateDock(
    () => false,
    () => {
      rebuilds += 1;
    },
  );
  assert.equal(rebuilds, 1);
});

test("terminal capture reads the complete buffer and falls back after a read failure", async () => {
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
    exitCode: -1,
  });
  assert.equal(terminalProcessOutput("failed", [], 7).exitCode, 7);

  const requestedBufferIds: number[] = [];
  assert.deepEqual(
    await captureTerminalProcessOutput(
      async (bufferId) => {
        requestedBufferIds.push(bufferId);
        return "complete\n\u001b[32mpassed\u001b[0m\n";
      },
      29,
      ["partial"],
      null,
    ),
    { stdout: "complete\npassed", stderr: "", exitCode: -1 },
  );
  assert.deepEqual(requestedBufferIds, [29]);

  assert.deepEqual(
    await captureTerminalProcessOutput(
      async () => {
        throw new Error("buffer closed");
      },
      30,
      ["fallback", "failed"],
      2,
    ),
    { stdout: "fallback\nfailed", stderr: "", exitCode: 2 },
  );

  assert.equal(mergeProcessExitCode(0, -1), -1);
  assert.equal(mergeProcessExitCode(-1, 0), -1);
  assert.equal(mergeProcessExitCode(-1, 3), 3);
  assert.equal(mergeProcessExitCode(2, -1), 2);
  assert.equal(mergeProcessExitCode(-1, -9), -9);
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

  for (const command of commands) {
    assert.ok(readme.includes(`\`Test Observatory: ${command}\``), command);
  }
  for (const key of keys) assert.ok(readme.includes(key), key);
  for (const setting of settings) assert.ok(readme.includes(`\`${setting}\``), setting);
  assert.match(readme, /fresh-test-observatory:test-summary/);
  assert.match(readme, /Settings, Status Bar/);
  assert.ok(readme.includes("[Fresh](https://github.com/sinelaw/fresh)"));
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

test("local installation removes stale and excluded package files", () => {
  const installer = source("scripts/install-local.sh");

  assert.match(installer, /--delete\s/);
  assert.match(installer, /--delete-excluded\s/);
  assert.match(installer, /--exclude 'REVIEW\.md'/);
  assert.match(installer, /--exclude '\.testagent\/'/);
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
