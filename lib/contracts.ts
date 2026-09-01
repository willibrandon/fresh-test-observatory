export type TestStatus = "unknown" | "queued" | "running" | "passed" | "failed" | "skipped";

export type TestScope = "workspace" | "file" | "nearest" | "selected" | "failed";

export interface SourceLocation {
  path: string;
  /** 1-based line number. */
  line: number;
  /** 1-based column number. */
  column?: number;
}

export interface TestCase {
  /** Stable adapter-qualified identifier. */
  id: string;
  /** Runner-native fully-qualified test name. */
  nativeId: string;
  label: string;
  adapterId: string;
  framework?: string;
  project?: string;
  /** Runner target identity, such as a Rust integration-test binary. */
  target?: string;
  suite?: string[];
  source?: SourceLocation;
  status: TestStatus;
  durationMs?: number;
  message?: string;
  stack?: string;
  /** Discovery parent for one concrete parameterized or subtest result. */
  parentId?: string;
}

export interface TestSummary {
  total: number;
  unknown: number;
  queued: number;
  running: number;
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
}

export interface CoverageLine {
  line: number;
  hits: number;
  branchRate?: number;
}

export interface CoverageFile {
  path: string;
  lines: CoverageLine[];
}

export interface ProcessSpec {
  command: string;
  args: string[];
  cwd?: string;
  /** Short user-facing description shown while this process runs. */
  label?: string;
  /** Optional exact report path the adapter expects the command to create. */
  reportPath?: string;
  reportFormat?: "trx" | "junit" | "cobertura";
}

export interface ProcessOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface AdapterContext {
  cwd: string;
  activeFile?: string;
  activeLine?: number;
  trusted: boolean;
  /** Authority-local report directory outside the workspace checkout. */
  reportDir?: string;
  preferNextest?: boolean;
  noBuild?: boolean;
  noRestore?: boolean;
  dotnetVerbosity?: "quiet" | "minimal" | "normal" | "detailed" | "diagnostic";
  readFile(path: string): string | null;
  /** Normalized absolute paths matching a recursive workspace file glob. */
  findFiles(glob: string): Promise<string[]>;
  execute(spec: ProcessSpec): Promise<ProcessOutput>;
}

export interface DiscoverResult {
  tests: TestCase[];
  diagnostics?: string[];
}

export interface RunRequest {
  scope: TestScope;
  tests: TestCase[];
  activeFile?: string;
  activeLine?: number;
}

export interface AdapterRunResult {
  tests: TestCase[];
  output: string;
  exitCode: number;
  diagnostics?: string[];
}

export interface CoverageResult {
  files: CoverageFile[];
  output: string;
  diagnostics?: string[];
}

/**
 * Public Test Observatory extension point. Adapters own their discovery and
 * runner-specific parsing while the host owns UI, state, navigation, and
 * decorations.
 */
export interface TestObservatoryAdapter {
  readonly id: string;
  readonly label: string;
  readonly priority?: number;
  detect(context: AdapterContext): boolean | Promise<boolean>;
  discover(context: AdapterContext): DiscoverResult | Promise<DiscoverResult>;
  run(context: AdapterContext, request: RunRequest): AdapterRunResult | Promise<AdapterRunResult>;
  collectCoverage?(
    context: AdapterContext,
    request: RunRequest,
  ): CoverageResult | Promise<CoverageResult>;
}

export interface TestObservatoryApi {
  /** Adds or replaces a language adapter for the current Fresh process. */
  registerAdapter(adapter: TestObservatoryAdapter): boolean;
  unregisterAdapter(id: string): boolean;
  listAdapters(): Array<{ id: string; label: string; priority: number }>;
  /** Imports a JUnit XML document into the shared test model. */
  ingestJUnit(xml: string, adapterId?: string): number;
  /** Imports a Cobertura XML document and updates editor decorations. */
  ingestCobertura(xml: string, workspaceRoot?: string): number;
  refresh(): Promise<number>;
  run(scope: TestScope): Promise<TestSummary>;
}
