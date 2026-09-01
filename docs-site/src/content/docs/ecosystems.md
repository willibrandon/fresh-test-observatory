---
title: Ecosystems
description: How the .NET, Rust, and Go adapters find and run tests, and what they need.
---

One adapter per ecosystem finds tests, builds the commands, and reads the results. Projects can be nested anywhere below the workspace root, including several of them side by side.

## .NET

A project is a test project when it references a test framework, sets `IsTestProject`, or references `Microsoft.NET.Test.Sdk`. MSTest, xUnit v2 and v3, NUnit, bUnit, and TUnit are recognised. `Directory.Build.props`, `Directory.Packages.props`, and `Directory.Build.targets` are read alongside the project file so runner properties set there count.

Three runner modes are supported, chosen per project:

- VSTest, the default for projects that do not opt into Microsoft.Testing.Platform.
- Microsoft.Testing.Platform through the `dotnet test` bridge, when the project sets `TestingPlatformDotnetTestSupport` and enables a runner.
- Native Microsoft.Testing.Platform, when the nearest `global.json` selects it. Commands run from the project directory so the SDK finds the same `global.json`.

Results come from a TRX file. VSTest writes one through its logger. Under Microsoft.Testing.Platform the project needs `Microsoft.Testing.Extensions.TrxReport`, which `MSTest.Sdk` and the `MSTest` package include; xUnit v3 uses its own TRX reporter. When a project lacks the extension, the dock says which package is missing and the run falls back to console output.

Discovery reads C#, F#, and Visual Basic sources for test attributes, including nested classes, then confirms the list with `dotnet test --list-tests`. The listing is cached per project until a source file or the project changes. Parameterized cases from `DataRow`, `Theory`, and similar attributes appear under their method, and the method takes the worst result of its cases. The `noBuild`, `noRestore`, and `dotnetVerbosity` settings are passed through.

## Rust

Every `Cargo.toml` with a `[package]` section below the workspace root is a package. When cargo-nextest is installed and `preferNextest` is on, listing and runs go through it, and selected tests are matched exactly with a nextest filter expression. Otherwise plain `cargo test` is used with `--exact`, one test per command.

Unit tests, integration tests under `tests/`, and doctests are all listed. Integration tests appear under their target, doctests under the file that holds them. Doctests run through `cargo test --doc` since nextest does not execute them. Module paths are derived from the file layout and from `mod` blocks that are still open at the test's position.

## Go

Every `go.mod` below the workspace root is a module. Discovery reads `_test.go` files for tests, benchmarks, fuzz targets, examples, and `t.Run` subtests with literal names. Runs use `go test -json` with an exact `-run` pattern; subtests run one at a time so the pattern cannot match other tests.

## Imported reports

Import Report loads a JUnit XML or Cobertura XML file into the dock. Imported tests keep their status, message, and location. They cannot be rerun unless an adapter with the same id is registered, and the dock says so if you try.
