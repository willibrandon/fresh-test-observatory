import type { ProcessSpec, SourceLocation, TestCase, TestScope } from "./contracts.ts";
import { parseFailureLocation } from "./junit.ts";
import { dirname, joinPath, safeName } from "./path.ts";
import { attributes, textContent } from "./xml.ts";

export type DotnetFramework = "mstest" | "xunit" | "nunit" | "tunit" | "unknown";
export type DotnetFlavor = DotnetFramework | "bunit";
export type DotnetPlatform = "vstest" | "mtp" | "unavailable";
export type DotnetCommandMode = "vstest" | "mtp-native";
export type DotnetTrxReporter = "vstest" | "mtp" | "xunit" | "none";
export type DotnetCoverageProvider = "vstest" | "mtp" | "none";

export interface DotnetProject {
  path: string;
  name: string;
  framework: DotnetFramework;
  flavor: DotnetFlavor;
  platform: DotnetPlatform;
  commandMode: DotnetCommandMode;
  bridge: boolean;
  testProject: boolean;
  xunitMajor?: 2 | 3;
  trxReporter: DotnetTrxReporter;
  coverageProvider: DotnetCoverageProvider;
  diagnostics: string[];
}

export interface DotnetCommandOptions {
  action: "list" | "run" | "coverage";
  scope?: TestScope;
  tests?: readonly TestCase[];
  workspaceRoot: string;
  reportDir?: string;
  noBuild?: boolean;
  noRestore?: boolean;
  verbosity?: "quiet" | "minimal" | "normal" | "detailed" | "diagnostic";
}

export function detectDotnetProject(
  path: string,
  projectXml: string,
  globalJson?: string | null,
): DotnetProject {
  const packages = packageReferences(projectXml);
  const lower = projectXml.toLowerCase();
  const packageNames = new Set(packages.map((pkg) => pkg.name.toLowerCase()));
  const projectSdk = projectXml.match(/<Project\b[^>]*\bSdk=["']([^"']+)["']/i)?.[1] ?? "";
  const isMstestSdk =
    /(?:^|;)MSTest\.Sdk(?:\/|;|$)/i.test(projectSdk) ||
    /<Sdk\b[^>]*Name=["']MSTest\.Sdk/i.test(projectXml);
  const isBunit = [...packageNames].some((name) => name === "bunit" || name.startsWith("bunit."));
  const isTunit = packageNames.has("tunit");
  const isMstest =
    isMstestSdk ||
    [...packageNames].some((name) => name === "mstest" || name.startsWith("mstest.test"));
  const xunitPackage = packages.find((pkg) => /^(?:xunit|xunit\.v3)(?:$|\.)/i.test(pkg.name));
  const isXunit = Boolean(xunitPackage);
  const isNunit = packageNames.has("nunit") || packageNames.has("nunit3testadapter");
  const framework: DotnetFramework = isTunit
    ? "tunit"
    : isMstest
      ? "mstest"
      : isXunit
        ? "xunit"
        : isNunit
          ? "nunit"
          : "unknown";
  const flavor: DotnetFlavor = isBunit ? "bunit" : framework;
  const xunitMajor = isXunit
    ? /xunit\.v3/i.test(xunitPackage!.name) ||
      Number.parseInt(xunitPackage!.version ?? "2", 10) >= 3
      ? 3
      : 2
    : undefined;

  const useVstest = property(projectXml, "UseVSTest") === true;
  const outputExe = /^exe$/i.test(propertyValue(projectXml, "OutputType") ?? "");
  const bridgeEnabled = property(projectXml, "TestingPlatformDotnetTestSupport") === true;
  const runnerEnabled =
    isTunit ||
    isMstestSdk ||
    property(projectXml, "EnableMSTestRunner") === true ||
    property(projectXml, "EnableNUnitRunner") === true ||
    property(projectXml, "UseMicrosoftTestingPlatformRunner") === true;
  const nativeMtp = globalJsonSelectsMtp(globalJson);
  const commandMode: DotnetCommandMode = nativeMtp ? "mtp-native" : "vstest";
  let platform: DotnetPlatform = "vstest";
  const diagnostics: string[] = [];

  if (useVstest && nativeMtp) {
    platform = "unavailable";
    diagnostics.push("global.json selects native MTP but the project sets UseVSTest=true");
  } else if (useVstest) {
    platform = "vstest";
  } else if (nativeMtp) {
    if (runnerEnabled && (outputExe || isMstestSdk || isTunit)) {
      platform = "mtp";
    } else {
      platform = "unavailable";
      diagnostics.push("native MTP requires an enabled runner and executable test application");
    }
  } else if (runnerEnabled && bridgeEnabled && (outputExe || isMstestSdk || isTunit)) {
    platform = "mtp";
  } else if (isTunit) {
    platform = "unavailable";
    diagnostics.push(
      "TUnit is MTP-only and needs native MTP mode or TestingPlatformDotnetTestSupport",
    );
  }

  const testProject =
    framework !== "unknown" ||
    property(projectXml, "IsTestProject") === true ||
    packageNames.has("microsoft.net.test.sdk") ||
    lower.includes("<testproject>true</testproject>");
  const isMstestMetaPackage = packageNames.has("mstest");
  const hasMtpTrx =
    isMstestSdk ||
    isMstestMetaPackage ||
    packageNames.has("microsoft.testing.extensions.trxreport");
  const hasMtpCoverage =
    isMstestSdk ||
    isMstestMetaPackage ||
    packageNames.has("microsoft.testing.extensions.codecoverage");
  const trxReporter: DotnetTrxReporter =
    platform === "vstest"
      ? "vstest"
      : hasMtpTrx
        ? "mtp"
        : framework === "xunit" && xunitMajor === 3
          ? "xunit"
          : "none";
  const coverageProvider: DotnetCoverageProvider =
    platform === "vstest" ? "vstest" : hasMtpCoverage ? "mtp" : "none";
  if (platform === "mtp" && trxReporter === "none") {
    diagnostics.push("TRX results require Microsoft.Testing.Extensions.TrxReport");
  }
  if (platform === "mtp" && coverageProvider === "none") {
    diagnostics.push("coverage requires Microsoft.Testing.Extensions.CodeCoverage");
  }

  return {
    path,
    name: safeName(path),
    framework,
    flavor,
    platform,
    commandMode,
    bridge: platform === "mtp" && commandMode === "vstest",
    testProject,
    trxReporter,
    coverageProvider,
    diagnostics,
    ...(xunitMajor !== undefined ? { xunitMajor } : {}),
  };
}

export function discoverDotnetSourceTests(
  path: string,
  source: string,
  project: DotnetProject,
): TestCase[] {
  if (!/\.(?:cs|fs|vb)$/i.test(path)) return [];
  if (/\.fs$/i.test(path)) return discoverFsharpSourceTests(path, source, project);
  if (/\.vb$/i.test(path)) return discoverVisualBasicSourceTests(path, source, project);
  const tests: TestCase[] = [];
  const declaration =
    /((?:\s*\[[^\]]+\]\s*)+)(?:(?:public|private|protected|internal|static|virtual|sealed|override|new|async|partial)\s+)*(?:[\w<>,.?\[\]]+\s+)+(?<method>@?[A-Za-z_]\w*)\s*\(/g;
  for (const match of source.matchAll(declaration)) {
    const attrs = match[1] ?? "";
    if (!isTestAttribute(attrs)) continue;
    const method = match.groups?.method?.replace(/^@/, "");
    if (!method) continue;
    const before = source.slice(0, match.index);
    const namespace = lastCapture(before, /\bnamespace\s+([\w.]+)/g) ?? "";
    const typePath = activeCsharpTypes(before);
    if (typePath.length === 0) continue;
    const nativeId = [namespace, ...typePath, method].filter(Boolean).join(".");
    const methodOffset = match.index + match[0].lastIndexOf(match.groups!.method!);
    const line = source.slice(0, methodOffset).split("\n").length;
    tests.push({
      id: `dotnet:${project.path}:${nativeId}`,
      nativeId,
      label: method,
      adapterId: "dotnet",
      framework: project.flavor,
      project: project.path,
      suite: [project.name, namespace, ...typePath].filter(Boolean),
      source: { path, line },
      status: ignoredAttribute(attrs) ? "skipped" : "unknown",
    });
  }
  return tests;
}

function discoverFsharpSourceTests(
  path: string,
  source: string,
  project: DotnetProject,
): TestCase[] {
  const tests: TestCase[] = [];
  const expression =
    /((?:\s*\[<[^>]+>\]\s*)+)\s*(?:member\s+(?:[^.\s]+\.)?|let\s+(?:rec\s+)?)(?<method>``[^`]+``|[A-Za-z_]\w*)\s*(?:[=(])/g;
  for (const match of source.matchAll(expression)) {
    const attrs = match[1] ?? "";
    if (!isTestAttribute(attrs.replace(/\[</g, "[").replace(/>\]/g, "]"))) continue;
    const method = match.groups?.method?.replace(/^``|``$/g, "");
    if (!method) continue;
    const before = source.slice(0, match.index);
    const namespace = lastCapture(before, /^\s*namespace\s+([\w.]+)/gm) ?? "";
    const typeName = lastAlternativeCapture(before, /^\s*type\s+(?:``([^`]+)``|([A-Za-z_]\w*))/gm);
    const resolvedType =
      typeName ??
      lastAlternativeCapture(before, /^\s*module\s+(?:``([^`]+)``|([A-Za-z_]\w*))/gm) ??
      "";
    const nativeId = [namespace, resolvedType, method].filter(Boolean).join(".");
    const methodOffset = match.index + match[0].lastIndexOf(match.groups!.method!);
    tests.push(
      sourceTest(
        project,
        path,
        nativeId,
        method,
        [namespace, resolvedType],
        source,
        methodOffset,
        attrs,
      ),
    );
  }
  return tests;
}

function discoverVisualBasicSourceTests(
  path: string,
  source: string,
  project: DotnetProject,
): TestCase[] {
  const tests: TestCase[] = [];
  const expression =
    /((?:\s*<[^>]+>\s*)+)(?:(?:Public|Private|Protected|Friend|Shared|Async|Overrides|Overridable)\s+)*(?:Sub|Function)\s+(?<method>[A-Za-z_]\w*)\s*\(/gi;
  for (const match of source.matchAll(expression)) {
    const attrs = match[1] ?? "";
    if (!isTestAttribute(attrs.replace(/</g, "[").replace(/>/g, "]"))) continue;
    const method = match.groups?.method;
    if (!method) continue;
    const before = source.slice(0, match.index);
    const scopes = activeVisualBasicScopes(before);
    const nativeId = [...scopes.namespaces, ...scopes.types, method].join(".");
    const methodOffset = match.index + match[0].toLowerCase().lastIndexOf(method.toLowerCase());
    tests.push(
      sourceTest(
        project,
        path,
        nativeId,
        method,
        [...scopes.namespaces, ...scopes.types],
        source,
        methodOffset,
        attrs,
      ),
    );
  }
  return tests;
}

function sourceTest(
  project: DotnetProject,
  path: string,
  nativeId: string,
  label: string,
  suite: string[],
  source: string,
  offset: number,
  attributesText: string,
): TestCase {
  return {
    id: `dotnet:${project.path}:${nativeId}`,
    nativeId,
    label,
    adapterId: "dotnet",
    framework: project.flavor,
    project: project.path,
    suite: [project.name, ...suite].filter(Boolean),
    source: { path, line: source.slice(0, offset).split("\n").length },
    status: ignoredAttribute(attributesText) ? "skipped" : "unknown",
  };
}

/** Tracks the enclosing C# type declarations instead of using the last name. */
function activeCsharpTypes(source: string): string[] {
  const structure = maskCStyleCommentsAndStrings(source);
  const types: Array<{ name: string; depth: number }> = [];
  let depth = 0;
  const expression =
    /\b(?:class|struct|record(?:\s+(?:class|struct))?)\s+(@?[A-Za-z_]\w*)[^;{}]*\{|[{}]/g;
  for (const match of structure.matchAll(expression)) {
    if (match[1]) {
      depth += 1;
      types.push({ name: match[1].replace(/^@/, ""), depth });
    } else if (match[0] === "{") {
      depth += 1;
    } else {
      while (types.at(-1)?.depth === depth) types.pop();
      depth = Math.max(0, depth - 1);
    }
  }
  return types.map((entry) => entry.name);
}

function activeVisualBasicScopes(source: string): { namespaces: string[]; types: string[] } {
  const namespaces: string[] = [];
  const types: string[] = [];
  for (const line of source.split(/\r?\n/)) {
    const code = line.replace(/'.*$/, "").trim();
    if (/^End\s+Namespace\b/i.test(code)) namespaces.pop();
    else if (/^Namespace\s+/i.test(code))
      namespaces.push(code.replace(/^Namespace\s+/i, "").trim());
    else if (/^End\s+(?:Class|Module|Structure)\b/i.test(code)) types.pop();
    else {
      const type = code.match(
        /^(?:(?:Public|Private|Protected|Friend|Partial|MustInherit|NotInheritable)\s+)*(?:Class|Module|Structure)\s+([A-Za-z_]\w*)/i,
      )?.[1];
      if (type) types.push(type);
    }
  }
  return { namespaces, types };
}

function maskCStyleCommentsAndStrings(source: string): string {
  let result = "";
  let index = 0;
  let blockComment = false;
  let quote: '"' | "'" | undefined;
  while (index < source.length) {
    const current = source[index]!;
    const next = source[index + 1];
    if (blockComment) {
      if (current === "*" && next === "/") {
        blockComment = false;
        result += "  ";
        index += 2;
      } else {
        result += current === "\n" ? "\n" : " ";
        index += 1;
      }
    } else if (quote) {
      if (current === "\\") {
        result += "  ";
        index += Math.min(2, source.length - index);
      } else {
        result += current === "\n" ? "\n" : " ";
        index += 1;
        if (current === quote) quote = undefined;
      }
    } else if (current === "/" && next === "/") {
      const end = source.indexOf("\n", index);
      const length = (end < 0 ? source.length : end) - index;
      result += " ".repeat(length);
      index += length;
    } else if (current === "/" && next === "*") {
      blockComment = true;
      result += "  ";
      index += 2;
    } else if (current === '"' || current === "'") {
      quote = current;
      result += " ";
      index += 1;
    } else {
      result += current;
      index += 1;
    }
  }
  return result;
}

export function parseDotnetListOutput(output: string, project: DotnetProject): TestCase[] {
  const lines = stripAnsi(output).split(/\r?\n/);
  let listing = false;
  const tests: TestCase[] = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (/^(?:The following Tests are available|Available tests|Test list):?$/i.test(line)) {
      listing = true;
      continue;
    }
    if (/^Discovered\s+\d+\s+tests?\s+in\s+assembly\b/i.test(line)) {
      listing = true;
      continue;
    }
    if (/^Discovered\s+\d+\s+tests?\.?$/i.test(line)) {
      listing = false;
      continue;
    }
    if (!listing || !line || isDotnetNoise(line)) continue;
    const nativeId = line.replace(/^[-*]\s*/, "").trim();
    if (!nativeId || /^(?:Passed|Failed|Skipped|Total tests):/i.test(nativeId)) continue;
    tests.push(testFromNativeId(nativeId, project));
  }
  return tests;
}

export function buildDotnetCommand(
  project: DotnetProject,
  options: DotnetCommandOptions,
): ProcessSpec {
  const resultsDir = joinPath(
    options.reportDir ?? joinPath(options.workspaceRoot, ".fresh-test-observatory"),
    "dotnet",
    project.name,
  );
  const reportName = `${project.name}.trx`;
  const reportPath = joinPath(resultsDir, reportName);
  const dotnetOptions: string[] = [];
  const testOptions: string[] = [];
  if (options.noBuild) dotnetOptions.push("--no-build");
  if (options.noRestore) dotnetOptions.push("--no-restore");

  if (options.action === "list") {
    testOptions.push("--list-tests");
  } else if (options.action === "run") {
    if (project.platform === "vstest") {
      dotnetOptions.push(
        "--logger",
        `trx;LogFileName=${reportName}`,
        "--results-directory",
        resultsDir,
      );
      dotnetOptions.push("--logger", `console;verbosity=${options.verbosity ?? "normal"}`);
    } else if (project.trxReporter === "mtp") {
      testOptions.push(
        "--report-trx",
        "--report-trx-filename",
        reportName,
        "--results-directory",
        resultsDir,
      );
    } else if (project.trxReporter === "xunit") {
      testOptions.push("--report-xunit-trx", "--report-xunit-trx-filename", reportPath);
    }
  } else if (project.platform === "vstest") {
    dotnetOptions.push("--collect", "XPlat Code Coverage", "--results-directory", resultsDir);
  } else if (project.coverageProvider === "mtp") {
    const coveragePath = joinPath(resultsDir, "coverage.cobertura.xml");
    testOptions.push(
      "--coverage",
      "--coverage-output-format",
      "cobertura",
      "--coverage-output",
      coveragePath,
    );
  }

  if (options.action !== "list" && options.tests?.length) {
    testOptions.push(...dotnetFilter(project, options.tests));
  }

  const args = ["test"];
  if (project.commandMode === "mtp-native") {
    args.push("--project", project.path, ...dotnetOptions, ...testOptions);
  } else {
    args.push(project.path, ...dotnetOptions);
    if (project.platform === "mtp") args.push("--", ...testOptions);
    else args.push(...testOptions);
  }
  const spec: ProcessSpec = {
    command: "dotnet",
    args,
    // dotnet locates global.json by walking upward from cwd, not from the
    // absolute --project argument. Starting beside the project preserves its
    // intended VSTest or native-MTP mode in nested repositories.
    cwd: dirname(project.path),
    label:
      options.action === "list"
        ? `Discovering .NET tests in ${project.name}`
        : options.action === "coverage"
          ? `Collecting .NET coverage for ${project.name}`
          : `Running .NET tests in ${project.name}`,
  };
  if (options.action === "run" && project.trxReporter !== "none") {
    spec.reportPath = reportPath;
    spec.reportFormat = "trx";
  } else if (options.action === "coverage") {
    if (project.coverageProvider === "mtp")
      spec.reportPath = joinPath(resultsDir, "coverage.cobertura.xml");
    spec.reportFormat = "cobertura";
  }
  return spec;
}

export function dotnetFilter(project: DotnetProject, tests: readonly TestCase[]): string[] {
  const ids = [...new Set(tests.map((test) => test.nativeId))];
  if (ids.length === 0) return [];
  if (project.platform === "mtp" && project.framework === "tunit") {
    const parsed = ids.map(splitTestId);
    if (parsed.length === 1) {
      const only = parsed[0]!;
      return ["--treenode-filter", `/*/*/${only.className}/${only.method}`];
    }
    const classes = [...new Set(parsed.map((entry) => entry.className))];
    return ["--treenode-filter", `/*/*/(${classes.join(")|(")})/*`];
  }
  if (project.platform === "mtp" && project.framework === "xunit" && project.xunitMajor === 3) {
    return ["--filter-method", ...ids];
  }
  return ["--filter", ids.map((id) => `FullyQualifiedName=${escapeVstestFilter(id)}`).join("|")];
}

export function parseTrx(xml: string, project: DotnetProject): TestCase[] {
  const definitions = new Map<string, { nativeId: string; source?: SourceLocation }>();
  const unitExpression = /<UnitTest\b([^>]*)>([\s\S]*?)<\/UnitTest>/gi;
  for (const match of xml.matchAll(unitExpression)) {
    const unitAttrs = attributes(match[1] ?? "");
    const methodTag = (match[2] ?? "").match(/<TestMethod\b([^>]*)\/?\s*>/i)?.[1] ?? "";
    const methodAttrs = attributes(methodTag);
    const nativeId =
      [methodAttrs.className, methodAttrs.name].filter(Boolean).join(".") || unitAttrs.name;
    if (unitAttrs.id && nativeId) {
      const sourcePath =
        methodAttrs.codeBase && /\.(?:cs|fs|vb)$/i.test(methodAttrs.codeBase)
          ? methodAttrs.codeBase
          : undefined;
      definitions.set(unitAttrs.id, {
        nativeId,
        ...(sourcePath ? { source: { path: sourcePath, line: 1 } } : {}),
      });
    }
  }

  const tests: TestCase[] = [];
  const resultExpression = /<UnitTestResult\b([^>]*?)(?:\/>|>([\s\S]*?)<\/UnitTestResult>)/gi;
  for (const match of xml.matchAll(resultExpression)) {
    const attrs = attributes(match[1] ?? "");
    const body = match[2] ?? "";
    const definition = attrs.testId ? definitions.get(attrs.testId) : undefined;
    const displayName = attrs.testName || definition?.nativeId || "unnamed test";
    const nativeId = definition?.nativeId || displayName;
    const outcome = trxOutcome(attrs.outcome);
    const message = textContent(body.match(/<Message>([\s\S]*?)<\/Message>/i)?.[1]);
    const stack = textContent(body.match(/<StackTrace>([\s\S]*?)<\/StackTrace>/i)?.[1]);
    const base = testFromNativeId(nativeId, project);
    const source = parseFailureLocation(stack) ?? definition?.source;
    const durationMs = parseTrxDuration(attrs.duration);
    tests.push({
      ...base,
      label: displayName.split(".").at(-1) || displayName,
      status: outcome,
      ...(source ? { source } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(message ? { message } : {}),
      ...(stack ? { stack } : {}),
    });
  }
  return tests;
}

export function parseDotnetConsoleResults(output: string, project: DotnetProject): TestCase[] {
  const tests: TestCase[] = [];
  const expression = /^\s*(Passed|Failed|Skipped|Not Run)\s+(.+?)(?:\s+\[\s*([^\]]+)\s*\])?\s*$/gim;
  for (const match of stripAnsi(output).matchAll(expression)) {
    const nativeId = match[2]!.trim();
    if (/^!\s/.test(nativeId)) continue;
    const test = testFromNativeId(nativeId, project);
    const durationMs = parseHumanDuration(match[3]);
    tests.push({
      ...test,
      status: /passed/i.test(match[1]!)
        ? "passed"
        : /failed/i.test(match[1]!)
          ? "failed"
          : "skipped",
      ...(durationMs !== undefined ? { durationMs } : {}),
    });
  }
  return tests;
}

export function findCoverageAttachment(output: string): string | undefined {
  return stripAnsi(output)
    .match(/(?:^|\s)((?:[A-Za-z]:[\\/]|\/)[^\r\n"']*coverage\.cobertura\.xml)\b/i)?.[1]
    ?.trim();
}

function packageReferences(xml: string): Array<{ name: string; version?: string }> {
  const packages = [];
  for (const match of xml.matchAll(
    /<PackageReference\b([^>]*?)(?:\/>|>[\s\S]*?<\/PackageReference>)/gi,
  )) {
    const attrs = attributes(match[1] ?? "");
    const name = attrs.Include ?? attrs.Update;
    if (name) packages.push({ name, ...(attrs.Version ? { version: attrs.Version } : {}) });
  }
  return packages;
}

function propertyValue(xml: string, name: string): string | undefined {
  const values = [...xml.matchAll(new RegExp(`<${name}\\b[^>]*>([^<]*)<\\/${name}>`, "gi"))];
  return values.at(-1)?.[1]?.trim();
}

function property(xml: string, name: string): boolean | undefined {
  const value = propertyValue(xml, name)?.toLowerCase();
  return value === "true" ? true : value === "false" ? false : undefined;
}

function globalJsonSelectsMtp(json?: string | null): boolean {
  if (!json) return false;
  try {
    const parsed = JSON.parse(json) as { test?: { runner?: string } };
    return parsed.test?.runner?.toLowerCase() === "microsoft.testing.platform";
  } catch {
    return false;
  }
}

function isTestAttribute(value: string): boolean {
  return /\[\s*(?:[\w.]+\.)?(?:TestMethod|DataTestMethod|Fact|Theory|Test|TestCase|TestCaseSource)\b/i.test(
    value,
  );
}

function ignoredAttribute(value: string): boolean {
  return /\[\s*(?:[\w.]+\.)?(?:Ignore|Explicit|Skip)\b/i.test(value) || /\bSkip\s*=/i.test(value);
}

function lastCapture(value: string, expression: RegExp): string | undefined {
  let result: string | undefined;
  for (const match of value.matchAll(expression)) result = match[1];
  return result;
}

function lastAlternativeCapture(value: string, expression: RegExp): string | undefined {
  let result: string | undefined;
  for (const match of value.matchAll(expression)) result = match[1] ?? match[2];
  return result;
}

function testFromNativeId(nativeId: string, project: DotnetProject): TestCase {
  const parts = nativeId.split(".");
  return {
    id: `dotnet:${project.path}:${nativeId}`,
    nativeId,
    label: parts.at(-1) || nativeId,
    adapterId: "dotnet",
    framework: project.flavor,
    project: project.path,
    suite: [project.name, ...parts.slice(0, -1)],
    status: "unknown",
  };
}

function isDotnetNoise(line: string): boolean {
  return (
    /^(?:Build started|Build succeeded|Build FAILED|Determining projects|Restored |Test run for |Microsoft \(R\)|VSTest version|Starting test execution|A total of |Attachments:|Results File:|\d+ Warning\(s\)|\d+ Error\(s\)|Time Elapsed|Workload updates)/i.test(
      line,
    ) ||
    /^[-=]{3,}$/.test(line) ||
    /\.(?:dll|csproj)\s*->\s*/i.test(line)
  );
}

function splitTestId(id: string): { className: string; method: string } {
  const parts = id.split(".");
  return { method: parts.pop() ?? "*", className: parts.pop() ?? "*" };
}

function escapeVstestFilter(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/([&|=~!()])/g, "\\$1");
}

function trxOutcome(value?: string): TestCase["status"] {
  if (/^(?:passed|completed)$/i.test(value ?? "")) return "passed";
  if (/^(?:failed|error|timeout|aborted)$/i.test(value ?? "")) return "failed";
  if (/^(?:notexecuted|skipped|inconclusive)$/i.test(value ?? "")) return "skipped";
  return "unknown";
}

function parseTrxDuration(value?: string): number | undefined {
  if (!value) return undefined;
  const match = value.match(/^(?:(\d+)\.)?(\d+):(\d+):(\d+(?:\.\d+)?)$/);
  if (!match) return undefined;
  return (
    (((Number(match[1] ?? 0) * 24 + Number(match[2])) * 60 + Number(match[3])) * 60 +
      Number(match[4])) *
    1000
  );
}

function parseHumanDuration(value?: string): number | undefined {
  const match = value?.trim().match(/^([\d.]+)\s*(ms|s|m)?$/i);
  if (!match) return undefined;
  const amount = Number(match[1]);
  return match[2]?.toLowerCase() === "m"
    ? amount * 60_000
    : match[2]?.toLowerCase() === "s"
      ? amount * 1000
      : amount;
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}
