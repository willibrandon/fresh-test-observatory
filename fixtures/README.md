# Fixture workspace

The workspace combines a Cargo package, a Go module, and an MSTest project so one Fresh session can exercise every built-in adapter.

The suites include passing, skipped, parameterized, subtest, doctest, and Rust integration-test cases. The Rust source keeps a separate navigation anchor for nearest-test checks. Generated reports and all Cargo and .NET build output are ignored.

Run the fixture directly when changing adapter commands:

    cd fixtures/workspace
    cargo nextest run --all-targets
    cargo test --doc
    go test ./...
    dotnet test dotnet/Observatory.Sample.Tests.csproj

Coverage requires cargo-llvm-cov for Rust. The .NET fixture uses MSTest.Sdk and Microsoft.Testing.Platform through the checked-in global.json.
