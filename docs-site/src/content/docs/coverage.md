---
title: Coverage
description: How coverage is collected and shown, and when it is cleared.
---

Toggle Coverage runs the workspace with the native coverage tool for each ecosystem and shows the result three ways:

- a mark in the gutter for each covered and uncovered line,
- ranges on the scrollbar,
- a percentage next to each file in the explorer.

The percentage colour follows the `coverageGoodThreshold` and `coverageWarningThreshold` settings. The dock's detail pane shows the totals for the workspace and for the current file.

Editing a covered file clears its coverage data, since the line numbers no longer match. The data returns after the next coverage run, or on the next save when `coverageOnSave` is on. Toggle Coverage again to hide it.

## Tools

- .NET under VSTest: `--collect "XPlat Code Coverage"`, which needs `coverlet.collector`.
- .NET under Microsoft.Testing.Platform: `--coverage`, which needs `Microsoft.Testing.Extensions.CodeCoverage`.
- Rust: cargo-llvm-cov.
- Go: `go test -coverprofile`.

Cobertura files from any other tool can be loaded with Import Report.
