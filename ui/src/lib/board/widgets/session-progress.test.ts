import type { ProgressCard } from "@openclaw/gateway-protocol";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { GatewaySessionRow } from "../../../api/types.ts";
import { createAgentSelectionCapability } from "../../../app/agent-selection.ts";
import type { ApplicationContext } from "../../../app/context.ts";
import { t } from "../../../i18n/index.ts";
import { createApplicationContextProvider } from "../../../test-helpers/application-context.ts";
import { createTestGatewayClient } from "../../../test-helpers/gateway-client.ts";
import {
  createGatewayHarness,
  createTestSessionCapability,
  sessionsResult,
} from "../../sessions/session-capability.test-support.ts";
import "./session-progress.ts";

function createContext(
  options: { row?: GatewaySessionRow; card?: ProgressCard; describeError?: boolean } = {},
) {
  const { gateway, emitEvent, publish } = createGatewayHarness(
    createTestGatewayClient(async (method) => {
      if (method === "sessions.list") {
        return sessionsResult([], 1);
      }
      if (method === "progressCard.get") {
        return { card: options.card ?? null };
      }
      if (method === "sessions.describe") {
        if (options.describeError) {
          throw new Error("Session status unavailable");
        }
        return { session: options.row ?? null };
      }
      throw new Error(`Unexpected request: ${method}`);
    }),
  );
  const sessions = createTestSessionCapability(gateway);
  const selection = createAgentSelectionCapability(
    Object.assign(gateway, { connection: { gatewayUrl: "ws://gateway.example.test" } }),
    { state: { agentsList: null }, subscribe: () => () => undefined },
  );
  let active = 0;
  const observeRow = sessions.observeRow.bind(sessions);
  const subscribe = vi.spyOn(sessions, "observeRow").mockImplementation((...args) => {
    const observation = observeRow(...args);
    const release = observation.dispose;
    active += 1;
    observation.dispose = () => {
      release();
      active -= 1;
    };
    return observation;
  });
  onTestFinished(() => {
    sessions.dispose();
    selection.dispose();
  });
  return {
    context: { gateway, sessions, agentSelection: selection } as unknown as ApplicationContext,
    selection,
    emitEvent,
    publish,
    subscribe,
    active: () => active,
  };
}

function mount(context: ApplicationContext) {
  const provider = createApplicationContextProvider(context);
  const element = document.createElement("openclaw-session-progress-widget");
  element.session = { sessionKey: "agent:main:progress-widget" };
  provider.append(element);
  document.body.append(provider);
  onTestFinished(() => provider.remove());
  return { provider, element };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("Session progress widget subscriptions", () => {
  it("does not reacquire a row observation when a queued property update runs after removal", async () => {
    const owner = createContext();
    const { provider, element } = mount(owner.context);

    for (let connections = 1; connections <= 2; connections += 1) {
      await element.updateComplete;
      await vi.waitFor(() =>
        expect(element.textContent).toContain(t("sessionProgressCard.widgetEmpty")),
      );
      expect(owner.active()).toBe(1);
      expect(owner.subscribe).toHaveBeenCalledTimes(connections);

      element.session = { sessionKey: `agent:main:queued-${connections}` };
      const update = element.updateComplete;
      expect(element.isUpdatePending).toBe(true);
      element.remove();
      expect(owner.active()).toBe(0);
      await update;
      expect(element.isConnected).toBe(false);
      expect(owner.active()).toBe(0);
      expect(owner.subscribe).toHaveBeenCalledTimes(connections);

      if (connections === 1) {
        provider.append(element);
      }
    }
  });

  it("keeps an off-roster target live as its own turn yields to delegated work", async () => {
    const row: GatewaySessionRow = {
      key: "agent:main:progress-widget",
      agentId: "main",
      sessionId: "progress-widget-run",
      kind: "direct",
      updatedAt: 100,
      startedAt: 100,
      status: "running",
      hasActiveRun: true,
      hasActiveSubagentRun: false,
    };
    const source = {
      row,
      describeError: false,
      card: {
        sessionKey: row.key,
        revision: 1,
        updatedAt: 101,
        steps: [{ step: "Collect findings", status: "in_progress" }],
      } satisfies ProgressCard,
    };
    const owner = createContext(source);
    const { element } = mount(owner.context);
    await vi.waitFor(() =>
      expect(
        element.querySelector(".session-progress-card__step")?.getAttribute("aria-label"),
      ).toBe("Collect findings, in progress"),
    );
    const yielded = {
      ...row,
      status: "done",
      hasActiveRun: false,
      hasActiveSubagentRun: true,
      updatedAt: 110,
      endedAt: 110,
    };
    owner.emitEvent({
      type: "event",
      event: "sessions.changed",
      payload: { reason: "update", agentId: "main", session: yielded, ts: 110 },
    });
    await element.updateComplete;
    expect(element.querySelector(".session-progress-card__runtime")?.textContent).toContain(
      t("sessionProgressCard.runtime.delegated"),
    );
    expect(element.querySelector(".session-progress-card__step")?.getAttribute("aria-label")).toBe(
      "Collect findings, in progress",
    );

    owner.publish(false);
    await element.updateComplete;
    expect(element.querySelector(".session-progress-card__runtime")?.textContent).toContain(
      t("sessionProgressCard.runtime.offline"),
    );
    expect(owner.active()).toBe(0);

    source.describeError = true;
    owner.publish(true);
    await vi.waitFor(() =>
      expect(element.querySelector(".session-progress-card__runtime")?.textContent).toContain(
        t("sessionProgressCard.runtime.unknown"),
      ),
    );
    expect(element.querySelector(".session-run-spinner")).toBeNull();

    source.describeError = false;
    source.row = { ...row, status: "done", hasActiveRun: false, endedAt: 110 };
    const retry = element.querySelector<HTMLButtonElement>(
      '[data-test-id="session-progress-runtime-retry"]',
    );
    expect(retry?.textContent).toContain(t("common.retry"));
    retry!.click();
    await vi.waitFor(() =>
      expect(element.querySelector(".session-progress-card__runtime")?.textContent).toContain(
        t("sessionProgressCard.runtime.idle"),
      ),
    );
    expect(element.querySelector('[data-test-id="session-progress-runtime-retry"]')).toBeNull();
  });

  it("moves the listener with context and activity without duplicating it on selection changes", async () => {
    const first = createContext();
    const second = createContext();
    const { provider, element } = mount(first.context);
    await element.updateComplete;
    await vi.waitFor(() =>
      expect(element.textContent).toContain(t("sessionProgressCard.widgetEmpty")),
    );
    expect([first.active(), second.active()]).toEqual([1, 0]);

    first.selection.set("writer");
    await element.updateComplete;
    expect(first.subscribe).toHaveBeenCalledOnce();

    provider.setContext(second.context);
    await element.updateComplete;
    expect([first.active(), second.active()]).toEqual([0, 1]);
    first.selection.set("main");
    second.selection.set("writer");
    await element.updateComplete;
    expect(second.subscribe).toHaveBeenCalledOnce();

    element.active = false;
    await element.updateComplete;
    expect([first.active(), second.active()]).toEqual([0, 0]);
    element.active = true;
    await element.updateComplete;
    expect([first.active(), second.active()]).toEqual([0, 1]);
    element.remove();
    await element.updateComplete;
    expect([first.active(), second.active()]).toEqual([0, 0]);
  });
});
