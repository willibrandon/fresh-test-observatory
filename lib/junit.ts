import type { SourceLocation, TestCase } from "./contracts.ts";
import { attributes, textContent } from "./xml.ts";

export interface JunitParseOptions {
  adapterId?: string;
  framework?: string;
  project?: string;
}

export function parseJunit(xml: string, options: JunitParseOptions = {}): TestCase[] {
  const adapterId = options.adapterId ?? "junit";
  const tests: TestCase[] = [];
  const expression = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/gi;
  for (const match of xml.matchAll(expression)) {
    const attrs = attributes(match[1] ?? "");
    const body = match[2] ?? "";
    const name = attrs.name || "unnamed test";
    const className = attrs.classname ?? attrs.class ?? "";
    const nativeId = className ? `${className}.${name}` : name;
    const failure = body.match(/<(failure|error)\b([^>]*)>([\s\S]*?)<\/\1>/i);
    const skipped = /<skipped\b/i.test(body);
    const failureAttrs = failure ? attributes(failure[2] ?? "") : {};
    const stack = failure ? textContent(failure[3]) : "";
    const message = failureAttrs.message || firstNonEmptyLine(stack);
    const source = sourceFrom(attrs.file, attrs.line) ?? parseFailureLocation(stack);
    const durationMs = secondsToMilliseconds(attrs.time);
    tests.push({
      id: `${adapterId}:${nativeId}`,
      nativeId,
      label: name,
      adapterId,
      status: failure ? "failed" : skipped ? "skipped" : "passed",
      ...(options.framework ? { framework: options.framework } : {}),
      ...(options.project ? { project: options.project } : {}),
      ...(className ? { suite: className.split(".") } : {}),
      ...(source ? { source } : {}),
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(message ? { message } : {}),
      ...(stack ? { stack } : {}),
    });
  }
  return tests;
}

export function parseFailureLocation(text: string): SourceLocation | undefined {
  const patterns = [
    /\s+in\s+(.+?):line\s+(\d+)(?::(?:(\d+)))?/i,
    /\bat\s+(.+?):(\d+):(?:(\d+))\b/,
    /\((.+?):(\d+):(?:(\d+))\)/,
    /\b(.+\.(?:cs|fs|vb|rs|go|py|tsx?|jsx?)):(\d+)(?::(\d+))?/,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (!match) continue;
    return {
      path: match[1]!.trim(),
      line: Number(match[2]),
      ...(match[3] ? { column: Number(match[3]) } : {}),
    };
  }
  return undefined;
}

function sourceFrom(path?: string, line?: string): SourceLocation | undefined {
  if (!path) return undefined;
  return { path, line: Number(line) || 1 };
}

function secondsToMilliseconds(value?: string): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) ? seconds * 1000 : undefined;
}

function firstNonEmptyLine(value: string): string {
  return (
    value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}
