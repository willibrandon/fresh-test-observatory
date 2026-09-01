---
title: Using the dock
description: The tree, the detail pane, the output view, and the marks in source files.
---

## The tree

`Test Observatory: Open` puts the explorer in Fresh's utility dock, below the editor. The tree groups tests by adapter, project, and suite. Parameterized cases and Go subtests sit under the test that declares them. Each row shows a status glyph: passed, failed, skipped, running, or not yet run.

Select a row to see its latest result under the tree: status, duration, source location, message, and the first lines of the stack trace; the full trace is in the output view. Press `Enter`, or double-click the row, to open the test in its file, or the failure location when the last run failed. The selection stays on the same test when results add or remove rows.

## Filtering and sorting

Filter narrows the tree by name, suite, project, or adapter. Failed Only hides everything that is not failing. Sort switches between name order and longest duration first. Next Failure moves the selection to the next failing test.

## Output

The output view holds the complete text each runner printed during the last operation, grouped by adapter, followed by any diagnostics. Copy sends it to the clipboard. Show Adapters lists the registered adapters here as well.

## Marks in source

Test files get a mark in the gutter on each test line showing its last status. A failed test also shows its message at the end of the line. The file explorer shows the worst status of the tests in each file. Marks are cleared while a file has unsaved edits and come back when it is saved.

## Progress

While tests run, the title shows what is running, how many of the selected tests have finished, and the elapsed time, updated several times a second. Results arrive in the tree as each runner reports them, and the detail pane shows the last test result or build step the runner reported. Everything else a runner prints, including a test's own console output, goes to the output view only. Discovery shows the tests found in source first and fills in the runner's own listing as it arrives.

## Stopping a run

Stop ends the process that is running, whether it is discovery, a test run, or coverage. Tests that did not report a result are shown as not run.

## Watch

With watch on, saving a file runs the tests declared in it. The `runOnSave` setting makes this the default; the Watch button and `w` toggle it for the current session.

## Terminal runs

Run Selected in Terminal and Run Nearest in Terminal open a terminal for the command so you can see it run and scroll back through it. When the command exits, the dock reads the terminal transcript and updates the tree the same way it would for a background run. Set `terminalRuns` to make every run behave this way.
