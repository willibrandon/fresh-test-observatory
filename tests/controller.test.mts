import assert from "node:assert/strict";
import test from "node:test";
import type {
  AdapterContext,
  ProcessOutput,
  TestCase,
  TestObservatoryAdapter,
} from "../lib/contracts.ts";
import {
  TestObservatoryController,
  isTrustedWorkspace,
  type ObservatoryPort,
} from "../lib/controller.ts";

function row(id = "case", adapterId = "fake"): TestCase {
  return {
    id: `${adapterId}:${id}`,
    nativeId: id,
    label: id,
    adapterId,
    source: { path: "/repo/tests.ts", line: 1 },
    status: "unknown",
  };
}

function context(trusted = true): AdapterContext {
  return {
    cwd: "/repo",
    trusted,
    reportDir: "/tmp/fresh-test-observatory/repo",
    readFile: () => null,
    findFiles: async () => [],
    execute: async (): Promise<ProcessOutput> => ({ stdout: "", stderr: "", exitCode: 0 }),
  };
}

function port(
  level: string,
  adapterContext = context(level === "trusted"),
): ObservatoryPort & { changes: number; cancels: number } {
  return {
    changes: 0,
    cancels: 0,
    workspaceRoot: () => "/repo",
    trustLevel: () => level,
    createContext: () => adapterContext,
    progress: () => {},
    changed() {
      this.changes += 1;
    },
    async cancelActiveProcess() {
      this.cancels += 1;
      return true;
    },
  };
}

function adapter(overrides: Partial<TestObservatoryAdapter> = {}): TestObservatoryAdapter {
  return {
    id: "fake",
    label: "Fake",
    detect: () => true,
    discover: () => ({ tests: [row()] }),
    run: (_context, request) => ({
      tests: request.tests.map((item) => ({ ...item, status: "passed" })),
      output: "one useful line",
      exitCode: 0,
    }),
    ...overrides,
  };
}

test("isTrustedWorkspace accepts only Fresh's exact trusted state", () => {
  assert.equal(isTrustedWorkspace("trusted"), true);
  assert.equal(isTrustedWorkspace(""), false);
  assert.equal(isTrustedWorkspace("restricted"), false);
  assert.equal(isTrustedWorkspace("blocked"), false);
});

test("controller refuses execution in an unknown trust state but still discovers source tests", async () => {
  let runs = 0;
  const fake = adapter({
    run: () => {
      runs += 1;
      return { tests: [], output: "", exitCode: 0 };
    },
  });
  const controller = new TestObservatoryController(port(""), [fake]);
  assert.equal(await controller.refresh(), 1);
  const summary = await controller.run("workspace");
  assert.equal(runs, 0);
  assert.equal(summary.unknown, 1);
  assert.match(controller.snapshot().diagnostics.join("\n"), /Trust this workspace/i);
});

test("controller turns unreported process failures into failed rows and replaces diagnostics on rerun", async () => {
  let failing = true;
  const fake = adapter({
    run: (_context, request) =>
      failing
        ? {
            tests: [],
            output: "runner crashed\nmore",
            exitCode: 9,
            diagnostics: ["first", "second"],
          }
        : {
            tests: request.tests.map((item) => ({ ...item, status: "passed" })),
            output: "passed",
            exitCode: 0,
          },
  });
  const controller = new TestObservatoryController(port("trusted"), [fake]);
  await controller.refresh();
  const failed = await controller.run("workspace");
  assert.equal(failed.failed, 1);
  assert.deepEqual(controller.snapshot().diagnostics, [
    "first",
    "second",
    "Fake exited 9: runner crashed",
  ]);
  assert.equal(controller.snapshot().tests[0]?.message, "Fake exited 9: runner crashed");
  assert.deepEqual(controller.snapshot().outputs, [
    { adapterId: "fake", text: "runner crashed\nmore" },
  ]);

  failing = false;
  const passed = await controller.run("workspace");
  assert.equal(passed.passed, 1);
  assert.deepEqual(controller.snapshot().diagnostics, []);
  assert.equal(controller.snapshot().tests[0]?.message, undefined);
});

test("controller trusts conclusive parsed results when terminal exit status is unavailable", async () => {
  let parsedStatus: TestCase["status"] = "passed";
  const fake = adapter({
    run: (_context, request) => ({
      tests: request.tests.map((item) => ({ ...item, status: parsedStatus })),
      output: parsedStatus === "failed" ? "FAIL case" : "PASS case",
      exitCode: -1,
    }),
  });
  const controller = new TestObservatoryController(port("trusted"), [fake]);
  await controller.refresh();

  const passed = await controller.run("workspace");
  assert.equal(passed.passed, 1);
  assert.deepEqual(controller.snapshot().diagnostics, []);

  parsedStatus = "failed";
  const failed = await controller.run("workspace");
  assert.equal(failed.failed, 1);
  assert.deepEqual(controller.snapshot().diagnostics, []);
});

test("controller removes stale tests when an adapter is replaced or unregistered", async () => {
  const controller = new TestObservatoryController(port("trusted"), [adapter()]);
  await controller.refresh();
  assert.equal(controller.snapshot().tests.length, 1);
  assert.equal(controller.registerAdapter(adapter({ label: "Replacement" })), true);
  assert.equal(controller.snapshot().tests.length, 0);
  await controller.refresh();
  assert.equal(controller.unregisterAdapter("fake"), true);
  assert.deepEqual(controller.snapshot().tests, []);
  assert.deepEqual(controller.listAdapters(), []);
});

test("controller keeps imported reports visible but explains that report-only rows cannot rerun", async () => {
  const controller = new TestObservatoryController(port("trusted"), []);
  controller.ingestTests("junit", [{ ...row("imported", "junit"), status: "failed" }]);
  const summary = await controller.run("failed");
  assert.equal(summary.failed, 1);
  assert.match(controller.snapshot().diagnostics.join("\n"), /imported report.*cannot be rerun/i);
});

test("controller cancellation reaches the active process port", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fakePort = port("trusted");
  const fake = adapter({
    async run(_context, request) {
      await pending;
      return { tests: request.tests, output: "stopped", exitCode: -1 };
    },
  });
  const controller = new TestObservatoryController(fakePort, [fake]);
  await controller.refresh();
  const running = controller.run("workspace");
  await Promise.resolve();
  assert.equal(await controller.stop(), true);
  assert.equal(fakePort.cancels, 1);
  release();
  await running;
  assert.equal(controller.snapshot().busy, false);
  assert.equal(controller.snapshot().cancelled, true);
});

test("controller invalidates only coverage for the edited source file", () => {
  const fakePort = port("trusted");
  const controller = new TestObservatoryController(fakePort, []);
  controller.ingestCoverage([
    { path: "/repo/a.cs", lines: [{ line: 1, hits: 1 }] },
    { path: "/repo/b.cs", lines: [{ line: 2, hits: 0 }] },
  ]);

  assert.equal(controller.invalidateCoveragePath("/repo/./a.cs"), true);
  assert.deepEqual(
    controller.snapshot().coverage.map((file) => file.path),
    ["/repo/b.cs"],
  );
  assert.equal(controller.invalidateCoveragePath("/repo/missing.cs"), false);
});

test("controller can disable adapters without removing their registrations", async () => {
  const controller = new TestObservatoryController(port("trusted"), [adapter()]);
  controller.setEnabledAdapters(["another-adapter"]);
  assert.equal(await controller.refresh(), 0);
  assert.deepEqual(
    controller.listAdapters().map((item) => item.id),
    ["fake"],
  );

  controller.setEnabledAdapters([]);
  assert.equal(await controller.refresh(), 1);
});

test("controller routes progress, trust, and empty-selection messages through its translation port", async () => {
  const progress: string[] = [];
  const restrictedPort = port("restricted");
  restrictedPort.translate = (key, params = {}) =>
    `localized:${key}:${Object.values(params).join("|")}`;
  restrictedPort.progress = (message) => progress.push(message);
  const restricted = new TestObservatoryController(restrictedPort, [adapter()]);

  await restricted.refresh();
  await restricted.run("workspace");

  assert.ok(progress.some((message) => message.startsWith("localized:controller.discovering:")));
  assert.ok(
    progress.some((message) =>
      message.startsWith("localized:controller.discovering_adapter:Fake|1|1"),
    ),
  );
  assert.deepEqual(restricted.snapshot().diagnostics, ["localized:controller.trust_run:"]);

  const trustedPort = port("trusted");
  trustedPort.translate = (key) => `localized:${key}`;
  const trusted = new TestObservatoryController(trustedPort, [adapter()]);
  await trusted.refresh();
  await trusted.run("selected");
  assert.deepEqual(trusted.snapshot().diagnostics, ["localized:controller.no_selected"]);
});

test("controller publishes partial discovery before an adapter finishes", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const fakePort = port("trusted");
  const seen: number[] = [];
  fakePort.changed = () => seen.push(controller.snapshot().tests.length);
  const fake = adapter({
    async discover(context) {
      context.report?.({ tests: [row("early")] });
      await pending;
      return { tests: [row("early"), row("late")] };
    },
  });
  const controller = new TestObservatoryController(fakePort, [fake]);
  const refreshing = controller.refresh();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(
    controller.snapshot().tests.map((test) => test.nativeId),
    ["early"],
  );
  assert.equal(controller.snapshot().busy, true);
  assert.ok(controller.snapshot().activity !== undefined);
  release();
  assert.equal(await refreshing, 2);
  assert.deepEqual(
    controller.snapshot().tests.map((test) => test.nativeId),
    ["early", "late"],
  );
  assert.ok(seen.includes(1));
});

test("controller applies streamed results and counts finished tests without re-rendering each one", async () => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const first = row("first");
  const second = row("second");
  const fakePort = port("trusted");
  const fake = adapter({
    discover: () => ({ tests: [first, second] }),
    async run(context, request) {
      context.update?.({ ...first, status: "passed", durationMs: 4 });
      await pending;
      return {
        tests: request.tests.map((item) => ({ ...item, status: "passed" })),
        output: "",
        exitCode: 0,
      };
    },
  });
  const controller = new TestObservatoryController(fakePort, [fake]);
  await controller.refresh();
  const changesBefore = fakePort.changes;
  const running = controller.run("workspace");
  await Promise.resolve();
  await Promise.resolve();
  const during = controller.snapshot();
  assert.deepEqual(during.activity && [during.activity.completed, during.activity.total], [1, 2]);
  assert.equal(during.tests.find((test) => test.id === first.id)?.status, "passed");
  assert.equal(during.tests.find((test) => test.id === second.id)?.status, "running");
  assert.ok(fakePort.changes - changesBefore <= 3, "a streamed result does not notify by itself");
  release();
  const summary = await running;
  assert.equal(summary.passed, 2);
  assert.equal(controller.snapshot().activity, undefined);
});
