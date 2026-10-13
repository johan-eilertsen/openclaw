import { html, render } from "lit";
import { describe, expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../../api/types.ts";
import { flush } from "../../test-helpers/solid-settle.ts";
import { projectSubagentStatus } from "./chat-subagent-wait.ts";
import { renderUnplacedSubagentWait } from "./components/chat-message-stream.ts";
import { renderSubagentActivity } from "./components/chat-subagent-activity.ts";
import { renderChatWorkingIndicator } from "./components/chat-working-indicator.ts";

function resolveChatSubagentWait(input: Parameters<typeof projectSubagentStatus>[0]) {
  return projectSubagentStatus(input, false).wait;
}

const parent: GatewaySessionRow = {
  key: "agent:main:parent",
  kind: "direct",
  hasActiveRun: false,
  hasActiveSubagentRun: true,
  startedAt: 1_000,
  endedAt: 2_000,
};
const child: GatewaySessionRow = {
  key: "agent:main:subagent:child",
  kind: "direct",
  spawnedBy: parent.key,
  label: "Backend implementation",
  hasActiveRun: true,
};
const messages = [
  {
    role: "assistant",
    runId: "parent-run",
    timestamp: 2_000,
    content: [{ type: "toolCall", id: "yield", name: "sessions_yield", arguments: {} }],
  },
  {
    role: "toolResult",
    runId: "parent-run",
    toolCallId: "yield",
    toolName: "sessions_yield",
    timestamp: 2_001,
    content: [{ type: "text", text: '{"status":"yielded"}' }],
  },
];

describe("chat waiting on subagents", () => {
  it("keeps each unfinished subagent's current activity visible without reviving old runs", () => {
    const active = {
      ...child,
      activeRunIds: ["backend-run"],
      createdAt: 1,
      observerDigest: {
        runId: "backend-run",
        headline: "Checking the API response",
        health: "on-track" as const,
        revision: 1,
        updatedAt: 3_000,
      },
    };
    const queued = {
      ...child,
      key: "agent:main:subagent:queued",
      label: "UI regression tests",
      createdAt: 2,
      status: "queued" as const,
      hasActiveRun: false,
    };
    const delegated = {
      ...child,
      key: "agent:main:subagent:review",
      label: "Review accessibility",
      createdAt: 3,
      hasActiveRun: false,
      hasActiveSubagentRun: true,
    };
    const project = (rows: GatewaySessionRow[], searching = false) =>
      projectSubagentStatus(
        {
          selectedSession: parent,
          messages,
          subagentSessions: rows,
          subagentSessionsHydrated: true,
        },
        searching,
      );
    const initial = project([delegated, queued, active]);
    expect(initial.activity).toMatchObject([
      {
        key: child.key,
        label: child.label,
        status: "running",
        activity: "Checking the API response",
        listed: true,
      },
      { key: queued.key, label: queued.label, status: "queued", activity: undefined, listed: true },
      {
        key: delegated.key,
        label: delegated.label,
        status: "waiting",
        activity: undefined,
        listed: true,
      },
    ]);
    const updated = project([
      {
        ...active,
        observerDigest: {
          ...active.observerDigest,
          headline: "Running the backend tests",
          revision: 2,
        },
      },
      queued,
      delegated,
    ]);
    expect(updated.statusKey).not.toBe(initial.statusKey);
    expect(updated.rowsKey).toBe(initial.rowsKey);
    expect(updated.activity[0]?.activity).toBe("Running the backend tests");
    expect(
      project([{ ...active, activeRunIds: ["replacement-run"] }]).activity[0]?.activity,
    ).toBeUndefined();
    expect(project([{ ...active, status: "done", hasActiveRun: false }]).activity).toEqual([]);
    expect(project([active], true).activity).toEqual([]);

    const container = document.createElement("div");
    const onOpenSubagent = vi.fn();
    const onOpenSession = vi.fn();
    render(renderSubagentActivity(initial.activity, onOpenSubagent, onOpenSession), container);
    expect(container.textContent).toContain("Backend implementation");
    expect(container.textContent).toContain("Checking the API response");
    expect(container.textContent).toContain("UI regression tests");
    expect(container.textContent).toContain("Queued");
    expect(container.textContent).toContain("Review accessibility");
    expect(container.textContent).toContain("Waiting on subagents");
    container.querySelector("button")?.click();
    expect(onOpenSubagent).toHaveBeenCalledWith(child.key);
    const acp = project([{ ...active, key: "agent:main:acp:coder" }]);
    render(renderSubagentActivity(acp.activity, onOpenSubagent, onOpenSession), container);
    container.querySelector("button")?.click();
    expect(onOpenSession).toHaveBeenCalledWith("agent:main:acp:coder");
    render(renderSubagentActivity(updated.activity), container);
    expect(container.textContent).toContain("Running the backend tests");
    expect(container.textContent).not.toContain("Checking the API response");
    expect(container.querySelector("button")).toBeNull();
  });

  it("keeps lifecycle wait timing after an announcement resumes and settles the parent", () => {
    const dashboardChild = { ...child, key: "agent:main:dashboard:worker" };
    const project = (
      session: GatewaySessionRow,
      history: unknown[],
      descendants = [dashboardChild],
    ) =>
      projectSubagentStatus(
        {
          selectedSession: session,
          messages: history,
          subagentSessions: descendants,
          subagentSessionsHydrated: true,
        },
        false,
      );
    expect(project({ ...parent, endedAt: 2_500 }, messages).wait?.startedAt).toBe(2_500);
    const resumed = { ...parent, startedAt: 3_000, endedAt: undefined, hasActiveRun: true };
    expect(project(resumed, messages).wait).toBeNull();
    const settled = { ...resumed, hasActiveRun: false, endedAt: 4_000 };
    const history = [
      ...messages,
      { role: "assistant", runId: "announcement", timestamp: 3_900, content: "Worker continues." },
    ];
    for (const loaded of [history, []]) {
      const projection = project(settled, loaded);
      expect(projection.wait).toEqual({
        startedAt: 4_000,
        runningCount: 0,
        sessionCount: 1,
      });
      // A clock is known even when the transcript cannot place a pending handoff.
      expect(projection.placedWait).toBeUndefined();
    }
    expect(project(settled, history, []).wait).toBeNull();
  });

  it.each([{ name: "no loaded handoff", history: [] }])(
    "renders the recorded wait clock with $name",
    async ({ history }) => {
      const now = Date.UTC(2026, 9, 12, 20, 48);
      const wait = resolveChatSubagentWait({
        selectedSession: { ...parent, startedAt: now - 100_000, endedAt: now - 65_000 },
        messages: history,
      });
      expect(wait?.startedAt).toBe(now - 65_000);
      if (!wait) {
        throw new Error("Expected a settled parent wait");
      }
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      const container = document.createElement("div");
      document.body.append(container);
      try {
        render(renderUnplacedSubagentWait(parent.key, wait, { waitingSubagents: wait }), container);
        flush();
        const elapsed = container.querySelector("openclaw-elapsed-time");
        await elapsed?.updateComplete;
        flush();
        expect(elapsed?.textContent?.trim()).toBe("1m 5s");
      } finally {
        render(null, container);
        container.remove();
        clock.mockRestore();
      }
    },
  );

  it.each([true])(
    "keeps a working fallback until child activity replaces it (bubble mode: %s)",
    (bubbleMode) => {
      const container = document.createElement("div");
      const onOpenSubagent = vi.fn();
      const projection = projectSubagentStatus(
        {
          selectedSession: parent,
          messages,
          subagentSessions: [child],
          subagentSessionsHydrated: true,
        },
        false,
      );
      const options = {
        bubbleMode,
        waitingSubagents: projection.wait ?? undefined,
        outputTokens: 4_700,
        workingPhrases: ["Building"],
      };
      const part = { kind: "reading-indicator" as const, key: "parent-wait", startedAt: 1_500 };
      render(renderChatWorkingIndicator(part, options), container);
      expect(container.textContent).toContain("Working…");
      expect(container.querySelector(".chat-reading-indicator")).not.toBeNull();
      render(
        renderChatWorkingIndicator(part, {
          ...options,
          subagentActivity: html`${renderSubagentActivity(projection.activity, onOpenSubagent)}`,
        }),
        container,
      );
      expect(container.textContent).toContain("Backend implementation");
      expect(container.textContent).not.toContain("Waiting on");
      expect(container.querySelector(".chat-working-indicator")).toBeNull();
      container.querySelector("button")?.click();
      expect(onOpenSubagent).toHaveBeenCalledWith(child.key);
    },
  );

  it("makes the running count the way to the list when navigation is available", () => {
    const container = document.createElement("div");
    const onOpenSubagents = vi.fn();
    const draw = (options: Parameters<typeof renderChatWorkingIndicator>[1]) =>
      render(
        renderChatWorkingIndicator(
          { kind: "reading-indicator", key: "parent-count", startedAt: 1_000 },
          { onOpenSubagents, ...options },
        ),
        container,
      );
    const control = () => container.querySelector<HTMLButtonElement>("button");
    draw({ runningSubagents: 3 });
    expect(control()?.textContent?.trim()).toBe("3 subagents running");
    control()?.click();
    expect(onOpenSubagents).toHaveBeenCalledOnce();
    draw({ runningSubagents: 1, onOpenSubagents: undefined });
    expect(container.textContent).toContain("1 subagent running");
    expect(control()).toBeNull();
  });
});
