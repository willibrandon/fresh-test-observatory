# Contributing

Use Node 24 or newer and Fresh 0.4.10 or newer. Install dependencies with <code>npm ci</code>, then run <code>npm run validate</code>.

The plugin runtime is QuickJS. Root TypeScript compilation therefore has no Node globals. Tests and development scripts use their own Node-aware project. <code>lib/package.json</code> marks pure library modules as ESM for Node's TypeScript test runner; it is not Fresh package metadata.

Fresh generates the canonical runtime declarations under its config directory. Run <code>npm run sync-types</code> after upgrading Fresh and commit the resulting <code>types/fresh.d.ts</code> change. <code>types/fresh-compat.d.ts</code> should contain only gaps in the generated bundle.

Pure parsers, command builders, and controller behavior belong under <code>lib/</code> with an exact regression test. UI acceptance must drive a real Fresh terminal through <code>scripts/acceptance.sh</code>; it should not inspect plugin internals.

The fixture workspace intentionally combines .NET, Rust, and Go. Keep it small enough for repeated local runs and do not commit generated reports or build output.
