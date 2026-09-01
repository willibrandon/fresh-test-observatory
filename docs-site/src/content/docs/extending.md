---
title: Extending
description: Register an adapter for another ecosystem from init.ts or another plugin.
---

The plugin exports its API through Fresh's plugin registry. From `init.ts` or another plugin:

```ts
const observatory = editor.getPluginApi("fresh-test-observatory");

observatory?.registerAdapter({
  id: "pytest",
  label: "Python",
  priority: 50,

  async detect(context) {
    return (await context.findFiles("**/pytest.ini")).length > 0;
  },

  async discover(context) {
    const output = await context.execute({
      command: "python",
      args: ["-m", "pytest", "--collect-only", "-q"],
      cwd: context.cwd,
    });
    return { tests: testsFromCollectOutput(output.stdout, context.cwd) };
  },

  async run(context, request) {
    const report = context.reportDir + "/pytest/results.xml";
    const output = await context.execute({
      command: "python",
      args: ["-m", "pytest", "--junitxml", report, ...request.tests.map((t) => t.nativeId)],
      cwd: context.cwd,
      reportPath: report,
      reportFormat: "junit",
    });
    return {
      tests: testsFromJunit(context.readFile(report) ?? ""),
      output: output.stdout + output.stderr,
      exitCode: output.exitCode,
    };
  },
});
```

The two parsing functions are yours to write.

## The adapter contract

An adapter has an `id`, a `label`, an optional `priority`, and three methods. `detect` says whether the workspace applies. `discover` returns the tests it can find. `run` executes a request and returns results. An optional `collectCoverage` returns line coverage per file.

The context passed to each method has the workspace root, whether it is trusted, the report directory, and three helpers: `readFile`, `findFiles` for a glob under the root, and `execute` for a command. `execute` refuses to spawn in an untrusted workspace, creates the parent directory of `reportPath`, and returns stdout, stderr, and the exit code.

Each test needs a stable `id`, the runner's own `nativeId`, a `label`, and the adapter id. Suite, project, source location, duration, message, and stack are optional. Set `parentId` on a concrete case to nest it under its parameterized parent.

## The rest of the API

The same object has `unregisterAdapter`, `listAdapters`, `ingestJUnit`, `ingestCobertura`, `refresh`, and `run`, which takes one of `workspace`, `file`, `nearest`, `selected`, or `failed`. The types are in [lib/contracts.ts](https://github.com/willibrandon/fresh-test-observatory/blob/main/lib/contracts.ts).
