import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCargoCommand,
  buildCargoDocListCommand,
  buildCargoListCommand,
  discoverRustSourceTests,
  parseCargoList,
  parseCargoRun,
  parseNextestList,
  parseNextestRun,
} from "../lib/cargo.ts";
import type { TestCase } from "../lib/contracts.ts";
import {
  buildGoCommand,
  discoverGoSourceTests,
  modulePathFromGoMod,
  parseGoCoverProfile,
  parseGoTestJson,
} from "../lib/go.ts";

function rustTest(nativeId: string): TestCase {
  return {
    id: `cargo:${nativeId}`,
    nativeId,
    label: nativeId.split("::").at(-1)!,
    adapterId: "cargo",
    status: "unknown",
  };
}

function goTest(nativeId: string, project = "example.com/demo/calc"): TestCase {
  return {
    id: `go:${project}:${nativeId}`,
    nativeId,
    label: nativeId,
    adapterId: "go",
    project,
    status: "unknown",
  };
}

test("discoverRustSourceTests recognizes libtest, async tests, rstest, ignore state, and lines", () => {
  const source = `mod math {
    #[test]
    fn adds() {}

    #[tokio::test]
    #[ignore]
    async fn waits() {}

    #[rstest]
    fn cases(#[case] value: i32) {}
}`;
  const tests = discoverRustSourceTests("/repo/src/lib.rs", source, "/repo");
  assert.deepEqual(
    tests.map((item) => [item.nativeId, item.framework, item.status, item.source!.line]),
    [
      ["math::adds", "libtest", "unknown", 3],
      ["math::waits", "libtest", "skipped", 7],
      ["math::cases", "rstest", "unknown", 10],
    ],
  );
});

test("discoverRustSourceTests scans long attribute sequences without backtracking", () => {
  const harmless = "#[cfg(test)] ".repeat(4_000) + "const VALUE: usize = 1;";
  assert.deepEqual(discoverRustSourceTests("/repo/src/lib.rs", harmless, "/repo"), []);

  const [discovered] = discoverRustSourceTests(
    "/repo/src/lib.rs",
    "#[cfg(test)] #[test] pub fn visible() {}",
    "/repo",
  );
  assert.equal(discovered?.nativeId, "visible");
  assert.equal(discovered?.source?.line, 1);
});

test("parseNextestList consumes the rust-suites JSON contract", () => {
  const input = JSON.stringify({
    "rust-suites": {
      "demo::lib": {
        "package-name": "demo",
        testcases: {
          "math::adds": { ignored: false },
          "math::slow": { ignored: true },
        },
      },
    },
  });
  const tests = parseNextestList(input);
  assert.deepEqual(
    tests.map((item) => [item.nativeId, item.project, item.status]),
    [
      ["math::adds", "demo", "unknown"],
      ["math::slow", "demo", "skipped"],
    ],
  );
});

test("parseCargoList accepts test and benchmark records without summaries", () => {
  assert.deepEqual(
    parseCargoList("math::adds: test\nbench::sort: benchmark\n2 tests, 0 benchmarks\n").map(
      (item) => item.nativeId,
    ),
    ["math::adds", "bench::sort"],
  );
  const doctest = parseCargoList("src/lib.rs - add (line 8): test\n")[0]!;
  assert.equal(doctest.framework, "rust-doctest");
  assert.deepEqual(doctest.source, { path: "src/lib.rs", line: 8 });
});

test("parseNextestRun maps JSON events, duration, captured panic, and location", () => {
  const output = [
    { type: "test", event: "started", name: "math::adds" },
    { type: "test", event: "ok", name: "math::adds", exec_time: 0.012 },
    {
      type: "test",
      event: "failed",
      name: "math::breaks",
      exec_time: 0.5,
      stdout: "thread panicked at src/math.rs:14:9\nexpected 4",
    },
    { type: "test", event: "ignored", name: "math::later" },
  ]
    .map((event) => JSON.stringify(event))
    .join("\n");
  const tests = parseNextestRun(output);
  assert.deepEqual(
    tests.map((item) => item.status),
    ["passed", "failed", "skipped"],
  );
  assert.equal(tests[0]!.durationMs, 12);
  assert.deepEqual(tests[1]!.source, { path: "src/math.rs", line: 14, column: 9 });
  assert.match(tests[1]!.stack!, /expected 4/);
});

test("parseNextestRun accepts stable final-status output without experimental environment flags", () => {
  const output = `thread 'tests::breaks' (42) panicked at src/lib.rs:14:9:
expected 4
────────────
     Summary [   0.019s] 3 tests run: 1 passed, 1 failed, 1 skipped
        PASS [   0.003s] (1/3) demo tests::adds
        SKIP [         ] (───) demo tests::later
        FAIL [  16.25ms] (2/3) demo tests::breaks`;
  const tests = parseNextestRun(output);
  assert.deepEqual(
    tests.map((item) => [item.nativeId, item.status, item.durationMs]),
    [
      ["tests::adds", "passed", 3],
      ["tests::later", "skipped", undefined],
      ["tests::breaks", "failed", 16.25],
    ],
  );
  assert.deepEqual(tests[2]!.source, { path: "src/lib.rs", line: 14, column: 9 });
  assert.match(tests[2]!.stack!, /expected 4/);
});

test("parseCargoRun consumes the pretty output emitted by the fallback command", () => {
  const output = `test math::adds ... ok
test math::breaks ... FAILED
test math::later ... ignored

---- math::breaks stdout ----
thread 'math::breaks' panicked at src/math.rs:9:5:
assertion failed

failures:`;
  const tests = parseCargoRun(output);
  assert.deepEqual(
    tests.map((item) => item.status),
    ["passed", "failed", "skipped"],
  );
  assert.deepEqual(tests[1]!.source, { path: "src/math.rs", line: 9, column: 5 });
  assert.match(tests[1]!.message!, /panicked/);
});

test("Cargo commands prefer nextest final-status output and retain plain Cargo fallback", () => {
  assert.deepEqual(buildCargoListCommand("/repo", true).args, [
    "nextest",
    "list",
    "--workspace",
    "--all-targets",
    "--message-format",
    "json",
  ]);
  assert.deepEqual(
    buildCargoCommand({ workspaceRoot: "/repo", nextest: true, tests: [rustTest("math::adds")] })
      .args,
    [
      "nextest",
      "run",
      "--workspace",
      "--all-targets",
      "--status-level",
      "none",
      "--final-status-level",
      "all",
      "-E",
      "test(=math::adds)",
    ],
  );
  assert.deepEqual(
    buildCargoCommand({ workspaceRoot: "/repo", nextest: false, tests: [rustTest("math::adds")] })
      .args,
    ["test", "--workspace", "--all-targets", "math::adds", "--", "--exact"],
  );
});

test("Cargo execution commands pair exact selection with parser-compatible output", () => {
  const selected = rustTest("math::adds");
  const plain = buildCargoCommand({ workspaceRoot: "/repo", nextest: false, tests: [selected] });
  assert.equal(plain.args.includes("terse"), false);
  assert.deepEqual(
    parseCargoRun("running 1 test\ntest math::adds ... ok\n").map((item) => [
      item.nativeId,
      item.status,
    ]),
    [["math::adds", "passed"]],
  );
  assert.throws(
    () =>
      buildCargoCommand({
        workspaceRoot: "/repo",
        nextest: false,
        tests: [selected, rustTest("math::adds_overflow")],
      }),
    /one exact test/i,
  );
  assert.deepEqual(buildCargoDocListCommand("/repo", "demo").args, [
    "test",
    "-p",
    "demo",
    "--doc",
    "--",
    "--list",
    "--format",
    "terse",
  ]);
  assert.deepEqual(
    buildCargoCommand({
      workspaceRoot: "/repo",
      nextest: true,
      packageName: "demo",
      tests: [{ ...selected, nativeId: "src/lib.rs - add (line 8)", framework: "rust-doctest" }],
      doctest: true,
    }).args,
    ["test", "-p", "demo", "--doc", "src/lib.rs - add (line 8)"],
  );
});

test("discoverRustSourceTests follows nested files, mod roots, and active inline modules", () => {
  assert.deepEqual(
    discoverRustSourceTests("/repo/src/foo/mod.rs", "#[test]\nfn from_mod() {}", "/repo").map(
      (item) => item.nativeId,
    ),
    ["foo::from_mod"],
  );
  assert.deepEqual(
    discoverRustSourceTests("/repo/src/a/b.rs", "#[test]\nfn nested() {}", "/repo").map(
      (item) => item.nativeId,
    ),
    ["a::b::nested"],
  );
  const integration = discoverRustSourceTests(
    "/repo/tests/api.rs",
    "#[test]\nfn creates_resource() {}",
    "/repo",
  );
  assert.deepEqual(
    integration.map((item) => [item.nativeId, item.framework, item.suite]),
    [["creates_resource", "rust-integration", ["integration:api"]]],
  );
  const directoryIntegration = [
    ...discoverRustSourceTests(
      "/repo/tests/integration/main.rs",
      "#[test]\nfn root_case() {}",
      "/repo",
    ),
    ...discoverRustSourceTests(
      "/repo/tests/integration/helpers.rs",
      "#[test]\nfn helper_case() {}",
      "/repo",
    ),
  ];
  assert.deepEqual(
    directoryIntegration.map((item) => [item.nativeId, item.target]),
    [
      ["root_case", "integration:integration"],
      ["helpers::helper_case", "integration:integration"],
    ],
  );
  const source = `mod closed { #[test] fn first() {} }
mod active {
  mod nested { #[test] fn second() {} }
  #[test] fn third() {}
}`;
  assert.deepEqual(
    discoverRustSourceTests("/repo/src/lib.rs", source, "/repo").map((item) => item.nativeId),
    ["closed::first", "active::nested::second", "active::third"],
  );
});

test("Cargo coverage command uses cargo-llvm-cov and an exact Cobertura path", () => {
  const spec = buildCargoCommand({ workspaceRoot: "/repo", nextest: true, coverage: true });
  assert.deepEqual(spec.args, [
    "llvm-cov",
    "nextest",
    "--workspace",
    "--cobertura",
    "--output-path",
    "/repo/.fresh-test-observatory/cargo/coverage.cobertura.xml",
  ]);
  assert.equal(spec.reportFormat, "cobertura");
});

test("discoverGoSourceTests finds tests, benchmarks, fuzz targets, and examples with module package identity", () => {
  const source = `package calc_test

func TestAdds(t *testing.T) {}
func BenchmarkAdds(b *testing.B) {}
func FuzzAdds(f *testing.F) {}
func ExampleAdd() {}`;
  const tests = discoverGoSourceTests(
    "/repo/calc/calc_test.go",
    source,
    "/repo",
    "example.com/demo",
  );
  assert.deepEqual(
    tests.map((item) => [item.nativeId, item.project, item.source!.line]),
    [
      ["TestAdds", "example.com/demo/calc", 3],
      ["BenchmarkAdds", "example.com/demo/calc", 4],
      ["FuzzAdds", "example.com/demo/calc", 5],
      ["ExampleAdd", "example.com/demo/calc", 6],
    ],
  );
});

test("discoverGoSourceTests adds literal subtests beneath their top-level test", () => {
  const source = `package calc

func TestAdd(t *testing.T) {
  t.Run("positive", func(t *testing.T) {})
  t.Run("negative input", func(t *testing.T) {})
}`;
  const tests = discoverGoSourceTests("/repo/calc_test.go", source, "/repo", "example.com/demo");
  assert.deepEqual(
    tests.map((item) => [item.nativeId, item.parentId, item.source?.line]),
    [
      ["TestAdd", undefined, 3],
      ["TestAdd/positive", "go:example.com/demo:TestAdd", 4],
      ["TestAdd/negative_input", "go:example.com/demo:TestAdd", 5],
    ],
  );
});

test("parseGoTestJson aggregates nested test events, failure output, and duration", () => {
  const events = [
    { Action: "run", Package: "example.com/demo/calc", Test: "TestAdds" },
    {
      Action: "output",
      Package: "example.com/demo/calc",
      Test: "TestAdds",
      Output: "    calc_test.go:12: expected 4\n",
    },
    { Action: "fail", Package: "example.com/demo/calc", Test: "TestAdds", Elapsed: 0.25 },
    { Action: "pass", Package: "example.com/demo/calc", Test: "TestAdds/positive", Elapsed: 0.01 },
    { Action: "skip", Package: "example.com/demo/calc", Test: "TestLater", Elapsed: 0 },
  ]
    .map((event) => JSON.stringify(event))
    .join("\n");
  const tests = parseGoTestJson(events);
  assert.deepEqual(
    tests.map((item) => item.status),
    ["failed", "passed", "skipped"],
  );
  assert.equal(tests[0]!.durationMs, 250);
  assert.deepEqual(tests[0]!.source, { path: "calc_test.go", line: 12 });
  assert.equal(tests[1]!.label, "positive");
});

test("Go commands use JSON, exact test regexes, package targets, and native coverage profiles", () => {
  const run = buildGoCommand("/repo", [goTest("TestA"), goTest("TestB")]);
  assert.deepEqual(run.args, [
    "test",
    "-json",
    "example.com/demo/calc",
    "-run",
    "^(?:TestA|TestB)$",
  ]);
  const relative = buildGoCommand("/repo", [goTest("TestA", "calc")]);
  assert.equal(relative.args[2], "./calc");
  const subtest = buildGoCommand("/repo", [goTest("TestA/positive")]);
  assert.deepEqual(subtest.args.slice(-2), ["-run", "^TestA$/^positive$"]);
  const coverage = buildGoCommand("/repo", [], true);
  assert.deepEqual(coverage.args, [
    "test",
    "-coverprofile=/repo/.fresh-test-observatory/go/cover.out",
    "./...",
  ]);
});

test("parseGoCoverProfile expands covered blocks, strips module paths, and merges overlaps", () => {
  const profile = `mode: set
example.com/demo/calc/add.go:2.10,4.2 2 0
example.com/demo/calc/add.go:4.2,5.3 1 3`;
  assert.deepEqual(parseGoCoverProfile(profile, "/repo", "example.com/demo"), [
    {
      path: "/repo/calc/add.go",
      lines: [
        { line: 2, hits: 0 },
        { line: 3, hits: 0 },
        { line: 4, hits: 3 },
        { line: 5, hits: 3 },
      ],
    },
  ]);
  assert.equal(modulePathFromGoMod("module example.com/demo\n\ngo 1.24\n"), "example.com/demo");
});
