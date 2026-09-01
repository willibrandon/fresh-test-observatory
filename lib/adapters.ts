import {
  buildCargoCommand,
  buildCargoDocListCommand,
  buildCargoListCommand,
  discoverRustSourceTests,
  parseCargoList,
  parseCargoRun,
  parseNextestList,
  parseNextestRun,
} from "./cargo.ts";
import { parseCobertura } from "./cobertura.ts";
import type {
  AdapterContext,
  AdapterRunResult,
  CoverageResult,
  DiscoverResult,
  TestCase,
  TestObservatoryAdapter,
} from "./contracts.ts";
import {
  buildDotnetCommand,
  detectDotnetProject,
  discoverDotnetSourceTests,
  findCoverageAttachment,
  parseDotnetConsoleResults,
  parseDotnetListOutput,
  parseTrx,
  type DotnetProject,
} from "./dotnet.ts";
import {
  buildGoCommand,
  discoverGoSourceTests,
  modulePathFromGoMod,
  parseGoCoverProfile,
  parseGoTestJson,
} from "./go.ts";
import { applyRunResults, mergeDiscoveredTests } from "./model.ts";
import { basename, dirname, isWithin, joinPath, resolvePath } from "./path.ts";
import { mergeProcessExitCode } from "./runtime.ts";

export function createBuiltInAdapters(): TestObservatoryAdapter[] {
  return [createDotnetAdapter(), createCargoAdapter(), createGoAdapter()];
}

function createDotnetAdapter(): TestObservatoryAdapter {
  let projects: DotnetProject[] = [];
  const listingCache = new Map<string, { fingerprint: number; tests: TestCase[] }>();

  return {
    id: "dotnet",
    label: ".NET",
    priority: 100,
    async detect(context): Promise<boolean> {
      return (await context.findFiles("**/*.*proj")).some((path) =>
        /\.(?:cs|fs|vb)proj$/i.test(path),
      );
    },
    async discover(context): Promise<DiscoverResult> {
      const diagnostics: string[] = [];
      const projectPaths = (await context.findFiles("**/*.*proj")).filter((path) =>
        /\.(?:cs|fs|vb)proj$/i.test(path),
      );
      projects = projectPaths
        .map((path) => {
          const xml = readEvaluatedProjectText(context, path);
          return xml ? detectDotnetProject(path, xml, readNearestGlobalJson(context, path)) : null;
        })
        .filter((project): project is DotnetProject => Boolean(project?.testProject));

      const sourcePaths = (
        await Promise.all([
          context.findFiles("**/*.cs"),
          context.findFiles("**/*.fs"),
          context.findFiles("**/*.vb"),
        ])
      ).flat();
      let tests: TestCase[] = [];
      for (const project of projects) {
        diagnostics.push(...project.diagnostics.map((message) => `${project.name}: ${message}`));
        const projectRoot = dirname(project.path);
        let projectTests: TestCase[] = [];
        let fingerprint = hashText(JSON.stringify(project));
        for (const path of sourcePaths) {
          if (!isWithin(projectRoot, path)) continue;
          const source = context.readFile(path);
          if (source) {
            fingerprint = hashText(path + "\0" + source, fingerprint);
            projectTests.push(...discoverDotnetSourceTests(path, source, project));
          }
        }
        tests.push(...projectTests);
        if (!context.trusted || project.platform === "unavailable") continue;
        const cached = listingCache.get(project.path);
        if (cached?.fingerprint === fingerprint) {
          tests = mergeWithSourceLocations(tests, cached.tests, project.path);
          continue;
        }
        const spec = buildDotnetCommand(project, {
          action: "list",
          workspaceRoot: context.cwd,
          ...(context.reportDir ? { reportDir: context.reportDir } : {}),
          ...(context.noBuild !== undefined ? { noBuild: context.noBuild } : {}),
          ...(context.noRestore !== undefined ? { noRestore: context.noRestore } : {}),
          ...(context.dotnetVerbosity ? { verbosity: context.dotnetVerbosity } : {}),
        });
        const output = await context.execute(spec);
        if (output.exitCode === 0) {
          const listed = parseDotnetListOutput(`${output.stdout}\n${output.stderr}`, project);
          listingCache.set(project.path, { fingerprint, tests: listed });
          tests = mergeWithSourceLocations(tests, listed, project.path);
        } else {
          diagnostics.push(`${project.name}: discovery command exited ${output.exitCode}`);
        }
      }
      return { tests, ...(diagnostics.length > 0 ? { diagnostics } : {}) };
    },
    async run(context, request): Promise<AdapterRunResult> {
      const diagnostics: string[] = [];
      let results: TestCase[] = [];
      let combinedOutput = "";
      let exitCode = 0;
      for (const project of projects) {
        if (project.platform === "unavailable") continue;
        const selected = request.tests.filter((test) => test.project === project.path);
        if (request.scope !== "workspace" && selected.length === 0) continue;
        const spec = buildDotnetCommand(project, {
          action: "run",
          scope: request.scope,
          tests: selected,
          workspaceRoot: context.cwd,
          ...(context.reportDir ? { reportDir: context.reportDir } : {}),
          ...(context.noBuild !== undefined ? { noBuild: context.noBuild } : {}),
          ...(context.noRestore !== undefined ? { noRestore: context.noRestore } : {}),
          ...(context.dotnetVerbosity ? { verbosity: context.dotnetVerbosity } : {}),
        });
        const output = await context.execute(spec);
        const text = `${output.stdout}\n${output.stderr}`;
        combinedOutput += `${text}\n`;
        exitCode = mergeProcessExitCode(exitCode, output.exitCode);
        const trx = spec.reportPath ? context.readFile(spec.reportPath) : null;
        const parsed = trx ? parseTrx(trx, project) : parseDotnetConsoleResults(text, project);
        const enriched = applyRunResults(selected, alignDotnetResults(selected, parsed), "dotnet");
        results = applyRunResults(results, enriched);
        if (parsed.length === 0)
          diagnostics.push(`${project.name}: no individual results were parsed`);
      }
      return {
        tests: results,
        output: combinedOutput,
        exitCode,
        ...(diagnostics.length > 0 ? { diagnostics } : {}),
      };
    },
    async collectCoverage(context, request): Promise<CoverageResult> {
      const files = [];
      const diagnostics: string[] = [];
      let combinedOutput = "";
      for (const project of projects) {
        if (project.platform === "unavailable") continue;
        const selected = request.tests.filter((test) => test.project === project.path);
        const spec = buildDotnetCommand(project, {
          action: "coverage",
          scope: request.scope,
          tests: selected,
          workspaceRoot: context.cwd,
          ...(context.reportDir ? { reportDir: context.reportDir } : {}),
          ...(context.noBuild !== undefined ? { noBuild: context.noBuild } : {}),
          ...(context.noRestore !== undefined ? { noRestore: context.noRestore } : {}),
          ...(context.dotnetVerbosity ? { verbosity: context.dotnetVerbosity } : {}),
        });
        const output = await context.execute(spec);
        const text = `${output.stdout}\n${output.stderr}`;
        combinedOutput += `${text}\n`;
        const reportPath = spec.reportPath ?? findCoverageAttachment(text);
        const report = reportPath ? context.readFile(reportPath) : null;
        if (report) files.push(...parseCobertura(report, context.cwd));
        else
          diagnostics.push(
            `${project.name}: no Cobertura report was produced; check the project's coverage collector`,
          );
      }
      return {
        files,
        output: combinedOutput,
        ...(diagnostics.length > 0 ? { diagnostics } : {}),
      };
    },
  };
}

function hashText(value: string, seed = 2_166_136_261): number {
  let hash = seed;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function createCargoAdapter(): TestObservatoryAdapter {
  type CargoPackage = { root: string; name: string };

  let nextestAvailable = false;
  let packages: CargoPackage[] = [];
  const rootsByTestId = new Map<string, string>();
  const nextestByRoot = new Map<string, boolean>();

  return {
    id: "cargo",
    label: "Rust",
    priority: 80,
    async detect(context): Promise<boolean> {
      return (await cargoPackages(context)).length > 0;
    },
    async discover(context): Promise<DiscoverResult> {
      packages = await cargoPackages(context);
      rootsByTestId.clear();
      const sourcePaths = await context.findFiles("**/*.rs");
      const diagnostics: string[] = [];
      let tests: TestCase[] = [];
      if (context.trusted && context.preferNextest !== false && packages.length > 0) {
        const probeRoot = packages[0]!.root;
        const cached = nextestByRoot.get(probeRoot);
        if (cached === undefined) {
          const version = await context.execute({
            command: "cargo",
            args: ["nextest", "--version"],
            cwd: probeRoot,
          });
          nextestAvailable = version.exitCode === 0;
          nextestByRoot.set(probeRoot, nextestAvailable);
        } else {
          nextestAvailable = cached;
        }
      } else {
        nextestAvailable = false;
      }
      for (const pkg of packages) {
        let sourceTests: TestCase[] = [];
        let hasDoctests = false;
        for (const path of sourcePaths) {
          if (
            nearestRoot(
              path,
              packages.map((entry) => entry.root),
            ) !== pkg.root
          )
            continue;
          const source = context.readFile(path);
          if (!source) continue;
          if (/^\s*\/\/\/(?:.*```|\s{5}\S)/m.test(source)) hasDoctests = true;
          sourceTests.push(
            ...discoverRustSourceTests(path, source, pkg.root).map((test) =>
              qualifyCargoTest(test, pkg.root, pkg.name),
            ),
          );
        }
        if (!context.trusted) {
          tests.push(...sourceTests);
          continue;
        }
        const output = await context.execute(
          buildCargoListCommand(pkg.root, nextestAvailable, pkg.name),
        );
        const listed = (
          nextestAvailable
            ? parseNextestList(output.stdout)
            : parseCargoList(`${output.stdout}\n${output.stderr}`)
        ).map((test) => qualifyCargoTest(test, pkg.root, pkg.name));
        let doctests: TestCase[] = [];
        if (hasDoctests) {
          const docOutput = await context.execute(buildCargoDocListCommand(pkg.root, pkg.name));
          if (docOutput.exitCode === 0) {
            doctests = parseCargoList(`${docOutput.stdout}\n${docOutput.stderr}`).map((test) => {
              const qualified = qualifyCargoTest(test, pkg.root, pkg.name);
              return qualified.source
                ? {
                    ...qualified,
                    source: {
                      ...qualified.source,
                      path: resolvePath(pkg.root, qualified.source.path),
                    },
                  }
                : qualified;
            });
          }
        }
        const discovered = mergeWithSourceLocations(sourceTests, [...listed, ...doctests]);
        tests.push(...(discovered.length > 0 ? discovered : sourceTests));
        if (output.exitCode !== 0)
          diagnostics.push(`${pkg.name}: Cargo discovery exited ${output.exitCode}`);
      }
      tests = mergeDiscoveredTests([], tests);
      for (const test of tests) {
        const root = packages.find((pkg) => test.id.startsWith(`cargo:${pkg.root}:`))?.root;
        if (root) rootsByTestId.set(test.id, root);
      }
      return {
        tests,
        ...(diagnostics.length > 0 ? { diagnostics } : {}),
      };
    },
    async run(context, request): Promise<AdapterRunResult> {
      let results: TestCase[] = [];
      let combinedOutput = "";
      let exitCode = 0;
      for (const pkg of packages) {
        const selected = request.tests.filter((test) => rootsByTestId.get(test.id) === pkg.root);
        if (selected.length === 0) continue;
        const doctests = selected.filter((test) => test.framework === "rust-doctest");
        const ordinary = selected.filter((test) => test.framework !== "rust-doctest");
        const batches: Array<{ tests: TestCase[]; doctest: boolean }> = [
          ...(ordinary.length === 0
            ? []
            : nextestAvailable
              ? [{ tests: ordinary, doctest: false }]
              : ordinary.map((test) => ({ tests: [test], doctest: false }))),
          ...doctests.map((test) => ({ tests: [test], doctest: true })),
        ];
        for (const item of batches) {
          const batch = item.tests;
          const spec = buildCargoCommand({
            workspaceRoot: pkg.root,
            nextest: nextestAvailable && !item.doctest,
            packageName: pkg.name,
            tests: batch,
            ...(item.doctest ? { doctest: true } : {}),
            ...(context.reportDir ? { reportDir: context.reportDir } : {}),
          });
          const output = await context.execute(spec);
          const text = `${output.stdout}\n${output.stderr}`;
          combinedOutput += `${text}\n`;
          exitCode = mergeProcessExitCode(exitCode, output.exitCode);
          const requested = new Set(batch.map((test) => test.nativeId));
          const parsed = (
            nextestAvailable && !item.doctest ? parseNextestRun(text) : parseCargoRun(text)
          )
            .filter((test) => requested.has(test.nativeId))
            .map((test) => {
              const qualified = qualifyCargoTest(test, pkg.root, pkg.name);
              const candidates = batch.filter(
                (candidate) =>
                  candidate.nativeId === test.nativeId &&
                  (!test.target || !candidate.target || candidate.target === test.target),
              );
              const aligned =
                candidates.length === 1
                  ? {
                      ...qualified,
                      id: candidates[0]!.id,
                      ...(candidates[0]!.target ? { target: candidates[0]!.target } : {}),
                    }
                  : qualified;
              return aligned.source
                ? {
                    ...aligned,
                    source: { ...aligned.source, path: resolvePath(pkg.root, aligned.source.path) },
                  }
                : aligned;
            });
          results = applyRunResults(results, applyRunResults(batch, parsed, "cargo"));
        }
      }
      return {
        tests: results,
        output: combinedOutput,
        exitCode,
      };
    },
    async collectCoverage(context, request): Promise<CoverageResult> {
      const files = [];
      const diagnostics: string[] = [];
      let combinedOutput = "";
      for (const pkg of packages) {
        const selected = request.tests.filter((test) => rootsByTestId.get(test.id) === pkg.root);
        if (selected.length === 0) continue;
        const spec = buildCargoCommand({
          workspaceRoot: pkg.root,
          nextest: nextestAvailable,
          packageName: pkg.name,
          tests: selected,
          coverage: true,
          ...(context.reportDir ? { reportDir: context.reportDir } : {}),
        });
        const output = await context.execute(spec);
        combinedOutput += `${output.stdout}\n${output.stderr}\n`;
        const report = spec.reportPath ? context.readFile(spec.reportPath) : null;
        if (report) files.push(...parseCobertura(report, pkg.root));
        else diagnostics.push(`${pkg.name}: cargo-llvm-cov did not produce a Cobertura report`);
      }
      return {
        files,
        output: combinedOutput,
        ...(diagnostics.length > 0 ? { diagnostics } : {}),
      };
    },
  };
}

function createGoAdapter(): TestObservatoryAdapter {
  type GoModule = { root: string; modulePath: string };

  let modules: GoModule[] = [];
  const rootsByTestId = new Map<string, string>();

  return {
    id: "go",
    label: "Go",
    priority: 70,
    async detect(context): Promise<boolean> {
      return (await goModules(context)).length > 0;
    },
    async discover(context): Promise<DiscoverResult> {
      modules = await goModules(context);
      rootsByTestId.clear();
      const tests: TestCase[] = [];
      for (const path of await context.findFiles("**/*_test.go")) {
        const root = nearestRoot(
          path,
          modules.map((module) => module.root),
        );
        const module = modules.find((entry) => entry.root === root);
        if (!module) continue;
        const source = context.readFile(path);
        if (!source) continue;
        for (const test of discoverGoSourceTests(path, source, module.root, module.modulePath)) {
          const qualified = qualifyGoTest(test, module.root);
          tests.push(qualified);
          rootsByTestId.set(qualified.id, module.root);
        }
      }
      return { tests };
    },
    async run(context, request): Promise<AdapterRunResult> {
      let results: TestCase[] = [];
      let combinedOutput = "";
      let exitCode = 0;
      for (const module of modules) {
        const selected = request.tests.filter((test) => rootsByTestId.get(test.id) === module.root);
        if (selected.length === 0) continue;
        // Go's slash-separated -run syntax cannot express an arbitrary set
        // of subtests without also selecting their cross-product. Run each
        // requested subtest independently to retain exact selection.
        const batches = selected.some((test) => test.nativeId.includes("/"))
          ? selected.map((test) => [test])
          : [selected];
        for (const batch of batches) {
          const output = await context.execute(
            buildGoCommand(module.root, batch, false, context.reportDir),
          );
          const text = `${output.stdout}\n${output.stderr}`;
          combinedOutput += `${text}\n`;
          exitCode = mergeProcessExitCode(exitCode, output.exitCode);
          const parsed = parseGoTestJson(text).map((test) =>
            alignGoFailureSource(module.root, batch, qualifyGoTest(test, module.root)),
          );
          results = applyRunResults(results, applyRunResults(batch, parsed, "go"));
        }
      }
      return {
        tests: results,
        output: combinedOutput,
        exitCode,
      };
    },
    async collectCoverage(context, request): Promise<CoverageResult> {
      const files = [];
      const diagnostics: string[] = [];
      let combinedOutput = "";
      for (const module of modules) {
        const selected = request.tests.filter((test) => rootsByTestId.get(test.id) === module.root);
        if (selected.length === 0) continue;
        const spec = buildGoCommand(module.root, selected, true, context.reportDir);
        const output = await context.execute(spec);
        combinedOutput += `${output.stdout}\n${output.stderr}\n`;
        const profile = spec.reportPath ? context.readFile(spec.reportPath) : null;
        if (profile) files.push(...parseGoCoverProfile(profile, module.root, module.modulePath));
        else diagnostics.push(`${module.modulePath}: go test did not produce a coverage profile`);
      }
      return {
        files,
        output: combinedOutput,
        ...(diagnostics.length > 0 ? { diagnostics } : {}),
      };
    },
  };
}

async function cargoPackages(
  context: AdapterContext,
): Promise<Array<{ root: string; name: string }>> {
  const packages = [];
  for (const path of await manifestPaths(context, "Cargo.toml")) {
    const manifest = context.readFile(path);
    const name = manifest ? cargoPackageName(manifest) : undefined;
    if (name) packages.push({ root: dirname(path), name });
  }
  return packages;
}

async function goModules(
  context: AdapterContext,
): Promise<Array<{ root: string; modulePath: string }>> {
  const modules = [];
  for (const path of await manifestPaths(context, "go.mod")) {
    const manifest = context.readFile(path);
    const modulePath = manifest ? modulePathFromGoMod(manifest) : undefined;
    if (modulePath) modules.push({ root: dirname(path), modulePath });
  }
  return modules;
}

async function manifestPaths(context: AdapterContext, name: string): Promise<string[]> {
  const rootManifest = joinPath(context.cwd, name);
  const matches = await context.findFiles(`**/${name}`);
  if (typeof context.readFile(rootManifest) === "string") matches.push(rootManifest);
  return [...new Set(matches)].filter((path) => typeof context.readFile(path) === "string").sort();
}

function nearestRoot(path: string, roots: readonly string[]): string | undefined {
  return roots
    .filter((root) => isWithin(root, path))
    .sort((left, right) => right.length - left.length)[0];
}

function cargoPackageName(manifest: string): string | undefined {
  let inPackageSection = false;
  for (const line of manifest.split(/\r?\n/)) {
    const section = line.match(/^\s*\[([^\]]+)\]\s*$/)?.[1];
    if (section) {
      inPackageSection = section === "package";
      continue;
    }
    if (!inPackageSection) continue;
    const name = line.match(/^\s*name\s*=\s*["']([^"']+)["']/)?.[1];
    if (name) return name;
  }
  return undefined;
}

function qualifyCargoTest(test: TestCase, root: string, packageName: string): TestCase {
  const qualified: TestCase = {
    ...test,
    id: `cargo:${root}:${test.target ? test.target + ":" : ""}${test.nativeId}`,
    project: test.project ?? packageName,
  };
  if (!test.project) qualified.suite = [packageName, ...(test.suite ?? [])];
  return qualified;
}

function qualifyGoTest(test: TestCase, root: string): TestCase {
  return {
    ...test,
    id: `go:${root}:${test.project ?? "package"}:${test.nativeId}`,
    ...(test.parentId ? { parentId: `go:${root}:${test.parentId.slice("go:".length)}` } : {}),
  };
}

/** Finds the global.json that the .NET SDK will apply to a nested project. */
function readNearestGlobalJson(context: AdapterContext, projectPath: string): string | null {
  let directory = dirname(projectPath);
  while (isWithin(context.cwd, directory)) {
    const content = context.readFile(joinPath(directory, "global.json"));
    if (content) return content;
    if (directory === context.cwd) break;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return null;
}

/**
 * Directory.Build.props is evaluated before the project, while targets are
 * evaluated after it. Concatenating in that order lets the pure detector apply
 * the same last-applicable-value rule for the runner properties it recognizes.
 */
function readEvaluatedProjectText(context: AdapterContext, projectPath: string): string {
  const chunks: string[] = [];
  const ancestors: string[] = [];
  let directory = dirname(projectPath);
  while (isWithin(context.cwd, directory)) {
    ancestors.unshift(directory);
    if (directory === context.cwd) break;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  for (const ancestor of ancestors) {
    for (const name of ["Directory.Packages.props", "Directory.Build.props"]) {
      const content = context.readFile(joinPath(ancestor, name));
      if (content) chunks.push(content);
    }
  }
  const project = context.readFile(projectPath);
  if (project) chunks.push(project);
  for (const ancestor of [...ancestors].reverse()) {
    const content = context.readFile(joinPath(ancestor, "Directory.Build.targets"));
    if (content) chunks.push(content);
  }
  return chunks.join("\n");
}

function mergeWithSourceLocations(
  sourceTests: readonly TestCase[],
  listedTests: readonly TestCase[],
  project?: string,
): TestCase[] {
  if (listedTests.length === 0) return [...sourceTests];
  const relevantSources = project
    ? sourceTests.filter((test) => test.project === project)
    : [...sourceTests];
  if (listedTests.some((test) => test.adapterId !== "dotnet")) {
    const enriched = listedTests.map((listed) => {
      const sourceMatches = relevantSources.filter(
        (candidate) =>
          candidate.adapterId === listed.adapterId &&
          (candidate.nativeId === listed.nativeId || listed.nativeId.endsWith(candidate.nativeId)),
      );
      const listedTarget = listed.target;
      const targetMatches = listedTarget
        ? sourceMatches.filter((candidate) => targetsAlign(candidate.target, listedTarget))
        : [];
      const source =
        targetMatches.length === 1
          ? targetMatches[0]
          : sourceMatches.length === 1
            ? sourceMatches[0]
            : undefined;
      return source
        ? {
            ...listed,
            id: source.id,
            ...(source.source ? { source: source.source } : {}),
            ...(!listed.suite && source.suite ? { suite: source.suite } : {}),
          }
        : listed;
    });
    const enrichedIds = new Set(enriched.map((test) => test.id));
    return mergeDiscoveredTests(
      [],
      [...sourceTests.filter((source) => !enrichedIds.has(source.id)), ...enriched],
    );
  }
  const consumedSources = new Set<string>();
  const enriched = listedTests.flatMap((listed) => {
    const listedBase = dotnetBaseName(listed.nativeId);
    const exact = relevantSources.filter((candidate) => candidate.nativeId === listedBase);
    const suffix =
      exact.length > 0
        ? []
        : relevantSources.filter(
            (candidate) =>
              listedBase.endsWith(`.${candidate.nativeId}`) ||
              candidate.nativeId.endsWith(`.${listedBase}`),
          );
    const method = listedBase.split(".").at(-1);
    const methodMatches =
      exact.length > 0 || suffix.length > 0
        ? []
        : relevantSources.filter((candidate) => candidate.nativeId.split(".").at(-1) === method);
    const candidates = exact.length > 0 ? exact : suffix.length > 0 ? suffix : methodMatches;
    const source = candidates.length === 1 ? candidates[0] : undefined;
    // VSTest can emit only a method display name. When more than one source
    // method has that name, retaining the bare row creates a third fake test.
    if (!source) return candidates.length > 1 && !listedBase.includes(".") ? [] : [listed];
    const parameters = listed.nativeId.slice(listedBase.length);
    const listedIsQualified = listedBase.includes(".");
    const nativeId = listedIsQualified ? listed.nativeId : `${source.nativeId}${parameters}`;
    const parameterized = parameters.length > 0;
    if (!parameterized) consumedSources.add(source.id);
    const result: TestCase = {
      ...listed,
      id: `dotnet:${listed.project ?? source.project}:${nativeId}`,
      nativeId,
      ...(parameterized ? { parentId: source.id } : {}),
    };
    if (source.status === "skipped") result.status = "skipped";
    if (source.source) result.source = source.source;
    if (!listed.suite && source.suite) result.suite = source.suite;
    return [result];
  });
  const untouched = sourceTests.filter(
    (source) => (project && source.project !== project) || !consumedSources.has(source.id),
  );
  return mergeDiscoveredTests([], [...untouched, ...enriched]);
}

function targetsAlign(source: string | undefined, runner: string): boolean {
  if (!source) return false;
  if (source === runner) return true;
  const sourceName = source.startsWith("integration:")
    ? source.slice("integration:".length)
    : source.split("::").at(-1)!;
  return runner === sourceName || runner.endsWith(`::${sourceName}`);
}

/**
 * Native MTP listings can contain display names while TRX definitions contain
 * fully qualified names. Align unique display-name matches before applying the
 * result so parameterized rows do not appear twice in the panel.
 */
function alignDotnetResults(
  discovered: readonly TestCase[],
  results: readonly TestCase[],
): TestCase[] {
  const aligned = results.map((result) => {
    const exact = discovered.find((test) => test.id === result.id);
    if (exact) {
      return {
        ...result,
        ...(exact.parentId ? { parentId: exact.parentId } : {}),
        ...(!result.source && exact.source ? { source: exact.source } : {}),
        ...(!result.suite && exact.suite ? { suite: exact.suite } : {}),
      };
    }
    const nativeMatches = discovered.filter(
      (test) => test.project === result.project && test.nativeId === result.nativeId,
    );
    if (nativeMatches.length === 1) return alignTestIdentity(result, nativeMatches[0]!);
    const resultBase = dotnetBaseName(result.nativeId);
    const parentMatches = discovered.filter(
      (test) =>
        test.project === result.project &&
        dotnetBaseName(test.nativeId) === resultBase &&
        !test.parentId,
    );
    if (parentMatches.length === 1 && result.nativeId !== parentMatches[0]!.nativeId) {
      const parent = parentMatches[0]!;
      return {
        ...result,
        id: `dotnet:${result.project}:${result.nativeId}`,
        parentId: parent.id,
        ...(!result.source && parent.source ? { source: parent.source } : {}),
        ...(!result.suite && parent.suite ? { suite: parent.suite } : {}),
      };
    }
    const labelMatches = discovered.filter(
      (test) => test.project === result.project && test.label === result.label,
    );
    return labelMatches.length === 1 ? alignTestIdentity(result, labelMatches[0]!) : result;
  });
  const childrenByParent = new Map<string, TestCase[]>();
  for (const result of aligned) {
    if (!result.parentId) continue;
    const children = childrenByParent.get(result.parentId) ?? [];
    children.push(result);
    childrenByParent.set(result.parentId, children);
  }
  const parents = discovered.flatMap((parent) => {
    const children = childrenByParent.get(parent.id);
    if (!children || children.length === 0) return [];
    const worst = [...children].sort(
      (left, right) => testStatusRank(right.status) - testStatusRank(left.status),
    )[0]!;
    const durationMs = children.reduce((total, child) => total + (child.durationMs ?? 0), 0);
    return [
      {
        ...parent,
        status: worst.status,
        ...(durationMs > 0 ? { durationMs } : {}),
        ...(worst.message ? { message: worst.message } : {}),
        ...(worst.stack ? { stack: worst.stack } : {}),
      },
    ];
  });
  return [...parents, ...aligned];
}

function dotnetBaseName(nativeId: string): string {
  return nativeId.replace(/\s*\(.*\)$/, "");
}

function testStatusRank(status: TestCase["status"]): number {
  return status === "failed"
    ? 6
    : status === "running"
      ? 5
      : status === "queued"
        ? 4
        : status === "skipped"
          ? 3
          : status === "passed"
            ? 2
            : 1;
}

function alignTestIdentity(result: TestCase, discovered: TestCase): TestCase {
  return {
    ...result,
    id: discovered.id,
    nativeId: discovered.nativeId,
    ...(!result.source && discovered.source ? { source: discovered.source } : {}),
  };
}

function alignGoFailureSource(
  workspaceRoot: string,
  discovered: readonly TestCase[],
  result: TestCase,
): TestCase {
  if (!result.source) return result;
  const match = discovered.find(
    (test) =>
      test.id === result.id ||
      (test.project === result.project && test.nativeId === result.nativeId),
  );
  const path =
    match?.source && basename(match.source.path) === basename(result.source.path)
      ? match.source.path
      : resolvePath(workspaceRoot, result.source.path);
  return { ...result, source: { ...result.source, path } };
}
