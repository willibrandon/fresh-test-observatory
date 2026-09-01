Fresh Test Observatory is a test explorer for Fresh. It discovers tests, runs them at workspace, file, selected, or cursor scope, keeps runner output available, navigates failures, and marks source coverage.

Install it with Package: Install from URL using https://github.com/willibrandon/fresh-test-observatory, then run Test Observatory: Open from the command palette.

Rust projects use cargo-nextest when it is installed and fall back to Cargo. Go projects use the standard toolchain. .NET projects can use VSTest or Microsoft.Testing.Platform with MSTest, xUnit, NUnit, bUnit, or TUnit. JUnit results and Cobertura coverage can also be imported.

Test commands run only in trusted workspaces. Reports are written to Fresh's temporary directory by default. Editing a covered file clears its old line data.

Language plugins can register their own discovery, execution, and result parsing through the typed registerAdapter API. The guide and API reference are at https://willibrandon.github.io/fresh-test-observatory/.

Development requires Fresh 0.4.10 or newer and Node 24 or newer.

    npm ci
    npm run validate
