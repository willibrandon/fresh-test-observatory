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
  const starts = lineStarts(source);
  const scopes = csharpScopes(source);
  let searchFrom = 0;
  for (;;) {
    const attributeStart = source.indexOf("[", searchFrom);
    if (attributeStart < 0) break;
    const block = squareAttributeBlock(source, attributeStart);
    if (!block) {
      searchFrom = attributeStart + 1;
      continue;
    }
    searchFrom = block.end;
    const attrs = block.attributes;
    if (!isTestAttribute(attrs)) continue;
    const declaration = csharpMethodAt(source, block.end);
    if (!declaration) continue;
    const method = declaration.method.replace(/^@/, "");
    const scope = scopes.at(attributeStart);
    const namespace = scope.namespace;
    const typePath = scope.types;
    if (typePath.length === 0) continue;
    // CLR test identities use '+' between nested types and '.' before the method.
    const nativeId = [namespace, typePath.join("+"), method].filter(Boolean).join(".");
    tests.push({
      id: `dotnet:${project.path}:${nativeId}`,
      nativeId,
      label: method,
      adapterId: "dotnet",
      framework: project.flavor,
      project: project.path,
      suite: [project.name, ...suiteSegments(project, namespace), ...typePath],
      source: { path, line: lineNumberAt(starts, declaration.offset) },
      status: ignoredAttribute(attrs) ? "skipped" : "unknown",
    });
    searchFrom = declaration.offset + declaration.method.length;
  }
  return tests;
}

/**
 * Namespace and enclosing types by position, computed in one pass over the
 * file. Tests are visited in source order, so lookups only move forward.
 */
function csharpScopes(source: string): {
  at(offset: number): { namespace: string; types: string[] };
} {
  const structure = maskCStyleCommentsAndStrings(source);
  const events = [
    ...structure.matchAll(
      /\b(?:class|struct|record(?:\s+(?:class|struct))?)\s+(@?[A-Za-z_]\w*)[^;{}]*\{|\bnamespace\s+([\w.]+)|[{}]/g,
    ),
  ];
  const types: Array<{ name: string; depth: number }> = [];
  let depth = 0;
  let namespace = "";
  let next = 0;
  return {
    at(offset) {
      while (next < events.length && events[next]!.index < offset) {
        const match = events[next]!;
        next += 1;
        if (match[1]) {
          depth += 1;
          types.push({ name: match[1].replace(/^@/, ""), depth });
        } else if (match[2]) {
          namespace = match[2];
        } else if (match[0] === "{") {
          depth += 1;
        } else {
          while (types.at(-1)?.depth === depth) types.pop();
          depth = Math.max(0, depth - 1);
        }
      }
      return { namespace, types: types.map((entry) => entry.name) };
    },
  };
}

function discoverFsharpSourceTests(
  path: string,
  source: string,
  project: DotnetProject,
): TestCase[] {
  const tests: TestCase[] = [];
  let attributesText = "";
  for (const line of sourceLines(source)) {
    const parsed = leadingAttributes(line.text, "[<", ">]");
    if (parsed.attributes) attributesText += parsed.attributes;
    const code = parsed.remainder.trim();
    if (!code) continue;
    const attrs = attributesText;
    attributesText = "";
    if (!isTestAttribute(attrs.replace(/\[</g, "[").replace(/>\]/g, "]"))) continue;
    const declaration = code.match(
      /^(?:member\s+(?:[^.\s]+\.)?|let\s+(?:rec\s+)?)(``[^`\r\n]+``|[A-Za-z_][A-Za-z0-9_]*)/,
    );
    const method = declaration?.[1]?.replace(/^``|``$/g, "");
    if (!method) continue;
    const before = source.slice(0, line.offset);
    const namespace = lastCapture(before, /^\s*namespace\s+([\w.]+)/gm) ?? "";
    const typeName = lastAlternativeCapture(before, /^\s*type\s+(?:``([^`]+)``|([A-Za-z_]\w*))/gm);
    const resolvedType =
      typeName ??
      lastAlternativeCapture(before, /^\s*module\s+(?:``([^`]+)``|([A-Za-z_]\w*))/gm) ??
      "";
    const nativeId = [namespace, resolvedType, method].filter(Boolean).join(".");
    tests.push(
      sourceTest(project, path, nativeId, method, [namespace, resolvedType], line.number, attrs),
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
  let attributesText = "";
  for (const line of sourceLines(source)) {
    const parsed = leadingAttributes(line.text, "<", ">");
    if (parsed.attributes) attributesText += parsed.attributes;
    const code = parsed.remainder.trim();
    if (!code) continue;
    const attrs = attributesText;
    attributesText = "";
    if (!isTestAttribute(attrs.replace(/</g, "[").replace(/>/g, "]"))) continue;
    const method = code.match(/\b(?:Sub|Function)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/i)?.[1];
    if (!method) continue;
    const before = source.slice(0, line.offset);
    const scopes = activeVisualBasicScopes(before);
    const nativeId = [...scopes.namespaces, ...scopes.types, method].join(".");
    tests.push(
      sourceTest(
        project,
        path,
        nativeId,
        method,
        [...scopes.namespaces, ...scopes.types],
        line.number,
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
  line: number,
  attributesText: string,
): TestCase {
  return {
    id: `dotnet:${project.path}:${nativeId}`,
    nativeId,
    label,
    adapterId: "dotnet",
    framework: project.flavor,
    project: project.path,
    suite: [project.name, ...suiteSegments(project, suite[0] ?? ""), ...suite.slice(1)].filter(
      Boolean,
    ),
    source: { path, line },
    status: ignoredAttribute(attributesText) ? "skipped" : "unknown",
  };
}

function leadingAttributes(
  line: string,
  open: string,
  close: string,
): { attributes: string; remainder: string } {
  let cursor = 0;
  let attributes = "";
  while (cursor < line.length) {
    while (/\s/.test(line[cursor] ?? "")) cursor += 1;
    const start = cursor;
    if (!line.startsWith(open, cursor)) break;
    const end =
      open === "[" && close === "]"
        ? matchingSquareBracket(line, cursor)
        : line.indexOf(close, cursor + open.length);
    if (end < 0) {
      cursor = start;
      break;
    }
    cursor = end + close.length;
    attributes += line.slice(start, cursor);
  }
  return { attributes, remainder: line.slice(cursor) };
}

function matchingSquareBracket(line: string, start: number): number {
  let depth = 1;
  let quote: '"' | "'" | undefined;
  for (let cursor = start + 1; cursor < line.length; cursor += 1) {
    const character = line[cursor]!;
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

function squareAttributeBlock(
  source: string,
  start: number,
): { attributes: string; end: number } | undefined {
  let cursor = start;
  let attributes = "";
  while (cursor < source.length && source[cursor] === "[") {
    const end = matchingSquareBracket(source, cursor);
    if (end < 0) return undefined;
    attributes += source.slice(cursor, end + 1);
    cursor = end + 1;
    while (/\s/.test(source[cursor] ?? "")) cursor += 1;
  }
  return attributes ? { attributes, end: cursor } : undefined;
}

function csharpMethodAt(
  source: string,
  start: number,
): { method: string; offset: number } | undefined {
  const parenthesis = source.indexOf("(", start);
  if (parenthesis < 0 || parenthesis - start > 4_096) return undefined;
  const head = source.slice(start, parenthesis);
  if (/[{};]/.test(head)) return undefined;
  const method = identifierBeforeParenthesis(`${head}(`);
  if (!method) return undefined;
  const relativeOffset = head.lastIndexOf(method);
  return relativeOffset < 0 ? undefined : { method, offset: start + relativeOffset };
}

function identifierBeforeParenthesis(code: string): string | undefined {
  const parenthesis = code.indexOf("(");
  if (parenthesis < 0) return undefined;
  let end = parenthesis;
  while (/\s/.test(code[end - 1] ?? "")) end -= 1;
  if (code[end - 1] === ">") {
    let depth = 1;
    end -= 1;
    while (end > 0 && depth > 0) {
      end -= 1;
      if (code[end] === ">") depth += 1;
      else if (code[end] === "<") depth -= 1;
    }
  }
  while (/\s/.test(code[end - 1] ?? "")) end -= 1;
  let start = end;
  while (/[A-Za-z0-9_@]/.test(code[start - 1] ?? "")) start -= 1;
  const identifier = code.slice(start, end);
  return /^@?[A-Za-z_][A-Za-z0-9_]*$/.test(identifier) ? identifier : undefined;
}

function sourceLines(source: string): Array<{ text: string; offset: number; number: number }> {
  const lines = [];
  let offset = 0;
  let number = 1;
  for (;;) {
    const newline = source.indexOf("\n", offset);
    const end = newline < 0 ? source.length : newline;
    const raw = source.slice(offset, end);
    lines.push({ text: raw.endsWith("\r") ? raw.slice(0, -1) : raw, offset, number });
    if (newline < 0) return lines;
    offset = newline + 1;
    number += 1;
  }
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

/** Tracks the enclosing C# type declarations instead of using the last name. */

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
  // One native pass: comments and string or character literals become spaces
  // of the same length so offsets and line breaks are preserved.
  return source.replace(
    /\/\*[\s\S]*?(?:\*\/|$)|\/\/[^\n]*|"(?:[^"\\\n]|\\.)*(?:"|$)|'(?:[^'\\\n]|\\.)*(?:'|$)/g,
    (match) => match.replace(/[^\n]/g, " "),
  );
}

export function parseDotnetListOutput(output: string, project: DotnetProject): TestCase[] {
  const lines = stripAnsi(output).split("\n");
  // Display names may span lines (test data with embedded newlines is printed
  // verbatim): an indented line starts an entry, an unindented line while one
  // is open continues its name. MTP indents entries with exactly two spaces.
  let mode: "off" | "mtp" | "loose" = "off";
  const ids: string[] = [];
  let current: string[] | undefined;
  const finish = (): void => {
    if (!current) return;
    while (current.length > 1 && !current.at(-1)!.trim()) current.pop();
    ids.push(current.join("\n"));
    current = undefined;
  };
  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    const trimmed = line.trim();
    if (/^(?:The following Tests are available|Available tests|Test list):?$/i.test(trimmed)) {
      finish();
      mode = "loose";
      continue;
    }
    if (/^Discovered\s+\d+\s+tests?\s+in\s+assembly\b/i.test(trimmed)) {
      finish();
      mode = "mtp";
      continue;
    }
    if (/^Discovered\s+\d+\s+tests?\.?$/i.test(trimmed)) {
      finish();
      mode = "off";
      continue;
    }
    if (mode === "off") continue;
    const startsEntry = mode === "mtp" ? /^ {2}\S/.test(line) : /^\s+\S/.test(line);
    if (startsEntry) {
      finish();
      const nativeId = trimmed.replace(/^[-*]\s*/, "");
      if (
        nativeId &&
        !isDotnetNoise(nativeId) &&
        !/^(?:Passed|Failed|Skipped|Total tests):/i.test(nativeId)
      ) {
        current = [nativeId];
      }
      continue;
    }
    if (current) {
      // Footer and runner noise at column 0 ends the open entry rather
      // than joining a multi-line display name.
      if (/^(?:Passed|Failed|Skipped|Total tests):/i.test(trimmed) || isDotnetNoise(trimmed)) {
        finish();
        continue;
      }
      current.push(line);
    }
  }
  finish();
  return ids.map((nativeId) => testFromNativeId(nativeId, project));
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
    // One line per finished test lets the dock report progress while the run executes.
    if (project.platform === "mtp") {
      // `--no-progress` is the spelling every platform version accepts;
      // `--progress off` is rejected as an invalid command line by older ones.
      testOptions.push("--output", "detailed", "--no-progress", "--no-ansi");
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

  // A workspace run executes every test anyway; a filter naming all of them
  // only bloats the command line (and trips on exotic display names).
  if (options.action !== "list" && options.tests?.length && options.scope !== "workspace") {
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
      label: dotnetDisplayLabel(displayName),
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

/** Namespace segments for the tree; a namespace equal to the project name adds nothing. */
function suiteSegments(project: DotnetProject, namespace: string): string[] {
  return namespace && namespace !== project.name ? [namespace] : [];
}

/** The display form of a test name: the member for a CLR id, one line otherwise. */
function dotnetDisplayLabel(name: string): string {
  if (!/[\s"'()]/.test(name)) return name.split(".").at(-1) || name;
  return name.replace(/\s*\r?\n\s*/g, " ").trim() || name;
}

function testFromNativeId(nativeId: string, project: DotnetProject): TestCase {
  // Only a plain CLR id is namespace-dotted; a display name with arguments
  // (spaces, quotes, newlines) must not be split on the dots inside them.
  const clrId = !/[\s"'()]/.test(nativeId);
  const parts = clrId ? nativeId.split(".") : [nativeId];
  const label = dotnetDisplayLabel(nativeId);
  return {
    id: `dotnet:${project.path}:${nativeId}`,
    nativeId,
    label,
    adapterId: "dotnet",
    framework: project.flavor,
    project: project.path,
    suite: clrId ? [project.name, ...parts.slice(0, -1)] : [project.name],
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

export interface DotnetProgressLine {
  status: "passed" | "failed" | "skipped";
  displayName: string;
  durationMs?: number;
}

/**
 * Recognises one finished test on a runner's console output. Microsoft.Testing.Platform
 * with `--output detailed` prints `passed Name (18ms)`; VSTest's console logger prints
 * `  Passed Name [12 ms]`.
 */
export function parseDotnetProgressLine(line: string): DotnetProgressLine | undefined {
  const text = stripAnsi(line).trim();
  const mtp = text.match(/^(passed|failed|skipped)\s+(.+?)(?:\s+\(([^()]+)\))?$/);
  if (mtp) {
    const durationMs = parseMtpDuration(mtp[3]);
    return {
      status: mtp[1] as DotnetProgressLine["status"],
      displayName: mtp[2]!.trim(),
      ...(durationMs !== undefined ? { durationMs } : {}),
    };
  }
  const vstest = text.match(/^(Passed|Failed|Skipped)\s+(.+?)(?:\s+\[\s*([^\]]+)\s*\])?$/);
  if (vstest && !/^!\s/.test(vstest[2]!)) {
    const durationMs = parseHumanDuration(vstest[3]);
    return {
      status: vstest[1]!.toLowerCase() as DotnetProgressLine["status"],
      displayName: vstest[2]!.trim(),
      ...(durationMs !== undefined ? { durationMs } : {}),
    };
  }
  return undefined;
}

export function buildDotnetBuildCommand(
  target: string,
  options: { noRestore?: boolean; label?: string } = {},
): ProcessSpec {
  return {
    command: "dotnet",
    args: ["build", target, ...(options.noRestore ? ["--no-restore"] : [])],
    cwd: dirname(target),
    label: options.label ?? `Building ${safeName(target)}`,
  };
}

/** Parses "1s 234ms", "18ms", or "2m 05s 003ms" from Microsoft.Testing.Platform output. */
function parseMtpDuration(value?: string): number | undefined {
  if (!value) return undefined;
  let total = 0;
  let matched = false;
  for (const part of value.matchAll(/(\d+(?:\.\d+)?)\s*(ms|s|m|h)\b/g)) {
    matched = true;
    const amount = Number(part[1]);
    total +=
      part[2] === "h"
        ? amount * 3_600_000
        : part[2] === "m"
          ? amount * 60_000
          : part[2] === "s"
            ? amount * 1000
            : amount;
  }
  return matched ? total : undefined;
}
