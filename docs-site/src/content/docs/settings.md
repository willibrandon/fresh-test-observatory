---
title: Settings
description: Plugin settings, the status bar token, and where reports are written.
---

## Settings

These appear under Plugin: fresh-test-observatory in Fresh's settings.

| Setting                    | Default  | Effect                                                                                                                                                       |
| -------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `runOnSave`                | `false`  | Run a file's tests after each save.                                                                                                                          |
| `coverageOnSave`           | `false`  | Collect coverage after a watched save.                                                                                                                       |
| `preferNextest`            | `true`   | Use cargo-nextest when it is installed.                                                                                                                      |
| `noBuild`                  | `false`  | Skip the .NET build before discovery and runs; use the binaries already on disk.                                                                             |
| `noRestore`                | `false`  | Pass `--no-restore` to .NET discovery and runs.                                                                                                              |
| `reportDir`                | empty    | Where reports go. Relative values are placed under Fresh's temporary directory.                                                                              |
| `dockWidth`                | `38`     | Height of the dock as a percentage of the window, from 24 to 60, applied each time it opens. Drag the separator above the dock to change it for the session. |
| `autoOpenOnFailure`        | `true`   | Open the dock when a run has failures.                                                                                                                       |
| `terminalRuns`             | `false`  | Run every test command in a visible terminal.                                                                                                                |
| `enabledAdapters`          | empty    | Adapter ids to use. An empty list means all of them.                                                                                                         |
| `coverageGoodThreshold`    | `90`     | Percentage shown in the good colour in the file explorer.                                                                                                    |
| `coverageWarningThreshold` | `70`     | Percentage shown in the warning colour in the file explorer.                                                                                                 |
| `dotnetVerbosity`          | `normal` | Console logger verbosity for .NET runs.                                                                                                                      |

## Status bar

The plugin registers a status bar token named `fresh-test-observatory:test-summary`. Add it to the left or right section under Settings, Status Bar. It shows the counts from the last run, or from the whole workspace when nothing has run yet, and the coverage percentage when coverage is visible.

## Reports

TRX files, Cobertura files, and Go cover profiles are written under Fresh's temporary directory in a folder named after the workspace, and cleared on each refresh. Nothing is written into the workspace itself. Set `reportDir` to keep them somewhere else.
