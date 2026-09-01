import { createBuiltInAdapters } from "./lib/adapters.ts";
import { parseCobertura } from "./lib/cobertura.ts";
import type {
  AdapterContext,
  CoverageFile,
  ProcessOutput,
  ProcessSpec,
  TestCase,
  TestObservatoryAdapter,
  TestObservatoryApi,
  TestScope,
  TestStatus,
  TestSummary,
} from "./lib/contracts.ts";
import { TestObservatoryController, type ObservatorySnapshot } from "./lib/controller.ts";
import { buildGitignoreMatcher, parseGitignore, type GitignoreMatcher } from "./lib/ignore.ts";
import { parseJunit } from "./lib/junit.ts";
import {
  buildTestTree,
  formatCoverageDetails,
  formatRunSummary,
  resolveExpandedTreeKeys,
  summarizeCoverage,
  summarizeTests,
  treeSelectionAt,
  type TestTreeRow,
  type TestSortMode,
  type TreeExpansionMode,
} from "./lib/model.ts";
import {
  basename,
  dirname,
  joinPath,
  normalizePath,
  pathKey,
  relativePath,
  resolvePath,
} from "./lib/path.ts";
import {
  beginDirtySourceSession,
  captureTerminalProcessOutput,
  dockStructureFingerprint,
  endDirtySourceSession,
  formatActivity,
  displayableProgressLine,
  formatElapsed,
  LineSplitter,
  mutateDockContent,
  registerSourceLifecycleEvents,
  sourceSaveAction,
  tickRenderPlan,
  updateDock,
} from "./lib/runtime.ts";
import {
  button,
  col,
  divider,
  hintBar,
  list,
  raw,
  wrappingRow,
  tree,
  treeExpansionAction,
  type ObservatoryTreeNode,
  type ObservatoryWidgetSpec,
} from "./lib/widgets.ts";

declare global {
  interface FreshPluginRegistry {
    "fresh-test-observatory": TestObservatoryApi;
  }
}

interface Settings {
  runOnSave: boolean;
  coverageOnSave: boolean;
  preferNextest: boolean;
  noBuild: boolean;
  noRestore: boolean;
  reportDir: string;
  dockWidth: number;
  autoOpenOnFailure: boolean;
  terminalRuns: boolean;
  enabledAdapters: string[];
  coverageGoodThreshold: number;
  coverageWarningThreshold: number;
  dotnetVerbosity: "quiet" | "minimal" | "normal" | "detailed" | "diagnostic";
}

interface PersistedUiState {
  selectedTestId?: string;
  selectedTreeKey?: string;
  expandedTreeKeys?: string[];
  treeExpansionMode?: TreeExpansionMode;
  filter?: string;
  failedOnly?: boolean;
  watch?: boolean;
  dockOpen?: boolean;
  sortMode?: TestSortMode;
}

interface TerminalWaiter {
  bufferId: number;
  fallbackLines: string[];
  resolve(output: ProcessOutput): void;
}

interface StreamingProcess {
  processId?: number;
  /** Stop arrived before the host named the process; kill it on first output. */
  killPending?: boolean;
  /** Settles the await early: killing a background process never resolves its promise. */
  cancel?: () => void;
  stdout: string[];
  stderr: string[];
  stdoutLines: LineSplitter;
  stderrLines: LineSplitter;
  onLine(line: string, stream: "stdout" | "stderr"): void;
}

/** Render cadence while an operation runs; keeps the elapsed seconds moving evenly. */
const TICK_MS = 250;

const editor = getEditor();
const PANEL_ID = 80_821;
const PANEL_BUFFER_NAME = "*Test Observatory*";
const PANEL_MODE = "test-observatory";
const TREE_KEY = "test-tree";
const OUTPUT_KEY = "test-output";
const UI_STATE_KEY = "ui";
const COVERAGE_NAMESPACE = "test-observatory-coverage";
const TEST_NAMESPACE = "test-observatory-state";
const FAILURE_TEXT_PREFIX = "test-observatory-failure:";
const STATUS_TOKEN = "test-summary";
const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".testagent",
  "node_modules",
  "target",
  "bin",
  "obj",
  "TestResults",
  ".fresh-test-observatory",
  "artifacts",
  ".artifacts",
  ".vs",
  ".idea",
  ".cache",
  "dist",
  "out",
]);

let settings: Settings = defineSettings();
let dockBufferId: number | undefined;
let dockSplitId: number | undefined;
let panelMounted = false;
let dockOpen = false;
let showOutput = false;
let coverageVisible = false;
let coverageDetailsVisible = false;
let selectedTestId: string | undefined;
let selectedTreeKey: string | undefined;
let treeRows: TestTreeRow[] = [];
let treeExpansionMode: TreeExpansionMode = "all";
let expandedTreeKeys = new Set<string>();
let filterText = "";
let failedOnly = false;
let sortMode: TestSortMode = "name";
let watchEnabled = settings.runOnSave;
let watchSessionOverride = false;
let lastRunScope: TestScope | undefined;
let lastOperationWasCoverage = false;
let manualOutput = "";
let activeStream: StreamingProcess | undefined;
const activeStreams = new Set<StreamingProcess>();
const streamsByProcessId = new Map<number, StreamingProcess>();
/** Spawn order; the host allocates process ids in the same order. */
const pendingStreams: StreamingProcess[] = [];
let activeTerminalId: number | undefined;
let tickerId: number | undefined;
let lastOutputLine = "";
let lastTreeRenderAt = 0;
/** Keyboard focus belongs to the tree unless the user moved it to a control. */
let treeHasFocus = true;
/** The host reports a click as a select; two on one row this close together open the test. */
const DOUBLE_CLICK_MS = 400;
let lastTreeSelect: { key: string; at: number } | undefined;
let lastTreeKeyboardMoveAt = 0;
/** Wall-clock time of the last discovery and the last run, shown when they finish. */
let lastDiscoveryMs: number | undefined;
let lastRunMs: number | undefined;
const DETAIL_LINE_LIMIT = 12;
let terminalRunActive = false;
let lastDockStructure = "";
let lastStatusBarText = "";
const statusBarBuffers = new Set<number>();
let lastSourceLocation: { path?: string; line?: number } = {};
const discoveryCache = new Map<string, string[]>();

function clearDiscoveryCaches(): void {
  discoveryCache.clear();
  workspaceListing = undefined;
}
let ignoreMatcher: { root: string; matcher: GitignoreMatcher } | undefined;
let workspaceListing: { root: string; files: string[] } | undefined;
const openBufferText = new Map<string, string>();
const terminalWaiters = new Map<number, TerminalWaiter>();
const invalidatedCoverageBuffers = new Set<number>();
const dirtySourcePaths = new Set<string>();

const restored = readPersistedState();
selectedTestId = restored.selectedTestId;
selectedTreeKey = restored.selectedTreeKey;
treeExpansionMode = restored.treeExpansionMode ?? "all";
expandedTreeKeys = new Set(restored.expandedTreeKeys ?? []);
filterText = restored.filter ?? "";
failedOnly = restored.failedOnly ?? false;
sortMode = restored.sortMode ?? "name";
watchEnabled = restored.watch ?? settings.runOnSave;
dockOpen = restored.dockOpen ?? false;

const controller = new TestObservatoryController(
  {
    workspaceRoot: () => editor.getCwd(),
    trustLevel: () => editor.workspaceTrustLevel(),
    createContext,
    progress(message): void {
      editor.setStatus(message);
    },
    changed: onControllerChanged,
    cancelActiveProcess,
    translate,
  },
  createBuiltInAdapters(),
);
controller.setEnabledAdapters(settings.enabledAdapters);

const publicApi: TestObservatoryApi = {
  registerAdapter(adapter: TestObservatoryAdapter): boolean {
    return controller.registerAdapter(adapter);
  },
  unregisterAdapter(id: string): boolean {
    return controller.unregisterAdapter(id);
  },
  listAdapters(): Array<{ id: string; label: string; priority: number }> {
    return controller.listAdapters();
  },
  ingestJUnit(xml: string, adapterId = "junit"): number {
    const count = controller.ingestTests(adapterId, parseJunit(xml, { adapterId }));
    lastRunScope = "workspace";
    openDockIfNeeded();
    return count;
  },
  ingestCobertura(xml: string, workspaceRoot = editor.getCwd()): number {
    const count = controller.ingestCoverage(parseCobertura(xml, workspaceRoot));
    coverageVisible = count > 0;
    coverageDetailsVisible = true;
    selectedTestId = undefined;
    selectedTreeKey = undefined;
    void paintDecorations();
    return count;
  },
  refresh: refreshTests,
  run: runScope,
};

editor.exportPluginApi("fresh-test-observatory", publicApi);
editor.registerStatusBarElement(STATUS_TOKEN, "Tests");

function translate(key: string, params: Readonly<Record<string, string>> = {}): string {
  return editor.t(key, params);
}

function defineSettings(): Settings {
  return {
    runOnSave: editor.defineConfigBoolean("runOnSave", {
      default: false,
      description: editor.t("setting.run_on_save"),
    }),
    coverageOnSave: editor.defineConfigBoolean("coverageOnSave", {
      default: false,
      description: editor.t("setting.coverage_on_save"),
    }),
    preferNextest: editor.defineConfigBoolean("preferNextest", {
      default: true,
      description: editor.t("setting.prefer_nextest"),
    }),
    noBuild: editor.defineConfigBoolean("noBuild", {
      default: false,
      description: editor.t("setting.no_build"),
    }),
    noRestore: editor.defineConfigBoolean("noRestore", {
      default: false,
      description: editor.t("setting.no_restore"),
    }),
    reportDir: editor.defineConfigString("reportDir", {
      default: "",
      description: editor.t("setting.report_dir"),
    }),
    dockWidth: editor.defineConfigInteger("dockWidth", {
      default: 38,
      minimum: 24,
      maximum: 60,
      description: editor.t("setting.dock_width"),
    }),
    autoOpenOnFailure: editor.defineConfigBoolean("autoOpenOnFailure", {
      default: true,
      description: editor.t("setting.auto_open_failure"),
    }),
    terminalRuns: editor.defineConfigBoolean("terminalRuns", {
      default: false,
      description: editor.t("setting.terminal_runs"),
    }),
    enabledAdapters: editor.defineConfigStringArray("enabledAdapters", {
      default: [],
      description: editor.t("setting.enabled_adapters"),
    }),
    coverageGoodThreshold: editor.defineConfigInteger("coverageGoodThreshold", {
      default: 90,
      minimum: 0,
      maximum: 100,
      description: editor.t("setting.coverage_good"),
    }),
    coverageWarningThreshold: editor.defineConfigInteger("coverageWarningThreshold", {
      default: 70,
      minimum: 0,
      maximum: 100,
      description: editor.t("setting.coverage_warning"),
    }),
    dotnetVerbosity: editor.defineConfigEnum("dotnetVerbosity", {
      values: ["quiet", "minimal", "normal", "detailed", "diagnostic"] as const,
      default: "normal",
      description: editor.t("setting.dotnet_verbosity"),
    }),
  };
}

function refreshSettings(): void {
  const current = editor.getPluginConfig<Partial<Settings>>() ?? {};
  settings = {
    ...settings,
    ...current,
    dockWidth: clampInteger(current.dockWidth ?? settings.dockWidth, 24, 60),
    coverageGoodThreshold: clampInteger(
      current.coverageGoodThreshold ?? settings.coverageGoodThreshold,
      0,
      100,
    ),
    coverageWarningThreshold: clampInteger(
      current.coverageWarningThreshold ?? settings.coverageWarningThreshold,
      0,
      100,
    ),
    enabledAdapters: Array.isArray(current.enabledAdapters)
      ? current.enabledAdapters.filter((id): id is string => typeof id === "string")
      : settings.enabledAdapters,
  };
  if (!watchSessionOverride) watchEnabled = settings.runOnSave;
  controller.setEnabledAdapters(settings.enabledAdapters);
}

async function refreshTests(): Promise<number> {
  await prepareOpenBufferText();
  clearDiscoveryCaches();
  ignoreMatcher = undefined;
  dirtySourcePaths.clear();
  invalidatedCoverageBuffers.clear();
  cleanDefaultReportDirectory();
  const startedAt = Date.now();
  const count = await controller.refresh();
  lastDiscoveryMs = Date.now() - startedAt;
  const snapshot = controller.snapshot();
  if (selectedTestId && !snapshot.tests.some((test) => test.id === selectedTestId)) {
    selectedTestId = undefined;
    selectedTreeKey = undefined;
  }
  editor.setStatus(
    editor.t("status.discovered", {
      count: String(count),
      elapsed: formatElapsed(lastDiscoveryMs),
    }),
  );
  persistUiState();
  await paintDecorations();
  return count;
}

async function runScope(scope: TestScope): Promise<TestSummary> {
  lastRunScope = scope;
  lastOperationWasCoverage = false;
  coverageDetailsVisible = false;
  showOutput = false;
  if (scope !== "selected" && scope !== "nearest") {
    selectedTestId = undefined;
    selectedTreeKey = undefined;
  }
  const runStartedAt = Date.now();
  const summary = await controller.run(scope, selectionContext());
  lastRunMs = Date.now() - runStartedAt;
  const focused = controller.snapshot().focusedTestId;
  if (focused) {
    selectedTestId = focused;
    selectedTreeKey = "test:" + focused;
  }
  renderDock();
  editor.setStatus(formatStatusSummary(summary));
  if (summary.failed > 0 && settings.autoOpenOnFailure) await openDock();
  persistUiState();
  await paintDecorations();
  return summary;
}

async function runScopeInTerminal(scope: TestScope): Promise<TestSummary> {
  terminalRunActive = true;
  try {
    return await runScope(scope);
  } finally {
    terminalRunActive = false;
  }
}

async function toggleCoverage(): Promise<void> {
  if (coverageVisible) {
    coverageVisible = false;
    coverageDetailsVisible = false;
    clearCoverageDecorations();
    renderDock();
    updateStatusBar();
    editor.setStatus(editor.t("status.coverage_hidden"));
    return;
  }
  lastOperationWasCoverage = true;
  coverageDetailsVisible = true;
  selectedTestId = undefined;
  selectedTreeKey = undefined;
  showOutput = false;
  const files = await controller.collectCoverage(selectionContext());
  coverageVisible = files.length > 0;
  invalidatedCoverageBuffers.clear();
  if (coverageVisible) {
    const summary = summarizeCoverage(files);
    editor.setStatus(
      editor.t("status.coverage", {
        covered: String(summary.coveredLines),
        total: String(summary.totalLines),
        percent: String(summary.percent),
      }),
    );
    await paintCoverage();
  } else {
    editor.setStatus(editor.t("status.no_coverage"));
  }
  renderDock();
  updateStatusBar();
}

async function stopRun(): Promise<void> {
  const stopped = await controller.stop();
  editor.setStatus(stopped ? editor.t("status.stopping") : editor.t("status.nothing_to_stop"));
}

function createContext(): AdapterContext {
  const active = activeLocation();
  return {
    cwd: editor.getCwd(),
    trusted: editor.workspaceTrustLevel() === "trusted",
    reportDir: reportDirectory(),
    cacheDir: cacheDirectory(),
    preferNextest: settings.preferNextest,
    noBuild: settings.noBuild,
    noRestore: settings.noRestore,
    dotnetVerbosity: settings.dotnetVerbosity,
    readFile: readWorkspaceFile,
    writeFile(path, content): boolean {
      editor.createDir(editor.authorityPath(dirname(path)));
      return editor.writeFile(editor.authorityPath(path), content);
    },
    findFiles,
    yieldToEditor: () => editor.delay(0),
    execute: executeProcess,
    ...(active.path ? { activeFile: active.path } : {}),
    ...(active.line !== undefined ? { activeLine: active.line } : {}),
  };
}

async function findFiles(glob: string): Promise<string[]> {
  const root = normalizePath(editor.getCwd());
  const cacheKey = pathKey(root) + "\0" + glob;
  const cached = discoveryCache.get(cacheKey);
  if (cached) return [...cached];
  const matcher = globMatcher(glob);
  const candidates = (await workspaceFiles(root)).filter((path) =>
    matcher(relativePath(root, path)),
  );
  // Only files that declare tests, projects, or manifests are worth handing
  // to an adapter; the signature check replaces a host content search.
  const pattern = sourceSearchPattern(glob);
  const signature = pattern ? new RegExp(pattern, "im") : undefined;
  const files: string[] = [];
  let checked = 0;
  for (const path of candidates) {
    if (signature) {
      const source = readWorkspaceFile(path);
      if (source === null || !signature.test(source)) continue;
      if (++checked % 32 === 0) await editor.delay(0);
    }
    files.push(path);
  }
  const unique = [...new Map(files.map((path) => [pathKey(path), path])).values()].sort(
    (left, right) => pathKey(left).localeCompare(pathKey(right)),
  );
  discoveryCache.set(cacheKey, unique);
  return [...unique];
}

/** File contents as the editor sees them: unsaved buffer text first, then disk. */
function readWorkspaceFile(path: string): string | null {
  const cached = openBufferText.get(pathKey(path));
  if (cached !== undefined) return cached;
  const content = editor.readFile(editor.authorityPath(path));
  return typeof content === "string" ? content : null;
}

/**
 * Every file under the workspace root, walked once per discovery. Fresh's
 * plugin-facing search walks ignored trees too and is run once per glob;
 * this prunes `.gitignore` matches and known output directories on the way
 * down, so a .NET ArtifactsPath or a vendored grammar is never entered.
 */
async function workspaceFiles(root: string): Promise<string[]> {
  if (workspaceListing && pathKey(workspaceListing.root) === pathKey(root)) {
    return workspaceListing.files;
  }
  const ignore = gitignoreFor(root);
  const files: string[] = [];
  const queue: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
  let directories = 0;
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth > 16) continue;
    let entries: DirEntry[];
    try {
      entries = editor.readDir(editor.authorityPath(current.path));
    } catch {
      continue;
    }
    if (
      current.depth > 0 &&
      entries.some((entry) => entry.is_file && entry.name === ".gitignore")
    ) {
      const text = editor.readFile(editor.authorityPath(joinPath(current.path, ".gitignore")));
      if (typeof text === "string") ignore.addRules(parseGitignore(current.path, text));
    }
    for (const entry of entries) {
      if (entry.is_dir && IGNORED_DIRECTORIES.has(entry.name)) continue;
      const path = joinPath(current.path, entry.name);
      if (ignore.isIgnored(path, entry.is_dir)) continue;
      if (entry.is_dir) {
        queue.push({ path, depth: current.depth + 1 });
      } else if (entry.is_file) {
        files.push(path);
        if (files.length > 100_000) {
          throw new Error(editor.t("error.file_walk_limit", { glob: "**" }));
        }
      }
    }
    // Keep the dock rendering while a large tree is walked.
    if (++directories % 64 === 0) await editor.delay(0);
  }
  workspaceListing = { root, files };
  return files;
}

/** Reads the root .gitignore once per discovery; nested files join during the walk. */
function gitignoreFor(root: string): GitignoreMatcher {
  if (ignoreMatcher && pathKey(ignoreMatcher.root) === pathKey(root)) return ignoreMatcher.matcher;
  const matcher = buildGitignoreMatcher(root, [], (path) => {
    const content = editor.readFile(editor.authorityPath(path));
    return typeof content === "string" ? content : null;
  });
  ignoreMatcher = { root, matcher };
  return matcher;
}

function sourceSearchPattern(glob: string): string | undefined {
  if (glob.endsWith(".rs")) {
    return "(?:#\\s*\\[(?:[A-Za-z0-9_:]+::)?(?:test|rstest)\\b|^\\s*///(?:.*```|\\s{5}\\S))";
  }
  if (glob.endsWith("_test.go")) {
    return "^\\s*func\\s+(?:Test|Benchmark|Fuzz|Example)[A-Za-z0-9_]*\\s*\\(";
  }
  if (glob.endsWith(".cs")) {
    return "\\[(?:[A-Za-z0-9_.]+\\.)?(?:TestMethod|DataTestMethod|Fact|Theory|Test|TestCase|TestCaseSource)\\b";
  }
  if (glob.endsWith(".fs")) {
    return "\\[<\\s*(?:[A-Za-z0-9_.]+\\.)?(?:TestMethod|DataTestMethod|Fact|Theory|Test|TestCase)\\b";
  }
  if (glob.endsWith(".vb")) {
    return "<\\s*(?:[A-Za-z0-9_.]+\\.)?(?:TestMethod|DataTestMethod|Fact|Theory|Test|TestCase)\\b";
  }
  // Manifests and solutions go through the host search as well, so ignored
  // output trees (a .NET ArtifactsPath, for example) never contribute stale
  // copies of a project.
  if (glob.endsWith("*.*proj")) return "<Project\\b";
  if (glob.endsWith("*.slnx")) return "<Solution\\b";
  if (glob.endsWith("*.sln")) return "^Microsoft Visual Studio Solution File";
  if (glob.endsWith("Cargo.toml")) return "^\\s*\\[(?:package|workspace)\\]";
  if (glob.endsWith("go.mod")) return "^\\s*module\\s";
  return undefined;
}

function globMatcher(glob: string): (relativePath: string) => boolean {
  let expression = "^";
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index]!;
    const next = glob[index + 1];
    if (character === "*" && next === "*") {
      index += 1;
      if (glob[index + 1] === "/") {
        index += 1;
        expression += "(?:.*/)?";
      } else {
        expression += ".*";
      }
    } else if (character === "*") {
      expression += "[^/]*";
    } else if (character === "?") {
      expression += "[^/]";
    } else {
      expression += character.replace(/[\\^$+?.()|[\]{}]/g, "\\$&");
    }
  }
  const regex = new RegExp(expression + "$", "i");
  return (path: string) => regex.test(normalizePath(path));
}

async function prepareOpenBufferText(): Promise<void> {
  openBufferText.clear();
  for (const buffer of editor.listBuffers()) {
    if (!buffer.path || buffer.is_virtual) continue;
    try {
      openBufferText.set(pathKey(buffer.path), await editor.getBufferText(buffer.id));
    } catch {
      // A buffer can close between the snapshot and the async read.
    }
  }
}

async function executeProcess(spec: ProcessSpec): Promise<ProcessOutput> {
  if (editor.workspaceTrustLevel() !== "trusted") {
    return { stdout: "", stderr: editor.t("error.untrusted"), exitCode: -1 };
  }
  if (spec.reportPath) editor.createDir(editor.authorityPath(dirname(spec.reportPath)));
  editor.setStatus(spec.label ?? editor.t("status.running_command", { command: spec.command }));
  if (terminalRunActive || settings.terminalRuns) return executeInTerminal(spec);
  // Everything runs as a background process: a plain spawn's handle cannot
  // kill the OS process, so Stop would leave it running and hang the await.
  return executeStreaming(spec, spec.onLine ?? (() => {}));
}

/**
 * Runs a command as a Fresh background process so its output arrives line by
 * line while it executes. The host names the process id on the first output
 * event, which is also what Stop uses to kill it.
 */
async function executeStreaming(
  spec: ProcessSpec,
  onLine: (line: string, stream: "stdout" | "stderr") => void,
): Promise<ProcessOutput> {
  const stream: StreamingProcess = {
    stdout: [],
    stderr: [],
    stdoutLines: new LineSplitter(),
    stderrLines: new LineSplitter(),
    onLine: (line, kind) => {
      const shown = displayableProgressLine(line);
      if (shown) lastOutputLine = shown;
      (kind === "stdout" ? stream.stdout : stream.stderr).push(line);
      try {
        onLine(line, kind);
      } catch (error) {
        editor.debug("Test Observatory: progress line handler failed: " + errorMessage(error));
      }
    },
  };
  activeStream = stream;
  activeStreams.add(stream);
  const cancelled = new Promise<{ cancelled: true }>((resolve) => {
    stream.cancel = () => resolve({ cancelled: true });
  });
  const spawned = spawnTracked(spec.command, spec.args, spec.cwd ?? editor.getCwd());
  if (spawned.processId !== undefined) {
    stream.processId = spawned.processId;
    streamsByProcessId.set(spawned.processId, stream);
  } else {
    pendingStreams.push(stream);
  }
  try {
    // The host's kill aborts the process without ever settling this promise,
    // so a Stop resolves the race instead of waiting for an exit event.
    const settled = await Promise.race([
      spawned.result
        .then((result) => ({ exitCode: result.exit_code ?? -1 }))
        .catch((error: unknown) => ({ error: errorMessage(error) })),
      cancelled,
    ]);
    for (const line of stream.stdoutLines.flush()) stream.onLine(line, "stdout");
    for (const line of stream.stderrLines.flush()) stream.onLine(line, "stderr");
    if ("cancelled" in settled) {
      return { stdout: stream.stdout.join("\n"), stderr: stream.stderr.join("\n"), exitCode: 130 };
    }
    if ("error" in settled) {
      return { stdout: stream.stdout.join("\n"), stderr: settled.error, exitCode: -1 };
    }
    return {
      stdout: stream.stdout.join("\n"),
      stderr: stream.stderr.join("\n"),
      exitCode: settled.exitCode,
    };
  } finally {
    activeStreams.delete(stream);
    if (stream.processId !== undefined) {
      streamsByProcessId.delete(stream.processId);
    }
    if (stream.processId !== undefined || !stream.killPending) {
      // A kill-pending stream with no id yet stays queued so the first
      // output can still name and kill the orphaned process.
      const pending = pendingStreams.indexOf(stream);
      if (pending >= 0) pendingStreams.splice(pending, 1);
    }
    if (activeStream === stream) activeStream = undefined;
  }
}

/**
 * Spawns through the host's raw entry point when available: the returned
 * request id is the process id, known before any output arrives, so Stop can
 * always kill the real process. Falls back to the public wrapper (process id
 * then arrives with the first output) if the internals ever change.
 */
function spawnTracked(
  command: string,
  args: string[],
  cwd: string,
): { processId?: number; result: Promise<{ exit_code?: number }> } {
  const raw = (
    editor as unknown as {
      _spawnBackgroundProcessStart?: (command: string, args: string[], cwd: string) => number;
    }
  )._spawnBackgroundProcessStart;
  const callbacks = (
    globalThis as unknown as {
      _pendingCallbacks?: Map<
        number,
        { resolve(value: unknown): void; reject(error: unknown): void }
      >;
    }
  )._pendingCallbacks;
  if (typeof raw === "function" && callbacks) {
    const processId = (
      editor as unknown as Record<string, (command: string, args: string[], cwd: string) => number>
    )["_spawnBackgroundProcessStart"]!(command, args, cwd);
    const result = new Promise((resolve, reject) => callbacks.set(processId, { resolve, reject }));
    return { processId, result: result as Promise<{ exit_code?: number }> };
  }
  return { result: editor.spawnBackgroundProcess(command, args, cwd).result };
}

function receiveProcessOutput(processId: number, data: string, kind: "stdout" | "stderr"): void {
  let stream = streamsByProcessId.get(processId);
  if (!stream) {
    // First output from a process the host has not named to us yet; spawn
    // order and id order agree, so the oldest unnamed stream owns it.
    stream = pendingStreams.shift();
    if (!stream) return;
    stream.processId = processId;
    if (stream.killPending) {
      editor.killProcess(processId);
      return;
    }
    streamsByProcessId.set(processId, stream);
  }
  const splitter = kind === "stdout" ? stream.stdoutLines : stream.stderrLines;
  for (const line of splitter.push(data)) stream.onLine(line, kind);
}

async function executeInTerminal(spec: ProcessSpec): Promise<ProcessOutput> {
  const terminal = await editor.createTerminal({
    cwd: spec.cwd ?? editor.getCwd(),
    command: [spec.command, ...spec.args],
    title: spec.label ?? "Test Observatory",
    direction: "horizontal",
    ratio: 0.65,
    focus: true,
    persistent: false,
  });
  activeTerminalId = terminal.terminalId;
  return new Promise<ProcessOutput>((resolve) => {
    terminalWaiters.set(terminal.terminalId, {
      bufferId: terminal.bufferId,
      fallbackLines: [],
      resolve,
    });
  });
}

async function cancelActiveProcess(): Promise<boolean> {
  // Listings run in parallel, so several processes can be live at once. A
  // process that has not produced output yet has no id; it dies on its first.
  let any = false;
  for (const stream of [...activeStreams]) {
    any = true;
    if (stream.processId !== undefined) editor.killProcess(stream.processId);
    else stream.killPending = true;
    stream.cancel?.();
  }
  if (!any && activeTerminalId !== undefined) return editor.closeTerminal(activeTerminalId);
  return any;
}

function reportDirectory(): string {
  if (settings.reportDir.trim()) {
    const configured = normalizePath(settings.reportDir.trim());
    return configured.startsWith("/") || /^[A-Za-z]:\//.test(configured)
      ? configured
      : joinPath(editor.getTempDir(), configured);
  }
  return joinPath(editor.getTempDir(), "fresh-test-observatory", workspaceHash(editor.getCwd()));
}

/** Listings and other reusable state; never cleaned with the report directory. */
function cacheDirectory(): string {
  return joinPath(
    editor.getTempDir(),
    "fresh-test-observatory",
    "cache",
    workspaceHash(editor.getCwd()),
  );
}

function cleanDefaultReportDirectory(): void {
  if (settings.reportDir.trim()) return;
  const path = reportDirectory();
  try {
    editor.removePath(editor.authorityPath(path));
  } catch {
    // A missing cache directory needs no cleanup.
  }
  editor.createDir(editor.authorityPath(path));
}

function workspaceHash(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function selectionContext(): {
  activeFile?: string;
  activeLine?: number;
  selectedTestId?: string;
} {
  const active = activeLocation();
  return {
    ...(active.path ? { activeFile: active.path } : {}),
    ...(active.line !== undefined ? { activeLine: active.line } : {}),
    ...(selectedTestId ? { selectedTestId } : {}),
  };
}

function activeLocation(): { path?: string; line?: number } {
  const bufferId = editor.getActiveBufferId();
  if (!bufferId || bufferId === dockBufferId) return { ...lastSourceLocation };
  const path = editor.getBufferPath(bufferId);
  if (!path) return { ...lastSourceLocation };
  const cursor = editor.getPrimaryCursor();
  lastSourceLocation = {
    path,
    ...(cursor?.line !== null && cursor?.line !== undefined ? { line: cursor.line + 1 } : {}),
  };
  return { ...lastSourceLocation };
}

function onControllerChanged(): void {
  const snapshot = controller.snapshot();
  if (snapshot.busy && tickerId === undefined) {
    lastOutputLine = "";
    lastTickAt = 0;
    tickerId = editor.setInterval(TICK_MS, "test_observatory_tick");
  } else if (!snapshot.busy && tickerId !== undefined) {
    editor.clearInterval(tickerId);
    tickerId = undefined;
    lastOutputLine = "";
  }
  updateDock(() => mutateDock(snapshot), renderDock);
  updateStatusBar();
}

/**
 * Streamed results only change controller state; this timer draws them. The
 * title, detail lines, and status token are small mutations sent every tick,
 * so the elapsed seconds advance evenly. The full tree is resent at most once
 * a second: Fresh drains plugin commands under a per-frame budget, and a
 * large tree on every tick would delay the small updates behind it.
 */
let lastTickAt = 0;

function tick(): void {
  const snapshot = controller.snapshot();
  if (!snapshot.busy) return;
  const now = Date.now();
  if (lastTickAt > 0 && now - lastTickAt > TICK_MS * 3) {
    editor.debug(
      `Test Observatory: render tick stalled ${now - lastTickAt} ms during "${snapshot.progress}"`,
    );
  }
  lastTickAt = now;
  const structureChanged =
    dockOpen && panelMounted && currentDockStructure(snapshot) !== lastDockStructure;
  if (tickRenderPlan(Date.now(), lastTreeRenderAt, structureChanged) === "tree") {
    renderDock();
  } else {
    mutateDock(snapshot, true);
  }
  updateStatusBar();
}

async function openDock(): Promise<void> {
  activeLocation();
  dockOpen = true;
  persistUiState();
  if (dockBufferId !== undefined && dockIsDisplayed()) {
    renderDock();
    if (dockSplitId !== undefined) editor.focusSplit(dockSplitId);
    return;
  }
  // Either the buffer is gone, or another utility panel took over the dock
  // and was closed with it. Discard what is left and build the dock again.
  if (panelMounted) editor.unmountWidgetPanel(PANEL_ID);
  panelMounted = false;
  dockBufferId = undefined;
  dockSplitId = undefined;
  const stale = editor
    .listBuffers()
    .filter(
      (buffer) => buffer.is_virtual && !buffer.is_terminal && buffer.name === PANEL_BUFFER_NAME,
    );
  for (const buffer of stale) editor.closeBuffer(buffer.id, true);
  if (stale.length > 0) await editor.flush();
  try {
    const result = await editor.createVirtualBufferInSplit({
      name: PANEL_BUFFER_NAME,
      mode: PANEL_MODE,
      readOnly: true,
      entries: [],
      ratio: 1 - settings.dockWidth / 100,
      panelId: "test-observatory",
      role: "utility_dock",
      showLineNumbers: false,
      showCursors: false,
      editingDisabled: true,
      scrollable: false,
    });
    dockBufferId = result.bufferId;
    dockSplitId = result.splitId ?? editor.getActiveSplitId();
    // An existing utility dock keeps its own size, so apply the setting here
    // rather than relying on the ratio passed at creation.
    editor.setSplitRatio(dockSplitId, 1 - settings.dockWidth / 100);
    panelMounted = editor.mountWidgetPanel(PANEL_ID, result.bufferId, dockSpec());
    treeHasFocus = true;
    renderDock();
    if (controller.snapshot().tests.length === 0 && !controller.snapshot().busy) {
      await refreshTests();
    }
  } catch (error) {
    dockBufferId = undefined;
    dockSplitId = undefined;
    panelMounted = false;
    dockOpen = false;
    persistUiState();
    throw error;
  }
}

/** True while the dock buffer still exists and some split shows it. */
function dockIsDisplayed(): boolean {
  const buffer = editor.listBuffers().find((entry) => entry.id === dockBufferId);
  return Boolean(buffer && buffer.splits.length > 0);
}

function openDockIfNeeded(): void {
  if (!dockOpen) void guardedCall(openDock);
  else renderDock();
}

function closeDock(): void {
  dockOpen = false;
  showOutput = false;
  if (panelMounted) editor.unmountWidgetPanel(PANEL_ID);
  if (dockBufferId !== undefined) editor.closeBuffer(dockBufferId, true);
  dockBufferId = undefined;
  dockSplitId = undefined;
  panelMounted = false;
  persistUiState();
}

function renderDock(): void {
  if (!dockOpen || dockBufferId === undefined || !panelMounted) return;
  const snapshot = controller.snapshot();
  editor.updateWidgetPanel(PANEL_ID, showOutput ? outputSpec() : dockSpec());
  lastDockStructure = currentDockStructure(snapshot);
  lastTreeRenderAt = Date.now();
  if (showOutput) return;
  // The host keeps tree selection by row index and focus by widget; rows move
  // when results add parameterized cases, and a full update can land focus on
  // the first button. Put both back where the user left them.
  const index = treeRows.findIndex(
    (item) => item.key === selectedTreeKey || (selectedTestId && item.testId === selectedTestId),
  );
  if (index >= 0) {
    editor.widgetMutate(PANEL_ID, { kind: "setSelectedIndex", widgetKey: TREE_KEY, index });
  }
  if (treeHasFocus && treeRows.length > 0) {
    editor.widgetMutate(PANEL_ID, { kind: "setFocusKey", widgetKey: TREE_KEY });
  }
}

/**
 * Updates title, details, and output in place. With `contentOnly` the tree may
 * be stale (a tick between rebuilds); the mutated widgets exist either way.
 */
function mutateDock(snapshot: ObservatorySnapshot, contentOnly = false): boolean {
  if (
    !dockOpen ||
    dockBufferId === undefined ||
    !panelMounted ||
    (!contentOnly && currentDockStructure(snapshot) !== lastDockStructure)
  ) {
    return false;
  }
  return mutateDockContent((mutation) => editor.widgetMutate(PANEL_ID, mutation), {
    showOutput,
    outputWidgetKey: OUTPUT_KEY,
    outputEntries: outputEntries(),
    titleWidgetKey: "title",
    titleEntries: [{ text: dockTitle(snapshot), style: { bold: true } }],
    detailsWidgetKey: "details",
    detailEntries: detailEntries(snapshot),
  });
}

function currentDockStructure(snapshot: ObservatorySnapshot): string {
  return dockStructureFingerprint({
    tests: snapshot.tests,
    busy: snapshot.busy,
    showOutput,
    coverageVisible,
    ...(selectedTestId ? { selectedTestId } : {}),
    ...(selectedTreeKey ? { selectedTreeKey } : {}),
    filter: filterText,
    failedOnly,
    sortMode,
  });
}

function dockSpec(): ObservatoryWidgetSpec {
  const snapshot = controller.snapshot();
  const displayedTests = filteredTests(snapshot);
  treeRows = buildTestTree(displayedTests, sortMode);
  const resolvedExpansion = resolveExpandedTreeKeys(treeRows, treeExpansionMode, expandedTreeKeys);
  expandedTreeKeys = new Set(resolvedExpansion);
  const workspaceSummary = summarizeTests(snapshot.tests);
  const controls = wrappingRow(
    button(editor.t("button.refresh"), "refresh", { disabled: snapshot.busy }),
    button(editor.t("button.run_all"), "run-workspace", {
      disabled: snapshot.busy,
      primary: true,
    }),
    button(editor.t("button.selected"), "run-selected", {
      disabled: snapshot.busy || !selectedTestId,
    }),
    button(editor.t("button.nearest"), "run-nearest", { disabled: snapshot.busy }),
    button(editor.t("button.file"), "run-file", { disabled: snapshot.busy }),
    button(editor.t("button.failed"), "rerun-failed", {
      disabled: snapshot.busy || workspaceSummary.failed === 0,
    }),
    button(
      coverageVisible ? editor.t("button.hide_coverage") : editor.t("button.coverage"),
      "toggle-coverage",
      { disabled: snapshot.busy },
    ),
    button(
      snapshot.busy ? editor.t("button.stop") : editor.t("button.output"),
      snapshot.busy ? "stop" : "output",
    ),
    button(watchEnabled ? editor.t("button.watching") : editor.t("button.watch"), "watch"),
  );
  const treeControls = wrappingRow(
    button(editor.t("button.expand_all"), "expand-all", { disabled: treeRows.length === 0 }),
    button(editor.t("button.collapse_all"), "collapse-all", { disabled: treeRows.length === 0 }),
    button(
      failedOnly ? editor.t("button.all_tests") : editor.t("button.failed_only"),
      "failed-only",
    ),
    button(filterText ? editor.t("button.filter_active") : editor.t("button.filter"), "filter"),
    button(
      sortMode === "duration" ? editor.t("button.sort_duration") : editor.t("button.sort_name"),
      "sort",
    ),
  );
  const selectedIndex = Math.max(
    0,
    treeRows.findIndex((item) => item.key === selectedTreeKey || item.testId === selectedTestId),
  );
  const body =
    treeRows.length > 0
      ? tree({
          nodes: treeRows.map(toWidgetNode),
          itemKeys: treeRows.map((item) => item.key),
          selectedIndex,
          expandedKeys: resolvedExpansion,
          key: TREE_KEY,
        })
      : raw(
          [
            {
              text: snapshot.busy
                ? editor.t("panel.discovering")
                : filterText || failedOnly
                  ? editor.t("panel.no_filter_matches")
                  : editor.t("panel.no_tests"),
            },
          ],
          "empty",
        );
  return col(
    raw([{ text: dockTitle(snapshot), style: { bold: true } }], "title"),
    controls,
    treeControls,
    divider(),
    body,
    divider(),
    raw(detailEntries(snapshot), "details"),
    hintBar([
      { keys: "Enter", label: editor.t("hint.open") },
      { keys: "r", label: editor.t("hint.run") },
      { keys: "f", label: editor.t("hint.filter") },
      { keys: "q", label: editor.t("hint.close") },
    ]),
  );
}

function outputSpec(): ObservatoryWidgetSpec {
  const entries = outputEntries();
  return col(
    raw([{ text: editor.t("panel.output"), style: { bold: true } }], "output-title"),
    wrappingRow(
      button(editor.t("button.back"), "back", { primary: true }),
      button(editor.t("button.copy"), "copy-output"),
      button(editor.t("button.clear"), "clear-output"),
      button(editor.t("button.adapters"), "adapters"),
    ),
    divider(),
    list(entries, OUTPUT_KEY),
    hintBar([
      { keys: "c", label: editor.t("hint.copy") },
      { keys: "q", label: editor.t("hint.back") },
    ]),
  );
}

function outputEntries(): TextPropertyEntry[] {
  const output = outputText();
  return output
    ? output.split(/\r?\n/).map((text) => ({ text }))
    : [{ text: editor.t("panel.no_output") }];
}

function dockTitle(snapshot: ObservatorySnapshot): string {
  const summary = controller.currentSummary();
  if (!snapshot.busy) return titleSummary(snapshot, summary, summarizeTests(snapshot.tests));
  return "◉ " + formatActivity(snapshot.progress, snapshot.activity, Date.now());
}

function filteredTests(snapshot: ObservatorySnapshot): TestCase[] {
  const query = filterText.trim().toLocaleLowerCase();
  return snapshot.tests.filter((test) => {
    if (failedOnly && test.status !== "failed") return false;
    if (!query) return true;
    return [
      test.label,
      test.nativeId,
      test.adapterId,
      test.project ?? "",
      ...(test.suite ?? []),
    ].some((value) => value.toLocaleLowerCase().includes(query));
  });
}

function toWidgetNode(value: TestTreeRow): ObservatoryTreeNode {
  return {
    text: {
      text: statusGlyph(value.status) + " " + value.label,
      style: { fg: statusTheme(value.status) },
    },
    depth: value.depth,
    hasChildren: value.hasChildren,
  };
}

function detailEntries(snapshot: ObservatorySnapshot): TextPropertyEntry[] {
  const entries: TextPropertyEntry[] = [];
  if (coverageDetailsVisible || lastOperationWasCoverage) {
    for (const text of formatCoverageDetails(snapshot.coverage, activeLocation().path, translate)) {
      entries.push({ text });
    }
  } else {
    const selected = snapshot.tests.find((test) => test.id === selectedTestId);
    if (selected) {
      entries.push({
        text: statusGlyph(selected.status) + " " + selected.nativeId,
        style: { bold: true, fg: statusTheme(selected.status) },
      });
      if (selected.durationMs !== undefined) {
        entries.push({
          text: editor.t("panel.duration", { duration: formatDuration(selected.durationMs) }),
        });
      }
      if (selected.source) {
        entries.push({ text: selected.source.path + ":" + selected.source.line });
      }
      if (selected.message) entries.push({ text: selected.message });
      if (selected.stack) {
        entries.push({ text: editor.t("panel.stack"), style: { bold: true } });
        const lines = selected.stack.split(/\r?\n/);
        const shown = lines.slice(0, DETAIL_LINE_LIMIT);
        entries.push(...shown.map((text) => ({ text })));
        if (lines.length > shown.length) {
          entries.push({
            text: editor.t("panel.more_in_output", { count: String(lines.length - shown.length) }),
            style: { fg: "diagnostic.info_fg" },
          });
        }
      }
    } else if (snapshot.busy) {
      entries.push({ text: snapshot.progress || editor.t("panel.running") });
      if (snapshot.activity) {
        const live = snapshot.activity;
        entries.push({
          text:
            live.total > 0
              ? editor.t("panel.progress_counts", {
                  completed: String(live.completed),
                  total: String(live.total),
                  elapsed: formatElapsed(Date.now() - live.startedAt),
                })
              : editor.t("panel.progress_elapsed", {
                  elapsed: formatElapsed(Date.now() - live.startedAt),
                }),
        });
      }
      if (lastOutputLine) {
        entries.push({ text: lastOutputLine, style: { fg: "diagnostic.info_fg" } });
      }
    } else if (lastRunScope && snapshot.summaryTestIds) {
      entries.push(
        ...formatRunSummary(
          controller.currentSummary(),
          translate,
          lastRunMs === undefined ? undefined : formatElapsed(lastRunMs),
        ).map((text) => ({ text })),
      );
    } else if (editor.workspaceTrustLevel() !== "trusted") {
      entries.push({ text: editor.t("panel.trust_required") });
    } else {
      if (lastDiscoveryMs !== undefined && snapshot.tests.length > 0) {
        entries.push({
          text: editor.t("panel.loaded", {
            count: String(snapshot.tests.length),
            elapsed: formatElapsed(lastDiscoveryMs),
          }),
        });
      }
      entries.push({ text: editor.t("panel.select_test") });
    }
  }
  if (snapshot.diagnostics.length > 0) {
    entries.push({ text: editor.t("panel.diagnostics"), style: { bold: true } });
    entries.push(
      ...snapshot.diagnostics.map((text) => ({
        text,
        style: { fg: "diagnostic.warning_fg" },
      })),
    );
  }
  return entries;
}

function titleSummary(
  snapshot: ObservatorySnapshot,
  summary: TestSummary,
  workspace: TestSummary,
): string {
  const scope = snapshot.summaryTestIds ? editor.t("panel.last_run") : editor.t("panel.workspace");
  const run =
    scope +
    " ✓ " +
    summary.passed +
    "  ✕ " +
    summary.failed +
    "  ○ " +
    summary.skipped +
    "  ◇ " +
    summary.unknown;
  if (!snapshot.summaryTestIds) return editor.t("panel.title") + " · " + run;
  return (
    editor.t("panel.title") +
    " · " +
    run +
    " · " +
    editor.t("panel.workspace_count", {
      count: String(workspace.total),
    })
  );
}

function setAllTreeBranchesExpanded(expanded: boolean): void {
  treeExpansionMode = expanded ? "all" : "none";
  const keys = resolveExpandedTreeKeys(treeRows, treeExpansionMode);
  expandedTreeKeys = new Set(keys);
  treeHasFocus = true;
  if (panelMounted) {
    for (const mutation of treeExpansionAction(TREE_KEY, keys)) {
      editor.widgetMutate(PANEL_ID, mutation);
    }
  }
  persistUiState();
  editor.setStatus(expanded ? editor.t("status.expanded") : editor.t("status.collapsed"));
}

async function setFilter(): Promise<void> {
  const value = await editor.prompt(editor.t("prompt.filter"), filterText);
  if (value === null) return;
  filterText = value.trim();
  selectedTestId = undefined;
  selectedTreeKey = undefined;
  treeExpansionMode = "all";
  persistUiState();
  renderDock();
}

function toggleFailedOnly(): void {
  failedOnly = !failedOnly;
  selectedTestId = undefined;
  selectedTreeKey = undefined;
  treeExpansionMode = "all";
  persistUiState();
  renderDock();
}

function toggleSort(): void {
  sortMode = sortMode === "name" ? "duration" : "name";
  persistUiState();
  renderDock();
}

function toggleWatch(): void {
  watchEnabled = !watchEnabled;
  watchSessionOverride = true;
  persistUiState();
  renderDock();
  editor.setStatus(watchEnabled ? editor.t("status.watch_on") : editor.t("status.watch_off"));
}

function nextFailure(): void {
  const failed = controller.snapshot().tests.filter((test) => test.status === "failed");
  if (failed.length === 0) {
    editor.setStatus(editor.t("status.no_failures"));
    return;
  }
  const current = failed.findIndex((test) => test.id === selectedTestId);
  const selected = failed[(current + 1) % failed.length]!;
  selectedTestId = selected.id;
  selectedTreeKey = "test:" + selected.id;
  persistUiState();
  renderDock();
  if (panelMounted) {
    const index = treeRows.findIndex((item) => item.testId === selected.id);
    if (index >= 0) {
      editor.widgetMutate(PANEL_ID, {
        kind: "setSelectedIndex",
        widgetKey: TREE_KEY,
        index,
      });
    }
  }
}

function openSelectedTest(): void {
  const selected = controller.snapshot().tests.find((test) => test.id === selectedTestId);
  if (!selected) return;
  if (!selected.source) {
    editor.setStatus(editor.t("status.no_source", { test: selected.label }));
    return;
  }
  editor.openFile(
    resolvePath(editor.getCwd(), selected.source.path),
    selected.source.line,
    selected.source.column ?? 1,
  );
}

async function importReport(): Promise<void> {
  const path = await editor.pickFile(editor.t("prompt.report"), editor.getCwd(), true);
  if (!path) return;
  const content = editor.readFile(editor.authorityPath(path));
  if (typeof content !== "string") {
    throw new Error(editor.t("error.read_report", { path }));
  }
  const lower = basename(path).toLocaleLowerCase();
  if (lower.includes("cobertura") || /<coverage\b/i.test(content)) {
    const count = publicApi.ingestCobertura(content, editor.getCwd());
    manualOutput = editor.t("status.imported_coverage", { count: String(count), path });
  } else {
    const adapterId = "junit:" + basename(path);
    const count = publicApi.ingestJUnit(content, adapterId);
    manualOutput = editor.t("status.imported_tests", { count: String(count), path });
  }
  editor.setStatus(manualOutput);
  await openDock();
}

function showAdapters(): void {
  const active = controller.snapshot().activeAdapterIds;
  manualOutput = controller
    .listAdapters()
    .map(
      (adapter) => (active.has(adapter.id) ? "● " : "○ ") + adapter.label + " (" + adapter.id + ")",
    )
    .join("\n");
  showOutput = true;
  renderDock();
}

function outputText(): string {
  const snapshot = controller.snapshot();
  const sections = snapshot.outputs.map(
    (output) => "[" + output.adapterId + "]\n" + output.text.trimEnd(),
  );
  if (snapshot.diagnostics.length > 0) {
    sections.push("[" + editor.t("panel.diagnostics") + "]\n" + snapshot.diagnostics.join("\n"));
  }
  if (manualOutput) sections.push(manualOutput);
  return sections.filter(Boolean).join("\n\n");
}

function showOutputPanel(): void {
  showOutput = true;
  renderDock();
}

function hideOutputPanel(): void {
  showOutput = false;
  renderDock();
}

function copyOutput(): void {
  editor.copyToClipboard(outputText());
  editor.setStatus(editor.t("status.output_copied"));
}

function clearOutput(): void {
  manualOutput = "";
  showOutput = false;
  renderDock();
}

async function paintDecorations(): Promise<void> {
  await paintTestState();
  if (coverageVisible) await paintCoverage();
  updateStatusBar();
}

async function paintTestState(bufferIds?: ReadonlySet<number>): Promise<void> {
  const testsByPath = testStateByPath();
  paintTestExplorerDecorations(testsByPath);
  for (const buffer of editor.listBuffers()) {
    if (
      !buffer.path ||
      buffer.is_virtual ||
      (bufferIds !== undefined && !bufferIds.has(buffer.id))
    ) {
      continue;
    }
    editor.clearLineIndicators(buffer.id, TEST_NAMESPACE);
    editor.removeVirtualTextsByPrefix(buffer.id, FAILURE_TEXT_PREFIX);
    const tests = testsByPath.get(pathKey(buffer.path));
    if (!tests) continue;
    let content = "";
    try {
      content = await editor.getBufferText(buffer.id);
    } catch {
      continue;
    }
    const ranges = lineByteRanges(content);
    const byLine = new Map<number, TestCase[]>();
    for (const test of tests) {
      const line = Math.max(1, test.source!.line);
      const items = byLine.get(line) ?? [];
      items.push(test);
      byLine.set(line, items);
    }
    for (const [line, lineTests] of byLine) {
      const status = worstStatus(lineTests.map((test) => test.status));
      const color = statusRgb(status);
      editor.setLineIndicator(
        buffer.id,
        line - 1,
        TEST_NAMESPACE,
        statusGlyph(status),
        color[0],
        color[1],
        color[2],
        40,
      );
      const failure = lineTests.find((test) => test.status === "failed" && test.message);
      const range = ranges[line - 1];
      if (failure && range) {
        editor.addVirtualTextStyled(
          buffer.id,
          FAILURE_TEXT_PREFIX + failure.id,
          range.contentEnd,
          "  ✕ " + failure.message,
          { fg: "diagnostic.error_fg", italic: true },
          false,
        );
      }
    }
  }
}

function testStateByPath(): Map<string, TestCase[]> {
  const snapshot = controller.snapshot();
  const root = editor.getCwd();
  const testsByPath = new Map<string, TestCase[]>();
  for (const test of snapshot.tests) {
    if (!test.source) continue;
    const path = resolvePath(root, test.source.path);
    if (dirtySourcePaths.has(pathKey(path))) continue;
    const items = testsByPath.get(pathKey(path)) ?? [];
    items.push({ ...test, source: { ...test.source, path } });
    testsByPath.set(pathKey(path), items);
  }
  return testsByPath;
}

function paintTestExplorerDecorations(testsByPath: ReadonlyMap<string, TestCase[]>): void {
  const explorer = [...testsByPath.values()].map((tests) => {
    const status = worstStatus(tests.map((test) => test.status));
    return {
      path: tests[0]!.source!.path,
      symbol: statusGlyph(status),
      color: statusTheme(status),
      priority: 30,
    };
  });
  editor.setFileExplorerDecorations(TEST_NAMESPACE, explorer);
}

async function paintCoverage(): Promise<void> {
  const files = controller.snapshot().coverage;
  const root = editor.getCwd();
  const byPath = new Map(
    files.map((file) => {
      const path = resolvePath(root, file.path);
      return [pathKey(path), { ...file, path }] as const;
    }),
  );
  for (const buffer of editor.listBuffers()) {
    if (!buffer.path || buffer.is_virtual || invalidatedCoverageBuffers.has(buffer.id)) continue;
    editor.clearLineIndicators(buffer.id, COVERAGE_NAMESPACE);
    editor.clearScrollbarMarkers(buffer.id, COVERAGE_NAMESPACE);
    const file = byPath.get(pathKey(buffer.path));
    if (!file) continue;
    const covered = file.lines.filter((line) => line.hits > 0).map((line) => line.line - 1);
    const uncovered = file.lines.filter((line) => line.hits === 0).map((line) => line.line - 1);
    if (covered.length > 0) {
      editor.setLineIndicators(buffer.id, covered, COVERAGE_NAMESPACE, "▏", 80, 200, 120, 20);
    }
    if (uncovered.length > 0) {
      editor.setLineIndicators(buffer.id, uncovered, COVERAGE_NAMESPACE, "▏", 230, 90, 90, 30);
    }
    let content = "";
    try {
      content = await editor.getBufferText(buffer.id);
    } catch {
      continue;
    }
    const ranges = lineByteRanges(content);
    editor.setScrollbarMarkers(
      buffer.id,
      COVERAGE_NAMESPACE,
      contiguousCoverageMarkers(file, ranges),
    );
  }
  paintCoverageExplorerDecorations(files, root);
}

function paintCoverageExplorerDecorations(
  files: readonly CoverageFile[],
  root = editor.getCwd(),
): void {
  editor.setFileExplorerDecorations(
    COVERAGE_NAMESPACE,
    files.map((file) => {
      const observed = file.lines.length;
      const covered = file.lines.filter((line) => line.hits > 0).length;
      const percent = observed > 0 ? Math.round((covered / observed) * 100) : 0;
      return {
        path: resolvePath(root, file.path),
        symbol: percent + "%",
        color:
          percent >= settings.coverageGoodThreshold
            ? "ui.file_status_added_fg"
            : percent >= settings.coverageWarningThreshold
              ? "diagnostic.warning_fg"
              : "diagnostic.error_fg",
        priority: 20,
      };
    }),
  );
}

function contiguousCoverageMarkers(
  file: CoverageFile,
  ranges: Array<{ start: number; end: number; contentEnd: number }>,
): ScrollbarMarker[] {
  const sorted = [...file.lines].sort((left, right) => left.line - right.line);
  const markers: ScrollbarMarker[] = [];
  let startIndex = 0;
  while (startIndex < sorted.length) {
    const covered = sorted[startIndex]!.hits > 0;
    let endIndex = startIndex;
    while (
      endIndex + 1 < sorted.length &&
      sorted[endIndex + 1]!.line === sorted[endIndex]!.line + 1 &&
      sorted[endIndex + 1]!.hits > 0 === covered
    ) {
      endIndex += 1;
    }
    const start = ranges[sorted[startIndex]!.line - 1];
    const end = ranges[sorted[endIndex]!.line - 1];
    if (start && end) {
      markers.push({
        position: start.start,
        end: end.end,
        color: covered ? "ui.file_status_added_fg" : "diagnostic.error_fg",
        priority: covered ? 20 : 30,
      });
    }
    startIndex = endIndex + 1;
  }
  return markers;
}

function lineByteRanges(
  content: string,
): Array<{ start: number; end: number; contentEnd: number }> {
  const lines = content.split("\n");
  const ranges: Array<{ start: number; end: number; contentEnd: number }> = [];
  let position = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const text = lines[index]!;
    const contentLength = editor.utf8ByteLength(text);
    const newlineLength = index + 1 < lines.length ? 1 : 0;
    ranges.push({
      start: position,
      contentEnd: position + contentLength,
      end: position + contentLength + newlineLength,
    });
    position += contentLength + newlineLength;
  }
  return ranges;
}

function invalidateDecorations(bufferId: number): void {
  const path = editor.getBufferPath(bufferId);
  if (!path) return;
  if (
    !beginDirtySourceSession(dirtySourcePaths, pathKey(path), editor.isBufferModified(bufferId))
  ) {
    return;
  }
  clearDiscoveryCaches();
  editor.clearLineIndicators(bufferId, TEST_NAMESPACE);
  editor.removeVirtualTextsByPrefix(bufferId, FAILURE_TEXT_PREFIX);
  paintTestExplorerDecorations(testStateByPath());
  if (coverageVisible && !invalidatedCoverageBuffers.has(bufferId)) {
    invalidatedCoverageBuffers.add(bufferId);
    controller.invalidateCoveragePath(path);
    editor.clearLineIndicators(bufferId, COVERAGE_NAMESPACE);
    editor.clearScrollbarMarkers(bufferId, COVERAGE_NAMESPACE);
    if (controller.snapshot().coverage.length === 0) {
      coverageVisible = false;
      editor.clearFileExplorerDecorations(COVERAGE_NAMESPACE);
      renderDock();
      updateStatusBar();
    } else {
      paintCoverageExplorerDecorations(controller.snapshot().coverage);
    }
    editor.setStatus(editor.t("status.coverage_stale"));
  }
}

function clearCoverageDecorations(): void {
  for (const buffer of editor.listBuffers()) {
    editor.clearLineIndicators(buffer.id, COVERAGE_NAMESPACE);
    editor.clearScrollbarMarkers(buffer.id, COVERAGE_NAMESPACE);
  }
  editor.clearFileExplorerDecorations(COVERAGE_NAMESPACE);
}

function updateStatusBar(): void {
  const snapshot = controller.snapshot();
  const summary = controller.currentSummary();
  const prefix = snapshot.summaryTestIds
    ? editor.t("status.last_prefix")
    : editor.t("status.all_prefix");
  const coverage = coverageVisible
    ? " Cov " + summarizeCoverage(snapshot.coverage).percent + "%"
    : "";
  const text = snapshot.busy
    ? "◉ " +
      formatActivity(
        snapshot.activity && snapshot.activity.total > 0
          ? editor.t("status.running_prefix")
          : snapshot.progress,
        snapshot.activity,
        Date.now(),
      )
    : prefix + " ✓" + summary.passed + " ✕" + summary.failed + " ○" + summary.skipped + coverage;
  if (snapshot.busy) {
    // One small command per tick; every other buffer catches up when the run ends.
    if (text === lastStatusBarText) return;
    lastStatusBarText = text;
    statusBarBuffers.clear();
    const active = editor.getActiveBufferId();
    if (active) {
      editor.setStatusBarValue(active, STATUS_TOKEN, text);
      statusBarBuffers.add(active);
    }
    return;
  }
  const buffers = editor.listBuffers();
  if (text === lastStatusBarText) {
    for (const buffer of buffers) {
      if (statusBarBuffers.has(buffer.id)) continue;
      editor.setStatusBarValue(buffer.id, STATUS_TOKEN, text);
      statusBarBuffers.add(buffer.id);
    }
    return;
  }
  lastStatusBarText = text;
  statusBarBuffers.clear();
  for (const buffer of buffers) {
    editor.setStatusBarValue(buffer.id, STATUS_TOKEN, text);
    statusBarBuffers.add(buffer.id);
  }
}

async function runSavedFile(path: string): Promise<void> {
  if (controller.snapshot().busy) return;
  await prepareOpenBufferText();
  endDirtySourceSession(dirtySourcePaths, pathKey(path));
  clearDiscoveryCaches();
  if (!controller.snapshot().discoveryRoot) await controller.refresh();
  const active = { activeFile: path, activeLine: 1 };
  lastRunScope = "file";
  await controller.run("file", active);
  if (settings.coverageOnSave) {
    lastOperationWasCoverage = true;
    const files = await controller.collectCoverage(active);
    coverageVisible = files.length > 0;
    invalidatedCoverageBuffers.clear();
  }
  await paintDecorations();
}

function statusGlyph(status: TestStatus): string {
  switch (status) {
    case "passed":
      return "✓";
    case "failed":
      return "✕";
    case "skipped":
      return "○";
    case "running":
      return "◉";
    case "queued":
      return "·";
    case "unknown":
      return "◇";
  }
}

function statusTheme(status: TestStatus): string {
  switch (status) {
    case "passed":
      return "ui.file_status_added_fg";
    case "failed":
      return "diagnostic.error_fg";
    case "skipped":
      return "diagnostic.warning_fg";
    case "running":
    case "queued":
    case "unknown":
      return "diagnostic.info_fg";
  }
}

function statusRgb(status: TestStatus): [number, number, number] {
  switch (status) {
    case "passed":
      return [80, 200, 120];
    case "failed":
      return [230, 90, 90];
    case "skipped":
      return [220, 180, 80];
    case "running":
    case "queued":
    case "unknown":
      return [100, 160, 220];
  }
}

function worstStatus(statuses: readonly TestStatus[]): TestStatus {
  const order: Record<TestStatus, number> = {
    failed: 6,
    running: 5,
    queued: 4,
    skipped: 3,
    passed: 2,
    unknown: 1,
  };
  return [...statuses].sort((left, right) => order[right] - order[left])[0] ?? "unknown";
}

function formatDuration(milliseconds: number): string {
  return milliseconds < 1000
    ? Math.round(milliseconds) + " ms"
    : (milliseconds / 1000).toFixed(2) + " s";
}

function formatStatusSummary(summary: TestSummary): string {
  return editor.t(lastRunMs === undefined ? "status.summary" : "status.summary_elapsed", {
    passed: String(summary.passed),
    failed: String(summary.failed),
    skipped: String(summary.skipped),
    elapsed: lastRunMs === undefined ? "" : formatElapsed(lastRunMs),
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, Math.round(value)));
}

function readPersistedState(): PersistedUiState {
  const value = editor.getWindowState(UI_STATE_KEY);
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as PersistedUiState;
}

function persistUiState(): void {
  editor.setWindowState(UI_STATE_KEY, {
    ...(selectedTestId ? { selectedTestId } : {}),
    ...(selectedTreeKey ? { selectedTreeKey } : {}),
    expandedTreeKeys: [...expandedTreeKeys],
    treeExpansionMode,
    filter: filterText,
    failedOnly,
    sortMode,
    watch: watchEnabled,
    dockOpen,
  } satisfies PersistedUiState);
}

function reportUnhandledError(error: unknown): void {
  const message = errorMessage(error);
  editor.error(editor.t("error.unhandled", { error: message }));
  editor.setStatus(editor.t("error.unhandled", { error: message }));
  renderDock();
}

async function guardedCall(action: () => void | Promise<unknown>): Promise<void> {
  try {
    await action();
  } catch (error) {
    reportUnhandledError(error);
  }
}

function guarded(action: () => void | Promise<unknown>): () => void {
  return () => {
    void guardedCall(action);
  };
}

registerHandler("test_observatory_open", guarded(openDock));
registerHandler("test_observatory_close", closeDock);
registerHandler("test_observatory_refresh", guarded(refreshTests));
registerHandler(
  "test_observatory_run_workspace",
  guarded(() => runScope("workspace")),
);
registerHandler(
  "test_observatory_run_selected",
  guarded(() => runScope("selected")),
);
registerHandler(
  "test_observatory_run_nearest",
  guarded(() => runScope("nearest")),
);
registerHandler(
  "test_observatory_run_file",
  guarded(() => runScope("file")),
);
registerHandler(
  "test_observatory_rerun_failed",
  guarded(() => runScope("failed")),
);
registerHandler(
  "test_observatory_run_selected_terminal",
  guarded(() => runScopeInTerminal("selected")),
);
registerHandler(
  "test_observatory_run_nearest_terminal",
  guarded(() => runScopeInTerminal("nearest")),
);
registerHandler("test_observatory_toggle_coverage", guarded(toggleCoverage));
registerHandler("test_observatory_stop", guarded(stopRun));
registerHandler("test_observatory_tick", tick);
registerHandler("test_observatory_open_selected", openSelectedTest);
registerHandler("test_observatory_expand_all", () => setAllTreeBranchesExpanded(true));
registerHandler("test_observatory_collapse_all", () => setAllTreeBranchesExpanded(false));
registerHandler("test_observatory_filter", guarded(setFilter));
registerHandler("test_observatory_failed_only", toggleFailedOnly);
registerHandler("test_observatory_sort", toggleSort);
registerHandler("test_observatory_watch", toggleWatch);
registerHandler("test_observatory_next_failure", nextFailure);
registerHandler("test_observatory_output", showOutputPanel);
registerHandler("test_observatory_back", hideOutputPanel);
registerHandler("test_observatory_copy_output", copyOutput);
registerHandler("test_observatory_import_report", guarded(importReport));
registerHandler("test_observatory_adapters", showAdapters);
registerHandler("test_observatory_context_close", () =>
  showOutput ? hideOutputPanel() : closeDock(),
);
registerHandler("test_observatory_context_c", () =>
  showOutput ? copyOutput() : void guardedCall(toggleCoverage),
);
registerHandler("test_observatory_widget_up", () => {
  lastTreeKeyboardMoveAt = Date.now();
  editor.widgetCommand(PANEL_ID, { kind: "key", key: "Up" });
});
registerHandler("test_observatory_widget_down", () => {
  lastTreeKeyboardMoveAt = Date.now();
  editor.widgetCommand(PANEL_ID, { kind: "key", key: "Down" });
});
registerHandler("test_observatory_widget_left", () =>
  editor.widgetCommand(PANEL_ID, { kind: "key", key: "Left" }),
);
registerHandler("test_observatory_widget_right", () =>
  editor.widgetCommand(PANEL_ID, { kind: "key", key: "Right" }),
);
registerHandler("test_observatory_widget_tab", () => {
  treeHasFocus = false;
  editor.widgetCommand(PANEL_ID, { kind: "focusAdvance", delta: 1 });
});
registerHandler("test_observatory_widget_backtab", () => {
  treeHasFocus = false;
  editor.widgetCommand(PANEL_ID, { kind: "focusAdvance", delta: -1 });
});
registerHandler("test_observatory_widget_activate", () => {
  // The "activate" command only fires buttons and toggles; a tree's
  // activate event comes from its Enter handling, so route the key.
  editor.widgetCommand(PANEL_ID, { kind: "key", key: "Enter" });
});

editor.defineMode(
  PANEL_MODE,
  [
    ["Up", "test_observatory_widget_up"],
    ["Down", "test_observatory_widget_down"],
    ["Left", "test_observatory_widget_left"],
    ["Right", "test_observatory_widget_right"],
    ["Tab", "test_observatory_widget_tab"],
    ["S-Tab", "test_observatory_widget_backtab"],
    ["Enter", "test_observatory_widget_activate"],
    ["r", "test_observatory_run_selected"],
    ["a", "test_observatory_run_workspace"],
    ["n", "test_observatory_run_nearest"],
    ["f", "test_observatory_filter"],
    ["x", "test_observatory_stop"],
    ["c", "test_observatory_context_c"],
    ["]", "test_observatory_next_failure"],
    ["o", "test_observatory_output"],
    ["w", "test_observatory_watch"],
    ["q", "test_observatory_context_close"],
    ["Escape", "test_observatory_context_close"],
  ],
  true,
  false,
  false,
);

const commands: Array<[string, string, string]> = [
  ["%cmd.open", "%cmd.open_desc", "test_observatory_open"],
  ["%cmd.close", "%cmd.close_desc", "test_observatory_close"],
  ["%cmd.refresh", "%cmd.refresh_desc", "test_observatory_refresh"],
  ["%cmd.run_workspace", "%cmd.run_workspace_desc", "test_observatory_run_workspace"],
  ["%cmd.run_selected", "%cmd.run_selected_desc", "test_observatory_run_selected"],
  ["%cmd.run_nearest", "%cmd.run_nearest_desc", "test_observatory_run_nearest"],
  ["%cmd.run_cursor", "%cmd.run_cursor_desc", "test_observatory_run_nearest"],
  ["%cmd.run_file", "%cmd.run_file_desc", "test_observatory_run_file"],
  ["%cmd.rerun_failed", "%cmd.rerun_failed_desc", "test_observatory_rerun_failed"],
  [
    "%cmd.run_selected_terminal",
    "%cmd.run_selected_terminal_desc",
    "test_observatory_run_selected_terminal",
  ],
  [
    "%cmd.run_nearest_terminal",
    "%cmd.run_nearest_terminal_desc",
    "test_observatory_run_nearest_terminal",
  ],
  ["%cmd.coverage", "%cmd.coverage_desc", "test_observatory_toggle_coverage"],
  ["%cmd.stop", "%cmd.stop_desc", "test_observatory_stop"],
  ["%cmd.navigate", "%cmd.navigate_desc", "test_observatory_open_selected"],
  ["%cmd.expand_all", "%cmd.expand_all_desc", "test_observatory_expand_all"],
  ["%cmd.collapse_all", "%cmd.collapse_all_desc", "test_observatory_collapse_all"],
  ["%cmd.filter", "%cmd.filter_desc", "test_observatory_filter"],
  ["%cmd.failed_only", "%cmd.failed_only_desc", "test_observatory_failed_only"],
  ["%cmd.sort", "%cmd.sort_desc", "test_observatory_sort"],
  ["%cmd.watch", "%cmd.watch_desc", "test_observatory_watch"],
  ["%cmd.next_failure", "%cmd.next_failure_desc", "test_observatory_next_failure"],
  ["%cmd.output", "%cmd.output_desc", "test_observatory_output"],
  ["%cmd.import_report", "%cmd.import_report_desc", "test_observatory_import_report"],
  ["%cmd.adapters", "%cmd.adapters_desc", "test_observatory_adapters"],
];
for (const [name, description, handler] of commands) {
  editor.registerCommand(name, description, handler, null);
}

editor.on("widget_event", (event) => {
  if (event.panel_id !== PANEL_ID) return;
  if (event.event_type === "cancel") {
    closeDock();
    return;
  }
  if (event.widget_key === TREE_KEY) treeHasFocus = true;
  else if (event.event_type === "activate" && event.widget_key !== OUTPUT_KEY) treeHasFocus = false;
  if (event.widget_key === TREE_KEY && event.event_type === "expand") {
    const key = event.payload.key;
    const expanded = event.payload.expanded;
    if (typeof key === "string" && typeof expanded === "boolean") {
      treeExpansionMode = "manual";
      if (expanded) expandedTreeKeys.add(key);
      else expandedTreeKeys.delete(key);
      persistUiState();
    }
    return;
  }
  if (
    event.widget_key === TREE_KEY &&
    (event.event_type === "select" || event.event_type === "activate")
  ) {
    const index = typeof event.payload.index === "number" ? event.payload.index : -1;
    const selection = treeSelectionAt(treeRows, index);
    selectedTreeKey = selection.treeKey;
    selectedTestId = selection.testId;
    coverageDetailsVisible = false;
    lastOperationWasCoverage = false;
    persistUiState();
    const now = Date.now();
    const doubleClick =
      event.event_type === "select" &&
      selectedTreeKey !== undefined &&
      lastTreeSelect?.key === selectedTreeKey &&
      now - lastTreeSelect.at <= DOUBLE_CLICK_MS &&
      now - lastTreeKeyboardMoveAt > DOUBLE_CLICK_MS;
    lastTreeSelect = selectedTreeKey ? { key: selectedTreeKey, at: now } : undefined;
    if ((event.event_type === "activate" || doubleClick) && selectedTestId) openSelectedTest();
    else renderDock();
    return;
  }
  if (event.event_type !== "activate") return;
  switch (event.widget_key) {
    case "refresh":
      void guardedCall(refreshTests);
      break;
    case "run-workspace":
      void guardedCall(() => runScope("workspace"));
      break;
    case "run-selected":
      void guardedCall(() => runScope("selected"));
      break;
    case "run-nearest":
      void guardedCall(() => runScope("nearest"));
      break;
    case "run-file":
      void guardedCall(() => runScope("file"));
      break;
    case "rerun-failed":
      void guardedCall(() => runScope("failed"));
      break;
    case "toggle-coverage":
      void guardedCall(toggleCoverage);
      break;
    case "stop":
      void guardedCall(stopRun);
      break;
    case "output":
      showOutputPanel();
      break;
    case "back":
      hideOutputPanel();
      break;
    case "copy-output":
      copyOutput();
      break;
    case "clear-output":
      clearOutput();
      break;
    case "adapters":
      showAdapters();
      break;
    case "watch":
      toggleWatch();
      break;
    case "expand-all":
      setAllTreeBranchesExpanded(true);
      break;
    case "collapse-all":
      setAllTreeBranchesExpanded(false);
      break;
    case "failed-only":
      toggleFailedOnly();
      break;
    case "sort":
      toggleSort();
      break;
    case "filter":
      void guardedCall(setFilter);
      break;
  }
});

// Fresh delivers background-process output on legacy hook names; the typed
// `process_output` alias is registered too for hosts that route through it.
registerHandler("test_observatory_process_stdout", (event: { process_id: number; data: string }) =>
  receiveProcessOutput(event.process_id, event.data, "stdout"),
);
registerHandler("test_observatory_process_stderr", (event: { process_id: number; data: string }) =>
  receiveProcessOutput(event.process_id, event.data, "stderr"),
);
editor.on("process_output", (event) =>
  receiveProcessOutput(event.process_id, event.data, "stdout"),
);
editor.on("onProcessStdout", "test_observatory_process_stdout");
editor.on("onProcessStderr", "test_observatory_process_stderr");

editor.on("terminal_output", (event) => {
  const waiter = terminalWaiters.get(event.terminal_id);
  if (!waiter) return;
  if (waiter.fallbackLines.at(-1) !== event.last_line) {
    waiter.fallbackLines.push(event.last_line);
    if (waiter.fallbackLines.length > 10_000) waiter.fallbackLines.shift();
  }
});

editor.on("terminal_exit", (event) => {
  void finishTerminalRun(event.terminal_id, event.exit_code);
});

async function finishTerminalRun(terminalId: number, exitCode: number | null): Promise<void> {
  const waiter = terminalWaiters.get(terminalId);
  if (!waiter) return;
  terminalWaiters.delete(terminalId);
  if (activeTerminalId === terminalId) activeTerminalId = undefined;
  waiter.resolve(
    await captureTerminalProcessOutput(
      (bufferId) => editor.getBufferText(bufferId),
      waiter.bufferId,
      waiter.fallbackLines,
      exitCode,
    ),
  );
}

function sourceFileSaved(path: string, bufferId: number): void {
  clearDiscoveryCaches();
  openBufferText.delete(pathKey(path));
  const action = sourceSaveAction(
    dirtySourcePaths,
    pathKey(path),
    bufferId,
    watchEnabled || settings.coverageOnSave,
  );
  if (action.kind === "run") {
    void guardedCall(() => runSavedFile(path));
  } else if (action.kind === "repaint") {
    void guardedCall(() => paintTestState(new Set([action.bufferId])));
  }
}

function sourceFileReverted(path: string, bufferId: number): void {
  clearDiscoveryCaches();
  openBufferText.delete(pathKey(path));
  endDirtySourceSession(dirtySourcePaths, pathKey(path));
  invalidatedCoverageBuffers.delete(bufferId);
  if (dockOpen && !controller.snapshot().busy) void guardedCall(refreshTests);
}

registerSourceLifecycleEvents((eventName, handler) => editor.on(eventName, handler), {
  linesChanged: invalidateDecorations,
  fileSaved: sourceFileSaved,
  fileReverted: sourceFileReverted,
});

editor.on("after_file_explorer_change", () => {
  clearDiscoveryCaches();
  if (dockOpen && !controller.snapshot().busy) void guardedCall(refreshTests);
});

editor.on("buffer_activated", () => {
  updateStatusBar();
  if (coverageVisible) void guardedCall(paintCoverage);
  if (coverageDetailsVisible) renderDock();
});

editor.on("buffer_closed", (event) => {
  invalidatedCoverageBuffers.delete(event.buffer_id);
  statusBarBuffers.delete(event.buffer_id);
  if (event.buffer_id !== dockBufferId) return;
  dockBufferId = undefined;
  dockSplitId = undefined;
  panelMounted = false;
  dockOpen = false;
  persistUiState();
});

editor.on("trust_changed", (event) => {
  clearDiscoveryCaches();
  if (event.level === "trusted" && dockOpen && !controller.snapshot().busy) {
    void guardedCall(refreshTests);
  } else {
    renderDock();
  }
});

editor.on("config_changed", () => {
  refreshSettings();
  clearDiscoveryCaches();
  renderDock();
  if (dockOpen && !controller.snapshot().busy) void guardedCall(refreshTests);
});

editor.on("ready", () => {
  if (dockOpen) void guardedCall(openDock);
});

export {};
