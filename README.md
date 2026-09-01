Fresh Test Observatory keeps test discovery, focused runs, failure navigation, output, and coverage inside Fresh. It supports .NET, Rust, Go, JUnit, and Cobertura without making any one workflow the center of the plugin.

Install it with Package: Install from URL and enter https://github.com/willibrandon/fresh-test-observatory. Open it with Test Observatory: Open. The dock can run all tests, the selected test, the current file, the test nearest the cursor, or the current failures. Complete stacks and runner output remain available when a summary is not enough.

Rust prefers cargo-nextest and uses cargo-llvm-cov for coverage. Go uses the standard toolchain. .NET supports VSTest and Microsoft.Testing.Platform projects using MSTest, xUnit, NUnit, bUnit, and TUnit. Source discovery also understands F# and Visual Basic tests.

Reports are stored outside the workspace by default. Commands execute only in a trusted workspace. Coverage is cleared for a file as soon as it is edited because old line data should not look current.

The status token is fresh-test-observatory:test-summary. Add it through Fresh's Status Bar settings if you want the latest result visible outside the dock.

The guide, settings reference, keys, requirements, and typed adapter example are at https://willibrandon.github.io/fresh-test-observatory/.

Development requires Fresh 0.4.10 or newer and Node 24 or newer. The checked-in Fresh declarations are runtime types, while Node types are restricted to the test and tooling projects.

    npm ci
    npm run validate

The UI acceptance harness drives a real Fresh session through hex1b. The fixture workspace contains deliberately passing, skipped, and failing cases so navigation and coverage can be observed rather than inferred.
