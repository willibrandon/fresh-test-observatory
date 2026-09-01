import type {
  AdapterContext,
  AdapterRunResult,
  CoverageFile,
  RunRequest,
  TestCase,
  TestObservatoryAdapter,
  TestScope,
  TestSummary,
} from "./contracts.ts";
import {
  applyRunResults,
  markTests,
  mergeCoverage,
  mergeDiscoveredTests,
  runPresentation,
  selectTestsForScope,
  summarizeTestsForIds,
  type TestSelectionContext,
  workspaceDiscoveryIsCurrent,
} from "./model.ts";
import { pathKey } from "./path.ts";
import type { LiveActivity } from "./runtime.ts";

export interface ObservatoryPort {
  workspaceRoot(): string;
  trustLevel(): string;
  createContext(): AdapterContext;
  progress(message: string): void;
  changed(): void;
  cancelActiveProcess(): Promise<boolean>;
  translate?(key: string, params?: Readonly<Record<string, string>>): string;
}

export interface ObservatoryOutput {
  adapterId: string;
  text: string;
}

export interface ObservatorySnapshot {
  tests: readonly TestCase[];
  coverage: readonly CoverageFile[];
  diagnostics: readonly string[];
  outputs: readonly ObservatoryOutput[];
  activeAdapterIds: ReadonlySet<string>;
  busy: boolean;
  cancelled: boolean;
  progress: string;
  /** Present while an operation runs: its start time and streamed completion counts. */
  activity?: LiveActivity;
  discoveryRoot?: string;
  summaryTestIds?: ReadonlySet<string>;
  focusedTestId?: string;
}

/** The execution and registry state machine, isolated from Fresh's UI API. */
export class TestObservatoryController {
  private readonly port: ObservatoryPort;
  private readonly adapters = new Map<string, TestObservatoryAdapter>();
  private readonly activeAdapterIds = new Set<string>();
  private readonly reportOnlyAdapterIds = new Set<string>();
  private enabledAdapterIds: ReadonlySet<string> | undefined;
  private tests: TestCase[] = [];
  private coverage: CoverageFile[] = [];
  private diagnostics: string[] = [];
  private outputs: ObservatoryOutput[] = [];
  private busy = false;
  private cancelled = false;
  private cancelRequested = false;
  private progressMessage = "";
  private activity: LiveActivity | undefined;
  private discoveryRoot: string | undefined;
  private summaryTestIds: ReadonlySet<string> | undefined;
  private focusedTestId: string | undefined;

  constructor(port: ObservatoryPort, initialAdapters: readonly TestObservatoryAdapter[] = []) {
    this.port = port;
    for (const adapter of initialAdapters) this.adapters.set(adapter.id, adapter);
  }

  snapshot(): ObservatorySnapshot {
    return {
      tests: this.tests,
      coverage: this.coverage,
      diagnostics: this.diagnostics,
      outputs: this.outputs,
      activeAdapterIds: this.activeAdapterIds,
      busy: this.busy,
      cancelled: this.cancelled,
      progress: this.progressMessage,
      ...(this.activity ? { activity: { ...this.activity } } : {}),
      ...(this.discoveryRoot ? { discoveryRoot: this.discoveryRoot } : {}),
      ...(this.summaryTestIds ? { summaryTestIds: this.summaryTestIds } : {}),
      ...(this.focusedTestId ? { focusedTestId: this.focusedTestId } : {}),
    };
  }

  registerAdapter(adapter: TestObservatoryAdapter): boolean {
    if (!validAdapter(adapter)) return false;
    if (this.adapters.has(adapter.id)) this.removeAdapterState(adapter.id);
    this.reportOnlyAdapterIds.delete(adapter.id);
    this.adapters.set(adapter.id, adapter);
    this.notify();
    return true;
  }

  unregisterAdapter(id: string): boolean {
    const removed = this.adapters.delete(id);
    if (removed) {
      this.removeAdapterState(id);
      this.notify();
    }
    return removed;
  }

  listAdapters(): Array<{ id: string; label: string; priority: number }> {
    return this.orderedAdapters().map((adapter) => ({
      id: adapter.id,
      label: adapter.label,
      priority: adapter.priority ?? 0,
    }));
  }

  /** Limits built-in and contributed adapters without unregistering their APIs. */
  setEnabledAdapters(ids: readonly string[]): void {
    this.enabledAdapterIds = ids.length > 0 ? new Set(ids) : undefined;
    this.discoveryRoot = undefined;
    this.notify();
  }

  ingestTests(adapterId: string, imported: readonly TestCase[]): number {
    this.tests = applyRunResults(this.tests, imported);
    if (!this.adapters.has(adapterId)) this.reportOnlyAdapterIds.add(adapterId);
    this.summaryTestIds = new Set(imported.map((test) => test.id));
    this.focusedTestId = imported.length === 1 ? imported[0]?.id : undefined;
    this.notify();
    return imported.length;
  }

  ingestCoverage(imported: readonly CoverageFile[]): number {
    this.coverage = mergeCoverage([...this.coverage, ...imported]);
    this.notify();
    return this.coverage.length;
  }

  clearCoverage(): void {
    this.coverage = [];
    this.notify();
  }

  /** Removes stale coverage for one edited file while retaining other reports. */
  invalidateCoveragePath(path: string): boolean {
    const before = this.coverage.length;
    this.coverage = this.coverage.filter((file) => pathKey(file.path) !== pathKey(path));
    if (this.coverage.length === before) return false;
    this.notify();
    return true;
  }

  currentSummary(): TestSummary {
    return summarizeTestsForIds(this.tests, this.summaryTestIds);
  }

  async refresh(): Promise<number> {
    if (this.busy) return this.tests.length;
    this.beginOperation(this.text("controller.discovering"));
    try {
      const baseContext = this.port.createContext();
      const root = baseContext.cwd;
      const previous = workspaceDiscoveryIsCurrent(this.discoveryRoot, root) ? this.tests : [];
      const imported = this.tests.filter((test) => this.reportOnlyAdapterIds.has(test.adapterId));
      const detected = new Set<string>();
      const discoveredByAdapter = new Map<string, readonly TestCase[]>();
      // Adapters publish what they have as soon as they have it: source scans
      // arrive in milliseconds, runner listings later. Each publication renders.
      const publish = (): void => {
        this.tests = mergeDiscoveredTests(previous, [
          ...[...discoveredByAdapter.values()].flat(),
          ...imported,
        ]);
        this.notify();
      };
      const enabled = this.orderedAdapters().filter((adapter) => this.isEnabled(adapter.id));
      for (let index = 0; index < enabled.length; index += 1) {
        const adapter = enabled[index]!;
        if (this.cancelRequested) break;
        try {
          this.setProgress(
            this.text("controller.detecting_adapter", {
              adapter: adapter.label,
              current: String(index + 1),
              total: String(enabled.length),
            }),
          );
          if (!(await adapter.detect(baseContext))) continue;
          detected.add(adapter.id);
          this.setProgress(
            this.text("controller.discovering_adapter", {
              adapter: adapter.label,
              current: String(index + 1),
              total: String(enabled.length),
            }),
          );
          const context: AdapterContext = {
            ...baseContext,
            report: (partial) => {
              discoveredByAdapter.set(adapter.id, partial.tests);
              publish();
            },
            progress: (message) => this.setProgress(message),
            cancelled: () => this.cancelRequested,
          };
          const result = await adapter.discover(context);
          discoveredByAdapter.set(adapter.id, result.tests);
          if (result.diagnostics) this.diagnostics.push(...result.diagnostics);
          publish();
        } catch (error) {
          this.diagnostics.push(
            this.text("controller.adapter_error", {
              adapter: adapter.label,
              error: errorMessage(error),
            }),
          );
        }
      }
      if (pathKey(root) !== pathKey(this.port.workspaceRoot())) {
        this.discoveryRoot = undefined;
        this.activeAdapterIds.clear();
        this.tests = [];
        this.diagnostics = [this.text("controller.workspace_changed")];
        return 0;
      }
      publish();
      this.discoveryRoot = root;
      this.activeAdapterIds.clear();
      for (const id of detected) this.activeAdapterIds.add(id);
      this.summaryTestIds = undefined;
      this.focusedTestId = undefined;
      return this.tests.length;
    } finally {
      this.endOperation();
    }
  }

  async run(scope: TestScope, selectionContext: TestSelectionContext = {}): Promise<TestSummary> {
    if (this.busy) return this.currentSummary();
    if (
      !workspaceDiscoveryIsCurrent(this.discoveryRoot, this.port.workspaceRoot()) &&
      this.adapters.size > 0
    ) {
      await this.refresh();
    }
    if (!isTrustedWorkspace(this.port.trustLevel())) {
      this.diagnostics = [this.text("controller.trust_run")];
      this.notify();
      return this.currentSummary();
    }
    const selection = selectTestsForScope(this.tests, scope, selectionContext);
    if (scope !== "workspace" && selection.length === 0) {
      this.diagnostics = [this.text(emptySelectionKey(scope))];
      this.notify();
      return this.currentSummary();
    }
    const presentation = runPresentation(scope, selection);
    this.summaryTestIds = presentation.summaryTestIds;
    this.focusedTestId = presentation.selectedTestId;
    this.beginOperation(
      this.text(selection.length === 1 ? "controller.running_one" : "controller.running_many", {
        count: String(selection.length),
      }),
    );
    const runningIds = new Set(
      selection
        .filter(
          (test) =>
            this.activeAdapterIds.has(test.adapterId) &&
            !this.reportOnlyAdapterIds.has(test.adapterId),
        )
        .map((test) => test.id),
    );
    this.tests = markTests(this.tests, runningIds, "running");
    this.activity = { startedAt: Date.now(), completed: 0, total: runningIds.size };
    this.notify();
    try {
      const baseContext = this.port.createContext();
      const completedIds = new Set<string>();
      const context: AdapterContext = {
        ...baseContext,
        update: (result) => this.applyStreamedResult(result, runningIds, completedIds),
        progress: (message) => this.setProgress(message),
        cancelled: () => this.cancelRequested,
      };
      const runnableAdapterIds = new Set(selection.map((test) => test.adapterId));
      for (const adapterId of runnableAdapterIds) {
        if (this.reportOnlyAdapterIds.has(adapterId) || !this.activeAdapterIds.has(adapterId)) {
          this.diagnostics.push(
            this.text("controller.imported_not_runnable", { adapter: adapterId }),
          );
        }
      }
      const runnable = this.orderedAdapters().filter(
        (adapter) => this.isEnabled(adapter.id) && this.activeAdapterIds.has(adapter.id),
      );
      for (let index = 0; index < runnable.length; index += 1) {
        const adapter = runnable[index]!;
        if (this.cancelRequested) break;
        const adapterTests = selection.filter((test) => test.adapterId === adapter.id);
        if (adapterTests.length === 0) continue;
        this.setProgress(
          this.text("controller.running_adapter", {
            adapter: adapter.label,
            current: String(index + 1),
            total: String(runnable.length),
          }),
        );
        const request = createRunRequest(scope, adapterTests, selectionContext);
        try {
          const result = await adapter.run(context, request);
          this.applyAdapterResult(adapter, adapterTests, result);
        } catch (error) {
          const message = this.text("controller.adapter_error", {
            adapter: adapter.label,
            error: errorMessage(error),
          });
          this.diagnostics.push(message);
          this.failTests(adapterTests, message);
        }
        this.refreshCompletedCount(runningIds);
        this.notify();
      }
    } finally {
      const stillRunning = new Set(
        this.tests
          .filter((test) => runningIds.has(test.id) && test.status === "running")
          .map((test) => test.id),
      );
      this.tests = markTests(this.tests, stillRunning, "unknown");
      this.cancelled = this.cancelRequested;
      this.endOperation();
    }
    return this.currentSummary();
  }

  async collectCoverage(
    selectionContext: TestSelectionContext = {},
  ): Promise<readonly CoverageFile[]> {
    if (this.busy) return this.coverage;
    if (!isTrustedWorkspace(this.port.trustLevel())) {
      this.diagnostics = [this.text("controller.trust_coverage")];
      this.notify();
      return this.coverage;
    }
    const selection = selectTestsForScope(this.tests, "workspace", selectionContext);
    this.beginOperation(this.text("controller.collecting_coverage"));
    const files: CoverageFile[] = [];
    try {
      const context: AdapterContext = {
        ...this.port.createContext(),
        progress: (message) => this.setProgress(message),
        cancelled: () => this.cancelRequested,
      };
      const coverageAdapters = this.orderedAdapters().filter(
        (adapter) =>
          this.isEnabled(adapter.id) &&
          this.activeAdapterIds.has(adapter.id) &&
          Boolean(adapter.collectCoverage),
      );
      for (let index = 0; index < coverageAdapters.length; index += 1) {
        const adapter = coverageAdapters[index]!;
        if (this.cancelRequested) break;
        if (!adapter.collectCoverage) continue;
        const adapterTests = selection.filter((test) => test.adapterId === adapter.id);
        if (adapterTests.length === 0) continue;
        this.setProgress(
          this.text("controller.collecting_adapter", {
            adapter: adapter.label,
            current: String(index + 1),
            total: String(coverageAdapters.length),
          }),
        );
        try {
          const result = await adapter.collectCoverage(
            context,
            createRunRequest("workspace", adapterTests, selectionContext),
          );
          files.push(...result.files);
          if (result.output) this.outputs.push({ adapterId: adapter.id, text: result.output });
          if (result.diagnostics) this.diagnostics.push(...result.diagnostics);
        } catch (error) {
          this.diagnostics.push(
            this.text("controller.adapter_error", {
              adapter: adapter.label,
              error: errorMessage(error),
            }),
          );
        }
      }
      this.coverage = mergeCoverage(files);
      return this.coverage;
    } finally {
      this.cancelled = this.cancelRequested;
      this.endOperation();
    }
  }

  async stop(): Promise<boolean> {
    if (!this.busy) return false;
    this.cancelRequested = true;
    this.setProgress(this.text("controller.stopping"));
    return this.port.cancelActiveProcess();
  }

  private applyAdapterResult(
    adapter: TestObservatoryAdapter,
    selection: readonly TestCase[],
    result: AdapterRunResult,
  ): void {
    this.tests = applyRunResults(this.tests, result.tests, adapter.id);
    if (result.output) this.outputs.push({ adapterId: adapter.id, text: result.output });
    if (result.diagnostics) this.diagnostics.push(...result.diagnostics);
    const hasConclusiveResult = result.tests.some(
      (test) => test.status === "passed" || test.status === "failed" || test.status === "skipped",
    );
    const parserResolvedUnknownExit = result.exitCode === -1 && hasConclusiveResult;
    if (
      result.exitCode !== 0 &&
      result.tests.every((test) => test.status !== "failed") &&
      !parserResolvedUnknownExit
    ) {
      const message = this.text("controller.adapter_exit", {
        adapter: adapter.label,
        code: String(result.exitCode),
        detail: firstUsefulLine(result.output, this.text("controller.no_diagnostic_output")),
      });
      this.diagnostics.push(message);
      this.failTests(selection, message);
    }
  }

  /**
   * Applies one live result. Streamed results only change state; the host
   * renders on its own timer, so a burst of results never floods the dock.
   */
  private applyStreamedResult(
    result: TestCase,
    runningIds: ReadonlySet<string>,
    completedIds: Set<string>,
  ): void {
    const matched =
      this.tests.find((test) => test.id === result.id) ??
      this.tests.find(
        (test) =>
          test.adapterId === result.adapterId &&
          test.nativeId === result.nativeId &&
          runningIds.has(test.id),
      );
    this.tests = applyRunResults(this.tests, [matched ? { ...result, id: matched.id } : result]);
    if (matched && runningIds.has(matched.id) && isConclusive(result.status)) {
      completedIds.add(matched.id);
    }
    if (this.activity) this.activity.completed = completedIds.size;
  }

  private refreshCompletedCount(runningIds: ReadonlySet<string>): void {
    if (!this.activity) return;
    this.activity.completed = this.tests.filter(
      (test) => runningIds.has(test.id) && isConclusive(test.status),
    ).length;
  }

  private failTests(selection: readonly TestCase[], message: string): void {
    const ids = new Set(selection.map((test) => test.id));
    this.tests = this.tests.map((test) =>
      ids.has(test.id) ? { ...test, status: "failed", message } : test,
    );
  }

  private beginOperation(progress: string): void {
    this.busy = true;
    this.cancelled = false;
    this.cancelRequested = false;
    this.diagnostics = [];
    this.outputs = [];
    this.activity = { startedAt: Date.now(), completed: 0, total: 0 };
    this.setProgress(progress);
  }

  private endOperation(): void {
    this.busy = false;
    this.progressMessage = "";
    this.activity = undefined;
    this.notify();
  }

  private setProgress(message: string): void {
    this.progressMessage = message;
    this.port.progress(message);
    this.notify();
  }

  private notify(): void {
    this.port.changed();
  }

  private text(key: string, params: Readonly<Record<string, string>> = {}): string {
    return this.port.translate?.(key, params) ?? defaultControllerMessage(key, params);
  }

  private removeAdapterState(id: string): void {
    this.activeAdapterIds.delete(id);
    this.tests = this.tests.filter((test) => test.adapterId !== id);
    this.coverage = this.coverage.filter((file) => !file.path.includes(`/${id}/`));
    this.discoveryRoot = undefined;
  }

  private orderedAdapters(): TestObservatoryAdapter[] {
    return [...this.adapters.values()].sort(
      (left, right) =>
        (right.priority ?? 0) - (left.priority ?? 0) || left.id.localeCompare(right.id),
    );
  }

  private isEnabled(id: string): boolean {
    return this.enabledAdapterIds?.has(id) ?? true;
  }
}

export function isTrustedWorkspace(level: string): boolean {
  return level === "trusted";
}

function isConclusive(status: TestCase["status"]): boolean {
  return status === "passed" || status === "failed" || status === "skipped";
}

function validAdapter(adapter: TestObservatoryAdapter): boolean {
  return (
    Boolean(adapter) &&
    /^[a-z][a-z0-9-]*$/.test(adapter.id) &&
    typeof adapter.detect === "function" &&
    typeof adapter.discover === "function" &&
    typeof adapter.run === "function"
  );
}

function createRunRequest(
  scope: TestScope,
  tests: readonly TestCase[],
  selection: TestSelectionContext,
): RunRequest {
  return {
    scope,
    tests: [...tests],
    ...(selection.activeFile ? { activeFile: selection.activeFile } : {}),
    ...(selection.activeLine !== undefined ? { activeLine: selection.activeLine } : {}),
  };
}

function emptySelectionKey(scope: TestScope): string {
  return scope === "failed"
    ? "controller.no_failed"
    : scope === "selected"
      ? "controller.no_selected"
      : "controller.no_location";
}

function firstUsefulLine(output: string, fallback: string): string {
  return (
    output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? fallback
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const CONTROLLER_ENGLISH: Readonly<Record<string, string>> = {
  "controller.discovering": "Discovering tests",
  "controller.detecting_adapter": "Detecting %{adapter} (%{current}/%{total})",
  "controller.discovering_adapter": "Discovering %{adapter} tests (%{current}/%{total})",
  "controller.adapter_error": "%{adapter}: %{error}",
  "controller.workspace_changed": "Workspace changed during test discovery; refresh again",
  "controller.trust_run": "Trust this workspace to run tests",
  "controller.running_one": "Running %{count} test",
  "controller.running_many": "Running %{count} tests",
  "controller.imported_not_runnable":
    "Tests from the imported report '%{adapter}' cannot be rerun without a registered active adapter",
  "controller.running_adapter": "Running %{adapter} (%{current}/%{total})",
  "controller.trust_coverage": "Trust this workspace to collect coverage",
  "controller.collecting_coverage": "Collecting coverage",
  "controller.collecting_adapter": "Collecting %{adapter} coverage (%{current}/%{total})",
  "controller.stopping": "Stopping test run",
  "controller.adapter_exit": "%{adapter} exited %{code}: %{detail}",
  "controller.no_diagnostic_output": "no diagnostic output",
  "controller.no_failed": "There are no failed tests to rerun",
  "controller.no_selected": "No test is selected",
  "controller.no_location": "No test was found for the current location",
};

function defaultControllerMessage(key: string, params: Readonly<Record<string, string>>): string {
  return (CONTROLLER_ENGLISH[key] ?? key).replace(/%\{([^}]+)\}/g, (_, name: string) => {
    return params[name] ?? `%{${name}}`;
  });
}
