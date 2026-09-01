import assert from "node:assert/strict";
import test from "node:test";
import type { TestCase } from "../lib/contracts.ts";
import {
  buildDotnetCommand,
  detectDotnetProject,
  discoverDotnetSourceTests,
  dotnetFilter,
  findCoverageAttachment,
  parseDotnetConsoleResults,
  parseDotnetListOutput,
  parseTrx,
  type DotnetProject,
} from "../lib/dotnet.ts";

function project(xml: string, globalJson?: string): DotnetProject {
  return detectDotnetProject("/repo/tests/App.Tests.csproj", xml, globalJson);
}

function selected(nativeId: string, detected: DotnetProject): TestCase {
  return {
    id: `dotnet:${detected.path}:${nativeId}`,
    nativeId,
    label: nativeId.split(".").at(-1)!,
    adapterId: "dotnet",
    project: detected.path,
    status: "unknown",
  };
}

test("detectDotnetProject recognizes MSTest on VSTest", () => {
  const detected = project(`<Project Sdk="Microsoft.NET.Sdk"><ItemGroup>
    <PackageReference Include="MSTest.TestFramework" Version="4.0.0" />
    <PackageReference Include="MSTest.TestAdapter" Version="4.0.0" />
    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="18.0.0" />
  </ItemGroup></Project>`);
  assert.equal(detected.framework, "mstest");
  assert.equal(detected.platform, "vstest");
  assert.equal(detected.commandMode, "vstest");
  assert.equal(detected.testProject, true);
});

test("detectDotnetProject recognizes an executable NUnit MTP bridge", () => {
  const detected = project(`<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup>
    <EnableNUnitRunner>true</EnableNUnitRunner><TestingPlatformDotnetTestSupport>true</TestingPlatformDotnetTestSupport>
    <OutputType>Exe</OutputType></PropertyGroup><ItemGroup>
    <PackageReference Include="NUnit" Version="4.4.0"/><PackageReference Include="NUnit3TestAdapter" Version="6.0.0"/>
  </ItemGroup></Project>`);
  assert.equal(detected.framework, "nunit");
  assert.equal(detected.platform, "mtp");
  assert.equal(detected.bridge, true);
});

test("detectDotnetProject recognizes xUnit v3 in SDK 10 native MTP mode", () => {
  const detected = project(
    `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup>
    <UseMicrosoftTestingPlatformRunner>true</UseMicrosoftTestingPlatformRunner><OutputType>Exe</OutputType>
  </PropertyGroup><ItemGroup><PackageReference Include="xunit.v3" Version="3.1.0"/></ItemGroup></Project>`,
    `{"test":{"runner":"Microsoft.Testing.Platform"}}`,
  );
  assert.equal(detected.framework, "xunit");
  assert.equal(detected.xunitMajor, 3);
  assert.equal(detected.platform, "mtp");
  assert.equal(detected.commandMode, "mtp-native");
});

test("detectDotnetProject treats TUnit as MTP-only and reports an incomplete runner path", () => {
  const detected = project(`<Project Sdk="Microsoft.NET.Sdk"><ItemGroup>
    <PackageReference Include="TUnit" Version="1.0.0"/>
  </ItemGroup></Project>`);
  assert.equal(detected.framework, "tunit");
  assert.equal(detected.platform, "unavailable");
  assert.match(detected.diagnostics[0]!, /MTP-only/);
});

test("detectDotnetProject exposes bUnit as a flavor while retaining xUnit filters", () => {
  const detected = project(`<Project Sdk="Microsoft.NET.Sdk"><ItemGroup>
    <PackageReference Include="bunit" Version="2.0.0"/><PackageReference Include="xunit" Version="2.9.3"/>
    <PackageReference Include="Microsoft.NET.Test.Sdk" Version="18.0.0"/>
  </ItemGroup></Project>`);
  assert.equal(detected.flavor, "bunit");
  assert.equal(detected.framework, "xunit");
  assert.equal(detected.xunitMajor, 2);
});

test("detectDotnetProject rejects native MTP combined with UseVSTest", () => {
  const detected = project(
    `<Project Sdk="MSTest.Sdk/4.0.0"><PropertyGroup><UseVSTest>true</UseVSTest></PropertyGroup></Project>`,
    `{"test":{"runner":"Microsoft.Testing.Platform"}}`,
  );
  assert.equal(detected.platform, "unavailable");
  assert.match(detected.diagnostics[0]!, /UseVSTest/);
});

test("discoverDotnetSourceTests maps MSTest, xUnit, NUnit, TUnit, skipped tests, and lines", () => {
  const detected = project(`<Project Sdk="MSTest.Sdk/4.0.0" />`);
  const source = `namespace Demo.Tests;
public class CalculatorTests
{
    [TestMethod]
    public void Adds() { }

    [Fact(Skip = "later")]
    public async Task Subtracts() { }

    [TestCase(1)]
    public void Divides(int value) { }
}`;
  const tests = discoverDotnetSourceTests("/repo/tests/CalculatorTests.cs", source, detected);
  assert.deepEqual(
    tests.map((item) => [item.nativeId, item.status, item.source!.line]),
    [
      ["Demo.Tests.CalculatorTests.Adds", "unknown", 5],
      ["Demo.Tests.CalculatorTests.Subtracts", "skipped", 8],
      ["Demo.Tests.CalculatorTests.Divides", "unknown", 11],
    ],
  );
});

test("discoverDotnetSourceTests preserves nested C# class identity", () => {
  const detected = project(`<Project Sdk="MSTest.Sdk/4.0.0" />`);
  const source = `namespace Demo.Tests;
public class Outer
{
  public class Inner
  {
    [TestMethod]
    public void Adds() { }
  }
}`;
  const [result] = discoverDotnetSourceTests("/repo/tests/NestedTests.cs", source, detected);
  assert.equal(result?.nativeId, "Demo.Tests.Outer.Inner.Adds");
  assert.deepEqual(result?.suite, ["App.Tests", "Demo.Tests", "Outer", "Inner"]);
});

test("discoverDotnetSourceTests recognizes F# and Visual Basic tests", () => {
  const detected = project(`<Project Sdk="MSTest.Sdk/4.0.0" />`);
  const fsharp = `[<TestClass>]
type CalculatorTests() =
  [<TestMethod>]
  member _.Adds() = ()`;
  const visualBasic = `Namespace Demo.Tests
Public Class CalculatorTests
  <TestMethod>
  Public Sub Adds()
  End Sub
End Class
End Namespace`;
  assert.equal(
    discoverDotnetSourceTests("/repo/tests/CalculatorTests.fs", fsharp, detected)[0]?.nativeId,
    "CalculatorTests.Adds",
  );
  assert.equal(
    discoverDotnetSourceTests("/repo/tests/CalculatorTests.vb", visualBasic, detected)[0]?.nativeId,
    "Demo.Tests.CalculatorTests.Adds",
  );
});

test("buildDotnetCommand keeps MTP bridge arguments after the separator", () => {
  const detected = project(`<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup>
    <EnableMSTestRunner>true</EnableMSTestRunner><TestingPlatformDotnetTestSupport>true</TestingPlatformDotnetTestSupport>
    <OutputType>Exe</OutputType></PropertyGroup><ItemGroup><PackageReference Include="MSTest" Version="4.0.0"/></ItemGroup></Project>`);
  const spec = buildDotnetCommand(detected, {
    action: "run",
    workspaceRoot: "/repo",
    tests: [selected("Demo.Tests.Case", detected)],
  });
  const separator = spec.args.indexOf("--");
  assert.ok(separator > 1);
  assert.equal(spec.args[separator + 1], "--report-trx");
  assert.ok(spec.args.slice(separator).includes("--filter"));
  assert.equal(spec.reportPath, "/repo/.fresh-test-observatory/dotnet/App.Tests/App.Tests.trx");
});

test("buildDotnetCommand uses --project and direct xUnit v3 filters in native MTP mode", () => {
  const detected = project(
    `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup>
    <UseMicrosoftTestingPlatformRunner>true</UseMicrosoftTestingPlatformRunner><OutputType>Exe</OutputType>
  </PropertyGroup><ItemGroup><PackageReference Include="xunit.v3" Version="3.1.0"/></ItemGroup></Project>`,
    `{"test":{"runner":"Microsoft.Testing.Platform"}}`,
  );
  const spec = buildDotnetCommand(detected, {
    action: "run",
    workspaceRoot: "/repo",
    tests: [selected("Demo.Tests.Case", detected)],
  });
  assert.deepEqual(spec.args.slice(0, 3), ["test", "--project", detected.path]);
  assert.equal(spec.args.includes("--"), false);
  assert.deepEqual(spec.args.slice(-2), ["--filter-method", "Demo.Tests.Case"]);
  assert.equal(spec.args.includes("--report-xunit-trx"), true);
  assert.equal(spec.reportPath, "/repo/.fresh-test-observatory/dotnet/App.Tests/App.Tests.trx");
});

test("buildDotnetCommand only enables MTP report and coverage switches for installed extensions", () => {
  const globalJson = `{"test":{"runner":"Microsoft.Testing.Platform"}}`;
  const withoutExtensions = project(
    `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup>
    <EnableNUnitRunner>true</EnableNUnitRunner><OutputType>Exe</OutputType>
  </PropertyGroup><ItemGroup><PackageReference Include="NUnit" Version="4.4.0"/></ItemGroup></Project>`,
    globalJson,
  );
  const runWithout = buildDotnetCommand(withoutExtensions, {
    action: "run",
    workspaceRoot: "/cache",
  });
  const coverageWithout = buildDotnetCommand(withoutExtensions, {
    action: "coverage",
    workspaceRoot: "/cache",
  });
  assert.equal(runWithout.args.includes("--report-trx"), false);
  assert.equal(runWithout.reportPath, undefined);
  assert.equal(coverageWithout.args.includes("--coverage"), false);
  assert.equal(coverageWithout.reportPath, undefined);
  assert.match(
    withoutExtensions.diagnostics.join("\n"),
    /Microsoft\.Testing\.Extensions\.TrxReport/,
  );
  assert.match(
    withoutExtensions.diagnostics.join("\n"),
    /Microsoft\.Testing\.Extensions\.CodeCoverage/,
  );

  const withExtensions = project(
    `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup>
    <EnableNUnitRunner>true</EnableNUnitRunner><OutputType>Exe</OutputType>
  </PropertyGroup><ItemGroup>
    <PackageReference Include="NUnit" Version="4.4.0"/>
    <PackageReference Include="Microsoft.Testing.Extensions.TrxReport" Version="2.0.0"/>
    <PackageReference Include="Microsoft.Testing.Extensions.CodeCoverage" Version="18.0.0"/>
  </ItemGroup></Project>`,
    globalJson,
  );
  assert.equal(
    buildDotnetCommand(withExtensions, { action: "run", workspaceRoot: "/cache" }).args.includes(
      "--report-trx",
    ),
    true,
  );
  assert.equal(
    buildDotnetCommand(withExtensions, {
      action: "coverage",
      workspaceRoot: "/cache",
    }).args.includes("--coverage"),
    true,
  );
});

test("dotnetFilter emits TUnit treenode paths instead of VSTest expressions", () => {
  const detected = project(
    `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType></PropertyGroup>
    <ItemGroup><PackageReference Include="TUnit" Version="1.0.0"/></ItemGroup></Project>`,
    `{"test":{"runner":"Microsoft.Testing.Platform"}}`,
  );
  assert.deepEqual(dotnetFilter(detected, [selected("Demo.Tests.LoginTests.Accepts", detected)]), [
    "--treenode-filter",
    "/*/*/LoginTests/Accepts",
  ]);
});

test("parseDotnetListOutput ignores build chatter and returns listed tests", () => {
  const detected = project(`<Project Sdk="MSTest.Sdk/4.0.0" />`);
  const tests = parseDotnetListOutput(
    `Build succeeded.
The following Tests are available:
    Demo.Tests.Adds
    Demo.Tests.Subtracts
Total tests: 2`,
    detected,
  );
  assert.deepEqual(
    tests.map((item) => item.nativeId),
    ["Demo.Tests.Adds", "Demo.Tests.Subtracts"],
  );
});

test("parseDotnetListOutput accepts native MTP assembly listings and parameterized display names", () => {
  const detected = project(`<Project Sdk="MSTest.Sdk/4.0.2" />`);
  const tests = parseDotnetListOutput(
    `Discovering tests from /repo/App.Tests.dll (net10.0|x64)

Discovered 3 tests in assembly - /repo/App.Tests.dll (net10.0|x64)
  Adds
  Subtracts (10,4,6)
  Subtracts (-2,-3,1)

Discovered 3 tests.`,
    detected,
  );
  assert.deepEqual(
    tests.map((item) => item.nativeId),
    ["Adds", "Subtracts (10,4,6)", "Subtracts (-2,-3,1)"],
  );
});

test("parseTrx joins definitions to results and extracts failure navigation", () => {
  const detected = project(`<Project Sdk="MSTest.Sdk/4.0.0" />`);
  const trx = `<TestRun><TestDefinitions><UnitTest id="abc" name="Adds">
    <TestMethod className="Demo.Tests.CalculatorTests" name="Adds" codeBase="/repo/tests/App.Tests.dll" />
  </UnitTest></TestDefinitions><Results>
    <UnitTestResult testId="abc" testName="Adds" outcome="Failed" duration="00:00:01.250">
      <Output><ErrorInfo><Message>Expected 4</Message><StackTrace>at Demo.Tests.CalculatorTests.Adds() in /repo/tests/CalculatorTests.cs:line 31</StackTrace></ErrorInfo></Output>
    </UnitTestResult>
  </Results></TestRun>`;
  const results = parseTrx(trx, detected);
  assert.equal(results[0]!.nativeId, "Demo.Tests.CalculatorTests.Adds");
  assert.equal(results[0]!.status, "failed");
  assert.equal(results[0]!.durationMs, 1250);
  assert.deepEqual(results[0]!.source, { path: "/repo/tests/CalculatorTests.cs", line: 31 });
  assert.equal(results[0]!.message, "Expected 4");
});

test("parseDotnetConsoleResults handles pass, fail, skip, and human durations", () => {
  const detected = project(`<Project Sdk="MSTest.Sdk/4.0.0" />`);
  const results = parseDotnetConsoleResults(
    `  Passed Demo.Adds [12 ms]
  Failed Demo.Breaks [1.5 s]
  Skipped Demo.Later [2 ms]`,
    detected,
  );
  assert.deepEqual(
    results.map((item) => [item.status, item.durationMs]),
    [
      ["passed", 12],
      ["failed", 1500],
      ["skipped", 2],
    ],
  );
});

test("findCoverageAttachment extracts the exact VSTest Cobertura attachment", () => {
  assert.equal(
    findCoverageAttachment("Attachments:\n  /repo/TestResults/42/coverage.cobertura.xml\n"),
    "/repo/TestResults/42/coverage.cobertura.xml",
  );
});
