# Adapter API

Language plugins can contribute discovery and result parsing while Test Observatory owns execution state, filtering, navigation, persistence, and decorations. The exported API is typed through Fresh's plugin registry.

## Register an adapter

```ts
const observatory = editor.getPluginApi("fresh-test-observatory");

observatory?.registerAdapter({
  id: "my-runner",
  label: "My Runner",
  priority: 50,
  detect: (context) => context.readFile("my-runner.toml") !== null,
  discover: async (context) => ({ tests: await discover(context) }),
  run: async (context, request) => runAndParse(context, request),
});
```

## Responsibilities

`detect` decides whether the adapter belongs in a workspace. `discover` returns stable adapter-qualified test IDs and optional source locations. `run` receives an explicit scope and selected tests, then returns parsed results, raw output, and an exit code. `collectCoverage` is optional and returns normalized files with one-based line numbers.

Use `context.findFiles` instead of walking the workspace. Use `context.execute` instead of spawning directly so trust, cancellation, progress, report storage, and terminal mode remain consistent.

## Report ingestion

```ts
observatory?.ingestJUnit(junitXml, "my-runner");
observatory?.ingestCobertura(coberturaXml, editor.getCwd());
```

Replacing or unregistering an adapter removes its stale rows. Report-only rows remain visible but cannot be rerun.
