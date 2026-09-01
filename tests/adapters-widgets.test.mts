import assert from "node:assert/strict";
import test from "node:test";
import { createBuiltInAdapters } from "../lib/adapters.ts";
import type {
  AdapterContext,
  ProcessOutput,
  ProcessSpec,
  TestObservatoryAdapter,
} from "../lib/contracts.ts";
import {
  button,
  col,
  divider,
  hintBar,
  raw,
  wrappingRow,
  tree,
  treeExpansionAction,
} from "../lib/widgets.ts";

function context(
  files: Record<string, string>,
  execute: (spec: ProcessSpec) => ProcessOutput | Promise<ProcessOutput>,
): AdapterContext {
  return {
    cwd: "/repo",
    trusted: true,
    readFile(path): string | null {
      return files[path] ?? null;
    },
    async findFiles(glob): Promise<string[]> {
      if (glob === "**/*.*proj")
        return Object.keys(files).filter((path) => /\.(?:cs|fs|vb)proj$/.test(path));
      if (glob === "**/*.cs") return Object.keys(files).filter((path) => path.endsWith(".cs"));
      if (glob === "**/*.fs") return Object.keys(files).filter((path) => path.endsWith(".fs"));
      if (glob === "**/*.vb") return Object.keys(files).filter((path) => path.endsWith(".vb"));
      if (glob === "**/*.rs") return Object.keys(files).filter((path) => path.endsWith(".rs"));
      if (glob === "**/*_test.go")
        return Object.keys(files).filter((path) => path.endsWith("_test.go"));
      if (glob === "**/Cargo.toml")
        return Object.keys(files).filter((path) => path.endsWith("/Cargo.toml"));
      if (glob === "**/go.mod")
        return Object.keys(files).filter((path) => path.endsWith("/go.mod"));
      return [];
    },
    async execute(spec): Promise<ProcessOutput> {
      return execute(spec);
    },
  };
}

test("createBuiltInAdapters exposes typed .NET, Cargo, and Go adapters in priority order", () => {
  const adapters = createBuiltInAdapters();
  const typed: TestObservatoryAdapter[] = adapters;
  assert.deepEqual(
    typed.map((adapter) => [adapter.id, adapter.priority]),
    [
      ["dotnet", 100],
      ["cargo", 80],
      ["go", 70],
    ],
  );
  assert.ok(
    typed.every(
      (adapter) => typeof adapter.discover === "function" && typeof adapter.run === "function",
    ),
  );
});

test("Cargo and Go adapters reject undefined manifests from the Fresh runtime", async () => {
  const fake = {
    ...context({}, () => ({ stdout: "", stderr: "", exitCode: 0 })),
    readFile: () => undefined,
  } as unknown as AdapterContext;
  const adapters = createBuiltInAdapters();
  assert.equal(await adapters.find((item) => item.id === "cargo")!.detect(fake), false);
  assert.equal(await adapters.find((item) => item.id === "go")!.detect(fake), false);
});

test(".NET adapter discovers source locations, merges runner listings, and parses execution", async () => {
  const files = {
    "/repo/tests/App.Tests.csproj": `<Project Sdk="Microsoft.NET.Sdk"><ItemGroup>
      <PackageReference Include="MSTest.TestFramework" Version="4.0.0"/>
      <PackageReference Include="MSTest.TestAdapter" Version="4.0.0"/>
      <PackageReference Include="Microsoft.NET.Test.Sdk" Version="18.0.0"/>
    </ItemGroup></Project>`,
    "/repo/tests/CalculatorTests.cs": `namespace Demo.Tests;
public class CalculatorTests { [TestMethod] public void Adds() {} }`,
  };
  let listRuns = 0;
  const fake = context(files, (spec) => {
    const listing = spec.args.includes("--list-tests");
    if (listing) listRuns += 1;
    return {
      stdout: listing
        ? "The following Tests are available:\n    Demo.Tests.CalculatorTests.Adds\n"
        : "  Passed Demo.Tests.CalculatorTests.Adds [5 ms]\n",
      stderr: "",
      exitCode: listing ? 0 : -1,
    };
  });
  const adapter = createBuiltInAdapters().find((item) => item.id === "dotnet")!;
  assert.equal(await adapter.detect(fake), true);
  const discovered = await adapter.discover(fake);
  await adapter.discover(fake);
  assert.equal(listRuns, 1);
  assert.equal(discovered.tests.length, 1);
  assert.deepEqual(discovered.tests[0]!.source, {
    path: "/repo/tests/CalculatorTests.cs",
    line: 2,
  });
  const result = await adapter.run(fake, { scope: "workspace", tests: discovered.tests });
  assert.equal(result.tests[0]!.status, "passed");
  assert.equal(result.tests[0]!.source!.path, "/repo/tests/CalculatorTests.cs");
  assert.equal(result.exitCode, -1);
});

test(".NET adapter keeps duplicate method names in distinct classes", async () => {
  const files = {
    "/repo/tests/App.Tests.csproj": `<Project Sdk="Microsoft.NET.Sdk"><ItemGroup>
      <PackageReference Include="MSTest.TestFramework" Version="4.0.0"/>
      <PackageReference Include="Microsoft.NET.Test.Sdk" Version="18.0.0"/>
    </ItemGroup></Project>`,
    "/repo/tests/ATests.cs": `namespace Demo; public class ATests { [TestMethod] public void Adds() {} }`,
    "/repo/tests/BTests.cs": `namespace Demo; public class BTests { [TestMethod] public void Adds() {} }`,
  };
  const fake = context(files, () => ({
    stdout: "The following Tests are available:\n Demo.BTests.Adds\n Demo.ATests.Adds\n",
    stderr: "",
    exitCode: 0,
  }));
  const adapter = createBuiltInAdapters().find((item) => item.id === "dotnet")!;
  const discovered = await adapter.discover(fake);
  assert.deepEqual(
    discovered.tests.map((item) => [item.nativeId, item.source?.path]),
    [
      ["Demo.ATests.Adds", "/repo/tests/ATests.cs"],
      ["Demo.BTests.Adds", "/repo/tests/BTests.cs"],
    ],
  );
});

test(".NET adapter drops an ambiguous bare VSTest listing instead of adding a source-less row", async () => {
  const files = {
    "/repo/tests/App.Tests.csproj": `<Project Sdk="Microsoft.NET.Sdk"><ItemGroup>
      <PackageReference Include="MSTest.TestFramework" Version="4.0.0"/>
      <PackageReference Include="Microsoft.NET.Test.Sdk" Version="18.0.0"/>
    </ItemGroup></Project>`,
    "/repo/tests/ATests.cs": `namespace Demo; public class ATests { [TestMethod] public void Adds() {} }`,
    "/repo/tests/BTests.cs": `namespace Demo; public class BTests { [TestMethod] public void Adds() {} }`,
  };
  const fake = context(files, () => ({
    stdout: "The following Tests are available:\n Adds\n",
    stderr: "",
    exitCode: 0,
  }));
  const adapter = createBuiltInAdapters().find((item) => item.id === "dotnet")!;
  const discovered = await adapter.discover(fake);

  assert.deepEqual(
    discovered.tests.map((item) => [item.nativeId, item.source?.path]),
    [
      ["Demo.ATests.Adds", "/repo/tests/ATests.cs"],
      ["Demo.BTests.Adds", "/repo/tests/BTests.cs"],
    ],
  );
  assert.equal(
    discovered.tests.some((item) => item.nativeId === "Adds"),
    false,
  );
});

test(".NET adapter reconciles CLR nested-type names with their source location", async () => {
  const files = {
    "/repo/tests/App.Tests.csproj": `<Project Sdk="Microsoft.NET.Sdk"><ItemGroup>
      <PackageReference Include="MSTest.TestFramework" Version="4.0.0"/>
      <PackageReference Include="Microsoft.NET.Test.Sdk" Version="18.0.0"/>
    </ItemGroup></Project>`,
    "/repo/tests/NestedTests.cs": `namespace Demo;
public class Outer { public class Inner { [TestMethod] public void Adds() {} } }`,
  };
  const fake = context(files, () => ({
    stdout: "The following Tests are available:\n Demo.Outer+Inner.Adds\n",
    stderr: "",
    exitCode: 0,
  }));
  const adapter = createBuiltInAdapters().find((item) => item.id === "dotnet")!;
  const discovered = await adapter.discover(fake);

  assert.equal(discovered.tests.length, 1);
  assert.equal(discovered.tests[0]!.nativeId, "Demo.Outer+Inner.Adds");
  assert.deepEqual(discovered.tests[0]!.source, {
    path: "/repo/tests/NestedTests.cs",
    line: 2,
  });
});

test(".NET adapter aggregates parameterized cases into a failed parent when listing is unavailable", async () => {
  const reportPath = "/repo/.fresh-test-observatory/dotnet/App.Tests/App.Tests.trx";
  const files = {
    "/repo/tests/App.Tests.csproj": `<Project Sdk="Microsoft.NET.Sdk"><ItemGroup>
      <PackageReference Include="MSTest.TestFramework" Version="4.0.0"/>
      <PackageReference Include="Microsoft.NET.Test.Sdk" Version="18.0.0"/>
    </ItemGroup></Project>`,
    "/repo/tests/CalculatorTests.cs": `namespace Demo; public class CalculatorTests { [DataTestMethod] public void Adds(int value) {} }`,
    [reportPath]: `<TestRun><TestDefinitions>
      <UnitTest id="one"><TestMethod className="Demo.CalculatorTests" name="Adds (1)" /></UnitTest>
      <UnitTest id="two"><TestMethod className="Demo.CalculatorTests" name="Adds (2)" /></UnitTest>
    </TestDefinitions><Results>
      <UnitTestResult testId="one" testName="Adds (1)" outcome="Failed" />
      <UnitTestResult testId="two" testName="Adds (2)" outcome="Passed" />
    </Results></TestRun>`,
  };
  const fake = context(files, (spec) =>
    spec.args.includes("--list-tests")
      ? { stdout: "", stderr: "listing unavailable", exitCode: 1 }
      : { stdout: "", stderr: "", exitCode: 1 },
  );
  const adapter = createBuiltInAdapters().find((item) => item.id === "dotnet")!;
  const discovered = await adapter.discover(fake);
  const result = await adapter.run(fake, { scope: "workspace", tests: discovered.tests });
  const parent = result.tests.find((item) => item.nativeId === "Demo.CalculatorTests.Adds");
  const cases = result.tests.filter((item) => item.parentId === parent?.id);
  assert.equal(parent?.status, "failed");
  assert.deepEqual(
    cases.map((item) => [item.nativeId, item.status]),
    [
      ["Demo.CalculatorTests.Adds (1)", "failed"],
      ["Demo.CalculatorTests.Adds (2)", "passed"],
    ],
  );
});

test(".NET adapter aligns native MTP display names with parameterized TRX results", async () => {
  const reportPath = "/repo/.fresh-test-observatory/dotnet/App.Tests/App.Tests.trx";
  const files = {
    "/repo/global.json": JSON.stringify({ test: { runner: "Microsoft.Testing.Platform" } }),
    "/repo/tests/App.Tests.csproj": `<Project Sdk="MSTest.Sdk/4.0.2"><PropertyGroup>
      <TargetFramework>net10.0</TargetFramework>
    </PropertyGroup></Project>`,
    "/repo/tests/CalculatorTests.cs": `namespace Demo.Tests;
public class CalculatorTests {
  [TestMethod] public void Simple() {}
  [DataTestMethod] [DataRow(1)] public void Adds(int value) {}
}`,
    [reportPath]: `<TestRun><TestDefinitions>
      <UnitTest id="simple" name="Simple"><TestMethod className="Demo.Tests.CalculatorTests" name="Simple" codeBase="/repo/tests/bin/App.Tests.dll" /></UnitTest>
      <UnitTest id="one" name="Adds (1)"><TestMethod className="Demo.Tests.CalculatorTests" name="Adds (1)" codeBase="/repo/tests/bin/App.Tests.dll" /></UnitTest>
      <UnitTest id="two" name="Adds (2)"><TestMethod className="Demo.Tests.CalculatorTests" name="Adds (2)" codeBase="/repo/tests/bin/App.Tests.dll" /></UnitTest>
    </TestDefinitions><Results>
      <UnitTestResult testId="simple" testName="Simple" outcome="Passed" duration="00:00:00.001" />
      <UnitTestResult testId="one" testName="Adds (1)" outcome="Passed" duration="00:00:00.001" />
      <UnitTestResult testId="two" testName="Adds (2)" outcome="Passed" duration="00:00:00.002" />
    </Results></TestRun>`,
  };
  const fake = context(files, (spec) => ({
    stdout: spec.args.includes("--list-tests")
      ? "Discovered 3 tests in assembly - App.Tests.dll\n  Simple\n  Adds (1)\n  Adds (2)\n\nDiscovered 3 tests.\n"
      : "",
    stderr: "",
    exitCode: 0,
  }));
  const adapter = createBuiltInAdapters().find((item) => item.id === "dotnet")!;
  const discovered = await adapter.discover(fake);
  const result = await adapter.run(fake, { scope: "workspace", tests: discovered.tests });
  assert.equal(result.tests.length, 4);
  assert.deepEqual(
    result.tests.map((item) => [item.label, item.nativeId, item.status]),
    [
      ["Adds", "Demo.Tests.CalculatorTests.Adds", "passed"],
      ["Adds (1)", "Demo.Tests.CalculatorTests.Adds (1)", "passed"],
      ["Adds (2)", "Demo.Tests.CalculatorTests.Adds (2)", "passed"],
      ["Simple", "Demo.Tests.CalculatorTests.Simple", "passed"],
    ],
  );
  assert.deepEqual(
    result.tests.map((item) => item.id),
    discovered.tests.map((item) => item.id),
  );
  assert.ok(result.tests.every((item) => item.source?.path === "/repo/tests/CalculatorTests.cs"));
});

test(".NET adapter uses the nearest nested global.json for native MTP runs", async () => {
  const projectPath = "/repo/fixtures/dotnet/App.Tests.csproj";
  const reportPath = "/repo/.fresh-test-observatory/dotnet/App.Tests/App.Tests.trx";
  const files = {
    "/repo/fixtures/global.json": JSON.stringify({
      test: { runner: "Microsoft.Testing.Platform" },
    }),
    [projectPath]: `<Project Sdk="MSTest.Sdk/4.0.2"><PropertyGroup>
      <TargetFramework>net10.0</TargetFramework>
    </PropertyGroup></Project>`,
    "/repo/fixtures/dotnet/CalculatorTests.cs": `namespace Demo.Tests;
public class CalculatorTests { [TestMethod] public void Adds() {} }`,
    [reportPath]: `<TestRun><TestDefinitions>
      <UnitTest id="adds" name="Adds"><TestMethod className="Demo.Tests.CalculatorTests" name="Adds" /></UnitTest>
    </TestDefinitions><Results>
      <UnitTestResult testId="adds" testName="Adds" outcome="Passed" duration="00:00:00.001" />
    </Results></TestRun>`,
  };
  const commands: ProcessSpec[] = [];
  const fake = context(files, (spec) => {
    commands.push(spec);
    return {
      stdout: spec.args.includes("--list-tests")
        ? "Discovered 1 test in assembly - App.Tests.dll\n  Adds\n\nDiscovered 1 test.\n"
        : "",
      stderr: "",
      exitCode: 0,
    };
  });
  const adapter = createBuiltInAdapters().find((item) => item.id === "dotnet")!;
  const discovered = await adapter.discover(fake);
  const result = await adapter.run(fake, { scope: "nearest", tests: discovered.tests });
  const runCommand = commands.at(-1)!;
  assert.deepEqual(runCommand.args.slice(0, 3), ["test", "--project", projectPath]);
  assert.deepEqual(runCommand.args.slice(-2), [
    "--filter",
    "FullyQualifiedName=Demo.Tests.CalculatorTests.Adds",
  ]);
  assert.equal(runCommand.cwd, "/repo/fixtures/dotnet");
  assert.equal(result.tests[0]!.status, "passed");
});

test("Cargo adapter prefers nextest JSON for discovery and execution", async () => {
  const files = {
    "/repo/Cargo.toml": '[package]\nname = "demo"\nversion = "0.1.0"\n',
    "/repo/src/lib.rs": "#[test]\nfn adds() {}\n",
  };
  let probes = 0;
  const fake = context(files, (spec) => {
    if (spec.args[0] === "nextest" && spec.args[1] === "--version") {
      probes += 1;
      return { stdout: "cargo-nextest 0.9", stderr: "", exitCode: 0 };
    }
    if (spec.args[0] === "nextest" && spec.args[1] === "list") {
      return {
        stdout: JSON.stringify({
          "rust-suites": {
            lib: { "package-name": "demo", testcases: { adds: { ignored: false } } },
          },
        }),
        stderr: "",
        exitCode: 0,
      };
    }
    return {
      stdout: JSON.stringify({ type: "test", event: "ok", name: "adds", exec_time: 0.001 }),
      stderr: "",
      exitCode: 0,
    };
  });
  const adapter = createBuiltInAdapters().find((item) => item.id === "cargo")!;
  assert.equal(await adapter.detect(fake), true);
  const discovered = await adapter.discover(fake);
  await adapter.discover(fake);
  assert.equal(probes, 1);
  assert.deepEqual(discovered.tests[0]!.source, { path: "/repo/src/lib.rs", line: 2 });
  const result = await adapter.run(fake, { scope: "workspace", tests: discovered.tests });
  assert.deepEqual(
    result.tests.map((item) => [item.nativeId, item.status]),
    [["adds", "passed"]],
  );
});

test("Cargo adapter ignores nextest SKIP rows for tests filtered out of a nearest run", async () => {
  const files = {
    "/repo/Cargo.toml": '[package]\nname = "demo"\nversion = "0.1.0"\n',
    "/repo/src/lib.rs": "#[test]\nfn selected() {}\n#[test]\nfn filtered_out() {}\n",
  };
  const fake = context(files, (spec) => {
    if (spec.args[0] === "nextest" && spec.args[1] === "--version") {
      return { stdout: "cargo-nextest 0.9", stderr: "", exitCode: 0 };
    }
    if (spec.args[0] === "nextest" && spec.args[1] === "list") {
      return {
        stdout: JSON.stringify({
          "rust-suites": {
            lib: { "package-name": "demo", testcases: { selected: {}, filtered_out: {} } },
          },
        }),
        stderr: "",
        exitCode: 0,
      };
    }
    return {
      stdout: `Summary [0.01s] 1 test run: 1 passed, 1 skipped
        PASS [0.01s] (1/1) demo selected
        SKIP [     ] (───) demo filtered_out`,
      stderr: "",
      exitCode: 0,
    };
  });
  const adapter = createBuiltInAdapters().find((item) => item.id === "cargo")!;
  const discovered = await adapter.discover(fake);
  const selected = discovered.tests.filter((item) => item.nativeId === "selected");
  const result = await adapter.run(fake, { scope: "nearest", tests: selected });
  assert.deepEqual(
    result.tests.map((item) => [item.nativeId, item.status]),
    [["selected", "passed"]],
  );
});

test("Cargo adapter discovers and runs a package nested below the Fresh workspace root", async () => {
  const files = {
    "/repo/fixtures/Cargo.toml": '[package]\nname = "fixture"\nversion = "0.1.0"\n',
    "/repo/fixtures/rust/src/lib.rs": "#[test]\nfn adds() {}\n",
  };
  const commands: ProcessSpec[] = [];
  const fake = context(files, (spec) => {
    commands.push(spec);
    if (spec.args[0] === "nextest" && spec.args[1] === "--version") {
      return { stdout: "cargo-nextest 0.9", stderr: "", exitCode: 0 };
    }
    if (spec.args[0] === "nextest" && spec.args[1] === "list") {
      return {
        stdout: JSON.stringify({
          "rust-suites": { lib: { "package-name": "fixture", testcases: { adds: {} } } },
        }),
        stderr: "",
        exitCode: 0,
      };
    }
    return {
      stdout: "Summary [0.01s] 1 test run: 1 passed\n  PASS [0.01s] (1/1) fixture adds",
      stderr: "",
      exitCode: 0,
    };
  });
  const adapter = createBuiltInAdapters().find((item) => item.id === "cargo")!;
  assert.equal(await adapter.detect(fake), true);
  const discovered = await adapter.discover(fake);
  const result = await adapter.run(fake, { scope: "workspace", tests: discovered.tests });
  assert.deepEqual(
    discovered.tests.map((item) => [item.project, item.source?.path]),
    [["fixture", "/repo/fixtures/rust/src/lib.rs"]],
  );
  assert.deepEqual(
    result.tests.map((item) => [item.nativeId, item.status]),
    [["adds", "passed"]],
  );
  assert.ok(
    commands
      .filter((spec) => spec.args[0] === "nextest")
      .every((spec) => spec.cwd === "/repo/fixtures"),
  );
  assert.ok(commands.some((spec) => spec.args.includes("-p") && spec.args.includes("fixture")));
});

test("Go adapter carries module package identity from source discovery into JSON results", async () => {
  const files = {
    "/repo/go.mod": "module example.com/demo\n\ngo 1.24\n",
    "/repo/calc/calc_test.go": "package calc\n\nfunc TestAdds(t *testing.T) {}\n",
  };
  const fake = context(files, () => ({
    stdout: [
      {
        Action: "output",
        Package: "example.com/demo/calc",
        Test: "TestAdds",
        Output: "    calc_test.go:9: expected 4\n",
      },
      { Action: "fail", Package: "example.com/demo/calc", Test: "TestAdds", Elapsed: 0.01 },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n"),
    stderr: "",
    exitCode: 0,
  }));
  const adapter = createBuiltInAdapters().find((item) => item.id === "go")!;
  assert.equal(await adapter.detect(fake), true);
  const discovered = await adapter.discover(fake);
  assert.equal(discovered.tests[0]!.project, "example.com/demo/calc");
  const result = await adapter.run(fake, { scope: "workspace", tests: discovered.tests });
  assert.equal(result.tests[0]!.status, "failed");
  assert.deepEqual(result.tests[0]!.source, { path: "/repo/calc/calc_test.go", line: 9 });
});

test("Go adapter discovers and runs a module nested below the Fresh workspace root", async () => {
  const files = {
    "/repo/fixtures/go.mod": "module example.com/fixture\n\ngo 1.24\n",
    "/repo/fixtures/calc_test.go": "package fixture\n\nfunc TestAdd(t *testing.T) {}\n",
  };
  const commands: ProcessSpec[] = [];
  const fake = context(files, (spec) => {
    commands.push(spec);
    return {
      stdout: JSON.stringify({
        Action: "pass",
        Package: "example.com/fixture",
        Test: "TestAdd",
        Elapsed: 0.01,
      }),
      stderr: "",
      exitCode: 0,
    };
  });
  const adapter = createBuiltInAdapters().find((item) => item.id === "go")!;
  assert.equal(await adapter.detect(fake), true);
  const discovered = await adapter.discover(fake);
  const result = await adapter.run(fake, { scope: "workspace", tests: discovered.tests });
  assert.deepEqual(
    discovered.tests.map((item) => [item.project, item.source?.path]),
    [["example.com/fixture", "/repo/fixtures/calc_test.go"]],
  );
  assert.deepEqual(
    result.tests.map((item) => [item.nativeId, item.status]),
    [["TestAdd", "passed"]],
  );
  assert.deepEqual(
    commands.map((spec) => spec.cwd),
    ["/repo/fixtures"],
  );
});

test("widget builders emit complete native Fresh specs without undefined option fields", () => {
  const treeSpec = tree({
    nodes: [{ text: { text: "✓ case" }, depth: 0, hasChildren: false }],
    itemKeys: ["case"],
    selectedIndex: 0,
    expandedKeys: [],
    key: "test-tree",
  });
  const panel = col(
    wrappingRow(
      button("Run", "run", { primary: true }),
      button("Stop", "stop", { disabled: true }),
    ),
    divider(),
    treeSpec,
    raw([{ text: "details" }], "details"),
    hintBar([{ keys: "Enter", label: "open" }]),
  );
  assert.equal(panel.kind, "col");
  assert.equal(JSON.stringify(panel).includes("undefined"), false);
  assert.match(JSON.stringify(panel), /"intent":"primary"/);
  assert.match(JSON.stringify(panel), /"kind":"tree"/);
  assert.deepEqual(treeSpec.kind === "tree" ? treeSpec.expandedKeys : undefined, []);
});

test("Expand All and Collapse All actions return keyboard focus to the test tree", () => {
  assert.deepEqual(treeExpansionAction("test-tree", ["cargo", "dotnet", "go"]), [
    {
      kind: "setExpandedKeys",
      widgetKey: "test-tree",
      keys: ["cargo", "dotnet", "go"],
    },
    { kind: "setFocusKey", widgetKey: "test-tree" },
  ]);
  assert.deepEqual(treeExpansionAction("test-tree", []), [
    { kind: "setExpandedKeys", widgetKey: "test-tree", keys: [] },
    { kind: "setFocusKey", widgetKey: "test-tree" },
  ]);
});
