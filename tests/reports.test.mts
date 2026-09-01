import assert from "node:assert/strict";
import test from "node:test";
import { parseCobertura } from "../lib/cobertura.ts";
import { parseFailureLocation, parseJunit } from "../lib/junit.ts";
import { attributes, decodeXml, escapeXml, textContent } from "../lib/xml.ts";

test("XML helpers decode named and numeric entities without damaging unknown entities", () => {
  assert.equal(decodeXml("A &amp; B &#x2713; &#65; &custom;"), "A & B ✓ A &custom;");
  assert.equal(escapeXml("<&\"'>"), "&lt;&amp;&quot;&apos;&gt;");
  assert.deepEqual(attributes("name=\"A &amp; B\" count='2'"), { name: "A & B", count: "2" });
  assert.equal(textContent("<![CDATA[one < two]]>"), "one < two");
  assert.equal(textContent("safe <<script>alert</script> tail"), "safe alert tail");
});

test("parseJunit ingests pass, skip, error, duration, entities, and source location", () => {
  const xml = `
    <testsuite name="sample">
      <testcase classname="Calc.Tests" name="adds &amp; rounds" file="tests/calc_test.py" line="12" time="0.125" />
      <testcase classname="Calc.Tests" name="disabled"><skipped /></testcase>
      <testcase classname="Calc.Tests" name="fails" time="1.5">
        <error message="expected 4"><![CDATA[AssertionError
    at /repo/tests/calc.test.ts:22:7]]></error>
      </testcase>
    </testsuite>`;
  const results = parseJunit(xml, { adapterId: "pytest", framework: "pytest", project: "calc" });
  assert.deepEqual(
    results.map((result) => result.status),
    ["passed", "skipped", "failed"],
  );
  assert.equal(results[0]!.durationMs, 125);
  assert.deepEqual(results[0]!.source, { path: "tests/calc_test.py", line: 12 });
  assert.equal(results[2]!.message, "expected 4");
  assert.deepEqual(results[2]!.source, { path: "/repo/tests/calc.test.ts", line: 22, column: 7 });
});

test("parseFailureLocation understands .NET stack trace line notation", () => {
  assert.deepEqual(parseFailureLocation("at Calc.Tests.Adds() in /repo/CalcTests.cs:line 42"), {
    path: "/repo/CalcTests.cs",
    line: 42,
  });
});

test("parseCobertura resolves source roots and merges duplicate class observations", () => {
  const xml = `
    <coverage><sources><source>/repo</source></sources><packages><package><classes>
      <class name="A" filename="src/a.ts"><lines>
        <line number="2" hits="0" branch="true" condition-coverage="50% (1/2)" />
      </lines></class>
      <class name="A.Inner" filename="src/a.ts"><lines>
        <line number="2" hits="3"/><line number="5" hits="1"/>
      </lines></class>
    </classes></package></packages></coverage>`;
  const files = parseCobertura(xml, "/ignored");
  assert.deepEqual(files, [
    {
      path: "/repo/src/a.ts",
      lines: [
        { line: 2, hits: 3, branchRate: 0.5 },
        { line: 5, hits: 1 },
      ],
    },
  ]);
});

test("parseCobertura ignores malformed line records while retaining valid siblings", () => {
  const xml = `<coverage><class filename="a.py"><lines>
    <line number="zero" hits="1"/><line number="4" hits="0"/>
  </lines></class></coverage>`;
  assert.deepEqual(parseCobertura(xml, "/repo")[0]!.lines, [{ line: 4, hits: 0 }]);
});
