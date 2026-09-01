---
title: Getting started
description: Install the plugin, open the dock, and run tests for the first time.
---

## Install

1. In Fresh, run `Package: Install from URL` from the command palette.
2. Enter `https://github.com/willibrandon/fresh-test-observatory`.
3. Restart Fresh and run `Test Observatory: Open`.

The plugin needs Fresh 0.4.10 or newer.

## Trust

Discovery and runs spawn `dotnet`, `cargo`, and `go`, which execute code from the workspace. They only run when Fresh reports the workspace as trusted. In any other state the dock still shows the tests found in source and says what is missing. Trusting the workspace triggers a refresh.

## First run

Opening the dock discovers tests when none are loaded. Press `a` in the dock, or run `Test Observatory: Run All`, to run everything. The tree updates as each adapter finishes, the status bar shows the counts, and the row you select shows its result underneath the tree.

To run a single test from source, put the cursor inside it and run `Test Observatory: Run Nearest`.

## Requirements by ecosystem

- .NET: the .NET SDK. Coverage under VSTest needs `coverlet.collector`; under Microsoft.Testing.Platform it needs `Microsoft.Testing.Extensions.CodeCoverage`.
- Rust: Cargo. cargo-nextest is used when installed. Coverage needs cargo-llvm-cov.
- Go: the Go toolchain.

See [Ecosystems](/fresh-test-observatory/ecosystems/) for the details of each one.
