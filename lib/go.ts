import type { CoverageFile, ProcessSpec, TestCase } from "./contracts.ts";
import { mergeCoverage } from "./model.ts";
import { dirname, joinPath, relativePath, resolvePath } from "./path.ts";

interface GoTestEvent {
  Action?: string;
  Package?: string;
  Test?: string;
  Elapsed?: number;
  Output?: string;
}

/** Discovers top-level Go tests and literal t.Run-style subtests. */
export function discoverGoSourceTests(
  path: string,
  source: string,
  workspaceRoot: string,
  modulePath?: string,
): TestCase[] {
  const tests: TestCase[] = [];
  const packageName = source.match(/^\s*package\s+([A-Za-z_]\w*)/m)?.[1] ?? "package";
  const expression = /^func\s+((?:Test|Benchmark|Fuzz)[A-Z]\w*|Example\w*)\s*\(/gm;
  const matches = [...source.matchAll(expression)];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index]!;
    const name = match[1]!;
    const before = source.slice(0, match.index);
    const relativeProject = relativePath(workspaceRoot, dirname(path)) || ".";
    const project = modulePath
      ? relativeProject === "."
        ? modulePath
        : `${modulePath}/${relativeProject}`
      : relativeProject;
    const parent: TestCase = {
      id: `go:${project}:${name}`,
      nativeId: name,
      label: name,
      adapterId: "go",
      framework: "go-test",
      project,
      suite: [project, packageName],
      source: { path, line: before.split("\n").length },
      status: "unknown",
    };
    tests.push(parent);

    const segmentEnd = matches[index + 1]?.index ?? source.length;
    const body = source.slice(match.index, segmentEnd);
    for (const subtest of body.matchAll(/\b[A-Za-z_]\w*\.Run\(\s*"([^"\r\n]+)"\s*,/g)) {
      const rawName = subtest[1]!;
      const subtestName = rawName.trim().replace(/\s+/g, "_");
      if (!subtestName) continue;
      const nativeId = `${name}/${subtestName}`;
      const offset = match.index + subtest.index;
      tests.push({
        id: `go:${project}:${nativeId}`,
        nativeId,
        label: subtestName,
        adapterId: "go",
        framework: "go-test",
        project,
        suite: [project, packageName, name],
        source: { path, line: source.slice(0, offset).split("\n").length },
        status: "unknown",
        parentId: parent.id,
      });
    }
  }
  return tests;
}

/** Aggregates the newline-delimited event stream emitted by `go test -json`. */
export function parseGoTestJson(output: string): TestCase[] {
  const tests = new Map<string, TestCase>();
  const captured = new Map<string, string>();
  for (const line of output.split(/\r?\n/)) {
    let event: GoTestEvent;
    try {
      event = JSON.parse(line) as GoTestEvent;
    } catch {
      continue;
    }
    if (!event.Package || !event.Test) continue;
    const key = `${event.Package}\0${event.Test}`;
    if (event.Output) captured.set(key, (captured.get(key) ?? "") + event.Output);
    const status =
      event.Action === "run"
        ? "running"
        : event.Action === "pass"
          ? "passed"
          : event.Action === "fail"
            ? "failed"
            : event.Action === "skip"
              ? "skipped"
              : undefined;
    if (!status) continue;
    const stack = captured.get(key)?.trim();
    const source = status === "failed" ? goFailureLocation(stack ?? "") : tests.get(key)?.source;
    const message = status === "failed" ? firstFailureLine(stack ?? "") : undefined;
    tests.set(key, {
      id: `go:${event.Package}:${event.Test}`,
      nativeId: event.Test,
      label: event.Test.split("/").at(-1) || event.Test,
      adapterId: "go",
      framework: "go-test",
      project: event.Package,
      suite: [event.Package, ...event.Test.split("/").slice(0, -1)],
      status,
      ...(event.Test.includes("/")
        ? { parentId: `go:${event.Package}:${event.Test.slice(0, event.Test.lastIndexOf("/"))}` }
        : {}),
      ...(source ? { source } : {}),
      ...(typeof event.Elapsed === "number" ? { durationMs: event.Elapsed * 1000 } : {}),
      ...(message ? { message } : {}),
      ...(status === "failed" && stack ? { stack } : {}),
    });
  }
  return [...tests.values()];
}

export function buildGoCommand(
  workspaceRoot: string,
  tests: readonly TestCase[] = [],
  coverage = false,
  reportDir?: string,
): ProcessSpec {
  if (coverage) {
    const reportPath = joinPath(
      reportDir ?? joinPath(workspaceRoot, ".fresh-test-observatory"),
      "go",
      "cover.out",
    );
    return {
      command: "go",
      args: ["test", `-coverprofile=${reportPath}`, "./..."],
      cwd: workspaceRoot,
      reportPath,
      label: "Collecting Go coverage",
    };
  }
  const projects = [
    ...new Set(
      tests.map((test) => test.project).filter((value): value is string => Boolean(value)),
    ),
  ];
  const names = [...new Set(tests.map((test) => test.nativeId.split("/")[0]!))];
  const selectedProject = projects.length === 1 ? projects[0]! : "./...";
  const target =
    selectedProject === "." || selectedProject.startsWith("./") || selectedProject.includes(".")
      ? selectedProject
      : `./${selectedProject}`;
  const args = ["test", "-json", target];
  if (tests.length === 1 && tests[0]!.nativeId.includes("/")) {
    const exactPath = tests[0]!.nativeId
      .split("/")
      .map((part) => `^${escapeRegex(part)}$`)
      .join("/");
    args.push("-run", exactPath);
  } else if (names.length > 0) {
    args.push("-run", `^(?:${names.map(escapeRegex).join("|")})$`);
  }
  return { command: "go", args, cwd: workspaceRoot, label: "Running Go tests" };
}

/** Converts Go's block-based coverprofile into line observations. */
export function parseGoCoverProfile(
  profile: string,
  workspaceRoot: string,
  modulePath?: string,
): CoverageFile[] {
  const files: CoverageFile[] = [];
  for (const line of profile.split(/\r?\n/)) {
    if (!line || line.startsWith("mode:")) continue;
    const match = line.match(/^(.+?):(\d+)\.(\d+),(\d+)\.(\d+)\s+\d+\s+(\d+)$/);
    if (!match) continue;
    let path = match[1]!;
    if (modulePath && (path === modulePath || path.startsWith(`${modulePath}/`))) {
      path = path.slice(modulePath.length).replace(/^\//, "");
    }
    const start = Number(match[2]);
    const end = Number(match[4]);
    const hits = Number(match[6]);
    const lines = [];
    for (let number = start; number <= end; number += 1) lines.push({ line: number, hits });
    files.push({ path: resolvePath(workspaceRoot, path), lines });
  }
  return mergeCoverage(files);
}

export function modulePathFromGoMod(goMod: string): string | undefined {
  return goMod.match(/^\s*module\s+([^\s]+)\s*$/m)?.[1];
}

function goFailureLocation(output: string): TestCase["source"] {
  const match = output.match(/^\s*([^:\r\n]+\.go):(\d+):/m);
  if (!match) return undefined;
  return { path: match[1]!, line: Number(match[2]) };
}

function firstFailureLine(output: string): string | undefined {
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !/^--- FAIL:/.test(line));
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
