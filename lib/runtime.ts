import type { ProcessOutput, TestCase } from "./contracts.ts";

export interface DockStructureState {
  tests: readonly TestCase[];
  busy: boolean;
  showOutput: boolean;
  coverageVisible: boolean;
  selectedTestId?: string;
  selectedTreeKey?: string;
  filter: string;
  failedOnly: boolean;
  sortMode: string;
}

/** Marks the first visible edit in a dirty session and ignores later batches. */
export function beginDirtySourceSession(
  dirtyPaths: Set<string>,
  path: string,
  modified: boolean,
): boolean {
  if (!modified || dirtyPaths.has(path)) return false;
  dirtyPaths.add(path);
  return true;
}

/** Ends a dirty session when Fresh confirms the buffer was saved or reverted. */
export function endDirtySourceSession(dirtyPaths: Set<string>, path: string): boolean {
  return dirtyPaths.delete(path);
}

/**
 * Captures only the state that requires rebuilding the dock widget tree.
 * Progress, diagnostics, and output can be updated through host mutations.
 */
export function dockStructureFingerprint(state: DockStructureState): string {
  return JSON.stringify([
    state.busy,
    state.showOutput,
    state.coverageVisible,
    state.selectedTestId ?? "",
    state.selectedTreeKey ?? "",
    state.filter,
    state.failedOnly,
    state.sortMode,
    state.tests.map((test) => [
      test.id,
      test.label,
      test.status,
      test.parentId ?? "",
      test.adapterId,
      test.project ?? "",
      test.suite ?? [],
      test.durationMs ?? -1,
    ]),
  ]);
}

/** Prefers Fresh's complete terminal buffer over lossy last-line PTY events. */
export function terminalProcessOutput(
  terminalBuffer: string | undefined,
  fallbackLines: readonly string[],
  exitCode: number | null,
): ProcessOutput {
  const complete = terminalBuffer?.trimEnd() ?? "";
  const fallback = fallbackLines.join("\n").trimEnd();
  return {
    stdout: stripTerminalControlSequences(complete || fallback),
    stderr: "",
    // Fresh 0.4.10 reports null after every hosted command, not just signals.
    // Test parsers still surface failing cases from the complete transcript.
    exitCode: exitCode ?? 0,
  };
}

/** Removes display-only terminal sequences before runner result parsing. */
export function stripTerminalControlSequences(value: string): string {
  return value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}
