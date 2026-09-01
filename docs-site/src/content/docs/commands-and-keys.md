---
title: Commands and keys
description: Every command in the palette and every key the dock responds to.
---

## Commands

Each command is listed under `Test Observatory:` in the command palette.

| Command                                           | Effect                                                          |
| ------------------------------------------------- | --------------------------------------------------------------- |
| Open, Close                                       | Show or hide the dock. Open discovers tests if none are loaded. |
| Refresh                                           | Discover tests again.                                           |
| Run All                                           | Run every test.                                                 |
| Run Selected                                      | Run the selected row.                                           |
| Run Nearest, Run Test at Cursor                   | Run the test nearest the cursor.                                |
| Run Current File                                  | Run the tests in the active file.                               |
| Rerun Failed                                      | Run the tests that failed last time.                            |
| Run Selected in Terminal, Run Nearest in Terminal | The same, in a visible terminal.                                |
| Toggle Coverage                                   | Collect and show coverage, or hide it.                          |
| Stop                                              | Stop the running process.                                       |
| Go to Test or Failure                             | Open the selected test or its failure location.                 |
| Expand All, Collapse All                          | Expand or collapse the tree.                                    |
| Filter                                            | Filter by name, suite, project, or adapter.                     |
| Toggle Failed Only                                | Show only failing tests.                                        |
| Toggle Name or Duration Sort                      | Sort by name or by longest duration.                            |
| Toggle Watch                                      | Run a file's tests on save.                                     |
| Next Failure                                      | Select the next failing test.                                   |
| Show Output                                       | Show runner output and diagnostics.                             |
| Import Report                                     | Load a JUnit or Cobertura XML file.                             |
| Show Adapters                                     | List registered adapters.                                       |

## Keys

These apply while the dock has focus.

| Key                  | Effect                                               |
| -------------------- | ---------------------------------------------------- |
| Arrow keys           | Move in the tree, expand, collapse.                  |
| `Tab`, `Shift`+`Tab` | Move between the buttons and the tree.               |
| `Enter`              | Open the selected test, or press the focused button. |
| `r`, `a`, `n`        | Run selected, all, nearest.                          |
| `f`                  | Filter.                                              |
| `x`                  | Stop.                                                |
| `c`                  | Toggle coverage. In the output view, copy.           |
| `]`                  | Next failure.                                        |
| `o`                  | Output view.                                         |
| `w`                  | Toggle watch.                                        |
| `q`, `Esc`           | Close. In the output view, back to the tree.         |
