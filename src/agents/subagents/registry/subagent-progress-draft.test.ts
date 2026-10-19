// Preserve module setup before modules that consume it.
// oxfmt-ignore
import { runSubagentStateWorkerOperation, useSubagentControlFixture } from "./subagent-control.test-support.js";
import { afterEach, beforeEach, expect, it, onTestFinished, vi, type Mock } from "vitest";
import {
  abortSessionRunTargetWithOutcome,
  captureChannelSessionStop,
} from "../../../auto-reply/reply/abort-operation.js";
import type { ProgressContinuationDraft } from "../../../channels/progress-continuation.js";
import { createChannelProgressDraftCompositor } from "../../../channels/progress-draft-compositor.js";
import { captureRuntimeConfigAsyncReader, getRuntimeConfig } from "../../../config/config.js";
import { resolveSessionStorePathCore } from "../../../config/sessions.js";
import { upsertSessionEntryCore } from "../../../config/sessions/session-accessor.js";
import { abortControlledSubagents } from "../../../gateway/server-methods/chat-abort-descendants.js";
import { emitAgentEvent } from "../../../infra/agent-events.js";
import { resetSystemEventsForTest } from "../../../infra/system-events.js";
import { prepareAgentRunTerminalReply } from "../../agent-run-terminal-reply.js";
import {
  clearTestEmbeddedRun as detachActiveEmbeddedRun,
  registerTestEmbeddedRun as attachActiveEmbeddedRun,
  createEmbeddedRunHandle,
} from "../../embedded-agent-runner/runs.test-support.js";
import { isSubagentRegistryWriteCommand } from "../../subagent-test-fixtures.test-helpers.js";
import {
  setSubagentAnnounceDeliveryDepsForTest,
  type SubagentAnnounceDeliveryTestDeps,
} from "../announce/subagent-announce-overrides.test-support.js";
import { SessionFollowupCompletion } from "../completion/session-followup-completion.js";
import { killSessionSubagentRuns } from "./subagent-control-kill.js";
import { adoptSubagentProgressDraft } from "./subagent-progress-draft.js";
import {
  childKey,
  requesterKey,
  useSubagentProgressCohort,
} from "./subagent-progress-draft.test-support.js";
import { subagentRuns } from "./subagent-registry-memory.js";
import { adoptPausedSubagentRunForFollowUp } from "./subagent-registry.js";
import { rowToSubagentRunRecord } from "./subagent-registry.store.codec.js";
import { testing as registryTesting } from "./subagent-registry.test-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

const fixture = useSubagentControlFixture();
beforeEach(async () => {
  await captureRuntimeConfigAsyncReader()();
});
const yieldCohort = useSubagentProgressCohort(fixture);

const CHILD_RESULT = "Private child result marker.";

type Dispatch = SubagentAnnounceDeliveryTestDeps["dispatchGatewayMethodInProcess"];
type DispatchParams = Parameters<Dispatch>[1];

afterEach(() => {
  setSubagentAnnounceDeliveryDepsForTest();
  resetSystemEventsForTest();
});

function rejectRegistryWrites(reject: (row: SubagentRunRecord) => boolean, message: string) {
  fixture.worker.mockImplementation((context, operation, options) =>
    runSubagentStateWorkerOperation(
      context,
      (scope) =>
        operation({
          execute: async (command, executeOptions) => {
            if (
              isSubagentRegistryWriteCommand(command) &&
              command.input.values.some((value) => {
                const row = rowToSubagentRunRecord(value);
                return row !== null && reject(row);
              })
            ) {
              throw new Error(message);
            }
            return scope.execute(command, executeOptions);
          },
        }),
      options,
    ),
  );
}

async function endRun(runId: string, data: Record<string, unknown> = {}) {
  fixture.capture.mockResolvedValue(CHILD_RESULT);
  emitAgentEvent({
    runId,
    sessionKey: subagentRuns.get(runId)!.childSessionKey,
    stream: "lifecycle",
    data: {
      phase: "end",
      endedAt: Date.now(),
      terminalReply: { disposition: "visible", text: CHILD_RESULT },
      ...data,
    },
  });
  await fixture.settle();
}

/** Each requester wake turn answers with the next reply; `onWake` runs inside that turn. */
function answerWakes(
  draft: TestDraft,
  replies: readonly string[],
  onWake?: (params: DispatchParams) => Promise<void>,
) {
  const wakes: Array<{ runId: string; retiredBefore: number }> = [];
  const dispatch: Dispatch = async <T>(...args: Parameters<Dispatch>): Promise<T> => {
    const [, params, options] = args;
    wakes.push({
      runId: String(params?.idempotencyKey),
      retiredBefore: draft.retire.mock.calls.length,
    });
    options?.onExecutionStarted?.();
    if (wakes.length === 1) {
      await onWake?.(params);
    }
    const terminal = prepareAgentRunTerminalReply({ rawText: replies[wakes.length - 1] ?? "" });
    return {
      status: "ok",
      inputProcessingCompleted: true,
      result: {
        payloads: terminal.text ? [{ text: terminal.text }] : [],
        meta: { terminalReply: terminal.terminalReply },
        ...(terminal.terminalReply.disposition === "silent"
          ? {
              deliveryStatus: {
                status: "suppressed",
                succeeded: true,
                reason: "no_visible_payload",
                resultCount: 0,
              },
            }
          : {}),
      },
    } as T;
  };
  setSubagentAnnounceDeliveryDepsForTest({ dispatchGatewayMethodInProcess: dispatch });
  return wakes;
}

type TestDraft = { push: Mock; updatePlan: Mock; retire: Mock };
const newDraft = (): TestDraft => ({ push: vi.fn(), updatePlan: vi.fn(), retire: vi.fn() });

function renderedDraft() {
  const progress = createChannelProgressDraftCompositor({
    active: true,
    mode: "progress",
    seed: "retained-delegation",
    preparedItems: true,
    showWorkStatus: true,
    entry: { streaming: { mode: "progress", progress: { toolProgress: true } } },
  });
  onTestFinished(() => progress.cancel());
  let pending: Promise<unknown> = progress.start();
  const draft = {
    push: vi.fn<ProgressContinuationDraft["push"]>((item) => {
      pending = pending.then(() => progress.pushItemEvent(item));
    }),
    updatePlan: vi.fn<NonNullable<ProgressContinuationDraft["updatePlan"]>>((steps, options) => {
      pending = pending.then(() => progress.pushPlanProgress(steps, options));
    }),
    retire: vi.fn(),
  };
  return { draft, progress, flush: () => pending };
}

function bindPeer(
  runId: string,
  requesterTurnRunId = "parent-turn",
  sessionId = "requester-session",
  storePath = resolveSessionStorePathCore(getRuntimeConfig().session?.store, { agentId: "main" }),
) {
  const lifetime = new AbortController();
  const owner = SessionFollowupCompletion.bind({
    runId,
    requesterTurnRunId,
    visibleReply: true,
    requesterSessionKey: requesterKey,
    requesterSessionId: sessionId,
    requesterStorePath: storePath,
    requesterAgentId: "main",
    targetSessionKey: "agent:peer:main",
    targetAgentId: "peer",
    custody: {
      signal: lifetime.signal,
      assertCurrent: () => lifetime.signal.throwIfAborted(),
      run: (work) => work(),
      release: () => lifetime.abort(),
    },
  });
  owner.markAccepted(runId);
  return owner;
}

it("updates the same peer card through two handoffs without retaining closed rows or private plans", async () => {
  const peer = bindPeer("peer-run");
  const { draft, progress, flush } = renderedDraft();
  await progress.pushPlanProgress([{ step: "Original request", status: "in_progress" }]);
  expect(adoptSubagentProgressDraft([], draft, [peer])).toBe(true);
  emitAgentEvent({
    runId: "peer-run",
    stream: "item",
    data: {
      itemId: "private-tool",
      kind: "tool",
      name: "read",
      status: "running",
      text: CHILD_RESULT,
      arguments: CHILD_RESULT,
      result: CHILD_RESULT,
    },
  });
  emitAgentEvent({
    runId: "peer-run",
    stream: "plan",
    data: { steps: [{ step: CHILD_RESULT, status: "in_progress" }], explanation: CHILD_RESULT },
  });
  let next: SessionFollowupCompletion | undefined;
  let last: SessionFollowupCompletion | undefined;
  try {
    await peer.withRequesterRun("requester-return", async () => {
      expect(draft.push).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Processing the result" }),
      );
      emitAgentEvent({
        runId: "requester-return",
        stream: "plan",
        data: {
          steps: [{ step: "Verify the result", status: "in_progress" }],
          explanation: "Updated *literal* plan",
          explanationFormat: "plain",
        },
      });
      next = bindPeer("next-peer-run", "requester-return");
      expect(draft.retire).not.toHaveBeenCalled();
    });
    peer.close();
    expect(draft.retire).not.toHaveBeenCalled();
    expect(draft.push).toHaveBeenCalledWith(expect.objectContaining({ itemId: "next-peer-run" }));
    await flush();
    expect(progress.getSnapshot().plan).toEqual([
      { step: "Verify the result", status: "in_progress" },
    ]);
    expect(progress.getSnapshot().planExplanation).toBe("Updated *literal* plan");
    expect(progress.getSnapshot().planExplanationFormat).toBe("plain");
    expect(JSON.stringify(progress.getSnapshot())).not.toContain(CHILD_RESULT);
    expect(progress.getSnapshot().lines).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "peer-run" })]),
    );
    expect(progress.getSnapshot().lines).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "peer-run:tool" })]),
    );
    expectNoChildResultPushed(draft);
    await next!.withRequesterRun("requester-again", async () => {
      emitAgentEvent({ runId: "requester-again", stream: "plan", data: { steps: [] } });
      last = bindPeer("last-peer-run", "requester-again");
    });
    next?.close();
    // Closed requesters cannot overwrite the current owner's plan.
    emitAgentEvent({
      runId: "requester-return",
      stream: "plan",
      data: { steps: [{ step: "Stale plan", status: "in_progress" }] },
    });
    await flush();
    expect(progress.getSnapshot().plan).toBeUndefined();
    expect(progress.getSnapshot().lines).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "next-peer-run" })]),
    );
    expect(draft.retire).not.toHaveBeenCalled();
    last?.close();
    expect(draft.retire).toHaveBeenCalledOnce();
  } finally {
    peer.close();
    next?.close();
    last?.close();
  }
});

it("stop retires only the original requester's detached peer card", async () => {
  const original = bindPeer("original-peer");
  const replacement = bindPeer("replacement-peer", "next-turn", "replacement-session");
  const otherStore = bindPeer(
    "other-store-peer",
    "parent-turn",
    "requester-session",
    "/synthetic/other-store/sessions.json",
  );
  const draft = newDraft();
  expect(adoptSubagentProgressDraft([], draft, [original])).toBe(true);
  try {
    const capture = captureChannelSessionStop({
      agentId: "main",
      key: requesterKey,
      storePath: original.request.requesterStorePath,
      sessionId: "requester-session",
    });
    const result = abortSessionRunTargetWithOutcome({
      capture,
      hookContext: { sessionKey: requesterKey, sessionId: "requester-session" },
      retirements: [],
    });
    const outcome = await result.completed;
    expect(outcome.aborted).toBe(true);
    await result.settled;
    expect(original.signal.aborted).toBe(true);
    expect(replacement.signal.aborted).toBe(false);
    expect(otherStore.signal.aborted).toBe(false);
    expect(draft.retire).toHaveBeenCalledOnce();
  } finally {
    original.close();
    replacement.close();
    otherStore.close();
  }
});

it("leaves a terminal failure visible when the requester result could not be delivered", () => {
  const owner = bindPeer("failed-peer");
  const draft = newDraft();
  expect(adoptSubagentProgressDraft([], draft, [owner])).toBe(true);
  owner.failProgress();
  owner.close(new Error(CHILD_RESULT));
  expect(draft.push).toHaveBeenLastCalledWith(
    expect.objectContaining({ phase: "end", status: "failed" }),
  );
  expect(draft.retire).not.toHaveBeenCalled();
  expectNoChildResultPushed(draft);
});

function expectNoChildResultPushed(draft: TestDraft) {
  expect(JSON.stringify(draft.push.mock.calls)).not.toContain(CHILD_RESULT);
}

it.each([
  ["a visible answer", ["The delegated work is done."], true],
  ["intentional external silence", ["NO_REPLY"], true],
  ["required internal result", ["NO_REPLY"], false],
] as const)("settles the progress card according to %s", async (name, replies, retired) => {
  const requesterOrigin =
    name === "intentional external silence"
      ? { channel: "telegram", to: "12345", accountId: "default" }
      : undefined;
  if (requesterOrigin) {
    await upsertSessionEntryCore(
      {
        storePath: resolveSessionStorePathCore(getRuntimeConfig().session?.store, {
          agentId: "main",
        }),
        sessionKey: requesterKey,
      },
      {
        delivery: {
          kind: "external",
          route: {
            channel: requesterOrigin.channel,
            accountId: requesterOrigin.accountId,
            target: { to: requesterOrigin.to },
          },
          context: requesterOrigin,
          origin: {
            provider: requesterOrigin.channel,
            to: requesterOrigin.to,
            accountId: requesterOrigin.accountId,
          },
        },
      },
    );
  }
  const spawns = await yieldCohort("parent-turn", ["a", "b"], requesterOrigin);
  const draft = newDraft();
  expect(adoptSubagentProgressDraft(spawns, draft)).toBe(true);
  const wakes = answerWakes(draft, replies);

  await endRun("a");
  expect(wakes).toEqual([]);
  expect(draft.retire).not.toHaveBeenCalled();

  await endRun("b");
  expect(wakes.map(({ retiredBefore }) => retiredBefore)).toEqual(replies.map(() => 0));
  if (retired) {
    expect(draft.retire).toHaveBeenCalledOnce();
  } else {
    expect(draft.retire).not.toHaveBeenCalled();
  }
  expect(draft.push).toHaveBeenCalledWith(
    expect.objectContaining({ itemId: "b", kind: "subagent", status: "completed" }),
  );
  expectNoChildResultPushed(draft);
});

it("does not adopt a card for a cohort whose completion was already delivered", async () => {
  const spawns = await yieldCohort("parent-turn", ["a", "b"]);
  answerWakes(newDraft(), ["The delegated work is done."]);
  await endRun("a");
  await endRun("b");
  expect(subagentRuns.get("b")?.requesterSettleWake).toBeUndefined();

  const stale = newDraft();
  expect(adoptSubagentProgressDraft(spawns, stale)).toBe(false);
  expect(stale.push).not.toHaveBeenCalled();
});

it.each(["visible result", "exhausted"] as const)(
  "recovers a known missing required result through periodic admission: %s",
  async (outcome) => {
    const spawns = await yieldCohort("parent-turn", ["a"]);
    const draft = newDraft();
    expect(adoptSubagentProgressDraft(spawns, draft)).toBe(true);
    const wakes = answerWakes(draft, [
      "NO_REPLY",
      outcome === "visible result" ? "The delegated work is done." : "NO_REPLY",
      "NO_REPLY",
    ]);
    await endRun("a");
    expect(wakes).toHaveLength(1);
    expect(draft.retire).not.toHaveBeenCalled();
    expect(subagentRuns.get("a")?.requesterSettleWake).toMatchObject({
      status: "pending",
      attemptCount: 1,
    });
    await registryTesting.sweepOnceForTests();
    await fixture.settle();
    expect(wakes).toHaveLength(1);

    const clock = vi.spyOn(Date, "now");
    try {
      for (let attempt = 1; attempt < (outcome === "visible result" ? 2 : 3); attempt++) {
        const due = subagentRuns.get("a")?.requesterSettleWake?.nextAttemptAt;
        expect(due).toBeTypeOf("number");
        clock.mockReturnValue(due!);
        await registryTesting.sweepOnceForTests();
        await fixture.settle();
        expect(wakes).toHaveLength(attempt + 1);
        expect(wakes[attempt]?.runId).toBe(`${wakes[0]!.runId}:retry-${attempt}`);
      }
      expect(draft.retire).toHaveBeenCalledOnce();
      expect(subagentRuns.get("a")?.requesterSettleWake).toBeUndefined();
      await registryTesting.sweepOnceForTests();
      await fixture.settle();
      expect(wakes).toHaveLength(outcome === "visible result" ? 2 : 3);
    } finally {
      clock.mockRestore();
    }
  },
);

it.each([
  ["killSessionSubagentRuns", "running", "committed"],
  ["abortControlledSubagents", "completed", "committed"],
  ["killSessionSubagentRuns", "running", "rejected"],
  ["abortControlledSubagents", "completed", "rejected"],
] as const)(
  "retires the card only when %s commits stop of a completed and a %s child (%s)",
  async (stop, sibling, write) => {
    const spawns = await yieldCohort("parent-turn", ["a", "b"]);
    const draft = newDraft();
    expect(adoptSubagentProgressDraft(spawns, draft)).toBe(true);
    // Completed children still owe their pending requester wake when Stop arrives.
    fixture.wake.mockResolvedValue(false);
    await endRun("a");
    if (sibling === "completed") {
      await endRun("b");
    }
    expect(subagentRuns.get("a")?.requesterSettleWake?.status).toBe("pending");
    if (write === "rejected") {
      rejectRegistryWrites(
        (row) => Boolean(row.killIntent) || row.suppressCompletionDelivery === true,
        "stop write rejected",
      );
    }

    const params = { cfg: getRuntimeConfig(), sessionKey: requesterKey, agentId: "main" };
    const result =
      stop === "killSessionSubagentRuns"
        ? await killSessionSubagentRuns(params)
        : await abortControlledSubagents(params);
    await fixture.settle();

    expect(result?.status).toBe(write === "rejected" ? "error" : "ok");
    if (write === "rejected") {
      expect(draft.retire).not.toHaveBeenCalled();
    } else {
      expect(draft.retire).toHaveBeenCalledOnce();
    }
    expectNoChildResultPushed(draft);
  },
);

it("keeps the card when stop cannot interrupt a child that is still finishing", async () => {
  const spawns = await yieldCohort("parent-turn", ["a"]);
  const draft = newDraft();
  expect(adoptSubagentProgressDraft(spawns, draft)).toBe(true);
  const handle = createEmbeddedRunHandle({
    runId: "a",
    isAbortable: false,
  });
  attachActiveEmbeddedRun(
    "a-session",
    handle,
    childKey("a"),
    undefined,
    "main",
    undefined,
    undefined,
    {
      storeScope: resolveSessionStorePathCore(getRuntimeConfig().session?.store, {
        agentId: "main",
      }),
    },
  );
  try {
    await killSessionSubagentRuns({
      cfg: getRuntimeConfig(),
      sessionKey: requesterKey,
      agentId: "main",
    });
    await fixture.settle();

    const child = subagentRuns.get("a");
    expect(child?.killIntent).toBeUndefined();
    expect(child?.execution.status).toBe("running");
    expect(child?.requesterSettleWake).toBeDefined();
    expect(draft.retire).not.toHaveBeenCalled();
  } finally {
    detachActiveEmbeddedRun("a-session", handle, childKey("a"));
  }
  answerWakes(draft, ["The delegated work is done."]);
  await endRun("a");
  expect(draft.retire).toHaveBeenCalledOnce();
});

it("follows a child's resumed execution and retires after the replacement settles", async () => {
  const spawns = await yieldCohort("parent-turn", ["a", "b"]);
  const draft = newDraft();
  expect(adoptSubagentProgressDraft(spawns, draft)).toBe(true);
  const wakes = answerWakes(draft, ["The delegated work is done."]);

  // The child yields to its own children and is resumed as a new execution of the same task.
  await endRun("a", { yielded: true, terminalReply: undefined });
  expect(
    await adoptPausedSubagentRunForFollowUp({
      childSessionKey: childKey("a"),
      runId: "a-resumed",
      task: "Continue delegated a",
    }),
  ).toBe(true);
  await fixture.settle();
  expect(subagentRuns.get("a-resumed")?.taskRunId).toBe("a");
  expect(draft.retire).not.toHaveBeenCalled();

  for (const [runId, name] of [
    ["a", "replaced_exec"],
    ["a-resumed", "exec"],
  ] as const) {
    emitAgentEvent({ runId, stream: "item", data: { kind: "tool", name, status: "running" } });
  }
  expect(draft.push).toHaveBeenCalledWith({
    itemId: "a:tool",
    kind: "tool",
    name: "exec",
    phase: "update",
    status: "running",
  });
  expect(JSON.stringify(draft.push.mock.calls)).not.toContain("replaced_exec");

  await endRun("a-resumed");
  await endRun("b");
  expect(wakes).toEqual([{ runId: expect.any(String), retiredBefore: 0 }]);
  expect(draft.retire).toHaveBeenCalledOnce();
  expectNoChildResultPushed(draft);
});

it("keeps the card for the resumed requester's re-yield cohort until that cohort settles", async () => {
  const spawns = await yieldCohort("parent-turn", ["a", "b"]);
  const draft = newDraft();
  expect(adoptSubagentProgressDraft(spawns, draft)).toBe(true);
  const wakes = answerWakes(
    draft,
    ["Waiting for the follow-up checks.", "Everything is verified."],
    async (params) => {
      emitAgentEvent({
        runId: String(params?.idempotencyKey),
        stream: "plan",
        data: { steps: [{ step: "Follow-up checks", status: "in_progress" }] },
      });
      await yieldCohort(String(params?.idempotencyKey), ["c", "d"]);
    },
  );

  await endRun("a");
  await endRun("b");
  expect(wakes).toHaveLength(1);
  expect(draft.updatePlan).toHaveBeenCalledWith(
    [{ step: "Follow-up checks", status: "in_progress" }],
    expect.any(Object),
  );
  expect(draft.retire).not.toHaveBeenCalled();
  for (const itemId of ["c", "d"]) {
    expect(draft.push).toHaveBeenCalledWith(
      expect.objectContaining({ itemId, kind: "subagent", status: "running" }),
    );
  }

  await endRun("c");
  await endRun("d");
  expect(wakes).toHaveLength(2);
  expect(wakes[1]).toEqual({ runId: expect.any(String), retiredBefore: 0 });
  expect(wakes[1]!.runId).not.toBe(wakes[0]!.runId);
  expect(draft.retire).toHaveBeenCalledOnce();
  expectNoChildResultPushed(draft);
});
