# Guide

Test Observatory requires Fresh 0.4.10 or newer. Install it from the repository URL, then run `Test Observatory: Open`.

## Commands

| Command          | Use                                                   |
| ---------------- | ----------------------------------------------------- |
| Open             | Open the utility dock and discover the workspace.     |
| Run All          | Run tests from every detected adapter.                |
| Run Selected     | Run the test selected in the tree.                    |
| Run Nearest      | Run the test nearest the source cursor.               |
| Run Current File | Run tests declared by the active file.                |
| Rerun Failed     | Run the current failing set.                          |
| Toggle Coverage  | Collect or hide source coverage.                      |
| Show Output      | Read and copy complete runner output.                 |
| Stop             | Stop the active discovery, test, or coverage process. |
| Import Report    | Load JUnit or Cobertura XML.                          |

## Dock keys

Use `r` for the selected test, `a` for all tests, `n` for nearest, `f` for the filter, `o` for output, `c` for coverage, `w` for watch, `]` for the next failure, `x` to stop, and `q` to close.

Palette commands can be assigned global shortcuts in Fresh's keybinding editor.

## Settings and state

Fresh's Settings UI exposes run on save, coverage on save, adapter selection, nextest preference, .NET build and restore switches, .NET verbosity, coverage thresholds, terminal runs, report location, auto-open on failure, and dock width.

Reports default to the active authority's temporary directory. The selected test, expansion state, filter, sort, failed-only view, watch mode, and dock state are kept with the Fresh session.

## Status bar

The status token is `fresh-test-observatory:test-summary`. Add it to the left or right section under Settings, Status Bar. Fresh 0.4.10 does not expose click handlers for plugin status tokens, so open the dock with a palette command or keybinding.

## Workspace trust

Source discovery works in restricted workspaces. Test commands, builds, and coverage run only when Fresh reports the exact `trusted` state.
