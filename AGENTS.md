# Repository Guidelines

## Project Structure & Module Organization

`fresh-test-observatory.ts` is the plugin entry point and runtime/UI layer. Keep reusable parsers, adapters, command builders, models, and controller logic in `lib/`. Type declarations live in `types/`; `fresh.d.ts` is generated, while `fresh-compat.d.ts` contains compatibility gaps. Node tests are in `tests/*.test.mts`. The fixture workspace under `fixtures/workspace/` supports .NET, Rust, and Go acceptance testing. Documentation lives in `docs-site/`, and maintenance scripts in `scripts/`.

## Build, Test, and Development Commands

Use Node 24 or newer and Fresh 0.4.10 or newer.

- `npm ci`: install locked root dependencies.
- `npm test`: run the Node test suite.
- `npm run test:coverage`: run tests with Node's experimental coverage report.
- `npm run typecheck`: type-check plugin and test TypeScript projects.
- `npm run format` / `npm run format:check`: apply or verify Prettier formatting.
- `npm run validate`: run formatting, type checks, tests, and Fresh plugin validation.
- `npm run check-types`: verify generated Fresh declarations are current; use `npm run sync-types` after a Fresh upgrade.
- `cd docs-site && npm ci && npm run build`: validate and build the Astro documentation. Use `npm run dev` there for local preview.
- `scripts/acceptance.sh`: exercise the plugin in a real terminal; requires Fresh, Hex1b, and fixture toolchains.

## Coding Style & Naming Conventions

Use TypeScript ESM with explicit `.ts` import extensions and strict compiler settings. Follow `.editorconfig`: UTF-8, LF endings, two-space indentation, final newline, and no trailing whitespace outside Markdown. Prettier is authoritative. Use `camelCase` for values/functions, `PascalCase` for types/classes, and descriptive lowercase module names such as `lib/cobertura.ts`. Keep the QuickJS plugin runtime free of Node globals; Node-specific code belongs in tests or scripts.

## Testing Guidelines

Tests use `node:test` with `node:assert/strict`. Name files `<area>.test.mts` and phrase test names as observable behavior. Add an exact regression test for parser, command-builder, or controller changes. No fixed coverage percentage is enforced; cover success, failure, and malformed-input paths where relevant. Keep fixtures small and never commit generated reports, `bin/`, `obj/`, or `target/` output.

## Commit & Pull Request Guidelines

Recent commits use concise, imperative, sentence-case subjects such as `Harden runtime wiring and terminal results`. Keep each commit focused. Pull requests should explain the user-visible change, identify affected ecosystems, link related issues, and report `npm run validate` plus `npm run check-types`. Include screenshots for dock or documentation UI changes and call out any fixture or generated-type updates.
