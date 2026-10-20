import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { resetDiagnosticEventsForTest } from "../../infra/diagnostic-events.js";
import { recoverStuckDiagnosticSession } from "../../logging/diagnostic-stuck-session-recovery.runtime.js";
import { createReplyOperation } from "../../sessions/session-controller.operation.js";
import {
  captureSessionControllerStop,
  stopSession,
} from "../../sessions/session-controller.stop.js";
import { testing as sessionTesting } from "../../sessions/session-controller.test-support.js";
import { prepareSystemAgentRunAdmission } from "../admitted-run-context.js";
import { applyCodeModeCatalog } from "../code-mode.js";
import { createCodeModeHarness, resetCodeModeTestState } from "../code-mode.test-support.js";
import type { PreparedSubagentRunsRead } from "../subagents/registry/subagent-registry-read-snapshot.js";
import type { SubagentRunRecord } from "../subagents/registry/subagent-registry.types.js";
import {
  collectorRun,
  createMainSessionWaitTool,
  preparedRuns,
  selectRuns,
} from "./agents-wait-tool.test-support.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolCallerIdentity,
} from "./gateway-caller-context.js";

const records = new Map<string, SubagentRunRecord>();
const registryEvents = vi.hoisted(() => ({
  listeners: new Set<() => void>(),
  read: vi.fn<(ids: readonly string[]) => Promise<PreparedSubagentRunsRead>>(),
}));
// mock-isolation: Collector persistence is external I/O; the real controller owns recovery.
vi.mock("../subagents/registry/subagent-registry.js", () => ({
  prepareSubagentRunsByRunIds: registryEvents.read,
}));
vi.mock("../subagents/registry/subagent-registry-publication.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../subagents/registry/subagent-registry-publication.js")>();
  return {
    ...actual,
    subscribeSubagentRunChanges: ((phase, listener) => {
      if (phase === "projection") {
        return actual.subscribeSubagentRunChanges(phase, listener);
      }
      const wake = () => listener({ runIds: undefined, sessionKeys: undefined });
      registryEvents.listeners.add(wake);
      return () => registryEvents.listeners.delete(wake);
    }) satisfies typeof actual.subscribeSubagentRunChanges,
  };
});
function observeRead() {
  const read = createDeferred();
  registryEvents.read.mockImplementation(async (ids) => {
    read.resolve();
    return preparedRuns(() => selectRuns(records, ids));
  });
  return read.promise;
}
function publishCompletion(entry: SubagentRunRecord) {
  entry.collectorCompletion = { status: "failed" };
  for (const listener of registryEvents.listeners) {
    listener();
  }
}
beforeEach(() => {
  records.clear();
  registryEvents.listeners.clear();
  registryEvents.read
    .mockReset()
    .mockImplementation(async (ids) => preparedRuns(() => selectRuns(records, ids)));
});
it.each(["cell", "nested"])(
  "keeps sibling results owned with %s awaitResults until every completion arrives",
  async (mode) => {
    onTestFinished(resetCodeModeTestState);
    const first = collectorRun("first-required", "agent:main:main", { status: "done" });
    const second = collectorRun("second-required", "agent:main:main");
    records.set(first.runId, first);
    records.set(second.runId, second);
    const read = observeRead();
    const h = createCodeModeHarness();
    applyCodeModeCatalog({ ...h.ctx, tools: [...h.tools, createMainSessionWaitTool()] });
    const result = expectDefined(h.tools[0], "exec").execute("required-child-results", {
      title: "Collect required child results",
      awaitResults: mode === "cell",
      code: `return await agents_wait({ids:["first-required", "second-required"]${mode === "nested" ? ", awaitResults: true" : ""}});`,
    });
    try {
      await read;
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      await vi.advanceTimersByTimeAsync(60_000);
      const pending = Symbol("pending");
      expect(await Promise.race([result, Promise.resolve(pending)])).toBe(pending);
      expect(registryEvents.read).toHaveBeenCalledOnce();
      second.completion = { required: false, resultText: "child failure evidence" };
      publishCompletion(second);
      vi.useRealTimers();
      expect((await result).details).toMatchObject({
        status: "completed",
        value: {
          pending: [],
          completed: [
            { runId: first.runId, status: "done" },
            { runId: second.runId, status: "failed", result: "child failure evidence" },
          ],
        },
      });
      expect(registryEvents.read).toHaveBeenCalledTimes(2);
      expect(registryEvents.listeners.size).toBe(0);
    } finally {
      vi.useRealTimers();
      publishCompletion(second);
      await result;
    }
  },
);

it("cancels required collection without borrowing another requester's child", async () => {
  const entry = collectorRun("foreign-required", "agent:other:main");
  records.set(entry.runId, entry);
  const tool = createMainSessionWaitTool();
  await expect(
    tool.execute("foreign", { ids: [entry.runId], awaitResults: true }),
  ).resolves.toMatchObject({
    details: { success: false, errors: [{ runId: entry.runId, error: "not_owner" }] },
  });
  entry.swarmRequesterSessionKey = "agent:main:main";
  const read = observeRead();
  const abort = new AbortController();
  const result = tool.execute(
    "required-abort",
    { ids: [entry.runId], awaitResults: true },
    abort.signal,
  );
  const rejected = expect(result).rejects.toThrow("agents_wait aborted");
  await read;
  abort.abort();
  await rejected;
  expect(registryEvents.listeners.size).toBe(0);
  await expect(
    tool.execute("ambiguous-wait", { ids: [entry.runId], awaitResults: true, timeoutSeconds: 1 }),
  ).rejects.toThrow("cannot also specify");
});

function publishChanges() {
  for (const listener of registryEvents.listeners) {
    listener();
  }
}

async function startParentWait(codeMode = false) {
  vi.useFakeTimers({ toFake: ["Date"] });
  const h = createCodeModeHarness({ agentId: "main" });
  const { sessionId, sessionKey, runId } = h.ctx;
  const admission = prepareSystemAgentRunAdmission({}, runId, "main", "wait-test");
  const admitted = await admission.admit("embedded");
  const caller = createAdmittedGatewayToolCallerIdentity({
    admittedRunContext: admitted,
    agentId: "main",
    sessionKey,
  });
  const operation = createReplyOperation({ sessionId, sessionKey, resetTriggered: false });
  operation.setPhase("running");
  const signal = new AbortController();
  const abort = vi.fn(() => {
    signal.abort();
    operation.complete();
  });
  operation.attachBackend({ kind: "embedded", runId, cancel: abort });
  const attempt = operation.watchdog.attachAttempt({
    assertCurrent: () => operation.abortSignal.throwIfAborted(),
  });
  const endTool = attempt.beginTool({
    toolName: codeMode ? "exec" : "agents_wait",
    toolCallId: "join",
  });
  const startedAt = Date.now();
  const entry = collectorRun("long-collector", sessionKey);
  records.set(entry.runId, entry);
  const read = createDeferred();
  registryEvents.read.mockImplementation(async (ids) =>
    preparedRuns(() => {
      read.resolve();
      return selectRuns(records, ids);
    }),
  );
  const tool = createMainSessionWaitTool();
  applyCodeModeCatalog({ ...h.ctx, tools: [...h.tools, tool] });
  const result = withGatewayToolCallerIdentity(
    { ...expectDefined(caller, "admitted caller"), watchdogAttempt: attempt },
    () =>
      (codeMode ? expectDefined(h.tools[0], "exec") : tool).execute(
        "join",
        codeMode
          ? {
              title: "Join required child",
              awaitResults: true,
              code: 'return await agents_wait({ids:["long-collector"], awaitResults:true});',
            }
          : { ids: [entry.runId], awaitResults: true },
        signal.signal,
      ),
  );
  // Observe pre-fix cancellation without changing the caller-visible result.
  const observed = result.then(
    () => {},
    () => {},
  );
  onTestFinished(async () => {
    signal.abort();
    await observed;
    endTool();
    operation.complete();
    admission.close();
    await resetCodeModeTestState();
    sessionTesting.resetSessionControllerForTest();
    resetDiagnosticEventsForTest();
    vi.useRealTimers();
  });
  return {
    admission,
    operation,
    attempt,
    abort,
    entry,
    result,
    read: read.promise,
    advancePastQuietToolDeadline() {
      vi.setSystemTime(startedAt + 16 * 60_000);
    },
  };
}

it.each([
  { outcome: "done", codeMode: true },
  { outcome: "failed", codeMode: false },
  { outcome: "stopped", codeMode: false },
] as const)(
  "keeps a long collector wait alive until $outcome (Code Mode: $codeMode)",
  async ({ outcome, codeMode }) => {
    const parent = await startParentWait(codeMode);
    await parent.read;
    parent.advancePastQuietToolDeadline();
    await expect(
      recoverStuckDiagnosticSession({
        operation: parent.operation,
        sessionId: parent.operation.sessionId,
        sessionKey: parent.operation.key,
        ageMs: 16 * 60_000,
        queueDepth: 0,
        allowActiveAbort: true,
      }),
    ).resolves.toMatchObject({ status: "skipped", reason: "active_reply_work" });
    expect(parent.abort).not.toHaveBeenCalled();
    expect(registryEvents.read).toHaveBeenCalledOnce();

    if (outcome === "stopped") {
      const stopped = stopSession({
        capture: captureSessionControllerStop({ operations: [parent.operation] }),
        source: "client-run",
      });
      expect(stopped.aborted).toBe(true);
      await expect(parent.result).rejects.toThrow("agents_wait aborted");
      expect(parent.abort).toHaveBeenCalledOnce();
    } else {
      parent.entry.collectorCompletion = { status: outcome };
      parent.entry.completion = { required: false, resultText: "collected result" };
      publishChanges();
      const completed = {
        completed: [{ runId: parent.entry.runId, status: outcome, result: "collected result" }],
        pending: [],
      };
      await expect(parent.result).resolves.toMatchObject({
        details: codeMode ? { status: "completed", value: completed } : completed,
      });
    }
    expect(parent.operation.watchdog.snapshot().waits).toEqual([]);
    expect(registryEvents.listeners.size).toBe(0);
  },
);

it.each(["execution deadline", "revoked authority", "stalled reread"] as const)(
  "does not protect a collector after %s",
  async (cause) => {
    const parent = await startParentWait();
    await parent.read;
    parent.advancePastQuietToolDeadline();
    expect(await parent.operation.watchdog.tick()).toEqual({
      action: "observe",
      reason: "runtime_owned",
    });
    const reread = createDeferred<PreparedSubagentRunsRead>();
    try {
      if (cause === "execution deadline") {
        parent.attempt.setExecutionDeadline(Date.now());
      } else if (cause === "revoked authority") {
        parent.admission.close();
      } else {
        registryEvents.read.mockImplementation(() => reread.promise);
        publishChanges();
      }
      expect(parent.operation.watchdog.decide()).toMatchObject({
        action: "stop",
        reason: cause === "execution deadline" ? "execution_deadline" : "semantic_stall",
      });
      await parent.operation.watchdog.tick();
      expect(parent.abort).toHaveBeenCalledOnce();
      expect(parent.operation.result).toMatchObject({ kind: "failed", code: "run_stalled" });
    } finally {
      reread.resolve(preparedRuns(() => selectRuns(records, [parent.entry.runId])));
    }
    await expect(parent.result).rejects.toThrow("agents_wait aborted");
    expect(parent.operation.watchdog.snapshot().waits).toEqual([]);
    expect(registryEvents.listeners.size).toBe(0);
  },
);
