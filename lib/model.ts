import type { CoverageFile, TestCase, TestScope, TestStatus, TestSummary } from "./contracts.ts";
import { normalizePath, pathKey } from "./path.ts";

export interface TestTreeRow {
  key: string;
  label: string;
  depth: number;
  hasChildren: boolean;
  testId?: string;
  status: TestStatus;
}

export interface TestSelectionContext {
  activeFile?: string;
  activeLine?: number;
  selectedTestId?: string;
}

export interface TestTreeSelection {
  treeKey?: string;
  testId?: string;
}

export interface RunPresentation {
  summaryTestIds: ReadonlySet<string>;
  selectedTestId?: string;
  selectedTreeKey?: string;
}

export interface CoverageSummary {
  files: number;
  totalLines: number;
  coveredLines: number;
  percent: number;
}

export type MessageFormatter = (key: string, params?: Readonly<Record<string, string>>) => string;

export type TreeExpansionMode = "all" | "none" | "manual";
export type TestSortMode = "name" | "duration";

const STATUS_ORDER: Record<TestStatus, number> = {
  failed: 6,
  running: 5,
  queued: 4,
  skipped: 3,
  passed: 2,
  unknown: 1,
};

/** Returns whether the cached discovery belongs to Fresh's active workspace. */
export function workspaceDiscoveryIsCurrent(
  discoveryRoot: string | undefined,
  currentRoot: string,
): boolean {
  return discoveryRoot !== undefined && pathKey(discoveryRoot) === pathKey(currentRoot);
}

/** Resolves a command scope without coupling adapter logic to the dock. */
export function selectTestsForScope(
  tests: readonly TestCase[],
  scope: TestScope,
  context: TestSelectionContext = {},
): TestCase[] {
  if (scope === "workspace") return [...tests];
  if (scope === "failed") return tests.filter((test) => test.status === "failed");
  if (scope === "selected") {
    const selected = tests.find((test) => test.id === context.selectedTestId);
    return selected ? [selected] : [];
  }
  if (!context.activeFile) return [];
  if (scope === "file") return testsForFile(tests, context.activeFile);
  const nearest = nearestTest(tests, context.activeFile, context.activeLine ?? 1);
  return nearest ? [nearest] : [];
}

/** Describes which results a run summarizes and whether it should move tree focus. */
export function runPresentation(scope: TestScope, selection: readonly TestCase[]): RunPresentation {
  const summaryTestIds = new Set(selection.map((test) => test.id));
  const focused =
    (scope === "selected" || scope === "nearest") && selection.length === 1
      ? selection[0]
      : undefined;
  return {
    summaryTestIds,
    ...(focused ? { selectedTestId: focused.id, selectedTreeKey: `test:${focused.id}` } : {}),
  };
}

/** A branch row intentionally has no test id, which clears the detail pane. */
export function treeSelectionAt(rows: readonly TestTreeRow[], index: number): TestTreeSelection {
  const row = rows[index];
  return row ? { treeKey: row.key, ...(row.testId ? { testId: row.testId } : {}) } : {};
}

/** Resolves branch expansion while retaining only keys present after a rerender. */
export function resolveExpandedTreeKeys(
  rows: readonly TestTreeRow[],
  mode: TreeExpansionMode,
  manuallyExpanded: ReadonlySet<string> = new Set(),
): string[] {
  const branchKeys = rows.filter((row) => row.hasChildren).map((row) => row.key);
  if (mode === "all") return branchKeys;
  if (mode === "none") return [];
  return branchKeys.filter((key) => manuallyExpanded.has(key));
}

export function summarizeTests(tests: readonly TestCase[]): TestSummary {
  const summary: TestSummary = {
    total: tests.length,
    unknown: 0,
    queued: 0,
    running: 0,
    passed: 0,
    failed: 0,
    skipped: 0,
    durationMs: 0,
  };
  for (const test of tests) {
    summary[test.status] += 1;
    summary.durationMs += test.durationMs ?? 0;
  }
  return summary;
}

/** Summarizes the most recent run without discarding results elsewhere in the tree. */
export function summarizeTestsForIds(
  tests: readonly TestCase[],
  ids: ReadonlySet<string> | undefined,
): TestSummary {
  return summarizeTests(ids ? tests.filter((test) => ids.has(test.id)) : tests);
}

/** Produces narrow-dock-friendly run details when no individual result is focused. */
export function formatRunSummary(
  summary: TestSummary,
  translate: MessageFormatter = defaultPresentationMessage,
): string[] {
  const duration =
    summary.durationMs > 0
      ? summary.durationMs < 1000
        ? `${Math.round(summary.durationMs)} ms`
        : `${(summary.durationMs / 1000).toFixed(2)} s`
      : "";
  const totalKey =
    summary.total === 1
      ? duration
        ? "run.one_test_duration"
        : "run.one_test"
      : duration
        ? "run.many_tests_duration"
        : "run.many_tests";
  return [
    translate("run.complete"),
    translate("run.counts", {
      passed: String(summary.passed),
      failed: String(summary.failed),
      skipped: String(summary.skipped),
    }),
    translate(totalKey, {
      total: String(summary.total),
      ...(duration ? { duration } : {}),
    }),
    ...(summary.unknown > 0
      ? [translate("run.unreported", { unknown: String(summary.unknown) })]
      : []),
  ];
}

/** Counts executable lines in the merged coverage model. */
export function summarizeCoverage(files: readonly CoverageFile[]): CoverageSummary {
  const totalLines = files.reduce((total, file) => total + file.lines.length, 0);
  const coveredLines = files.reduce(
    (total, file) => total + file.lines.filter((line) => line.hits > 0).length,
    0,
  );
  return {
    files: files.length,
    totalLines,
    coveredLines,
    percent: totalLines > 0 ? Math.round((coveredLines / totalLines) * 100) : 0,
  };
}

/** Explains collected coverage even when the active file has no executable records. */
export function formatCoverageDetails(
  files: readonly CoverageFile[],
  activeFile?: string,
  translate: MessageFormatter = defaultPresentationMessage,
): string[] {
  if (files.length === 0) return [translate("coverage.none")];
  const summary = summarizeCoverage(files);
  const active = activeFile
    ? files.find((file) => pathKey(file.path) === pathKey(activeFile))
    : undefined;
  const lines = [
    translate("coverage.summary", {
      covered: String(summary.coveredLines),
      total: String(summary.totalLines),
      percent: String(summary.percent),
    }),
    translate(summary.files === 1 ? "coverage.one_file" : "coverage.many_files", {
      files: String(summary.files),
    }),
  ];
  if (active) {
    const current = summarizeCoverage([active]);
    lines.push(
      translate("coverage.current", {
        covered: String(current.coveredLines),
        total: String(current.totalLines),
        percent: String(current.percent),
      }),
    );
    lines.push(translate("coverage.legend"));
  } else if (activeFile) {
    lines.push(translate("coverage.no_current"));
    lines.push(translate("coverage.open_covered"));
  }
  lines.push(translate("coverage.explorer"));
  return lines;
}

const PRESENTATION_ENGLISH: Readonly<Record<string, string>> = {
  "run.complete": "Run complete",
  "run.counts": "%{passed} passed, %{failed} failed, %{skipped} skipped",
  "run.one_test": "%{total} test",
  "run.many_tests": "%{total} tests",
  "run.one_test_duration": "%{total} test in %{duration}",
  "run.many_tests_duration": "%{total} tests in %{duration}",
  "run.unreported": "%{unknown} results not reported",
  "coverage.none": "No coverage report was produced.",
  "coverage.summary": "Coverage: %{covered}/%{total} lines (%{percent}%)",
  "coverage.one_file": "%{files} source file",
  "coverage.many_files": "%{files} source files",
  "coverage.current": "Current file: %{covered}/%{total} lines (%{percent}%)",
  "coverage.legend": "Green covered · red uncovered",
  "coverage.no_current": "No data for the current file",
  "coverage.open_covered": "Open a covered source file",
  "coverage.explorer": "Explorer shows file percentages",
};

function defaultPresentationMessage(
  key: string,
  params: Readonly<Record<string, string>> = {},
): string {
  return (PRESENTATION_ENGLISH[key] ?? key).replace(/%\{([^}]+)\}/g, (_, name: string) => {
    return params[name] ?? `%{${name}}`;
  });
}

export function mergeDiscoveredTests(
  current: readonly TestCase[],
  discovered: readonly TestCase[],
): TestCase[] {
  const oldById = new Map(current.map((test) => [test.id, test]));
  return deduplicateTests(discovered).map((test) => {
    const old = oldById.get(test.id);
    if (!old) return test;
    return {
      ...test,
      status: old.status,
      ...(old.durationMs !== undefined ? { durationMs: old.durationMs } : {}),
      ...(old.message !== undefined ? { message: old.message } : {}),
      ...(old.stack !== undefined ? { stack: old.stack } : {}),
    };
  });
}

export function applyRunResults(
  current: readonly TestCase[],
  results: readonly TestCase[],
  adapterId?: string,
): TestCase[] {
  const byId = new Map(results.map((test) => [test.id, test]));
  const byNative = new Map(results.map((test) => [`${test.adapterId}\0${test.nativeId}`, test]));
  const seen = new Set<string>();
  const merged = current.map((test) => {
    const result = byId.get(test.id) ?? byNative.get(`${test.adapterId}\0${test.nativeId}`);
    if (!result) {
      return adapterId && test.adapterId === adapterId && test.status === "running"
        ? { ...test, status: "unknown" as const }
        : test;
    }
    seen.add(result.id);
    const combined: TestCase = {
      ...test,
      ...result,
    };
    if (result.status === "passed") {
      delete combined.message;
      delete combined.stack;
    }
    if (!result.source && test.source) combined.source = test.source;
    if (!result.suite && test.suite) combined.suite = test.suite;
    if (!result.project && test.project) combined.project = test.project;
    if (!result.framework && test.framework) combined.framework = test.framework;
    return combined;
  });
  const mergedIds = new Set(merged.map((test) => test.id));
  for (const result of results) {
    if (!seen.has(result.id) && !mergedIds.has(result.id)) {
      merged.push(result);
      mergedIds.add(result.id);
    }
  }
  return deduplicateTests(merged);
}

export function markTests(
  tests: readonly TestCase[],
  ids: ReadonlySet<string>,
  status: TestStatus,
): TestCase[] {
  return tests.map((test) => (ids.has(test.id) ? { ...test, status } : test));
}

export function nearestTest(
  tests: readonly TestCase[],
  path: string,
  line: number,
): TestCase | undefined {
  const normalized = pathKey(path);
  const candidates = tests.filter(
    (test) => test.source && pathKey(test.source.path) === normalized,
  );
  candidates.sort((left, right) => {
    const leftLine = left.source!.line;
    const rightLine = right.source!.line;
    const leftAfter = leftLine > line ? 1 : 0;
    const rightAfter = rightLine > line ? 1 : 0;
    return leftAfter - rightAfter || Math.abs(line - leftLine) - Math.abs(line - rightLine);
  });
  return candidates[0];
}

export function testsForFile(tests: readonly TestCase[], path: string): TestCase[] {
  const normalized = pathKey(path);
  return tests.filter((test) => test.source && pathKey(test.source.path) === normalized);
}

export function buildTestTree(
  tests: readonly TestCase[],
  sortMode: TestSortMode = "name",
): TestTreeRow[] {
  type Branch = {
    key: string;
    label: string;
    status: TestStatus;
    tests: TestCase[];
    children: Map<string, Branch>;
  };
  const roots = new Map<string, Branch>();
  const testById = new Map(tests.map((test) => [test.id, test]));
  const childrenByParent = new Map<string, TestCase[]>();

  for (const test of tests) {
    if (!test.parentId || !testById.has(test.parentId)) continue;
    const children = childrenByParent.get(test.parentId) ?? [];
    children.push(test);
    childrenByParent.set(test.parentId, children);
  }

  function branch(parent: Map<string, Branch>, key: string, label: string): Branch {
    let value = parent.get(key);
    if (!value) {
      value = { key, label, status: "unknown", tests: [], children: new Map() };
      parent.set(key, value);
    }
    return value;
  }

  const compareForTree =
    sortMode === "duration"
      ? (left: TestCase, right: TestCase): number =>
          (right.durationMs ?? -1) - (left.durationMs ?? -1) || compareTests(left, right)
      : compareTests;

  for (const test of [...tests].sort(compareForTree)) {
    if (test.parentId && testById.has(test.parentId)) continue;
    let current = branch(roots, `adapter:${test.adapterId}`, test.adapterId);
    const segments = test.suite?.filter(Boolean) ?? [];
    for (let index = 0; index < segments.length; index += 1) {
      const label = segments[index]!;
      const key = `${current.key}/${segments.slice(0, index + 1).join("::")}`;
      current = branch(current.children, key, label);
    }
    current.tests.push(test);
  }

  function aggregate(node: Branch): TestStatus {
    const statuses = [
      ...node.tests.map((test) => test.status),
      ...[...node.children.values()].map(aggregate),
    ];
    node.status = statuses.sort((a, b) => STATUS_ORDER[b] - STATUS_ORDER[a])[0] ?? "unknown";
    return node.status;
  }

  function emit(node: Branch, depth: number, rows: TestTreeRow[]): void {
    const childBranches = [...node.children.values()].sort((a, b) =>
      a.label.localeCompare(b.label),
    );
    rows.push({
      key: node.key,
      label: node.label,
      depth,
      hasChildren: childBranches.length > 0 || node.tests.length > 0,
      status: node.status,
    });
    for (const child of childBranches) emit(child, depth + 1, rows);
    function emitTest(test: TestCase, testDepth: number): void {
      const cases = (childrenByParent.get(test.id) ?? []).sort(compareForTree);
      rows.push({
        key: `test:${test.id}`,
        label: test.label,
        depth: testDepth,
        hasChildren: cases.length > 0,
        testId: test.id,
        status: test.status,
      });
      for (const child of cases) emitTest(child, testDepth + 1);
    }
    for (const test of node.tests.sort(compareForTree)) {
      emitTest(test, depth + 1);
    }
  }

  const rows: TestTreeRow[] = [];
  for (const root of [...roots.values()].sort((a, b) => a.label.localeCompare(b.label))) {
    aggregate(root);
    emit(root, 0, rows);
  }
  return rows;
}

export function mergeCoverage(files: readonly CoverageFile[]): CoverageFile[] {
  const merged = new Map<
    string,
    { path: string; lines: Map<number, { hits: number; branchRate?: number }> }
  >();
  for (const file of files) {
    const path = normalizePath(file.path);
    const key = pathKey(path);
    let entry = merged.get(key);
    if (!entry) {
      entry = { path, lines: new Map() };
      merged.set(key, entry);
    }
    const lines = entry.lines;
    for (const line of file.lines) {
      const current = lines.get(line.line);
      const branchRate = line.branchRate ?? current?.branchRate;
      lines.set(line.line, {
        hits: Math.max(current?.hits ?? 0, line.hits),
        ...(branchRate !== undefined ? { branchRate } : {}),
      });
    }
  }
  return [...merged.values()]
    .sort((left, right) => pathKey(left.path).localeCompare(pathKey(right.path)))
    .map((entry) => ({
      path: entry.path,
      lines: [...entry.lines.entries()]
        .sort(([left], [right]) => left - right)
        .map(([line, data]) => ({ line, ...data })),
    }));
}

function deduplicateTests(tests: readonly TestCase[]): TestCase[] {
  const unique = new Map<string, TestCase>();
  for (const test of tests) {
    const existing = unique.get(test.id);
    if (!existing) {
      unique.set(test.id, test);
      continue;
    }
    const combined: TestCase = { ...existing, ...test };
    if (!test.source && existing.source) combined.source = existing.source;
    unique.set(test.id, combined);
  }
  return [...unique.values()].sort(compareTests);
}

function compareTests(left: TestCase, right: TestCase): number {
  return (
    left.adapterId.localeCompare(right.adapterId) ||
    (left.project ?? "").localeCompare(right.project ?? "") ||
    left.nativeId.localeCompare(right.nativeId)
  );
}
