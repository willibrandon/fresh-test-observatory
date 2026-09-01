# Test Observatory

Test Observatory adds test discovery, focused runs, failure navigation, runner output, and source coverage to Fresh.

## Install

Open `Package: Install from URL` in Fresh and enter:

```
https://github.com/willibrandon/fresh-test-observatory
```

Run `Test Observatory: Open` from the command palette. The utility dock opens and discovers the current workspace.

## Use

Run every test, the selected test, the current file, the test nearest the cursor, or the current failures. Results stay attached to their source locations. Complete output remains available when a summary is not enough.

Coverage marks covered and missed lines in the editor. Editing a file clears its old coverage so stale data is never shown as current.

## Supported workspaces

| Workspace | Support                                             |
| --------- | --------------------------------------------------- |
| Rust      | Cargo, cargo-nextest, and cargo-llvm-cov            |
| Go        | `go test -json` and native coverage profiles        |
| .NET      | VSTest, MTP, MSTest, xUnit, NUnit, bUnit, and TUnit |
| Reports   | JUnit test results and Cobertura coverage           |

See the [guide](./guide) for commands, keys, and settings. Language plugins can add support through the typed [adapter API](./api).
