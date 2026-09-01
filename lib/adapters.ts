import {
  buildCargoCommand,
  buildCargoDocListCommand,
  buildCargoListCommand,
  buildCargoLocateWorkspaceCommand,
  discoverRustSourceTests,
  parseCargoList,
  parseCargoRun,
  parseCargoStatusLine,
  parseNextestList,
  parseNextestRun,
  parseNextestStatusLine,
} from "./cargo.ts";
import { parseCobertura } from "./cobertura.ts";
import type {
  AdapterContext,
  AdapterRunResult,
  CoverageResult,
  DiscoverResult,
  ProcessOutput,
  TestCase,
  TestObservatoryAdapter,
} from "./contracts.ts";
import {
  buildDotnetBuildCommand,
  buildDotnetCommand,
  detectDotnetProject,
  discoverDotnetSourceTests,
  findCoverageAttachment,
  parseDotnetConsoleResults,
  parseDotnetListOutput,
  parseDotnetProgressLine,
  parseTrx,
  type DotnetCommandOptions,
  type DotnetProject,
} from "./dotnet.ts";
import {
  buildGoCommand,
  discoverGoSourceTests,
  modulePathFromGoMod,
  parseGoCoverProfile,
  parseGoStatusLine,
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
  /** Bumped when parsing changes so stale caches from older builds are discarded. */
  const LISTING_CACHE_VERSION = 2;
  const listingCache = new Map<string, { fingerprint: number; tests: TestCase[] }>();
  let listingCacheLoadedFrom: string | undefined;

  /** The runner listing survives editor restarts so an unchanged project never rebuilds. */
  function listingCachePath(context: AdapterContext): string | undefined {
    const directory = context.cacheDir ?? context.reportDir;
    return directory ? joinPath(directory, "dotnet-listings.json") : undefined;
  }

  function loadListingCache(context: AdapterContext): void {
    const path = listingCachePath(context);
    if (!path || listingCacheLoadedFrom === path) return;
    listingCacheLoadedFrom = path;
    const text = context.readFile(path);
    if (!text) return;
    try {
      const parsed = JSON.parse(text) as {
        version?: number;
        projects?: Record<string, { fingerprint: number; tests: TestCase[] }>;
      };
      if (parsed.version !== LISTING_CACHE_VERSION || !parsed.projects) return;
      for (const [project, entry] of Object.entries(parsed.projects)) {
        if (typeof entry?.fingerprint === "number" && Array.isArray(entry.tests)) {
          listingCache.set(project, entry);
        }
      }
    } catch {
      // An unreadable cache only costs one listing.
    }
  }

  function saveListingCache(context: AdapterContext): void {
    const path = listingCachePath(context);
    if (!path || !context.writeFile) return;
    context.writeFile(
      path,
      JSON.stringify({
        version: LISTING_CACHE_VERSION,
        projects: Object.fromEntries(listingCache),
      }),
    );
  }
  const restoredTargets = new Set<string>();

  function commandOptions(
    context: AdapterContext,
    action: DotnetCommandOptions["action"],
    extra: Partial<DotnetCommandOptions> = {},
  ): DotnetCommandOptions {
    return {
      action,
      workspaceRoot: context.cwd,
      ...(context.reportDir ? { reportDir: context.reportDir } : {}),
      ...(context.noBuild !== undefined ? { noBuild: context.noBuild } : {}),
      ...(context.noRestore !== undefined ? { noRestore: context.noRestore } : {}),
      ...(context.dotnetVerbosity ? { verbosity: context.dotnetVerbosity } : {}),
      ...extra,
    };
  }

  /**
   * Builds every project that needs it with one `dotnet build` per solution or
   * project, so the later `dotnet test --no-build` calls skip MSBuild almost
   * entirely. `--no-restore` is tried first because a restore costs more than
   * the incremental build; the build repeats with a restore only when the SDK
   * asks for one.
   */
  async function build(
    context: AdapterContext,
    pending: readonly DotnetProject[],
  ): Promise<{ ok: Set<string>; output: string }> {
    const ok = new Set<string>();
    if (pending.length === 0) return { ok, output: "" };
    if (context.noBuild) {
      for (const project of pending) ok.add(project.path);
      return { ok, output: "" };
    }
    // Build exactly what `dotnet test` would: each test project and its
    // references. A whole-solution build drags in unrelated projects, whose
    // failures or outputs can break the test projects.
    const targets = pending.map((project) => ({ target: project.path, projects: [project] }));
    let output = "";
    for (const item of targets) {
      const label = `Building ${item.projects[0]!.name}`;
      context.progress?.(label);
      let result = await context.execute({
        ...buildDotnetBuildCommand(item.target, { label, noRestore: true }),
        onLine: () => {},
      });
      if (result.exitCode !== 0 && !context.noRestore && needsRestore(result)) {
        result = await context.execute({
          ...buildDotnetBuildCommand(item.target, { label }),
          onLine: () => {},
        });
      }
      output += `${result.stdout}\n${result.stderr}\n`;
      if (result.exitCode === 0) {
        restoredTargets.add(item.target);
        for (const project of item.projects) ok.add(project.path);
      }
    }
    return { ok, output };
  }

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
      const fingerprints = new Map<string, number>();
      let tests: TestCase[] = [];
      let scanned = 0;
      for (const project of projects) {
        diagnostics.push(...project.diagnostics.map((message) => `${project.name}: ${message}`));
        const projectRoot = dirname(project.path);
        let fingerprint = hashText(JSON.stringify(project));
        for (const path of sourcePaths) {
          if (!isWithin(projectRoot, path)) continue;
          const source = context.readFile(path);
          if (source) {
            fingerprint = hashText(path + "\0" + source, fingerprint);
            tests.push(...discoverDotnetSourceTests(path, source, project));
            if (++scanned % SCAN_YIELD_EVERY === 0) await context.yieldToEditor?.();
          }
        }
        fingerprints.set(project.path, fingerprint);
      }
      // The source scan is enough to draw the tree; runner listings refine it.
      context.report?.({ tests: [...tests] });
      if (!context.trusted) return { tests, ...(diagnostics.length > 0 ? { diagnostics } : {}) };

      loadListingCache(context);
      const pending: DotnetProject[] = [];
      for (const project of projects) {
        if (project.platform === "unavailable") continue;
        const cached = listingCache.get(project.path);
        if (cached && cached.fingerprint === fingerprints.get(project.path)) {
          tests = mergeWithSourceLocations(tests, cached.tests, project.path);
        } else {
          pending.push(project);
        }
      }
      if (pending.length === 0) {
        return { tests, ...(diagnostics.length > 0 ? { diagnostics } : {}) };
      }
      context.report?.({ tests: [...tests] });
      const built = await build(context, pending);
      context.progress?.(
        pending.length === 1
          ? `Listing ${pending[0]!.name}`
          : `Listing ${pending.length} .NET test projects`,
      );
      await Promise.all(
        pending.map(async (project) => {
          if (context.cancelled?.()) return;
          const output = await context.execute(
            buildDotnetCommand(
              project,
              commandOptions(context, "list", { noBuild: built.ok.has(project.path) }),
            ),
          );
          if (output.exitCode === 0) {
            const listed = parseDotnetListOutput(`${output.stdout}\n${output.stderr}`, project);
            listingCache.set(project.path, {
              fingerprint: fingerprints.get(project.path)!,
              tests: listed,
            });
            saveListingCache(context);
            tests = mergeWithSourceLocations(tests, listed, project.path);
            context.report?.({ tests: [...tests] });
          } else if (!context.cancelled?.()) {
            diagnostics.push(
              `${project.name}: discovery command exited ${output.exitCode}: ${firstErrorLine(`${output.stdout}\n${output.stderr}`)}`,
            );
          }
        }),
      );
      return { tests, ...(diagnostics.length > 0 ? { diagnostics } : {}) };
    },
    async run(context, request): Promise<AdapterRunResult> {
      const diagnostics: string[] = [];
      let results: TestCase[] = [];
      let combinedOutput = "";
      let exitCode = 0;
      const targets = projects.filter((project) => {
        if (project.platform === "unavailable") return false;
        const selected = request.tests.filter((test) => test.project === project.path);
        return request.scope === "workspace" || selected.length > 0;
      });
      const built = await build(context, targets);
      combinedOutput += built.output;
      for (const project of targets) {
        if (context.cancelled?.()) break;
        const selected = request.tests.filter((test) => test.project === project.path);
        const spec = buildDotnetCommand(
          project,
          commandOptions(context, "run", {
            scope: request.scope,
            tests: selected,
            noBuild: built.ok.has(project.path) || context.noBuild === true,
          }),
        );
        context.progress?.(`Running ${project.name}`);
        const output = await context.execute({
          ...spec,
          onLine: (line) => {
            const progress = parseDotnetProgressLine(line);
            if (!progress) return;
            const match = matchDotnetTest(selected, progress.displayName);
            if (match) {
              context.update?.({
                ...match,
                status: progress.status,
                ...(progress.durationMs !== undefined ? { durationMs: progress.durationMs } : {}),
              });
            }
          },
        });
        const text = `${output.stdout}\n${output.stderr}`;
        combinedOutput += `${text}\n`;
        exitCode = mergeProcessExitCode(exitCode, output.exitCode);
        const trx = spec.reportPath ? context.readFile(spec.reportPath) : null;
        const parsed = trx ? parseTrx(trx, project) : parseDotnetConsoleResults(text, project);
        const enriched = applyRunResults(selected, alignDotnetResults(selected, parsed), "dotnet");
        results = applyRunResults(results, enriched);
        if (parsed.length === 0 && !context.cancelled?.())
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
      const targets = projects.filter((project) => project.platform !== "unavailable");
      const built = await build(context, targets);
      combinedOutput += built.output;
      for (const project of targets) {
        if (context.cancelled?.()) break;
        const selected = request.tests.filter((test) => test.project === project.path);
        const spec = buildDotnetCommand(
          project,
          commandOptions(context, "coverage", {
            scope: request.scope,
            tests: selected,
            noBuild: built.ok.has(project.path) || context.noBuild === true,
          }),
        );
        context.progress?.(`Collecting coverage for ${project.name}`);
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

/** The line a person would quote from a failed command: its first error, else its last line. */
function firstErrorLine(text: string): string {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const error =
    lines.find((line) => /\berror\b(?!\s*output)|exception occurred|not found/i.test(line)) ??
    lines.at(-1) ??
    "no output";
  // MSBuild prefixes errors with the file, line, and task; keep the message.
  const message = error.replace(/^.*?:\s*(?=error\b)/i, "");
  return message.length > 200 ? `${message.slice(0, 197)}...` : message;
}

function needsRestore(output: ProcessOutput): boolean {
  return /NETSDK1004|NU1\d{3}|project\.assets\.json|Run a NuGet package restore|--no-restore/i.test(
    `${output.stdout}\n${output.stderr}`,
  );
}

/** Finds the discovered row a runner's display name refers to, parameterized cases included. */
function matchDotnetTest(selected: readonly TestCase[], displayName: string): TestCase | undefined {
  const exact = selected.filter(
    (test) => test.label === displayName || test.nativeId === displayName,
  );
  if (exact.length === 1) return exact[0];
  const suffix = selected.filter((test) => displayName.endsWith(`.${test.nativeId}`));
  if (suffix.length === 1) return suffix[0];
  const base = displayName.replace(/\s*\(.*\)$/, "");
  const parents = selected.filter(
    (test) => !test.parentId && (test.label === base || test.nativeId.endsWith(`.${base}`)),
  );
  return parents.length === 1 ? parents[0] : undefined;
}

/** Source files scanned between two chances for the editor to render. */
const SCAN_YIELD_EVERY = 8;

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
  const workspaceByPackageRoot = new Map<string, string>();

  async function workspaceRootFor(context: AdapterContext, pkg: CargoPackage): Promise<string> {
    const cached = workspaceByPackageRoot.get(pkg.root);
    if (cached) return cached;
    const output = await context.execute(buildCargoLocateWorkspaceCommand(pkg.root));
    const manifest = output.stdout.trim().split(/\r?\n/).at(-1)?.trim();
    const root =
      output.exitCode === 0 && manifest && /Cargo\.toml$/.test(manifest)
        ? dirname(manifest)
        : pkg.root;
    workspaceByPackageRoot.set(pkg.root, root);
    return root;
  }

  function streamCargoResults(
    context: AdapterContext,
    batch: readonly TestCase[],
    nextest: boolean,
  ): (line: string) => void {
    return (line) => {
      const status = nextest ? parseNextestStatusLine(line) : parseCargoStatusLine(line);
      if (!status) return;
      const candidates = batch.filter(
        (test) =>
          test.nativeId === status.nativeId &&
          (!status.target || !test.target || targetsAlign(test.target, status.target)),
      );
      if (candidates.length !== 1) return;
      context.update?.({
        ...candidates[0]!,
        status: status.status,
        ...(status.durationMs !== undefined ? { durationMs: status.durationMs } : {}),
      });
    };
  }

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
      const sourceTestsByPackage = new Map<string, TestCase[]>();
      const doctestPackages = new Set<string>();
      const testMarkedPackages = new Set<string>();
      const roots = packages.map((entry) => entry.root);
      for (const pkg of packages) sourceTestsByPackage.set(pkg.root, []);
      let scanned = 0;
      for (const path of sourcePaths) {
        const root = nearestRoot(path, roots);
        const pkg = packages.find((entry) => entry.root === root);
        if (!pkg) continue;
        const source = context.readFile(path);
        if (!source) continue;
        if (++scanned % SCAN_YIELD_EVERY === 0) await context.yieldToEditor?.();
        if (/^\s*\/\/\/(?:.*```|\s{5}\S)/m.test(source)) doctestPackages.add(pkg.root);
        if (
          /#\s*\[\s*(?:cfg\s*\(\s*test\s*\)|test\b|rstest\b|test_case\b|tokio::test\b)/.test(source)
        ) {
          testMarkedPackages.add(pkg.root);
        }
        sourceTestsByPackage
          .get(pkg.root)!
          .push(
            ...discoverRustSourceTests(path, source, pkg.root).map((test) =>
              qualifyCargoTest(test, pkg.root, pkg.name),
            ),
          );
      }
      const allSourceTests = [...sourceTestsByPackage.values()].flat();
      context.report?.({ tests: mergeDiscoveredTests([], allSourceTests) });
      // A crate with no test attribute, test directory, or doctest anywhere in
      // its sources has nothing to list; compiling it would only cost time.
      packages = packages.filter(
        (pkg) =>
          (sourceTestsByPackage.get(pkg.root)?.length ?? 0) > 0 ||
          doctestPackages.has(pkg.root) ||
          testMarkedPackages.has(pkg.root),
      );

      let tests: TestCase[] = [];
      if (!context.trusted || packages.length === 0) {
        tests = allSourceTests;
      } else {
        if (context.preferNextest !== false) {
          const probeRoot = packages[0]!.root;
          const cached = nextestByRoot.get(probeRoot);
          if (cached === undefined) {
            const version = await context.execute({
              command: "cargo",
              args: ["nextest", "--version"],
              cwd: probeRoot,
              label: "Checking for cargo-nextest",
            });
            nextestAvailable = version.exitCode === 0;
            nextestByRoot.set(probeRoot, nextestAvailable);
          } else {
            nextestAvailable = cached;
          }
        } else {
          nextestAvailable = false;
        }

        // Packages in one Cargo workspace are listed together: one compilation
        // instead of one per package.
        const workspaces = new Map<string, CargoPackage[]>();
        for (const pkg of packages) {
          const workspace = nextestAvailable ? await workspaceRootFor(context, pkg) : pkg.root;
          const members = workspaces.get(workspace) ?? [];
          members.push(pkg);
          workspaces.set(workspace, members);
        }
        const listedByPackage = new Map<string, TestCase[]>();
        let index = 0;
        for (const [workspace, members] of workspaces) {
          index += 1;
          context.progress?.(
            members.length === 1
              ? `Listing Rust tests in ${members[0]!.name}`
              : `Listing Rust tests in ${basename(workspace)} (${members.length} packages, ${index}/${workspaces.size})`,
          );
          if (nextestAvailable) {
            const output = await context.execute(
              buildCargoListCommand(
                workspace,
                true,
                members.length === 1 ? members[0]!.name : undefined,
              ),
            );
            if (output.exitCode !== 0) {
              diagnostics.push(`${basename(workspace)}: Cargo discovery exited ${output.exitCode}`);
            }
            const byName = new Map(members.map((pkg) => [pkg.name, pkg]));
            for (const listed of parseNextestList(output.stdout)) {
              const pkg = listed.project ? byName.get(listed.project) : undefined;
              if (!pkg) continue;
              const bucket = listedByPackage.get(pkg.root) ?? [];
              bucket.push(qualifyCargoTest(listed, pkg.root, pkg.name));
              listedByPackage.set(pkg.root, bucket);
            }
          } else {
            for (const pkg of members) {
              const output = await context.execute(
                buildCargoListCommand(pkg.root, false, pkg.name),
              );
              if (output.exitCode !== 0) {
                diagnostics.push(`${pkg.name}: Cargo discovery exited ${output.exitCode}`);
              }
              listedByPackage.set(
                pkg.root,
                parseCargoList(`${output.stdout}\n${output.stderr}`).map((test) =>
                  qualifyCargoTest(test, pkg.root, pkg.name),
                ),
              );
            }
          }
          for (const pkg of members) {
            let doctests: TestCase[] = [];
            if (doctestPackages.has(pkg.root)) {
              const docOutput = await context.execute(buildCargoDocListCommand(pkg.root, pkg.name));
              if (docOutput.exitCode === 0) {
                doctests = parseCargoList(`${docOutput.stdout}\n${docOutput.stderr}`).map(
                  (test) => {
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
                  },
                );
              }
            }
            const sourceTests = sourceTestsByPackage.get(pkg.root) ?? [];
            const discovered = mergeWithSourceLocations(sourceTests, [
              ...(listedByPackage.get(pkg.root) ?? []),
              ...doctests,
            ]);
            tests.push(...(discovered.length > 0 ? discovered : sourceTests));
          }
          const listedRoots = new Set(tests.map((test) => rootOf(test, packages)));
          context.report?.({
            tests: mergeDiscoveredTests(
              [],
              [
                ...tests,
                ...packages
                  .filter((pkg) => !listedRoots.has(pkg.root))
                  .flatMap((pkg) => sourceTestsByPackage.get(pkg.root) ?? []),
              ],
            ),
          });
        }
      }
      tests = mergeDiscoveredTests([], tests);
      for (const test of tests) {
        const root = rootOf(test, packages);
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
        if (context.cancelled?.()) break;
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
          const nextest = nextestAvailable && !item.doctest;
          const spec = buildCargoCommand({
            workspaceRoot: pkg.root,
            nextest,
            packageName: pkg.name,
            tests: batch,
            ...(item.doctest ? { doctest: true } : {}),
            ...(context.reportDir ? { reportDir: context.reportDir } : {}),
          });
          context.progress?.(spec.label ?? `Running Rust tests in ${pkg.name}`);
          const output = await context.execute({
            ...spec,
            onLine: streamCargoResults(context, batch, nextest),
          });
          const text = `${output.stdout}\n${output.stderr}`;
          combinedOutput += `${text}\n`;
          exitCode = mergeProcessExitCode(exitCode, output.exitCode);
          const requested = new Set(batch.map((test) => test.nativeId));
          const parsed = (nextest ? parseNextestRun(text) : parseCargoRun(text))
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
        if (context.cancelled?.()) break;
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
        context.progress?.(spec.label ?? `Collecting Rust coverage for ${pkg.name}`);
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

function rootOf(test: TestCase, packages: readonly { root: string }[]): string | undefined {
  return packages.find((pkg) => test.id.startsWith(`cargo:${pkg.root}:`))?.root;
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
      let scanned = 0;
      for (const path of await context.findFiles("**/*_test.go")) {
        const root = nearestRoot(
          path,
          modules.map((module) => module.root),
        );
        const module = modules.find((entry) => entry.root === root);
        if (!module) continue;
        const source = context.readFile(path);
        if (!source) continue;
        if (++scanned % SCAN_YIELD_EVERY === 0) await context.yieldToEditor?.();
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
        if (context.cancelled?.()) break;
        const selected = request.tests.filter((test) => rootsByTestId.get(test.id) === module.root);
        if (selected.length === 0) continue;
        // Go's slash-separated -run syntax cannot express an arbitrary set
        // of subtests without also selecting their cross-product. Run each
        // requested subtest independently to retain exact selection.
        const batches = selected.some((test) => test.nativeId.includes("/"))
          ? selected.map((test) => [test])
          : [selected];
        for (const batch of batches) {
          const spec = buildGoCommand(module.root, batch, false, context.reportDir);
          context.progress?.(`Running Go tests in ${module.modulePath}`);
          const output = await context.execute({
            ...spec,
            onLine: (line) => {
              const status = parseGoStatusLine(line);
              if (!status) return;
              const candidates = batch.filter(
                (test) => test.nativeId === status.nativeId && test.project === status.packagePath,
              );
              if (candidates.length !== 1) return;
              context.update?.({
                ...candidates[0]!,
                status: status.status,
                ...(status.durationMs !== undefined ? { durationMs: status.durationMs } : {}),
              });
            },
          });
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
        if (context.cancelled?.()) break;
        const selected = request.tests.filter((test) => rootsByTestId.get(test.id) === module.root);
        if (selected.length === 0) continue;
        const spec = buildGoCommand(module.root, selected, true, context.reportDir);
        context.progress?.(`Collecting Go coverage for ${module.modulePath}`);
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
            ...(source.suite ? { suite: source.suite } : {}),
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
    if (source.suite) result.suite = source.suite;
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
        ...(exact.suite ? { suite: exact.suite } : {}),
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
        ...(parent.suite ? { suite: parent.suite } : {}),
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
  // Arguments may contain newlines; `.` must not stop at them or the case
  // never finds its parent method.
  return nativeId.replace(/\s*\([\s\S]*\)$/, "");
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
    ...(discovered.suite ? { suite: discovered.suite } : {}),
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
