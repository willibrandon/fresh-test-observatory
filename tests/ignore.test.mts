import assert from "node:assert/strict";
import test from "node:test";
import { buildGitignoreMatcher, GitignoreMatcher, parseGitignore } from "../lib/ignore.ts";

function matcher(files: Record<string, string>, root = "/repo"): GitignoreMatcher {
  const paths = Object.keys(files).filter((path) => !path.endsWith("/.gitignore"));
  return buildGitignoreMatcher(root, paths, (path) => files[path] ?? null);
}

test("gitignore rules follow git: directories, anchors, wildcards, negation", () => {
  const files = {
    "/repo/.gitignore": [
      "# build output",
      "artifacts/",
      "*.obj",
      "!keep.obj",
      "/build",
      "docs/**/*.tmp",
      "bin/",
      "temp?",
    ].join("\n"),
    "/repo/artifacts/reproductions/tests/App.Tests.csproj": "",
    "/repo/src/a.obj": "",
    "/repo/src/keep.obj": "",
    "/repo/build/x.cs": "",
    "/repo/src/build/y.cs": "",
    "/repo/docs/a/b/c.tmp": "",
    "/repo/docs/c.tmp": "",
    "/repo/src/bin/Debug/App.dll": "",
    "/repo/tests/App.Tests.csproj": "",
    "/repo/tempo": "",
    "/repo/temporary": "",
  };
  const ignore = matcher(files);
  assert.equal(ignore.isIgnored("/repo/artifacts/reproductions/tests/App.Tests.csproj"), true);
  assert.equal(ignore.isIgnored("/repo/artifacts", true), true);
  assert.equal(ignore.isIgnored("/repo/src/a.obj"), true);
  assert.equal(ignore.isIgnored("/repo/src/keep.obj"), false);
  assert.equal(ignore.isIgnored("/repo/build/x.cs"), true, "anchored /build");
  assert.equal(
    ignore.isIgnored("/repo/src/build/y.cs"),
    false,
    "anchored pattern does not match nested",
  );
  assert.equal(ignore.isIgnored("/repo/docs/a/b/c.tmp"), true);
  assert.equal(ignore.isIgnored("/repo/docs/c.tmp"), true, "** matches zero directories");
  assert.equal(ignore.isIgnored("/repo/src/bin/Debug/App.dll"), true, "bin/ at any depth");
  assert.equal(ignore.isIgnored("/repo/tests/App.Tests.csproj"), false);
  assert.equal(ignore.isIgnored("/repo/tempo"), true);
  assert.equal(ignore.isIgnored("/repo/temporary"), false);
  assert.equal(ignore.isIgnored("/elsewhere/file.obj"), false, "outside the root");
});

test("nested .gitignore files override parents, and ignored parents cannot be re-included", () => {
  const files = {
    "/repo/.gitignore": "*.log\nvendor/\n",
    "/repo/app/.gitignore": "!important.log\n",
    "/repo/app/important.log": "",
    "/repo/app/other.log": "",
    "/repo/vendor/.gitignore": "!keep.txt\n",
    "/repo/vendor/keep.txt": "",
    "/repo/root.log": "",
  };
  const ignore = matcher(files);
  assert.equal(ignore.isIgnored("/repo/app/important.log"), false);
  assert.equal(ignore.isIgnored("/repo/app/other.log"), true);
  assert.equal(ignore.isIgnored("/repo/root.log"), true);
  assert.equal(ignore.isIgnored("/repo/vendor/keep.txt"), true, "parent directory is ignored");
});

test("gitignore parsing skips comments and blanks and keeps escaped characters", () => {
  const rules = parseGitignore("/repo", "\n# comment\n\\#literal\n  \nfoo/ \n");
  assert.deepEqual(
    rules.map((rule) => [rule.directoryOnly, rule.negated]),
    [
      [false, false],
      [true, false],
    ],
  );
  assert.equal(rules[0]!.regex.test("#literal"), true);
  assert.equal(rules[0]!.regex.test("a/#literal"), true);
  assert.equal(rules[1]!.regex.test("foo"), true);
  assert.equal(rules[1]!.regex.test("food"), false);
});

test("a Visual Studio style ignore file keeps the checked-in projects and drops the artifacts tree", () => {
  const gitignore = [
    "## Ignore Visual Studio temporary files, build results, and",
    "[Dd]ebug/",
    "[Rr]elease/",
    "x64/",
    "[Bb]in/",
    "[Oo]bj/",
    "artifacts/",
    "*.obj",
    "*.binlog",
    "TestResults/",
  ].join("\n");
  const files = {
    "/csls/.gitignore": gitignore,
    "/csls/tests/Csls.Tests/Csls.Tests.csproj": "",
    "/csls/tests/Csls.Tests/Debug/leftover.cs": "",
    "/csls/artifacts/reproductions/pr100/tests/Csls.Tests/Csls.Tests.csproj": "",
    "/csls/artifacts/zed-extension/grammar-source/c_sharp/Cargo.toml": "",
    "/csls/src/Csls.App/bin/Debug/net10.0/Csls.App.dll": "",
    "/csls/editors/zed/Cargo.toml": "",
  };
  const ignore = matcher(files, "/csls");
  const kept = Object.keys(files)
    .filter((path) => !path.endsWith(".gitignore") && !ignore.isIgnored(path))
    .sort();
  assert.deepEqual(kept, [
    "/csls/editors/zed/Cargo.toml",
    "/csls/tests/Csls.Tests/Csls.Tests.csproj",
  ]);
});

test("rules from a nested .gitignore found during a walk apply below their directory", () => {
  const matcher = new GitignoreMatcher("/repo", parseGitignore("/repo", "*.log\n"));
  matcher.addRules(parseGitignore("/repo/tests", "fixtures/\n!keep.log\n"));
  assert.equal(matcher.isIgnored("/repo/tests/fixtures", true), true);
  assert.equal(matcher.isIgnored("/repo/tests/fixtures/a.cs"), true);
  assert.equal(matcher.isIgnored("/repo/tests/keep.log"), false);
  assert.equal(matcher.isIgnored("/repo/src/fixtures", true), false);
  assert.equal(matcher.isIgnored("/repo/src/keep.log"), true);
});
