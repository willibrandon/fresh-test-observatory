import assert from "node:assert/strict";
import test from "node:test";
import type { TestCase } from "../lib/contracts.ts";
import {
  applyRunResults,
  buildTestTree,
  formatCoverageDetails,
  formatRunSummary,
  mergeCoverage,
  mergeDiscoveredTests,
  nearestTest,
  resolveExpandedTreeKeys,
  runPresentation,
  selectTestsForScope,
  summarizeTests,
  summarizeTestsForIds,
  summarizeCoverage,
  testsForFile,
  treeSelectionAt,
  workspaceDiscoveryIsCurrent,
} from "../lib/model.ts";
import {
  basename,
  dirname,
  isWithin,
  joinPath,
  normalizePath,
  pathKey,
  relativePath,
  resolvePath,
  safeName,
  stem,
} from "../lib/path.ts";

function sample(id: string, status: TestCase["status"], line = 1): TestCase {
  return {
    id: `adapter:${id}`,
    nativeId: id,
    label: id.split(".").at(-1)!,
    adapterId: "adapter",
    suite: ["project", "suite"],
    source: { path: "/repo/tests/example.cs", line },
    status,
  };
}

test("path helpers normalize separators without changing host-facing drive spelling", () => {
  assert.equal(normalizePath("C:\\repo\\src\\..\\tests\\a.cs"), "C:/repo/tests/a.cs");
  assert.equal(pathKey("C:\\Repo\\tests\\a.cs"), "c:/repo/tests/a.cs");
  assert.equal(joinPath("/repo/", "./src", "a.ts"), "/repo/src/a.ts");
  assert.equal(dirname("C:/repo/a.cs"), "C:/repo");
  assert.equal(basename("/repo/a.test.ts"), "a.test.ts");
  assert.equal(stem("/repo/a.test.ts"), "a.test");
  assert.equal(safeName("/repo/My Tests.csproj"), "My-Tests");
});

test("path helpers distinguish path boundaries and preserve external paths", () => {
  assert.equal(isWithin("/repo/app", "/repo/application/file"), false);
  assert.equal(isWithin("/repo/app", "/repo/app/file"), true);
  assert.equal(relativePath("/repo", "/repo/src/file.go"), "src/file.go");
  assert.equal(resolvePath("/repo", "src/file.go"), "/repo/src/file.go");
  assert.equal(resolvePath("/repo", "/tmp/file.go"), "/tmp/file.go");
  assert.equal(resolvePath("C:\\Repo", "tests\\A.cs"), "C:/Repo/tests/A.cs");
});

test("workspaceDiscoveryIsCurrent invalidates cached adapters after Fresh changes roots", () => {
  assert.equal(workspaceDiscoveryIsCurrent(undefined, "/repo"), false);
  assert.equal(workspaceDiscoveryIsCurrent("/repo/fixtures", "/repo"), false);
  assert.equal(workspaceDiscoveryIsCurrent("C:\\repo\\project", "c:/repo/project/./"), true);
});

test("selectTestsForScope runs only the test selected in the Observatory tree", () => {
  const first = sample("first", "passed");
  const second = sample("second", "failed");
  assert.deepEqual(
    selectTestsForScope([first, second], "selected", { selectedTestId: second.id }).map(
      (item) => item.id,
    ),
    [second.id],
  );
  assert.deepEqual(selectTestsForScope([first, second], "selected"), []);
});

test("Selected run resets the summary to one test and focuses its result", () => {
  const rust = sample("rust", "passed");
  const selected = sample("selected", "unknown");
  const presentation = runPresentation("selected", [selected]);
  const completed = applyRunResults(
    [rust, selected],
    [{ ...selected, status: "passed", durationMs: 4 }],
  );

  assert.deepEqual(summarizeTestsForIds(completed, presentation.summaryTestIds), {
    total: 1,
    unknown: 0,
    queued: 0,
    running: 0,
    passed: 1,
    failed: 0,
    skipped: 0,
    durationMs: 4,
  });
  assert.equal(presentation.selectedTestId, selected.id);
  assert.equal(presentation.selectedTreeKey, `test:${selected.id}`);
});

test("Nearest run resets the summary and focuses the test nearest the cursor", () => {
  const rust = sample("rust", "passed", 10);
  const nearest = sample("go", "unknown", 30);
  nearest.source = { path: "/repo/calculator_test.go", line: 30 };
  const selection = selectTestsForScope([rust, nearest], "nearest", {
    activeFile: "/repo/calculator_test.go",
    activeLine: 32,
  });
  const presentation = runPresentation("nearest", selection);
  const completed = applyRunResults(
    [rust, nearest],
    [{ ...nearest, status: "failed", message: "want 5" }],
  );

  assert.deepEqual(summarizeTestsForIds(completed, presentation.summaryTestIds), {
    total: 1,
    unknown: 0,
    queued: 0,
    running: 0,
    passed: 0,
    failed: 1,
    skipped: 0,
    durationMs: 0,
  });
  assert.equal(presentation.selectedTestId, nearest.id);
  assert.equal(presentation.selectedTreeKey, `test:${nearest.id}`);
});

test("Run All clears stale test detail and formats a useful run summary", () => {
  const tests = [
    ...Array.from({ length: 7 }, (_, index) => sample(`pass-${index}`, "passed")),
    ...Array.from({ length: 3 }, (_, index) => sample(`skip-${index}`, "skipped")),
  ];
  tests[0]!.durationMs = 26;
  const presentation = runPresentation("workspace", tests);

  assert.equal(presentation.selectedTestId, undefined);
  assert.equal(presentation.selectedTreeKey, undefined);
  assert.deepEqual(formatRunSummary(summarizeTestsForIds(tests, presentation.summaryTestIds)), [
    "Run complete",
    "7 passed, 0 failed, 3 skipped",
    "10 tests in 26 ms",
  ]);
});

test("coverage details explain when the current file has no coverage data", () => {
  const files = [
    {
      path: "/repo/calculator.go",
      lines: [
        { line: 3, hits: 1 },
        { line: 4, hits: 0 },
      ],
    },
    { path: "/repo/lib.rs", lines: [{ line: 1, hits: 2 }] },
  ];

  assert.deepEqual(summarizeCoverage(files), {
    files: 2,
    totalLines: 3,
    coveredLines: 2,
    percent: 67,
  });
  assert.deepEqual(formatCoverageDetails(files, "/repo/calculator_test.go"), [
    "Coverage: 2/3 lines (67%)",
    "2 source files",
    "No data for the current file",
    "Open a covered source file",
    "Explorer shows file percentages",
  ]);
});

test("coverage details describe markers for a covered current file", () => {
  const files = [
    {
      path: "/repo/calculator.go",
      lines: [
        { line: 3, hits: 1 },
        { line: 4, hits: 0 },
      ],
    },
  ];

  assert.deepEqual(formatCoverageDetails(files, "/repo/./calculator.go"), [
    "Coverage: 1/2 lines (50%)",
    "1 source file",
    "Current file: 1/2 lines (50%)",
    "Green covered · red uncovered",
    "Explorer shows file percentages",
  ]);
});

test("run and coverage presentation use the supplied message formatter", () => {
  const seen: string[] = [];
  const translate = (key: string, params: Readonly<Record<string, string>> = {}): string => {
    seen.push(key);
    return `${key}:${Object.values(params).join("|")}`;
  };

  const summary = summarizeTests([sample("pass", "passed")]);
  assert.deepEqual(formatRunSummary(summary, translate), [
    "run.complete:",
    "run.counts:1|0|0",
    "run.one_test:1",
  ]);
  assert.deepEqual(
    formatCoverageDetails(
      [{ path: "/repo/a.ts", lines: [{ line: 1, hits: 1 }] }],
      "/repo/a.ts",
      translate,
    ),
    [
      "coverage.summary:1|1|100",
      "coverage.one_file:1",
      "coverage.current:1|1|100",
      "coverage.legend:",
      "coverage.explorer:",
    ],
  );
  assert.deepEqual(seen, [
    "run.complete",
    "run.counts",
    "run.one_test",
    "coverage.summary",
    "coverage.one_file",
    "coverage.current",
    "coverage.legend",
    "coverage.explorer",
  ]);
});

test("treeSelectionAt clears the displayed test when a branch node is selected", () => {
  const rows = buildTestTree([sample("Suite.Case", "passed")]);
  const branchIndex = rows.findIndex((row) => !row.testId);
  const testIndex = rows.findIndex((row) => row.testId);
  assert.deepEqual(treeSelectionAt(rows, branchIndex), { treeKey: rows[branchIndex]!.key });
  assert.deepEqual(treeSelectionAt(rows, testIndex), {
    treeKey: rows[testIndex]!.key,
    testId: rows[testIndex]!.testId,
  });
});

test("Expand All and Collapse All resolve every test branch across rerenders", () => {
  const initial = buildTestTree([sample("Suite.Case", "passed"), sample("Other.Case", "failed")]);
  const branchKeys = initial.filter((row) => row.hasChildren).map((row) => row.key);
  assert.deepEqual(resolveExpandedTreeKeys(initial, "all"), branchKeys);
  assert.deepEqual(resolveExpandedTreeKeys(initial, "none", new Set(branchKeys)), []);

  const retained = new Set([branchKeys[0]!, "branch-that-was-removed"]);
  assert.deepEqual(resolveExpandedTreeKeys(initial, "manual", retained), [branchKeys[0]!]);
});

test("summarizeTests counts every state and sums duration", () => {
  const tests = [sample("pass", "passed"), sample("fail", "failed"), sample("skip", "skipped")];
  tests[0]!.durationMs = 12;
  tests[1]!.durationMs = 8;
  assert.deepEqual(summarizeTests(tests), {
    total: 3,
    unknown: 0,
    queued: 0,
    running: 0,
    passed: 1,
    failed: 1,
    skipped: 1,
    durationMs: 20,
  });
});

test("mergeDiscoveredTests preserves prior execution state but refreshes source metadata", () => {
  const old = sample("suite.case", "failed", 10);
  old.message = "boom";
  const refreshed = sample("suite.case", "unknown", 25);
  refreshed.label = "renamed display";
  const merged = mergeDiscoveredTests([old], [refreshed]);
  assert.equal(merged[0]!.status, "failed");
  assert.equal(merged[0]!.message, "boom");
  assert.equal(merged[0]!.source!.line, 25);
  assert.equal(merged[0]!.label, "renamed display");
});

test("applyRunResults preserves discovery location and adds parameterized results", () => {
  const discovered = sample("Suite.Case", "running", 7);
  const result = { ...sample("Suite.Case", "passed", 1), source: undefined } as unknown as TestCase;
  delete result.source;
  const parameterized = sample("Suite.Case(value: 2)", "failed", 9);
  const merged = applyRunResults([discovered], [result, parameterized], "adapter");
  assert.equal(merged.find((item) => item.nativeId === "Suite.Case")!.source!.line, 7);
  assert.equal(merged.find((item) => item.nativeId === "Suite.Case")!.status, "passed");
  assert.equal(merged.find((item) => item.nativeId.includes("value"))!.status, "failed");
});

test("applyRunResults clears stale failure diagnostics after a passing rerun", () => {
  const failed = {
    ...sample("Suite.Case", "failed", 7),
    message: "expected 4",
    stack: "at Suite.Case",
  };
  const passed = sample("Suite.Case", "passed", 7);
  const [result] = applyRunResults([failed], [passed], "adapter");
  assert.equal(result!.status, "passed");
  assert.equal(result!.message, undefined);
  assert.equal(result!.stack, undefined);
});

test("nearestTest prefers the preceding test and testsForFile uses normalized paths", () => {
  const before = sample("before", "unknown", 10);
  const after = sample("after", "unknown", 22);
  assert.equal(nearestTest([after, before], "/repo/tests/./example.cs", 20)?.nativeId, "before");
  assert.deepEqual(
    testsForFile([before, after], "\\repo\\tests\\example.cs").map((item) => item.nativeId),
    ["before", "after"],
  );
});

test("buildTestTree aggregates failure state and emits stable test keys", () => {
  const rows = buildTestTree([sample("Suite.Pass", "passed"), sample("Suite.Fail", "failed")]);
  assert.equal(rows[0]!.status, "failed");
  assert.equal(rows.filter((row) => row.testId).length, 2);
  assert.ok(rows.some((row) => row.key === "test:adapter:Suite.Fail"));
});

test("buildTestTree nests concrete parameterized results below their aggregate parent", () => {
  const parent = sample("Suite.Theory", "failed");
  const first = { ...sample("Suite.Theory(1)", "failed"), parentId: parent.id };
  const second = { ...sample("Suite.Theory(2)", "passed"), parentId: parent.id };
  const rows = buildTestTree([parent, first, second]);
  const parentRow = rows.find((row) => row.testId === parent.id)!;
  const cases = rows.filter((row) => row.testId === first.id || row.testId === second.id);

  assert.equal(parentRow.hasChildren, true);
  assert.equal(cases.length, 2);
  assert.ok(cases.every((row) => row.depth === parentRow.depth + 1));
});

test("buildTestTree can order tests by longest duration first", () => {
  const quick = { ...sample("Suite.Quick", "passed"), durationMs: 2 };
  const slow = { ...sample("Suite.Slow", "passed"), durationMs: 40 };
  const rows = buildTestTree([quick, slow], "duration").filter((row) => row.testId);
  assert.deepEqual(
    rows.map((row) => row.testId),
    [slow.id, quick.id],
  );
});

test("applyRunResults remains linear enough for a ten-thousand-test workspace", () => {
  const current = Array.from({ length: 10_000 }, (_, index) =>
    sample(`Suite.Case${index}`, "running"),
  );
  const results = current.map((item) => ({ ...item, status: "passed" as const }));
  const started = performance.now();
  const merged = applyRunResults(current, results, "adapter");

  assert.equal(merged.length, 10_000);
  assert.equal(merged.at(-1)!.status, "passed");
  assert.ok(performance.now() - started < 2_000);
});

test("mergeCoverage coalesces duplicate lines without erasing branch data", () => {
  const merged = mergeCoverage([
    { path: "C:\\repo\\a.cs", lines: [{ line: 3, hits: 0, branchRate: 0.5 }] },
    {
      path: "c:/repo/a.cs",
      lines: [
        { line: 3, hits: 2 },
        { line: 4, hits: 1 },
      ],
    },
  ]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0]!.path, "C:/repo/a.cs");
  assert.deepEqual(merged[0]!.lines, [
    { line: 3, hits: 2, branchRate: 0.5 },
    { line: 4, hits: 1 },
  ]);
});
