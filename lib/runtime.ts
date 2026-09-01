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

interface SourceLifecycleEventMap {
  lines_changed: { buffer_id: number };
  after_file_save: { path: string; buffer_id: number };
  after_file_revert: { path: string; buffer_id: number };
}

export type SourceLifecycleRegister = <K extends keyof SourceLifecycleEventMap>(
  eventName: K,
  handler: (event: SourceLifecycleEventMap[K]) => void,
) => void;

export interface SourceLifecycleHandlers {
  linesChanged(bufferId: number): void;
  fileSaved(path: string, bufferId: number): void;
  fileReverted(path: string, bufferId: number): void;
}

export type SourceSaveAction =
  { kind: "none" } | { kind: "repaint"; bufferId: number } | { kind: "run" };

export type DockContentMutation<TEntry> =
  | {
      kind: "setItems";
      widgetKey: string;
      items: TEntry[];
      itemKeys: string[];
    }
  | {
      kind: "setRawEntries";
      widgetKey: string;
      entries: TEntry[];
    };

export interface DockContentState<TEntry> {
  showOutput: boolean;
  outputWidgetKey: string;
  outputEntries: TEntry[];
  titleWidgetKey: string;
  titleEntries: TEntry[];
  detailsWidgetKey: string;
  detailEntries: TEntry[];
}

/** Registers the three source events needed for batched edit invalidation. */
export function registerSourceLifecycleEvents(
  register: SourceLifecycleRegister,
  handlers: SourceLifecycleHandlers,
): void {
  register("lines_changed", (event) => handlers.linesChanged(event.buffer_id));
  register("after_file_save", (event) => handlers.fileSaved(event.path, event.buffer_id));
  register("after_file_revert", (event) => handlers.fileReverted(event.path, event.buffer_id));
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

/** Chooses the minimum work needed after Fresh saves a source buffer. */
export function sourceSaveAction(
  dirtyPaths: Set<string>,
  path: string,
  bufferId: number,
  runOnSave: boolean,
): SourceSaveAction {
  const wasDirty = endDirtySourceSession(dirtyPaths, path);
  if (runOnSave) return { kind: "run" };
  if (wasDirty) return { kind: "repaint", bufferId };
  return { kind: "none" };
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

/** Updates dock content without rebuilding its widget tree. */
export function mutateDockContent<TEntry>(
  mutate: (mutation: DockContentMutation<TEntry>) => boolean,
  state: DockContentState<TEntry>,
): boolean {
  if (state.showOutput) {
    return mutate({
      kind: "setItems",
      widgetKey: state.outputWidgetKey,
      items: state.outputEntries,
      itemKeys: state.outputEntries.map((_, index) => `${state.outputWidgetKey}:${index}`),
    });
  }
  const titleUpdated = mutate({
    kind: "setRawEntries",
    widgetKey: state.titleWidgetKey,
    entries: state.titleEntries,
  });
  const detailsUpdated = mutate({
    kind: "setRawEntries",
    widgetKey: state.detailsWidgetKey,
    entries: state.detailEntries,
  });
  return titleUpdated && detailsUpdated;
}

/** Rebuilds the dock only when the host cannot apply its content mutations. */
export function updateDock(mutate: () => boolean, rebuild: () => void): void {
  if (!mutate()) rebuild();
}

/** Retains an unavailable status unless a concrete failure code is observed. */
export function mergeProcessExitCode(current: number, next: number): number {
  if (current !== 0 && current !== -1) return current;
  if (next !== 0 && next !== -1) return next;
  return current === -1 || next === -1 ? -1 : 0;
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
    // Preserve that uncertainty; parsed test results remain authoritative.
    exitCode: exitCode ?? -1,
  };
}

/** Reads the final terminal buffer, with PTY last-line events as a fallback. */
export async function captureTerminalProcessOutput(
  readBuffer: (bufferId: number) => Promise<string>,
  bufferId: number,
  fallbackLines: readonly string[],
  exitCode: number | null,
): Promise<ProcessOutput> {
  let transcript: string | undefined;
  try {
    transcript = await readBuffer(bufferId);
  } catch {
    // The terminal can be closed before its final buffer snapshot is available.
  }
  return terminalProcessOutput(transcript, fallbackLines, exitCode);
}

/** Removes display-only terminal sequences before runner result parsing. */
export function stripTerminalControlSequences(value: string): string {
  return value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
}
