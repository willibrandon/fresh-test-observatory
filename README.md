Fresh Test Observatory is a test explorer for [Fresh](https://github.com/sinelaw/fresh). It discovers tests, runs them at workspace, file, selected, or cursor scope, keeps complete runner output available, navigates failures, and marks source coverage.

Install it with `Package: Install from URL` using https://github.com/willibrandon/fresh-test-observatory, then run `Test Observatory: Open` from the command palette.

Rust projects use cargo-nextest when it is installed and fall back to Cargo. Go projects use the standard toolchain. .NET projects can use VSTest or Microsoft.Testing.Platform with MSTest, xUnit, NUnit, bUnit, or TUnit. JUnit results and Cobertura coverage can also be imported.

The command palette provides Test Observatory: Open, Close, Refresh, Run All, Run Selected, Run Nearest, Run Test at Cursor, Run Current File, Rerun Failed, Run Selected in Terminal, Run Nearest in Terminal, Toggle Coverage, Stop, Go to Test or Failure, Expand All, Collapse All, Filter, Toggle Failed Only, Toggle Name or Duration Sort, Toggle Watch, Next Failure, Show Output, Import Report, and Show Adapters.

Inside the dock, `r` runs the selected test, `a` runs all tests, `n` runs the nearest test, `f` filters, `x` stops, `c` toggles coverage, `]` selects the next failure, `o` opens output, `w` toggles watch, and `q` closes the current Observatory view. Arrow keys navigate the tree, Enter activates the current row, and Tab moves between controls.

Fresh Settings exposes `runOnSave`, `coverageOnSave`, `preferNextest`, `noBuild`, `noRestore`, `reportDir`, `dockWidth`, `autoOpenOnFailure`, `terminalRuns`, `enabledAdapters`, `coverageGoodThreshold`, `coverageWarningThreshold`, and `dotnetVerbosity`.

The optional status-bar token is `fresh-test-observatory:test-summary`. Add it to the left or right section under Settings, Status Bar. Fresh 0.4.10 does not expose click handlers for plugin status tokens, so opening the dock remains a palette or keybinding action.

Test commands run only in trusted workspaces. Reports are written to Fresh's temporary directory by default. Editing a covered file clears its old line data. Saving restores test-state marks; coverage returns after the next coverage run.

Language plugins can register their own discovery, execution, result parsing, and coverage collection through the typed `registerAdapter()` API exported by the plugin.

Development requires Fresh 0.4.10 or newer and Node 24 or newer.

    npm ci
    npm run validate
