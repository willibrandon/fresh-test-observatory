import type { CoverageFile, ProcessSpec, TestCase } from "./contracts.ts";
import { mergeCoverage } from "./model.ts";
import { joinPath, relativePath, stem } from "./path.ts";

export interface CargoOptions {
  workspaceRoot: string;
  nextest: boolean;
  packageName?: string;
  tests?: readonly TestCase[];
  activeFile?: string;
  coverage?: boolean;
  reportDir?: string;
  doctest?: boolean;
}

/** Finds ordinary, async, and rstest-style Rust test functions in a source file. */
export function discoverRustSourceTests(
  path: string,
  source: string,
  workspaceRoot: string,
): TestCase[] {
  const tests: TestCase[] = [];
  const starts = lineStarts(source);
  const declaration =
    /(?:pub(?:\([^()\r\n]{0,128}\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*[<(]/y;
  let searchFrom = 0;
  for (;;) {
    const attributeStart = source.indexOf("#", searchFrom);
    if (attributeStart < 0) break;
    const block = rustAttributeBlock(source, attributeStart);
    if (!block) {
      searchFrom = attributeStart + 1;
      continue;
    }
    searchFrom = block.end;
    const attrs = block.attributes;
    if (!/#\s*\[\s*(?:(?:tokio|async_std)::)?test\b|#\s*\[\s*rstest\b/.test(attrs)) continue;
    declaration.lastIndex = block.end;
    const match = declaration.exec(source);
    if (!match) continue;
    const name = match[1]!;
    const before = source.slice(0, attributeStart);
    const modulePath = rustModulePath(path, workspaceRoot, before);
    const nativeId = [...modulePath, name].join("::");
    const integrationTarget = rustIntegrationTarget(path, workspaceRoot);
    tests.push({
      id: `cargo:${integrationTarget ? integrationTarget + ":" : ""}${nativeId}`,
      nativeId,
      label: name,
      adapterId: "cargo",
      framework: integrationTarget
        ? "rust-integration"
        : /rstest/.test(attrs)
          ? "rstest"
          : "libtest",
      ...(integrationTarget ? { target: integrationTarget } : {}),
      suite: [...(integrationTarget ? [integrationTarget] : []), ...modulePath],
      source: { path, line: lineNumberAt(starts, match.index) },
      status: /#\s*\[\s*ignore\b/.test(attrs) ? "skipped" : "unknown",
    });
    searchFrom = declaration.lastIndex;
  }
  return tests;
}

function rustAttributeBlock(
  source: string,
  start: number,
): { attributes: string; end: number } | undefined {
  let cursor = start;
  let attributes = "";
  while (cursor < source.length && source[cursor] === "#") {
    const attributeStart = cursor;
    cursor += 1;
    while (/\s/.test(source[cursor] ?? "")) cursor += 1;
    if (source[cursor] !== "[") return undefined;
    const end = matchingSquareBracket(source, cursor);
    if (end < 0) return undefined;
    attributes += source.slice(attributeStart, end + 1);
    cursor = end + 1;
    while (/\s/.test(source[cursor] ?? "")) cursor += 1;
  }
  return attributes ? { attributes, end: cursor } : undefined;
}

function matchingSquareBracket(source: string, start: number): number {
  let depth = 1;
  let quote: '"' | "'" | undefined;
  for (let cursor = start + 1; cursor < source.length; cursor += 1) {
    const character = source[cursor]!;
    if (quote) {
      if (character === "\\") cursor += 1;
      else if (character === quote) quote = undefined;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === "[") {
      depth += 1;
    } else if (character === "]") {
      depth -= 1;
      if (depth === 0) return cursor;
    }
  }
  return -1;
}

function lineStarts(source: string): number[] {
  const starts = [0];
  let cursor = 0;
  while ((cursor = source.indexOf("\n", cursor)) >= 0) {
    cursor += 1;
    starts.push(cursor);
  }
  return starts;
}

function lineNumberAt(starts: readonly number[], offset: number): number {
  let low = 0;
  let high = starts.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (starts[middle]! <= offset) low = middle + 1;
    else high = middle;
  }
  return low;
}

/** Parses `cargo nextest list --message-format json`. */
export function parseNextestList(json: string): TestCase[] {
  let root: unknown;
  try {
    root = JSON.parse(json);
  } catch {
    return [];
  }
  if (!isRecord(root)) return [];
  const suites = recordAt(root, "rust-suites") ?? recordAt(root, "rust_suites");
  if (!suites) return [];
  const tests: TestCase[] = [];
  for (const [suiteKey, suiteValue] of Object.entries(suites)) {
    if (!isRecord(suiteValue)) continue;
    const cases = recordAt(suiteValue, "testcases") ?? recordAt(suiteValue, "test-cases");
    if (!cases) continue;
    const packageName =
      stringAt(suiteValue, "package-name") ?? stringAt(suiteValue, "package_name") ?? suiteKey;
    for (const [nativeId, caseValue] of Object.entries(cases)) {
      const ignored = isRecord(caseValue) && Boolean(caseValue.ignored);
      tests.push(
        cargoTest(
          nativeId,
          packageName,
          ignored ? "skipped" : "unknown",
          nextestTarget(suiteKey, suiteValue, packageName),
        ),
      );
    }
  }
  return tests;
}

/** Parses stable terse output from `cargo test -- --list --format terse`. */
export function parseCargoList(output: string): TestCase[] {
  const tests: TestCase[] = [];
  for (const match of output.matchAll(/^(.+?):\s+(test|benchmark)\s*$/gm)) {
    const nativeId = match[1]!.trim();
    if (nativeId) tests.push(cargoTest(nativeId, undefined, "unknown"));
  }
  return tests;
}

/** Parses nextest's JSON stream or stable final-status output. */
export function parseNextestRun(output: string): TestCase[] {
  const tests = new Map<string, TestCase>();
  for (const line of output.split(/\r?\n/)) {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(event) || event.type !== "test" || typeof event.name !== "string") continue;
    const status =
      event.event === "ok"
        ? "passed"
        : event.event === "failed" || event.event === "timeout"
          ? "failed"
          : event.event === "ignored"
            ? "skipped"
            : event.event === "started"
              ? "running"
              : undefined;
    if (!status) continue;
    const target = stringAt(event, "binary_id") ?? stringAt(event, "binary-id");
    const testKey = `${target ?? ""}\0${event.name}`;
    const previous =
      tests.get(testKey) ??
      cargoTest(event.name, stringAt(event, "package_name"), "unknown", target);
    const captured = typeof event.stdout === "string" ? event.stdout : "";
    const durationMs =
      typeof event.exec_time === "number" ? event.exec_time * 1000 : previous.durationMs;
    const source = status === "failed" ? rustFailureLocation(captured) : previous.source;
    const message = status === "failed" ? firstLine(captured) : undefined;
    tests.set(testKey, {
      ...previous,
      status,
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(message ? { message } : {}),
      ...(status === "failed" && captured ? { stack: captured } : {}),
      ...(source ? { source } : {}),
    });
  }
  if (tests.size > 0) return [...tests.values()];

  // Machine-readable execution is still experimental in nextest and requires
  // a process environment flag that Fresh cannot set for an individual spawn.
  const plain = stripAnsi(output);
  const summaryAt = plain.lastIndexOf("Summary [");
  const finalStatus = summaryAt >= 0 ? plain.slice(summaryAt) : plain;
  const expression =
    /^\s*(PASS|FAIL|SKIP|SLOW|LEAK|FLAKY)\s+\[\s*([^\]]*)\]\s+(?:\([^)]*\)\s+)?(\S+)\s+(.+?)\s*$/gm;
  for (const match of finalStatus.matchAll(expression)) {
    const nativeId = match[4]!.trim();
    const target = match[3]!.includes("::") ? match[3] : undefined;
    const status = /^(?:PASS|SLOW|FLAKY)$/i.test(match[1]!)
      ? "passed"
      : /^SKIP$/i.test(match[1]!)
        ? "skipped"
        : "failed";
    const durationMs = parseNextestDuration(match[2]);
    const captured = status === "failed" ? nextestFailureBlock(plain, nativeId) : undefined;
    const source = captured ? rustFailureLocation(captured) : undefined;
    const message = captured ? firstLine(captured) : undefined;
    tests.set(`${target ?? ""}\0${nativeId}`, {
      ...cargoTest(nativeId, target ? target.split("::")[0] : match[3], status, target),
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(message ? { message } : {}),
      ...(captured ? { stack: captured } : {}),
      ...(source ? { source } : {}),
    });
  }
  return [...tests.values()];
}

/** Parses classic libtest status lines and panic locations. */
export function parseCargoRun(output: string): TestCase[] {
  const tests = new Map<string, TestCase>();
  for (const match of output.matchAll(
    /^test[ \t]+(.+?)[ \t]+\.\.\.[ \t]+(ok|FAILED|ignored)(?:[ \t].*)?$/gm,
  )) {
    const nativeId = match[1]!.trim();
    const status = match[2] === "ok" ? "passed" : match[2] === "FAILED" ? "failed" : "skipped";
    tests.set(nativeId, cargoTest(nativeId, undefined, status));
  }
  const failureExpression = /----\s+(.+?)\s+stdout\s+----([\s\S]*?)(?=\n----\s+|\nfailures:|$)/g;
  for (const match of output.matchAll(failureExpression)) {
    const nativeId = match[1]!.trim();
    const captured = match[2]!.trim();
    const previous = tests.get(nativeId) ?? cargoTest(nativeId, undefined, "failed");
    const source = rustFailureLocation(captured);
    const message = firstLine(captured);
    tests.set(nativeId, {
      ...previous,
      status: "failed",
      stack: captured,
      ...(message ? { message } : {}),
      ...(source ? { source } : {}),
    });
  }
  return [...tests.values()];
}

export function buildCargoCommand(options: CargoOptions): ProcessSpec {
  const selected = [...new Set(options.tests?.map((test) => test.nativeId) ?? [])];
  const packageArgs = options.packageName ? ["-p", options.packageName] : ["--workspace"];
  if (options.doctest) {
    if (selected.length > 1) throw new Error("Cargo can run only one exact doctest per command");
    return {
      command: "cargo",
      args: ["test", ...packageArgs, "--doc", ...(selected.length === 1 ? [selected[0]!] : [])],
      cwd: options.workspaceRoot,
      label: options.packageName
        ? `Running Rust doctest in ${options.packageName}`
        : "Running Rust doctest",
    };
  }
  if (options.coverage) {
    const reportPath = joinPath(
      options.reportDir ?? joinPath(options.workspaceRoot, ".fresh-test-observatory"),
      "cargo",
      "coverage.cobertura.xml",
    );
    return {
      command: "cargo",
      args: [
        "llvm-cov",
        ...(options.nextest ? ["nextest"] : []),
        ...packageArgs,
        "--cobertura",
        "--output-path",
        reportPath,
      ],
      cwd: options.workspaceRoot,
      reportPath,
      reportFormat: "cobertura",
      label: options.packageName
        ? `Collecting Rust coverage for ${options.packageName}`
        : "Collecting Rust coverage",
    };
  }
  if (options.nextest) {
    const expression = (options.tests ?? [])
      .map((test) =>
        test.target && !test.target.startsWith("integration:")
          ? `(binary_id(=${test.target}) & test(=${test.nativeId}))`
          : `test(=${test.nativeId})`,
      )
      .join(" | ");
    return {
      command: "cargo",
      args:
        selected.length === 0
          ? [
              "nextest",
              "run",
              ...packageArgs,
              "--all-targets",
              "--status-level",
              "none",
              "--final-status-level",
              "all",
            ]
          : [
              "nextest",
              "run",
              ...packageArgs,
              "--all-targets",
              "--status-level",
              "none",
              "--final-status-level",
              "all",
              "-E",
              expression,
            ],
      cwd: options.workspaceRoot,
      label: options.packageName
        ? `Running Rust tests in ${options.packageName}`
        : "Running Rust tests",
    };
  }
  if (selected.length > 1) {
    throw new Error("Plain Cargo can run only one exact test per command");
  }
  return {
    command: "cargo",
    args: [
      "test",
      ...packageArgs,
      ...cargoTargetArgs(options.tests?.[0]?.target),
      ...(selected.length === 1 ? [selected[0]!] : []),
      ...(selected.length === 1 ? ["--", "--exact"] : []),
    ],
    cwd: options.workspaceRoot,
    label: options.packageName
      ? `Running Rust test in ${options.packageName}`
      : "Running Rust test",
  };
}

export function buildCargoListCommand(
  workspaceRoot: string,
  nextest: boolean,
  packageName?: string,
): ProcessSpec {
  const packageArgs = packageName ? ["-p", packageName] : ["--workspace"];
  return {
    command: "cargo",
    args: nextest
      ? ["nextest", "list", ...packageArgs, "--all-targets", "--message-format", "json"]
      : ["test", ...packageArgs, "--all-targets", "--", "--list", "--format", "terse"],
    cwd: workspaceRoot,
    label: packageName ? `Discovering Rust tests in ${packageName}` : "Discovering Rust tests",
  };
}

/** Lists rustdoc examples, which cargo-nextest intentionally does not execute. */
export function buildCargoDocListCommand(workspaceRoot: string, packageName?: string): ProcessSpec {
  const packageArgs = packageName ? ["-p", packageName] : ["--workspace"];
  return {
    command: "cargo",
    args: ["test", ...packageArgs, "--doc", "--", "--list", "--format", "terse"],
    cwd: workspaceRoot,
    label: packageName
      ? `Discovering Rust doctests in ${packageName}`
      : "Discovering Rust doctests",
  };
}

export function parseRustCobertura(files: readonly CoverageFile[]): CoverageFile[] {
  return mergeCoverage(files);
}

function cargoTest(
  nativeId: string,
  project: string | undefined,
  status: TestCase["status"],
  target?: string,
): TestCase {
  const parts = nativeId.split("::");
  const doctest = nativeId.match(/^(.+\.rs) - .*\(line (\d+)\)$/);
  return {
    id: `cargo:${target ? target + ":" : ""}${nativeId}`,
    nativeId,
    label: parts.at(-1) || nativeId,
    adapterId: "cargo",
    framework: doctest
      ? "rust-doctest"
      : target?.startsWith("integration:")
        ? "rust-integration"
        : "libtest",
    suite: [project, target, ...parts.slice(0, -1)].filter((part): part is string => Boolean(part)),
    status,
    ...(project ? { project } : {}),
    ...(target ? { target } : {}),
    ...(doctest ? { source: { path: doctest[1]!, line: Number(doctest[2]) } } : {}),
  };
}

function rustModulePath(path: string, root: string, before: string): string[] {
  const relative = relativePath(root, path);
  const parts = relative.split("/");
  const file = parts.pop() ?? "";
  const sourceIndex = parts.indexOf("src");
  const testsIndex = parts.indexOf("tests");
  const modules =
    sourceIndex >= 0
      ? parts.slice(sourceIndex + 1)
      : testsIndex >= 0
        ? parts.slice(testsIndex + 1)
        : parts;
  if (!/^(?:lib|main|mod)\.rs$/.test(file) && !(testsIndex >= 0 && modules.length === 0)) {
    modules.push(stem(file));
  } else if (testsIndex >= 0 && /^(?:lib|main)\.rs$/.test(file)) modules.push(stem(file));
  modules.push(...activeInlineRustModules(before));
  return modules.filter(Boolean);
}

function rustIntegrationTarget(path: string, root: string): string | undefined {
  const parts = relativePath(root, path).split("/");
  const testsIndex = parts.indexOf("tests");
  if (testsIndex < 0) return undefined;
  const target = parts[testsIndex + 1];
  return target ? `integration:${stem(target)}` : "integration";
}

function nextestTarget(
  suiteKey: string,
  suite: Record<string, unknown>,
  packageName: string,
): string | undefined {
  const binaryId = stringAt(suite, "binary-id") ?? stringAt(suite, "binary_id");
  const raw = binaryId ?? suiteKey.replace(new RegExp(`^${escapeRegex(packageName)}::`), "");
  if (!raw || raw === packageName || raw === "lib") return undefined;
  return binaryId ?? suiteKey;
}

function cargoTargetArgs(target?: string): string[] {
  if (!target) return ["--all-targets"];
  if (target.startsWith("integration:")) return ["--test", target.slice("integration:".length)];
  return ["--all-targets"];
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Returns only inline modules whose braces still contain the current test. */
function activeInlineRustModules(source: string): string[] {
  const structure = maskRustCommentsAndStrings(source);
  const modules: Array<{ name: string; depth: number }> = [];
  let depth = 0;
  for (const match of structure.matchAll(/\bmod\s+([A-Za-z_]\w*)\s*\{|[{}]/g)) {
    if (match[1]) {
      depth += 1;
      modules.push({ name: match[1], depth });
    } else if (match[0] === "{") {
      depth += 1;
    } else {
      while (modules.at(-1)?.depth === depth) modules.pop();
      depth = Math.max(0, depth - 1);
    }
  }
  return modules.map((entry) => entry.name);
}

/** Masks non-code without changing offsets so braces in strings/comments are ignored. */
function maskRustCommentsAndStrings(source: string): string {
  let result = "";
  let index = 0;
  let blockDepth = 0;
  let quote: '"' | "'" | undefined;
  while (index < source.length) {
    const current = source[index]!;
    const next = source[index + 1];
    if (blockDepth > 0) {
      if (current === "/" && next === "*") {
        blockDepth += 1;
        result += "  ";
        index += 2;
      } else if (current === "*" && next === "/") {
        blockDepth -= 1;
        result += "  ";
        index += 2;
      } else {
        result += current === "\n" ? "\n" : " ";
        index += 1;
      }
      continue;
    }
    if (quote) {
      if (current === "\\") {
        result += "  ";
        index += Math.min(2, source.length - index);
      } else {
        result += current === "\n" ? "\n" : " ";
        index += 1;
        if (current === quote) quote = undefined;
      }
      continue;
    }
    if (current === "/" && next === "/") {
      const end = source.indexOf("\n", index);
      const length = (end < 0 ? source.length : end) - index;
      result += " ".repeat(length);
      index += length;
      continue;
    }
    if (current === "/" && next === "*") {
      blockDepth = 1;
      result += "  ";
      index += 2;
      continue;
    }
    if (current === '"' || current === "'") {
      quote = current;
      result += " ";
      index += 1;
      continue;
    }
    result += current;
    index += 1;
  }
  return result;
}

function rustFailureLocation(output: string): TestCase["source"] {
  const match =
    output.match(/panicked at (?:[^,]+,\s*)?([^\r\n:]+\.rs):(\d+):(\d+)/) ??
    output.match(/-->\s+([^\r\n:]+\.rs):(\d+):(\d+)/);
  return match ? { path: match[1]!, line: Number(match[2]), column: Number(match[3]) } : undefined;
}

function firstLine(value: string): string | undefined {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
}

function parseNextestDuration(value?: string): number | undefined {
  const match = value?.trim().match(/^([\d.]+)\s*(ms|s|m)$/i);
  if (!match) return undefined;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount)) return undefined;
  return match[2]!.toLowerCase() === "m"
    ? amount * 60_000
    : match[2]!.toLowerCase() === "s"
      ? amount * 1000
      : amount;
}

function nextestFailureBlock(output: string, nativeId: string): string | undefined {
  const marker = `thread '${nativeId}'`;
  const start = output.lastIndexOf(marker);
  if (start < 0) return undefined;
  const tail = output.slice(start);
  const boundary = tail.search(/\n(?:\s*thread '|[-─]{6,}\s*$|\s*Summary\s+\[)/m);
  return (boundary > 0 ? tail.slice(0, boundary) : tail).trim();
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordAt(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const candidate = value[key];
  return isRecord(candidate) ? candidate : undefined;
}

function stringAt(value: Record<string, unknown>, key: string): string | undefined {
  const candidate = value[key];
  return typeof candidate === "string" ? candidate : undefined;
}
