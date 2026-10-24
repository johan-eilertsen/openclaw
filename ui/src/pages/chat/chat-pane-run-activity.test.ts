/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, describe, expect, it } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { sessionMutationGatewayHello } from "../../test-helpers/gateway-methods.ts";
import { createRefreshChatPane } from "./chat-pane-history.test-support.ts";
import { renderChat } from "./chat-view.ts";
import { resetChatComposerState } from "./components/chat-composer.ts";

function sessionsResult(rows: GatewaySessionRow[]): SessionsListResult {
  return {
    ts: 1,
    path: "",
    count: rows.length,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions: rows,
  };
}

describe.each([false, true])("chat run activity (recovery ready: %s)", (recoveryScopeReady) => {
  afterEach(() => resetChatComposerState());

  it("keeps the retained progress card in sync with the owned child roster", () => {
    const parentKey = "agent:main:main";
    const parent: GatewaySessionRow = {
      key: parentKey,
      kind: "direct",
      status: "done",
      hasActiveRun: false,
      hasActiveSubagentRun: true,
      startedAt: 1_000,
      endedAt: 3_000,
    };
    const rows: GatewaySessionRow[] = Array.from({ length: 5 }, (_, index) => ({
      key: `agent:main:subagent:worker-${index}`,
      kind: "direct",
      spawnedBy: parentKey,
      status: index < 2 ? "running" : "queued",
      hasActiveRun: index < 2,
    }));
    const client = {
      request: async () => ({}),
      recoveryScopeReady,
    } as unknown as GatewayBrowserClient;
    const { pane, state, context } = createRefreshChatPane(client);
    context.gateway.snapshot.hello = sessionMutationGatewayHello(["operator.write"]);
    state.sessionKey = parentKey;
    state.sessionsResult = sessionsResult([parent]);
    pane.render();
    const container = document.createElement("div");
    const props = {
      ...pane.chatProps!,
      connected: true,
      loading: false,
      progressCard: {
        sessionKey: parentKey,
        revision: 1,
        updatedAt: 2_000,
        steps: [{ step: "Collect the results", status: "in_progress" as const }],
      },
      subagentSessions: rows,
      subagentSessionsHydrated: false,
    };
    render(renderChat(props), container);
    expect(container.querySelector(".session-progress-card__runtime")?.textContent).toContain(
      "Waiting for delegated work",
    );
    expect(container.querySelector(".session-progress-card__runtime")?.textContent).not.toContain(
      "2 running",
    );

    props.subagentSessionsHydrated = true;
    render(renderChat(props), container);
    expect(container.querySelector(".session-progress-card__runtime")?.textContent).toContain(
      "2 running · 3 queued",
    );
    rows[0] = {
      ...rows[0]!,
      label: "Research",
      status: "failed",
      hasActiveRun: false,
      endedAt: 4_000,
      lastRunError: "The service is unavailable.",
    };
    rows[1] = { ...rows[1]!, status: "done", hasActiveRun: false, endedAt: 4_000 };
    render(renderChat({ ...props, subagentSessions: [...rows] }), container);
    expect(container.querySelector(".session-progress-card__runtime")?.textContent).toContain(
      "3 queued · 1 failed",
    );
    expect(container.querySelector("[data-complete]")?.getAttribute("data-complete")).toBe("false");
    expect(container.querySelector(".session-progress-card__runtime-detail")?.textContent).toBe(
      "Research: The service is unavailable.",
    );
    // A later authored snapshot reconciles the old failure. Siblings do not count.
    render(
      renderChat({
        ...props,
        progressCard: { ...props.progressCard, updatedAt: 5_000 },
        subagentSessions: [
          ...rows,
          { ...rows[0]!, key: "agent:main:subagent:other", spawnedBy: "agent:main:other" },
        ],
      }),
      container,
    );
    expect(container.querySelector(".session-progress-card__runtime")?.textContent).toContain(
      "3 queued",
    );
    expect(container.querySelector(".session-progress-card__runtime")?.textContent).not.toContain(
      "failed",
    );
  });

  it.each([
    {
      name: "shows a completed parent waiting on its visible child, not working",
      selectedKey: "agent:main:main",
      parentActive: false,
      expectWorking: false,
      expectWaiting: true,
    },
    {
      name: "shows activity on the visible child itself",
      selectedKey: "agent:main:subagent:attachment-fix",
      parentActive: false,
      expectWorking: true,
      expectWaiting: false,
    },
    {
      name: "shows activity while the parent has its own live turn",
      selectedKey: "agent:main:main",
      parentActive: true,
      expectWorking: true,
      expectWaiting: false,
    },
  ])("$name", ({ selectedKey, parentActive, expectWorking, expectWaiting }) => {
    const parentKey = "agent:main:main";
    const childKey = "agent:main:subagent:attachment-fix";
    const parent = {
      key: parentKey,
      kind: "direct",
      updatedAt: 2,
      status: parentActive ? "running" : "done",
      hasActiveRun: parentActive,
      activeRunIds: parentActive ? ["parent-run"] : [],
      hasActiveSubagentRun: true,
      childSessions: [childKey],
    } satisfies GatewaySessionRow;
    const child = {
      key: childKey,
      kind: "direct",
      updatedAt: 3,
      status: "running",
      hasActiveRun: true,
      activeRunIds: ["child-run"],
      subagentRunState: "active",
      spawnedBy: parentKey,
      parentSessionKey: parentKey,
      startedAt: 1,
    } satisfies GatewaySessionRow;
    const client = {
      request: async () => ({}),
      recoveryScopeReady,
    } as unknown as GatewayBrowserClient;
    const { pane, state, context } = createRefreshChatPane(client);
    context.gateway.snapshot.hello = sessionMutationGatewayHello(["operator.write"]);
    state.sessionKey = selectedKey;
    state.sessionsResult = sessionsResult([parent, child]);
    pane.render();

    const container = document.createElement("div");
    render(renderChat(pane.chatProps!), container);

    expect(pane.chatProps?.canAbort).toBe(true);
    expect(
      container.querySelector(
        ".chat-working-indicator:not(.chat-working-indicator--subagents) .chat-reading-indicator",
      ) !== null,
    ).toBe(expectWorking);
    // Live transcript rows render once history has loaded; until then the skeleton owns the pane.
    expect(container.querySelector(".chat-working-indicator--subagents") !== null).toBe(
      expectWaiting && pane.chatProps?.loading !== true,
    );
  });
});
